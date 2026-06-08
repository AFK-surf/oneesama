/* eslint-disable max-lines */
import { request as httpRequest } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { RequestOptions } from "node:https";
import type { Duplex } from "node:stream";

import type {
  CanonicalConversationEvent,
  CanonicalConversationEventType,
  ConversationEngineControlCommand,
  ConversationEnginePort,
  LanOperatorTextInput,
  LanOperatorToolResultInput,
} from "./lan-operator-conversation-engine.ts";
import type { LanOperatorVoiceChunk, LanOperatorVoiceForwardResult } from "./lan-operator-voice.ts";

export type OpenAIRealtimeRawEvent = Record<string, unknown> & {
  type?: unknown;
};

export interface OpenAIRealtimeEventMapContext {
  engineId?: string;
  sessionId: string;
  now?: () => string;
}

export interface OpenAIRealtimeTransportResult {
  ok?: boolean;
  error?: string;
  reason?: string;
  events?: OpenAIRealtimeRawEvent[];
  [key: string]: unknown;
}

export interface OpenAIRealtimeTransport {
  id?: string;
  connect?(
    sessionId: string,
  ):
    | Promise<OpenAIRealtimeTransportResult | OpenAIRealtimeRawEvent[] | void>
    | OpenAIRealtimeTransportResult
    | OpenAIRealtimeRawEvent[]
    | void;
  sendAudioChunk?(
    chunk: LanOperatorVoiceChunk,
  ):
    | Promise<OpenAIRealtimeTransportResult | OpenAIRealtimeRawEvent[] | void>
    | OpenAIRealtimeTransportResult
    | OpenAIRealtimeRawEvent[]
    | void;
  sendTextInput?(
    input: LanOperatorTextInput,
  ):
    | Promise<OpenAIRealtimeTransportResult | OpenAIRealtimeRawEvent[] | void>
    | OpenAIRealtimeTransportResult
    | OpenAIRealtimeRawEvent[]
    | void;
  sendToolResult?(
    input: LanOperatorToolResultInput,
  ):
    | Promise<OpenAIRealtimeTransportResult | OpenAIRealtimeRawEvent[] | void>
    | OpenAIRealtimeTransportResult
    | OpenAIRealtimeRawEvent[]
    | void;
  sendControlEvent?(
    event: OpenAIRealtimeRawEvent,
    command: ConversationEngineControlCommand,
  ):
    | Promise<OpenAIRealtimeTransportResult | OpenAIRealtimeRawEvent[] | void>
    | OpenAIRealtimeTransportResult
    | OpenAIRealtimeRawEvent[]
    | void;
  disconnect?(
    reason?: string,
  ):
    | Promise<OpenAIRealtimeTransportResult | OpenAIRealtimeRawEvent[] | void>
    | OpenAIRealtimeTransportResult
    | OpenAIRealtimeRawEvent[]
    | void;
}

export interface OpenAIRealtimeConversationEngineOptions {
  engineId?: string;
  transport: OpenAIRealtimeTransport;
}

export interface OpenAIRealtimeWebSocketLike {
  readyState?: number | string;
  send?(payload: string): void;
  close?(code?: number, reason?: string): void;
  on?(event: string, handler: (...args: unknown[]) => void): OpenAIRealtimeWebSocketLike;
  once?(event: string, handler: (...args: unknown[]) => void): OpenAIRealtimeWebSocketLike;
  addEventListener?(event: string, handler: (...args: unknown[]) => void, options?: unknown): void;
}

export interface OpenAIRealtimeWebSocketInit {
  headers?: Record<string, string>;
  agent?: unknown;
}

export type OpenAIRealtimeWebSocketFactory = (
  url: string,
  init: OpenAIRealtimeWebSocketInit,
) => OpenAIRealtimeWebSocketLike | Promise<OpenAIRealtimeWebSocketLike>;

export interface OpenAIRealtimeWebSocketTransportOptions {
  apiKey?: string;
  model?: string;
  url?: string;
  safetyIdentifier?: string;
  headers?: Record<string, string>;
  instructions?: string;
  session?: Record<string, unknown>;
  response?: Record<string, unknown>;
  connectTimeoutMs?: number;
  drainMs?: number;
  proxyUrl?: string | false;
  webSocketFactory?: OpenAIRealtimeWebSocketFactory;
}

interface MapperState {
  audioStartedResponseIds: Set<string>;
}

const DEFAULT_ENGINE_ID = "openai_realtime";
const PROVIDER = "openai_realtime";
const DEFAULT_REALTIME_MODEL = "gpt-realtime-2";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_MS = 25;
const OPEN_READY_STATE = 1;
const CLOSED_READY_STATE = 3;

function eventType(raw: OpenAIRealtimeRawEvent) {
  return String(raw?.type || "").trim();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function sanitizeProviderText(value: unknown) {
  return String(value || "").replace(/\bsk-[A-Za-z0-9_.*-]+/g, "[redacted_openai_api_key]");
}

function responseIdFrom(raw: OpenAIRealtimeRawEvent) {
  const response = objectValue(raw.response);
  return stringValue(raw.response_id) || stringValue(raw.responseId) || stringValue(response.id);
}

function itemFrom(raw: OpenAIRealtimeRawEvent) {
  return objectValue(raw.item || raw.output_item);
}

function itemIdFrom(raw: OpenAIRealtimeRawEvent) {
  const item = itemFrom(raw);
  return stringValue(raw.item_id) || stringValue(raw.itemId) || stringValue(item.id);
}

function callIdFrom(raw: OpenAIRealtimeRawEvent) {
  const item = itemFrom(raw);
  return (
    stringValue(raw.call_id) ||
    stringValue(raw.callId) ||
    stringValue(item.call_id) ||
    stringValue(item.callId)
  );
}

function toolNameFrom(raw: OpenAIRealtimeRawEvent) {
  const item = itemFrom(raw);
  return stringValue(raw.name) || stringValue(item.name);
}

function textFrom(raw: OpenAIRealtimeRawEvent) {
  return (
    stringValue(raw.delta) ||
    stringValue(raw.text) ||
    stringValue(raw.transcript) ||
    stringValue(raw.arguments)
  );
}

function providerDetail(
  raw: OpenAIRealtimeRawEvent,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    provider: PROVIDER,
    providerEventType: eventType(raw),
    ...extra,
  };
  const providerEventId = stringValue(raw.event_id) || stringValue(raw.eventId);
  const callId = callIdFrom(raw);
  const name = toolNameFrom(raw) || stringValue(detail.name);
  const reason = sanitizeProviderText(
    stringValue(raw.reason) || stringValue(objectValue(raw.status_details).reason),
  );
  const status = stringValue(raw.status);
  const error = errorFrom(raw);
  if (providerEventId) detail.providerEventId = providerEventId;
  if (callId) detail.callId = callId;
  if (name) {
    detail.name = name;
    detail.expectedTool = name;
  }
  if (reason) detail.reason = reason;
  if (status) detail.status = status;
  if (error) detail.error = error;
  return detail;
}

function canonicalId(raw: OpenAIRealtimeRawEvent, type: CanonicalConversationEventType) {
  const providerEventId = stringValue(raw.event_id) || stringValue(raw.eventId);
  if (providerEventId) return `${PROVIDER}_${type}_${providerEventId}`;
  return `${PROVIDER}_${type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function canonicalEvent(
  raw: OpenAIRealtimeRawEvent,
  context: Required<OpenAIRealtimeEventMapContext>,
  type: CanonicalConversationEventType,
  input: Partial<CanonicalConversationEvent> = {},
): CanonicalConversationEvent {
  return {
    id: input.id || canonicalId(raw, type),
    ts: input.ts || context.now(),
    sessionId: input.sessionId || context.sessionId,
    type,
    engineId: input.engineId || context.engineId,
    turnId: input.turnId,
    responseId: input.responseId || responseIdFrom(raw) || undefined,
    itemId: input.itemId || itemIdFrom(raw) || undefined,
    text: input.text,
    audioBase64: input.audioBase64,
    error: input.error,
    detail: input.detail,
  };
}

function normalizeContext(
  context: OpenAIRealtimeEventMapContext,
): Required<OpenAIRealtimeEventMapContext> {
  return {
    engineId: context.engineId || DEFAULT_ENGINE_ID,
    sessionId: context.sessionId,
    now: context.now || (() => new Date().toISOString()),
  };
}

function errorFrom(raw: OpenAIRealtimeRawEvent) {
  const error = objectValue(raw.error);
  return sanitizeProviderText(
    stringValue(raw.error) ||
      stringValue(error.message) ||
      stringValue(error.code) ||
      stringValue(raw.reason) ||
      stringValue(raw.status),
  );
}

function responseOutput(raw: OpenAIRealtimeRawEvent) {
  const response = objectValue(raw.response);
  return Array.isArray(response.output) ? (response.output as Record<string, unknown>[]) : [];
}

function mapFunctionCallOutput(
  raw: OpenAIRealtimeRawEvent,
  context: Required<OpenAIRealtimeEventMapContext>,
) {
  return responseOutput(raw)
    .filter((entry) => entry?.type === "function_call")
    .map((entry) =>
      canonicalEvent(raw, context, "tool_call_completed", {
        itemId: stringValue(entry.id) || itemIdFrom(raw) || undefined,
        text: stringValue(entry.arguments),
        detail: providerDetail(raw, {
          callId: stringValue(entry.call_id) || stringValue(entry.callId),
          name: stringValue(entry.name),
        }),
      }),
    );
}

export function createOpenAIRealtimeEventMapper(context: OpenAIRealtimeEventMapContext) {
  const normalized = normalizeContext(context);
  const state: MapperState = {
    audioStartedResponseIds: new Set<string>(),
  };

  return (raw: OpenAIRealtimeRawEvent): CanonicalConversationEvent[] =>
    mapOpenAIRealtimeEvent(raw, normalized, state);
}

export function mapOpenAIRealtimeEvent(
  raw: OpenAIRealtimeRawEvent,
  context: OpenAIRealtimeEventMapContext,
  state: MapperState = { audioStartedResponseIds: new Set<string>() },
): CanonicalConversationEvent[] {
  const normalized = normalizeContext(context);
  const type = eventType(raw);
  if (!type) return [];

  if (type === "session.created") {
    const session = objectValue(raw.session);
    return [
      canonicalEvent(raw, normalized, "engine_connected", {
        detail: providerDetail(raw, { providerSessionId: stringValue(session.id) }),
      }),
    ];
  }
  if (type === "input_audio_buffer.speech_started") {
    return [
      canonicalEvent(raw, normalized, "speech_started", {
        detail: providerDetail(raw),
      }),
    ];
  }
  if (type === "input_audio_buffer.speech_stopped") {
    return [canonicalEvent(raw, normalized, "speech_stopped", { detail: providerDetail(raw) })];
  }
  if (type === "conversation.item.input_audio_transcription.delta") {
    return [
      canonicalEvent(raw, normalized, "transcript_delta", {
        text: textFrom(raw),
        detail: providerDetail(raw),
      }),
    ];
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    return [
      canonicalEvent(raw, normalized, "transcript_completed", {
        text: textFrom(raw),
        detail: providerDetail(raw),
      }),
    ];
  }
  if (
    type === "response.output_text.delta" ||
    type === "response.text.delta" ||
    type === "response.output_audio_transcript.delta"
  ) {
    return [
      canonicalEvent(raw, normalized, "assistant_text_delta", {
        text: textFrom(raw),
        detail: providerDetail(raw),
      }),
    ];
  }
  if (
    type === "response.output_text.done" ||
    type === "response.text.done" ||
    type === "response.output_audio_transcript.done"
  ) {
    return [
      canonicalEvent(raw, normalized, "assistant_text_completed", {
        text: textFrom(raw),
        detail: providerDetail(raw),
      }),
    ];
  }
  if (type === "response.output_audio.delta" || type === "response.audio.delta") {
    const responseId = responseIdFrom(raw) || "unknown_response";
    const events = [];
    if (!state.audioStartedResponseIds.has(responseId)) {
      state.audioStartedResponseIds.add(responseId);
      events.push(
        canonicalEvent(raw, normalized, "assistant_audio_started", { detail: providerDetail(raw) }),
      );
    }
    events.push(
      canonicalEvent(raw, normalized, "assistant_audio_chunk", {
        audioBase64: stringValue(raw.delta),
        detail: providerDetail(raw),
      }),
    );
    return events;
  }
  if (type === "response.output_audio.done" || type === "response.audio.done") {
    const responseId = responseIdFrom(raw) || "unknown_response";
    state.audioStartedResponseIds.delete(responseId);
    return [
      canonicalEvent(raw, normalized, "assistant_audio_stopped", { detail: providerDetail(raw) }),
    ];
  }
  if (type === "response.function_call_arguments.delta") {
    return [
      canonicalEvent(raw, normalized, "tool_call_delta", {
        text: textFrom(raw),
        detail: providerDetail(raw),
      }),
    ];
  }
  if (type === "response.function_call_arguments.done") {
    return [
      canonicalEvent(raw, normalized, "tool_call_completed", {
        text: textFrom(raw),
        detail: providerDetail(raw),
      }),
    ];
  }
  if (type === "conversation.item.created" || type === "response.output_item.added") {
    const item = itemFrom(raw);
    if (item.type === "function_call") {
      return [
        canonicalEvent(raw, normalized, "tool_call_started", {
          detail: providerDetail(raw, { itemType: item.type }),
        }),
      ];
    }
    if (item.type === "function_call_output") {
      return [
        canonicalEvent(raw, normalized, "tool_result_accepted", {
          detail: providerDetail(raw, { itemType: item.type }),
        }),
      ];
    }
  }
  if (type === "response.output_item.done" && itemFrom(raw).type === "function_call") {
    return [
      canonicalEvent(raw, normalized, "tool_call_completed", {
        text: stringValue(itemFrom(raw).arguments),
        detail: providerDetail(raw, { itemType: "function_call" }),
      }),
    ];
  }
  if (type === "response.done") {
    return mapFunctionCallOutput(raw, normalized);
  }
  if (
    type === "response.cancelled" ||
    type === "response.canceled" ||
    type === "agents_sdk.audio_interrupted" ||
    type === "audio_interrupted"
  ) {
    return [
      canonicalEvent(raw, normalized, "interrupted", {
        detail: providerDetail(raw),
      }),
    ];
  }
  if (type === "error" || type === "response.failed") {
    return [
      canonicalEvent(raw, normalized, "engine_error", {
        error: errorFrom(raw) || type,
        detail: providerDetail(raw),
      }),
    ];
  }
  return [];
}

function eventsFromTransportOutput(
  output: OpenAIRealtimeTransportResult | OpenAIRealtimeRawEvent[] | void,
): OpenAIRealtimeRawEvent[] {
  if (Array.isArray(output)) return output;
  if (output && typeof output === "object" && Array.isArray(output.events)) return output.events;
  return [];
}

function resultFromTransportOutput(
  output: OpenAIRealtimeTransportResult | OpenAIRealtimeRawEvent[] | void,
): LanOperatorVoiceForwardResult {
  if (!output || Array.isArray(output)) return { ok: true, engineId: DEFAULT_ENGINE_ID };
  return {
    ...output,
    ok: output.ok !== false,
    error: output.error ? sanitizeProviderText(output.error) : output.error,
    reason: output.reason ? sanitizeProviderText(output.reason) : output.reason,
  };
}

function rawControlEvent(command: ConversationEngineControlCommand): OpenAIRealtimeRawEvent {
  if (command.type === "connect")
    return { type: "session.connect", reason: command.reason || "operator_connect" };
  if (command.type === "disconnect")
    return { type: "session.disconnect", reason: command.reason || "operator_disconnect" };
  if (command.type === "drain_events") return { type: "session.drain_events" };
  if (command.type === "cancel_response") {
    return {
      type: "response.cancel",
      response_id: command.responseId,
      reason: command.reason || "operator_cancelled",
    };
  }
  if (command.type === "clear_audio_buffer") return { type: "input_audio_buffer.clear" };
  if (command.type === "reset_session") {
    return { type: "session.reset", reason: command.reason || "operator_reset" };
  }
  return { type: "session.reconnect", reason: command.reason || "operator_reconnect" };
}

function defaultRealtimeApiKey() {
  return (
    process.env.ONEESAMA_OPENAI_API_KEY ||
    process.env.MAB_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ""
  );
}

function defaultRealtimeModel() {
  return (
    process.env.MAB_LAN_OPENAI_REALTIME_MODEL ||
    process.env.MAB_OPENAI_REALTIME_MODEL ||
    process.env.OPENAI_REALTIME_MODEL ||
    DEFAULT_REALTIME_MODEL
  );
}

function realtimeWebSocketUrl(options: OpenAIRealtimeWebSocketTransportOptions) {
  if (options.url) return options.url;
  const model = options.model || defaultRealtimeModel();
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

function proxyUrlFromEnv() {
  return (
    process.env.MAB_LAN_OPENAI_REALTIME_PROXY_URL ||
    process.env.MAB_OPENAI_REALTIME_PROXY_URL ||
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.all_proxy ||
    process.env.ALL_PROXY ||
    ""
  );
}

function proxyUrlForTransport(options: OpenAIRealtimeWebSocketTransportOptions) {
  if (options.proxyUrl === false) return "";
  return String(options.proxyUrl || proxyUrlFromEnv()).trim();
}

function proxyAuthorizationHeader(proxyUrl: URL) {
  if (!proxyUrl.username) return "";
  const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function createHttpConnectProxyAgent(proxyUrlText: string) {
  const proxyUrl = new URL(proxyUrlText);
  if (proxyUrl.protocol !== "http:") return null;
  return new (class OpenAIRealtimeHttpConnectProxyAgent extends HttpsAgent {
    createConnection(
      options: RequestOptions,
      callback?: (error: Error | null, socket: Duplex) => void,
    ): Duplex {
      const targetHost = String(options.servername || options.host || options.hostname || "");
      const targetPort = Number(options.port || 443);
      const target = `${targetHost}:${targetPort}`;
      const done = callback || (() => {});
      const headers: Record<string, string> = { Host: target };
      const proxyAuthorization = proxyAuthorizationHeader(proxyUrl);
      if (proxyAuthorization) headers["Proxy-Authorization"] = proxyAuthorization;
      const request = httpRequest({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port || 80),
        method: "CONNECT",
        path: target,
        headers,
      });
      request.once("connect", (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          done(
            new Error(`openai_realtime_proxy_connect_failed_${response.statusCode || "unknown"}`),
            socket,
          );
          return;
        }
        if (head.length > 0) socket.unshift(head);
        const tlsSocket = tlsConnect({
          socket,
          servername: targetHost,
        });
        done(null, tlsSocket);
      });
      request.once("error", (error) => done(error, request as unknown as Duplex));
      request.end();
      return undefined as unknown as Duplex;
    }
  })();
}

function openAIRealtimeWebSocketInit(
  options: OpenAIRealtimeWebSocketTransportOptions,
  headers: Record<string, string>,
): OpenAIRealtimeWebSocketInit {
  const init: OpenAIRealtimeWebSocketInit = { headers };
  const proxyUrlText = proxyUrlForTransport(options);
  if (!proxyUrlText) return init;
  try {
    const agent = createHttpConnectProxyAgent(proxyUrlText);
    if (agent) init.agent = agent;
  } catch {
    // A malformed proxy URL should not hide the provider's real connect error.
  }
  return init;
}

function transportErrorEvent(
  error: string,
  detail: Record<string, unknown> = {},
): OpenAIRealtimeRawEvent {
  return {
    type: "error",
    error: {
      message: sanitizeProviderText(error),
      ...detail,
    },
  };
}

function defaultSessionUpdate(
  options: OpenAIRealtimeWebSocketTransportOptions,
): OpenAIRealtimeRawEvent {
  const session = options.session ?? {};
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions:
        options.instructions ||
        "You are Oneesama's realtime Local Operator Surface conversation engine. Respond concisely and use tools when the user asks you to control the focused app/system view.",
      ...session,
    },
  };
}

function responseCreateEvent(
  options: OpenAIRealtimeWebSocketTransportOptions,
): OpenAIRealtimeRawEvent {
  return options.response
    ? {
        type: "response.create",
        response: options.response,
      }
    : { type: "response.create" };
}

function isOpenSocket(socket: OpenAIRealtimeWebSocketLike | null) {
  return socket?.readyState === OPEN_READY_STATE || socket?.readyState === "open";
}

function messageText(raw: unknown) {
  const data = objectValue(raw).data;
  if (data !== undefined) return messageText(data);
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (ArrayBuffer.isView(raw))
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return String(raw || "");
}

function attachSocketListener(
  socket: OpenAIRealtimeWebSocketLike,
  event: string,
  handler: (...args: unknown[]) => void,
  once = false,
) {
  if (once && typeof socket.once === "function") {
    socket.once(event, handler);
    return;
  }
  if (typeof socket.on === "function") {
    socket.on(event, handler);
    return;
  }
  socket.addEventListener?.(event, handler, once ? { once: true } : undefined);
}

function sendRealtimeJson(
  socket: OpenAIRealtimeWebSocketLike | null,
  event: OpenAIRealtimeRawEvent,
) {
  if (!isOpenSocket(socket) || typeof socket?.send !== "function") return false;
  socket.send(JSON.stringify(event));
  return true;
}

function textInputTranscriptEvent(
  engineId: string,
  input: LanOperatorTextInput,
): CanonicalConversationEvent {
  return {
    id: `operator_text_transcript_${input.id}`,
    ts: input.ts,
    sessionId: input.sessionId,
    type: "transcript_completed",
    engineId,
    turnId: `turn_${input.id}`,
    text: input.text,
    detail: {
      inputMode: "text",
      inputId: input.id,
      source: input.source,
      surfaceContext: input.surfaceContext || {},
    },
  };
}

function toolResultAcceptedEvent(
  engineId: string,
  input: LanOperatorToolResultInput,
): CanonicalConversationEvent {
  const text = typeof input.output === "string" ? input.output : JSON.stringify(input.output || {});
  return {
    id: `operator_tool_result_${input.id}`,
    ts: input.ts,
    sessionId: input.sessionId,
    type: "tool_result_accepted",
    engineId,
    turnId: input.turnId,
    responseId: input.responseId,
    itemId: input.itemId,
    text,
    detail: {
      inputMode: "tool_result",
      inputId: input.id,
      source: input.source,
      callId: input.callId,
      name: input.toolName || "kwwk_computer_use",
      expectedTool: input.toolName || "kwwk_computer_use",
      jobId: input.jobId || "",
      status: input.status,
      surfaceContext: input.surfaceContext || {},
    },
  };
}

async function defaultWebSocketFactory(
  url: string,
  init: OpenAIRealtimeWebSocketInit,
): Promise<OpenAIRealtimeWebSocketLike> {
  const imported = (await import("ws")) as {
    WebSocket?: new (url: string, init: OpenAIRealtimeWebSocketInit) => OpenAIRealtimeWebSocketLike;
    default?: new (url: string, init: OpenAIRealtimeWebSocketInit) => OpenAIRealtimeWebSocketLike;
  };
  const WebSocketConstructor = imported.WebSocket || imported.default;
  if (!WebSocketConstructor) throw new Error("openai_realtime_ws_module_missing_constructor");
  return new WebSocketConstructor(url, init);
}

function waitForSocketOpen(socket: OpenAIRealtimeWebSocketLike, timeoutMs: number) {
  if (isOpenSocket(socket)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("openai_realtime_websocket_connect_timeout"));
    }, timeoutMs);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve();
    };
    attachSocketListener(socket, "open", () => finish(), true);
    attachSocketListener(
      socket,
      "error",
      (error) => finish(error || "openai_realtime_websocket_error"),
      true,
    );
    attachSocketListener(
      socket,
      "close",
      () => finish("openai_realtime_websocket_closed_before_open"),
      true,
    );
  });
}

function drainQueuedEvents(queue: OpenAIRealtimeRawEvent[], drainMs: number) {
  return new Promise<OpenAIRealtimeRawEvent[]>((resolve) => {
    setTimeout(() => resolve(queue.splice(0, queue.length)), Math.max(0, drainMs));
  });
}

export function createOpenAIRealtimeWebSocketTransport(
  options: OpenAIRealtimeWebSocketTransportOptions = {},
): OpenAIRealtimeTransport {
  const incomingEvents: OpenAIRealtimeRawEvent[] = [];
  const factory = options.webSocketFactory || defaultWebSocketFactory;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  let socket: OpenAIRealtimeWebSocketLike | null = null;
  let activeSessionId = "";

  async function closeSocket(reason = "operator_surface_closed") {
    const current = socket;
    socket = null;
    if (
      current &&
      current.readyState !== CLOSED_READY_STATE &&
      typeof current.close === "function"
    ) {
      current.close(1000, reason.slice(0, 120));
    }
  }

  async function connect(sessionId: string): Promise<OpenAIRealtimeTransportResult> {
    const apiKey = options.apiKey ?? defaultRealtimeApiKey();
    if (!apiKey) {
      return {
        ok: false,
        error: "openai_realtime_api_key_missing",
        events: [transportErrorEvent("openai_realtime_api_key_missing")],
      };
    }
    if (isOpenSocket(socket) && activeSessionId === sessionId) {
      return { ok: true, events: await drainQueuedEvents(incomingEvents, drainMs) };
    }
    await closeSocket("operator_reconnect");
    incomingEvents.splice(0, incomingEvents.length);
    activeSessionId = sessionId;
    const extraHeaders = options.headers ?? {};
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      ...(options.safetyIdentifier ? { "OpenAI-Safety-Identifier": options.safetyIdentifier } : {}),
      ...extraHeaders,
    };
    try {
      socket = await factory(
        realtimeWebSocketUrl(options),
        openAIRealtimeWebSocketInit(options, headers),
      );
      attachSocketListener(socket, "message", (raw) => {
        try {
          incomingEvents.push(JSON.parse(messageText(raw)) as OpenAIRealtimeRawEvent);
        } catch {
          incomingEvents.push(transportErrorEvent("openai_realtime_invalid_json_event"));
        }
      });
      attachSocketListener(socket, "error", (error) => {
        incomingEvents.push(
          transportErrorEvent(String(error || "openai_realtime_websocket_error")),
        );
      });
      attachSocketListener(socket, "close", () => {
        if (socket) incomingEvents.push({ type: "response.failed", status: "websocket_closed" });
      });
      await waitForSocketOpen(socket, connectTimeoutMs);
      if (!sendRealtimeJson(socket, defaultSessionUpdate(options))) {
        throw new Error("openai_realtime_websocket_send_session_update_failed");
      }
      return { ok: true, events: await drainQueuedEvents(incomingEvents, drainMs) };
    } catch (error) {
      await closeSocket("connect_failed");
      const message = sanitizeProviderText(
        error instanceof Error ? error.message : String(error || "openai_realtime_connect_failed"),
      );
      return { ok: false, error: message, events: [transportErrorEvent(message)] };
    }
  }

  return {
    id: "openai_realtime_websocket",
    connect,
    async sendAudioChunk(chunk) {
      if (!isOpenSocket(socket)) {
        return {
          ok: false,
          error: "openai_realtime_websocket_not_connected",
          events: [transportErrorEvent("openai_realtime_websocket_not_connected")],
        };
      }
      const sent = sendRealtimeJson(socket, {
        type: "input_audio_buffer.append",
        audio: chunk.dataBase64,
      });
      if (!sent) {
        return {
          ok: false,
          error: "openai_realtime_websocket_send_audio_failed",
          events: [transportErrorEvent("openai_realtime_websocket_send_audio_failed")],
        };
      }
      return { ok: true, accepted: true, events: await drainQueuedEvents(incomingEvents, drainMs) };
    },
    async sendTextInput(input) {
      if (!isOpenSocket(socket)) {
        return {
          ok: false,
          error: "openai_realtime_websocket_not_connected",
          events: [transportErrorEvent("openai_realtime_websocket_not_connected")],
        };
      }
      const itemSent = sendRealtimeJson(socket, {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input.text }],
        },
      });
      const responseSent = itemSent && sendRealtimeJson(socket, responseCreateEvent(options));
      if (!responseSent) {
        return {
          ok: false,
          error: "openai_realtime_websocket_send_text_failed",
          events: [transportErrorEvent("openai_realtime_websocket_send_text_failed")],
        };
      }
      return {
        ok: true,
        accepted: true,
        inputMode: "text",
        events: await drainQueuedEvents(incomingEvents, drainMs),
      };
    },
    async sendToolResult(input) {
      if (!isOpenSocket(socket)) {
        return {
          ok: false,
          error: "openai_realtime_websocket_not_connected",
          events: [transportErrorEvent("openai_realtime_websocket_not_connected")],
        };
      }
      const output =
        typeof input.output === "string" ? input.output : JSON.stringify(input.output || {});
      const itemSent = sendRealtimeJson(socket, {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: input.callId, output },
      });
      const responseSent = itemSent && sendRealtimeJson(socket, responseCreateEvent(options));
      if (!responseSent) {
        return {
          ok: false,
          error: "openai_realtime_websocket_send_tool_result_failed",
          events: [transportErrorEvent("openai_realtime_websocket_send_tool_result_failed")],
        };
      }
      return {
        ok: true,
        accepted: true,
        inputMode: "tool_result",
        events: await drainQueuedEvents(incomingEvents, drainMs),
      };
    },
    async sendControlEvent(event, command) {
      if (command.type === "drain_events") {
        return {
          ok: true,
          control: command.type,
          events: await drainQueuedEvents(incomingEvents, drainMs),
        };
      }
      if (command.type === "reset_session") {
        await closeSocket(command.reason || "operator_reset");
        return connect(command.sessionId);
      }
      if (!isOpenSocket(socket)) {
        return {
          ok: false,
          error: "openai_realtime_websocket_not_connected",
          events: [transportErrorEvent("openai_realtime_websocket_not_connected")],
        };
      }
      const sent = sendRealtimeJson(socket, event);
      if (!sent) {
        return {
          ok: false,
          error: "openai_realtime_websocket_send_control_failed",
          events: [transportErrorEvent("openai_realtime_websocket_send_control_failed")],
        };
      }
      return {
        ok: true,
        control: command.type,
        events: await drainQueuedEvents(incomingEvents, drainMs),
      };
    },
    async disconnect(reason = "operator_surface_closed") {
      await closeSocket(reason);
      return { ok: true, reason, events: await drainQueuedEvents(incomingEvents, drainMs) };
    },
  };
}

export function createOpenAIRealtimeConversationEngine(
  options: OpenAIRealtimeConversationEngineOptions,
): ConversationEnginePort {
  const engineId = options.engineId || DEFAULT_ENGINE_ID;
  const transport = options.transport;
  const state = {
    connected: false,
    sessionId: "",
    mapper: null as ReturnType<typeof createOpenAIRealtimeEventMapper> | null,
  };

  function mapperFor(sessionId: string) {
    if (!state.mapper || state.sessionId !== sessionId) {
      state.mapper = createOpenAIRealtimeEventMapper({ engineId, sessionId });
      state.sessionId = sessionId;
    }
    return state.mapper;
  }

  function mapRawEvents(sessionId: string, rawEvents: OpenAIRealtimeRawEvent[]) {
    const mapper = mapperFor(sessionId);
    return rawEvents.flatMap((event) => mapper(event));
  }

  async function connect(sessionId: string) {
    if (state.connected) return [];
    const output = await transport.connect?.(sessionId);
    const events = mapRawEvents(sessionId, eventsFromTransportOutput(output));
    const result = resultFromTransportOutput(output);
    const providerErrored = events.some((event) => event.type === "engine_error");
    if (result.ok === false || providerErrored) {
      state.connected = false;
      if (!events.some((event) => event.type === "engine_error")) {
        events.push({
          id: `${PROVIDER}_engine_error_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          sessionId,
          type: "engine_error",
          engineId,
          error: sanitizeProviderText(
            result.error || result.reason || "openai_realtime_transport_connect_failed",
          ),
          detail: {
            provider: PROVIDER,
            providerEventType: "transport.connect.error",
            transportId: transport.id || "",
          },
        });
      }
      return events;
    }
    state.connected = true;
    if (!events.some((event) => event.type === "engine_connected")) {
      events.unshift({
        id: `${PROVIDER}_engine_connected_${Date.now().toString(36)}`,
        ts: new Date().toISOString(),
        sessionId,
        type: "engine_connected",
        engineId,
        detail: {
          provider: PROVIDER,
          providerEventType: "transport.connected",
          transportId: transport.id || "",
        },
      });
    }
    return events;
  }

  return {
    id: engineId,
    connect,
    async control(command) {
      if (command.type === "connect") {
        const events = await connect(command.sessionId);
        return {
          result: {
            ok: state.connected,
            engineId,
            control: command.type,
            ...(state.connected ? {} : { error: "openai_realtime_transport_connect_failed" }),
          },
          events,
        };
      }
      if (command.type === "disconnect") {
        const events = await this.disconnect?.(command.reason || "operator_disconnect");
        return { result: { ok: true, engineId, control: command.type }, events: events || [] };
      }
      if (command.type === "reconnect") {
        const disconnected = await this.disconnect?.(command.reason || "operator_reconnect");
        const connected = await connect(command.sessionId);
        return {
          result: {
            ok: state.connected,
            engineId,
            control: command.type,
            ...(state.connected ? {} : { error: "openai_realtime_transport_connect_failed" }),
          },
          events: [...(disconnected || []), ...connected],
        };
      }
      if (command.type === "set_voice_armed" || command.type === "set_voice_muted") {
        const wantsArmed = command.type === "set_voice_armed" && command.detail?.armed !== false;
        const events = wantsArmed ? await connect(command.sessionId) : [];
        return {
          result: { ok: true, engineId, control: command.type, detail: command.detail || {} },
          events,
        };
      }
      if (command.type === "reset_session") state.connected = false;
      if (typeof transport.sendControlEvent !== "function") {
        return {
          result: {
            ok: false,
            engineId,
            control: command.type,
            error: "openai_realtime_transport_missing_send_control_event",
          },
          events: [
            {
              id: `${PROVIDER}_engine_error_${Date.now().toString(36)}`,
              ts: new Date().toISOString(),
              sessionId: command.sessionId,
              type: "engine_error",
              engineId,
              error: "openai_realtime_transport_missing_send_control_event",
              detail: { provider: PROVIDER, providerEventType: "transport.control.error" },
            },
          ],
        };
      }
      const output = await transport.sendControlEvent(rawControlEvent(command), command);
      const events = mapRawEvents(command.sessionId, eventsFromTransportOutput(output));
      if (
        command.type === "cancel_response" &&
        !events.some((event) => event.type === "interrupted")
      ) {
        events.push({
          id: `${PROVIDER}_interrupted_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          sessionId: command.sessionId,
          type: "interrupted",
          engineId,
          responseId: command.responseId,
          detail: { provider: PROVIDER, providerEventType: "control.response.cancel" },
        });
      }
      return {
        result: { ...resultFromTransportOutput(output), engineId, control: command.type },
        events,
      };
    },
    async receiveVoiceChunk(chunk) {
      const events = [];
      if (!state.connected) {
        events.push(...(await connect(chunk.sessionId)));
        if (!state.connected) {
          const error =
            events.find((event) => event.type === "engine_error")?.error ||
            "openai_realtime_transport_connect_failed";
          return { result: { ok: false, error, engineId }, events };
        }
      }
      if (typeof transport.sendAudioChunk !== "function") {
        const error = "openai_realtime_transport_missing_send_audio_chunk";
        events.push({
          id: `${PROVIDER}_engine_error_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          sessionId: chunk.sessionId,
          type: "engine_error",
          engineId,
          error,
          detail: {
            provider: PROVIDER,
            providerEventType: "transport.error",
            sequence: chunk.sequence,
          },
        });
        return { result: { ok: false, error, engineId }, events };
      }
      const output = await transport.sendAudioChunk(chunk);
      events.push(...mapRawEvents(chunk.sessionId, eventsFromTransportOutput(output)));
      const result = resultFromTransportOutput(output);
      result.engineId = engineId;
      if (result.ok === false && !events.some((event) => event.type === "engine_error")) {
        events.push({
          id: `${PROVIDER}_engine_error_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          sessionId: chunk.sessionId,
          type: "engine_error",
          engineId,
          error: String(result.error || result.reason || "openai_realtime_transport_failed"),
          detail: {
            provider: PROVIDER,
            providerEventType: "transport.error",
            sequence: chunk.sequence,
          },
        });
      }
      return { result, events };
    },
    async receiveTextInput(input) {
      const events = [textInputTranscriptEvent(engineId, input)];
      if (!state.connected) {
        events.push(...(await connect(input.sessionId)));
        if (!state.connected) {
          const error =
            events.find((event) => event.type === "engine_error")?.error ||
            "openai_realtime_transport_connect_failed";
          return { result: { ok: false, error, engineId }, events };
        }
      }
      if (typeof transport.sendTextInput !== "function") {
        const error = "openai_realtime_transport_missing_send_text_input";
        events.push({
          id: `${PROVIDER}_engine_error_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          sessionId: input.sessionId,
          type: "engine_error",
          engineId,
          error,
          detail: { provider: PROVIDER, providerEventType: "transport.error", inputMode: "text" },
        });
        return { result: { ok: false, error, engineId }, events };
      }
      const output = await transport.sendTextInput(input);
      events.push(...mapRawEvents(input.sessionId, eventsFromTransportOutput(output)));
      const result = resultFromTransportOutput(output);
      result.engineId = engineId;
      if (result.ok === false && !events.some((event) => event.type === "engine_error")) {
        events.push({
          id: `${PROVIDER}_engine_error_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          sessionId: input.sessionId,
          type: "engine_error",
          engineId,
          error: String(result.error || result.reason || "openai_realtime_transport_failed"),
          detail: { provider: PROVIDER, providerEventType: "transport.error", inputMode: "text" },
        });
      }
      return { result, events };
    },
    async receiveToolResult(input) {
      const events = [toolResultAcceptedEvent(engineId, input)];
      if (!state.connected) {
        events.push(...(await connect(input.sessionId)));
        if (!state.connected) {
          const error =
            events.find((event) => event.type === "engine_error")?.error ||
            "openai_realtime_transport_connect_failed";
          return { result: { ok: false, error, engineId }, events };
        }
      }
      if (typeof transport.sendToolResult !== "function") {
        const error = "openai_realtime_transport_missing_send_tool_result";
        events.push({
          id: `${PROVIDER}_engine_error_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          sessionId: input.sessionId,
          type: "engine_error",
          engineId,
          error,
          detail: {
            provider: PROVIDER,
            providerEventType: "transport.error",
            inputMode: "tool_result",
          },
        });
        return { result: { ok: false, error, engineId }, events };
      }
      const output = await transport.sendToolResult(input);
      events.push(...mapRawEvents(input.sessionId, eventsFromTransportOutput(output)));
      const result = resultFromTransportOutput(output);
      result.engineId = engineId;
      if (result.ok === false && !events.some((event) => event.type === "engine_error")) {
        events.push({
          id: `${PROVIDER}_engine_error_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          sessionId: input.sessionId,
          type: "engine_error",
          engineId,
          error: String(result.error || result.reason || "openai_realtime_transport_failed"),
          detail: {
            provider: PROVIDER,
            providerEventType: "transport.error",
            inputMode: "tool_result",
          },
        });
      }
      return { result, events };
    },
    async disconnect(reason = "operator_surface_closed") {
      const output = await transport.disconnect?.(reason);
      const sessionId = state.sessionId || "";
      state.connected = false;
      return [
        ...mapRawEvents(sessionId, eventsFromTransportOutput(output)),
        {
          id: `${PROVIDER}_engine_disconnected_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          sessionId,
          type: "engine_disconnected",
          engineId,
          detail: {
            provider: PROVIDER,
            providerEventType: "transport.disconnected",
            reason,
          },
        },
      ];
    },
  };
}
