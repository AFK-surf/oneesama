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

export type GeminiLiveRawEvent = Record<string, unknown>;

export interface GeminiLiveEventMapContext {
  engineId?: string;
  sessionId: string;
  now?: () => string;
}

export interface GeminiLiveTransportResult {
  ok?: boolean;
  error?: string;
  reason?: string;
  events?: GeminiLiveRawEvent[];
  [key: string]: unknown;
}

export interface GeminiLiveTransport {
  id?: string;
  connect?(
    sessionId: string,
  ):
    | Promise<GeminiLiveTransportResult | GeminiLiveRawEvent[] | void>
    | GeminiLiveTransportResult
    | GeminiLiveRawEvent[]
    | void;
  sendAudioChunk?(
    chunk: LanOperatorVoiceChunk,
  ):
    | Promise<GeminiLiveTransportResult | GeminiLiveRawEvent[] | void>
    | GeminiLiveTransportResult
    | GeminiLiveRawEvent[]
    | void;
  sendTextInput?(
    input: LanOperatorTextInput,
  ):
    | Promise<GeminiLiveTransportResult | GeminiLiveRawEvent[] | void>
    | GeminiLiveTransportResult
    | GeminiLiveRawEvent[]
    | void;
  sendToolResult?(
    input: LanOperatorToolResultInput,
  ):
    | Promise<GeminiLiveTransportResult | GeminiLiveRawEvent[] | void>
    | GeminiLiveTransportResult
    | GeminiLiveRawEvent[]
    | void;
  sendControlEvent?(
    event: GeminiLiveRawEvent,
    command: ConversationEngineControlCommand,
  ):
    | Promise<GeminiLiveTransportResult | GeminiLiveRawEvent[] | void>
    | GeminiLiveTransportResult
    | GeminiLiveRawEvent[]
    | void;
  disconnect?(
    reason?: string,
  ):
    | Promise<GeminiLiveTransportResult | GeminiLiveRawEvent[] | void>
    | GeminiLiveTransportResult
    | GeminiLiveRawEvent[]
    | void;
}

export interface GeminiLiveConversationEngineOptions {
  engineId?: string;
  transport: GeminiLiveTransport;
}

export interface GeminiLiveWebSocketLike {
  readyState?: number | string;
  send?(payload: string): void;
  close?(code?: number, reason?: string): void;
  on?(event: string, handler: (...args: unknown[]) => void): GeminiLiveWebSocketLike;
  once?(event: string, handler: (...args: unknown[]) => void): GeminiLiveWebSocketLike;
  addEventListener?(event: string, handler: (...args: unknown[]) => void, options?: unknown): void;
}

export interface GeminiLiveWebSocketInit {
  headers?: Record<string, string>;
  agent?: unknown;
}

export type GeminiLiveWebSocketFactory = (
  url: string,
  init: GeminiLiveWebSocketInit,
) => GeminiLiveWebSocketLike | Promise<GeminiLiveWebSocketLike>;

export interface GeminiLiveWebSocketTransportOptions {
  apiKey?: string;
  model?: string;
  url?: string;
  headers?: Record<string, string>;
  instructions?: string;
  generationConfig?: Record<string, unknown>;
  setup?: Record<string, unknown>;
  tools?: unknown[];
  connectTimeoutMs?: number;
  drainMs?: number;
  proxyUrl?: string | false;
  webSocketFactory?: GeminiLiveWebSocketFactory;
}

interface MapperState {
  audioStartedResponseIds: Set<string>;
}

const DEFAULT_ENGINE_ID = "gemini_live";
const PROVIDER = "gemini_live";
const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_GEMINI_LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_MS = 25;
const OPEN_READY_STATE = 1;
const CLOSED_READY_STATE = 3;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function sanitizeProviderText(value: unknown) {
  return String(value || "")
    .replace(/([?&]key=)[^&\s]+/giu, "$1[redacted_gemini_api_key]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, "[redacted_gemini_api_key]")
    .replace(/\bsk-[A-Za-z0-9_.*-]+/gu, "[redacted_openai_api_key]");
}

function fieldObject(
  raw: Record<string, unknown>,
  camel: string,
  snake: string,
): Record<string, unknown> {
  return objectValue(raw[camel] ?? raw[snake]);
}

function fieldArray(raw: Record<string, unknown>, camel: string, snake: string) {
  return arrayValue(raw[camel] ?? raw[snake]).map(objectValue);
}

function geminiEventType(raw: GeminiLiveRawEvent) {
  const explicit = stringValue(raw.type).trim();
  if (explicit) return explicit;
  if ("setupComplete" in raw || "setup_complete" in raw) return "setupComplete";
  if ("serverContent" in raw || "server_content" in raw) return "serverContent";
  if ("toolCall" in raw || "tool_call" in raw) return "toolCall";
  if ("toolCallCancellation" in raw || "tool_call_cancellation" in raw) {
    return "toolCallCancellation";
  }
  if ("goAway" in raw || "go_away" in raw) return "goAway";
  if ("sessionResumptionUpdate" in raw || "session_resumption_update" in raw) {
    return "sessionResumptionUpdate";
  }
  if ("error" in raw) return "error";
  return "";
}

function responseIdFromServerContent(serverContent: Record<string, unknown>) {
  return (
    stringValue(serverContent.responseId) ||
    stringValue(serverContent.response_id) ||
    stringValue(serverContent.generationId) ||
    stringValue(serverContent.generation_id) ||
    "gemini_live_response"
  );
}

function turnIdFromServerContent(serverContent: Record<string, unknown>) {
  return stringValue(serverContent.turnId) || stringValue(serverContent.turn_id) || undefined;
}

function errorFrom(raw: GeminiLiveRawEvent) {
  const error = objectValue(raw.error);
  return sanitizeProviderText(
    stringValue(raw.error) ||
      stringValue(error.message) ||
      stringValue(error.code) ||
      stringValue(raw.reason) ||
      stringValue(raw.status),
  );
}

function providerDetail(raw: GeminiLiveRawEvent, extra: Record<string, unknown> = {}) {
  const detail: Record<string, unknown> = {
    provider: PROVIDER,
    providerEventType: geminiEventType(raw),
    ...extra,
  };
  const error = errorFrom(raw);
  const reason = sanitizeProviderText(stringValue(raw.reason));
  const status = stringValue(raw.status);
  if (error) detail.error = error;
  if (reason) detail.reason = reason;
  if (status) detail.status = status;
  return detail;
}

function canonicalId(raw: GeminiLiveRawEvent, type: CanonicalConversationEventType) {
  const providerEventId =
    stringValue(raw.eventId) || stringValue(raw.event_id) || stringValue(raw.id);
  if (providerEventId) return `${PROVIDER}_${type}_${providerEventId}`;
  return `${PROVIDER}_${type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function canonicalEvent(
  raw: GeminiLiveRawEvent,
  context: Required<GeminiLiveEventMapContext>,
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
    responseId: input.responseId,
    itemId: input.itemId,
    text: input.text,
    audioBase64: input.audioBase64,
    error: input.error,
    detail: input.detail,
  };
}

function normalizeContext(context: GeminiLiveEventMapContext): Required<GeminiLiveEventMapContext> {
  return {
    engineId: context.engineId || DEFAULT_ENGINE_ID,
    sessionId: context.sessionId,
    now: context.now || (() => new Date().toISOString()),
  };
}

function transcriptionText(value: Record<string, unknown>) {
  return stringValue(value.text) || stringValue(value.transcript);
}

function inlineDataFromPart(part: Record<string, unknown>) {
  return fieldObject(part, "inlineData", "inline_data");
}

function functionCallFromPart(part: Record<string, unknown>) {
  return fieldObject(part, "functionCall", "function_call");
}

function functionResponseFromPart(part: Record<string, unknown>) {
  return fieldObject(part, "functionResponse", "function_response");
}

function textFromArgs(args: unknown) {
  if (typeof args === "string") return args;
  return JSON.stringify(args || {});
}

function toolEventsFromCall(
  raw: GeminiLiveRawEvent,
  context: Required<GeminiLiveEventMapContext>,
  call: Record<string, unknown>,
) {
  const name = stringValue(call.name);
  const callId =
    stringValue(call.id) || stringValue(call.callId) || stringValue(call.call_id) || name;
  const detail = providerDetail(raw, {
    callId,
    name,
    expectedTool: name,
  });
  return [
    canonicalEvent(raw, context, "tool_call_started", {
      itemId: callId,
      detail,
    }),
    canonicalEvent(raw, context, "tool_call_completed", {
      itemId: callId,
      text: textFromArgs(call.args),
      detail,
    }),
  ];
}

function serverContentParts(serverContent: Record<string, unknown>) {
  const modelTurn = fieldObject(serverContent, "modelTurn", "model_turn");
  const parts = arrayValue(modelTurn.parts).map(objectValue);
  if (parts.length > 0) return parts;
  return arrayValue(serverContent.parts).map(objectValue);
}

function mapServerContent(
  raw: GeminiLiveRawEvent,
  context: Required<GeminiLiveEventMapContext>,
  state: MapperState,
) {
  const serverContent = fieldObject(raw, "serverContent", "server_content");
  const responseId = responseIdFromServerContent(serverContent);
  const turnId = turnIdFromServerContent(serverContent);
  const events: CanonicalConversationEvent[] = [];
  const inputTranscription = fieldObject(
    serverContent,
    "inputTranscription",
    "input_transcription",
  );
  const outputTranscription = fieldObject(
    serverContent,
    "outputTranscription",
    "output_transcription",
  );
  const inputText = transcriptionText(inputTranscription);
  const outputText = transcriptionText(outputTranscription);
  const turnComplete = Boolean(serverContent.turnComplete ?? serverContent.turn_complete);
  if (inputText) {
    events.push(
      canonicalEvent(raw, context, turnComplete ? "transcript_completed" : "transcript_delta", {
        turnId,
        responseId,
        text: inputText,
        detail: providerDetail(raw, { transcription: "input" }),
      }),
    );
  }
  if (outputText) {
    events.push(
      canonicalEvent(raw, context, "assistant_text_delta", {
        turnId,
        responseId,
        text: outputText,
        detail: providerDetail(raw, { transcription: "output" }),
      }),
    );
  }
  for (const part of serverContentParts(serverContent)) {
    const text = stringValue(part.text);
    if (text) {
      events.push(
        canonicalEvent(
          raw,
          context,
          turnComplete ? "assistant_text_completed" : "assistant_text_delta",
          {
            turnId,
            responseId,
            text,
            detail: providerDetail(raw),
          },
        ),
      );
    }
    const inlineData = inlineDataFromPart(part);
    const mimeType = stringValue(inlineData.mimeType) || stringValue(inlineData.mime_type);
    const data = stringValue(inlineData.data);
    if (data && mimeType.startsWith("audio/")) {
      if (!state.audioStartedResponseIds.has(responseId)) {
        state.audioStartedResponseIds.add(responseId);
        events.push(
          canonicalEvent(raw, context, "assistant_audio_started", {
            turnId,
            responseId,
            detail: providerDetail(raw, { mimeType, sampleRate: 24000, channels: 1 }),
          }),
        );
      }
      events.push(
        canonicalEvent(raw, context, "assistant_audio_chunk", {
          turnId,
          responseId,
          audioBase64: data,
          detail: providerDetail(raw, { mimeType, sampleRate: 24000, channels: 1 }),
        }),
      );
    }
    const functionCall = functionCallFromPart(part);
    if (stringValue(functionCall.name))
      events.push(...toolEventsFromCall(raw, context, functionCall));
    const functionResponse = functionResponseFromPart(part);
    if (stringValue(functionResponse.name)) {
      events.push(
        canonicalEvent(raw, context, "tool_result_accepted", {
          itemId: stringValue(functionResponse.id) || undefined,
          detail: providerDetail(raw, {
            callId: stringValue(functionResponse.id),
            name: stringValue(functionResponse.name),
            expectedTool: stringValue(functionResponse.name),
          }),
        }),
      );
    }
  }
  if (turnComplete && state.audioStartedResponseIds.has(responseId)) {
    state.audioStartedResponseIds.delete(responseId);
    events.push(
      canonicalEvent(raw, context, "assistant_audio_stopped", {
        turnId,
        responseId,
        detail: providerDetail(raw),
      }),
    );
  }
  if (serverContent.interrupted) {
    events.push(
      canonicalEvent(raw, context, "interrupted", {
        turnId,
        responseId,
        detail: providerDetail(raw),
      }),
    );
  }
  return events;
}

function mapToolCall(raw: GeminiLiveRawEvent, context: Required<GeminiLiveEventMapContext>) {
  const toolCall = fieldObject(raw, "toolCall", "tool_call");
  return fieldArray(toolCall, "functionCalls", "function_calls").flatMap((call) =>
    toolEventsFromCall(raw, context, call),
  );
}

function mapToolCallCancellation(
  raw: GeminiLiveRawEvent,
  context: Required<GeminiLiveEventMapContext>,
) {
  const toolCallCancellation = fieldObject(raw, "toolCallCancellation", "tool_call_cancellation");
  const ids = arrayValue(toolCallCancellation.ids);
  if (ids.length === 0) {
    return [canonicalEvent(raw, context, "interrupted", { detail: providerDetail(raw) })];
  }
  return ids.map((id) =>
    canonicalEvent(raw, context, "interrupted", {
      itemId: String(id),
      detail: providerDetail(raw, { callId: String(id) }),
    }),
  );
}

export function createGeminiLiveEventMapper(context: GeminiLiveEventMapContext) {
  const normalized = normalizeContext(context);
  const state: MapperState = {
    audioStartedResponseIds: new Set<string>(),
  };
  return (raw: GeminiLiveRawEvent): CanonicalConversationEvent[] =>
    mapGeminiLiveEvent(raw, normalized, state);
}

export function mapGeminiLiveEvent(
  raw: GeminiLiveRawEvent,
  context: GeminiLiveEventMapContext,
  state: MapperState = { audioStartedResponseIds: new Set<string>() },
): CanonicalConversationEvent[] {
  const normalized = normalizeContext(context);
  const type = geminiEventType(raw);
  if (!type) return [];
  if (type === "setupComplete") {
    const setupComplete = fieldObject(raw, "setupComplete", "setup_complete");
    return [
      canonicalEvent(raw, normalized, "engine_connected", {
        detail: providerDetail(raw, {
          providerSessionId:
            stringValue(setupComplete.sessionId) || stringValue(setupComplete.session_id),
        }),
      }),
    ];
  }
  if (type === "serverContent") return mapServerContent(raw, normalized, state);
  if (type === "toolCall") return mapToolCall(raw, normalized);
  if (type === "toolCallCancellation") return mapToolCallCancellation(raw, normalized);
  if (type === "goAway") {
    return [
      canonicalEvent(raw, normalized, "engine_disconnected", {
        detail: providerDetail(raw, fieldObject(raw, "goAway", "go_away")),
      }),
    ];
  }
  if (type === "error") {
    return [
      canonicalEvent(raw, normalized, "engine_error", {
        error: errorFrom(raw) || "gemini_live_provider_error",
        detail: providerDetail(raw),
      }),
    ];
  }
  return [];
}

function eventsFromTransportOutput(
  output: GeminiLiveTransportResult | GeminiLiveRawEvent[] | void,
): GeminiLiveRawEvent[] {
  if (Array.isArray(output)) return output;
  if (output && typeof output === "object" && Array.isArray(output.events)) return output.events;
  return [];
}

function resultFromTransportOutput(
  output: GeminiLiveTransportResult | GeminiLiveRawEvent[] | void,
): LanOperatorVoiceForwardResult {
  if (!output || Array.isArray(output)) return { ok: true, engineId: DEFAULT_ENGINE_ID };
  return {
    ...output,
    ok: output.ok !== false,
    error: output.error ? sanitizeProviderText(output.error) : output.error,
    reason: output.reason ? sanitizeProviderText(output.reason) : output.reason,
  };
}

function defaultGeminiApiKey() {
  return (
    process.env.ONEESAMA_GEMINI_API_KEY ||
    process.env.MAB_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ""
  );
}

function defaultGeminiLiveModel() {
  return (
    process.env.MAB_LAN_GEMINI_LIVE_MODEL ||
    process.env.MAB_GEMINI_LIVE_MODEL ||
    process.env.GEMINI_LIVE_MODEL ||
    DEFAULT_GEMINI_LIVE_MODEL
  );
}

function defaultGeminiLiveUrl() {
  return (
    process.env.MAB_LAN_GEMINI_LIVE_URL ||
    process.env.MAB_GEMINI_LIVE_URL ||
    process.env.GEMINI_LIVE_URL ||
    ""
  );
}

function normalizedGeminiModel(model: string) {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function appendApiKeyToUrl(urlText: string, apiKey: string) {
  const url = new URL(urlText);
  if (!url.searchParams.has("key")) url.searchParams.set("key", apiKey);
  return url.toString();
}

function geminiLiveWebSocketUrl(options: GeminiLiveWebSocketTransportOptions, apiKey: string) {
  const explicit = String(options.url || defaultGeminiLiveUrl()).trim();
  if (explicit) return appendApiKeyToUrl(explicit, apiKey);
  return appendApiKeyToUrl(DEFAULT_GEMINI_LIVE_ENDPOINT, apiKey);
}

function defaultThinkingLevel() {
  return (
    process.env.MAB_LAN_GEMINI_THINKING_LEVEL ||
    process.env.MAB_GEMINI_THINKING_LEVEL ||
    process.env.GEMINI_THINKING_LEVEL ||
    "low"
  );
}

function defaultVoiceName() {
  return (
    process.env.MAB_LAN_GEMINI_VOICE ||
    process.env.MAB_GEMINI_VOICE ||
    process.env.GEMINI_LIVE_VOICE ||
    ""
  );
}

function defaultSetupMessage(options: GeminiLiveWebSocketTransportOptions): GeminiLiveRawEvent {
  const thinkingLevel = defaultThinkingLevel();
  const voiceName = defaultVoiceName();
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["AUDIO"],
    ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
    ...(voiceName ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } } : {}),
    ...options.generationConfig,
  };
  return {
    setup: {
      model: normalizedGeminiModel(options.model || defaultGeminiLiveModel()),
      generationConfig,
      systemInstruction: {
        parts: [
          {
            text:
              options.instructions ||
              "You are Oneesama's realtime Local Operator Surface conversation engine. Respond concisely and use tools when the user asks you to control the focused app/system view.",
          },
        ],
      },
      ...(options.tools ? { tools: options.tools } : {}),
      ...options.setup,
    },
  };
}

function proxyUrlFromEnv() {
  return (
    process.env.MAB_LAN_GEMINI_LIVE_PROXY_URL ||
    process.env.MAB_GEMINI_LIVE_PROXY_URL ||
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.all_proxy ||
    process.env.ALL_PROXY ||
    ""
  );
}

function proxyUrlForTransport(options: GeminiLiveWebSocketTransportOptions) {
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
  return new (class GeminiLiveHttpConnectProxyAgent extends HttpsAgent {
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
            new Error(`gemini_live_proxy_connect_failed_${response.statusCode || "unknown"}`),
            socket,
          );
          return;
        }
        if (head.length > 0) socket.unshift(head);
        const tlsSocket = tlsConnect({ socket, servername: targetHost });
        done(null, tlsSocket);
      });
      request.once("error", (error) => done(error, request as unknown as Duplex));
      request.end();
      return undefined as unknown as Duplex;
    }
  })();
}

function geminiLiveWebSocketInit(
  options: GeminiLiveWebSocketTransportOptions,
): GeminiLiveWebSocketInit {
  const init: GeminiLiveWebSocketInit = { headers: options.headers || {} };
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
): GeminiLiveRawEvent {
  return {
    error: {
      message: sanitizeProviderText(error),
      ...detail,
    },
  };
}

function isOpenSocket(socket: GeminiLiveWebSocketLike | null) {
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
  socket: GeminiLiveWebSocketLike,
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

function sendGeminiJson(socket: GeminiLiveWebSocketLike | null, event: GeminiLiveRawEvent) {
  if (!isOpenSocket(socket) || typeof socket?.send !== "function") return false;
  socket.send(JSON.stringify(event));
  return true;
}

function audioMimeType(chunk: LanOperatorVoiceChunk) {
  const sampleRate = Math.max(1, Number(chunk.sampleRate || 16000));
  return `audio/pcm;rate=${sampleRate}`;
}

function toolResponsePayload(input: LanOperatorToolResultInput) {
  if (input.output && typeof input.output === "object") return input.output;
  return { output: input.output || "", status: input.status };
}

function rawControlEvent(command: ConversationEngineControlCommand): GeminiLiveRawEvent {
  if (command.type === "clear_audio_buffer" || command.type === "cancel_response") {
    return { realtimeInput: { audioStreamEnd: true } };
  }
  return { realtimeInput: { audioStreamEnd: true } };
}

async function defaultWebSocketFactory(
  url: string,
  init: GeminiLiveWebSocketInit,
): Promise<GeminiLiveWebSocketLike> {
  const imported = (await import("ws")) as {
    WebSocket?: new (url: string, init: GeminiLiveWebSocketInit) => GeminiLiveWebSocketLike;
    default?: new (url: string, init: GeminiLiveWebSocketInit) => GeminiLiveWebSocketLike;
  };
  const WebSocketConstructor = imported.WebSocket || imported.default;
  if (!WebSocketConstructor) throw new Error("gemini_live_ws_module_missing_constructor");
  return new WebSocketConstructor(url, init);
}

function waitForSocketOpen(socket: GeminiLiveWebSocketLike, timeoutMs: number) {
  if (isOpenSocket(socket)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("gemini_live_websocket_connect_timeout"));
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
      (error) => finish(error || "gemini_live_websocket_error"),
      true,
    );
    attachSocketListener(
      socket,
      "close",
      () => finish("gemini_live_websocket_closed_before_open"),
      true,
    );
  });
}

function drainQueuedEvents(queue: GeminiLiveRawEvent[], drainMs: number) {
  return new Promise<GeminiLiveRawEvent[]>((resolve) => {
    setTimeout(() => resolve(queue.splice(0, queue.length)), Math.max(0, drainMs));
  });
}

export function createGeminiLiveWebSocketTransport(
  options: GeminiLiveWebSocketTransportOptions = {},
): GeminiLiveTransport {
  const incomingEvents: GeminiLiveRawEvent[] = [];
  const factory = options.webSocketFactory || defaultWebSocketFactory;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  let socket: GeminiLiveWebSocketLike | null = null;
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

  // Single-flight guard: concurrent callers (the engine auto-connects on every
  // in-flight voice chunk, up to the server's forward limit) must share one
  // handshake — otherwise each attempt closes the previous CONNECTING socket
  // and the connection never establishes.
  let connectInFlight: Promise<GeminiLiveTransportResult> | null = null;

  function connect(sessionId: string): Promise<GeminiLiveTransportResult> {
    if (!connectInFlight) {
      connectInFlight = connectNow(sessionId).finally(() => {
        connectInFlight = null;
      });
    }
    return connectInFlight;
  }

  async function connectNow(sessionId: string): Promise<GeminiLiveTransportResult> {
    const apiKey = options.apiKey ?? defaultGeminiApiKey();
    if (!apiKey) {
      return {
        ok: false,
        error: "gemini_live_api_key_missing",
        events: [transportErrorEvent("gemini_live_api_key_missing")],
      };
    }
    if (isOpenSocket(socket) && activeSessionId === sessionId) {
      return { ok: true, events: await drainQueuedEvents(incomingEvents, drainMs) };
    }
    await closeSocket("operator_reconnect");
    incomingEvents.splice(0, incomingEvents.length);
    activeSessionId = sessionId;
    try {
      socket = await factory(
        geminiLiveWebSocketUrl(options, apiKey),
        geminiLiveWebSocketInit(options),
      );
      attachSocketListener(socket, "message", (raw) => {
        try {
          incomingEvents.push(JSON.parse(messageText(raw)) as GeminiLiveRawEvent);
        } catch {
          incomingEvents.push(transportErrorEvent("gemini_live_invalid_json_event"));
        }
      });
      attachSocketListener(socket, "error", (error) => {
        incomingEvents.push(transportErrorEvent(String(error || "gemini_live_websocket_error")));
      });
      attachSocketListener(socket, "close", () => {
        if (socket) incomingEvents.push({ goAway: { reason: "websocket_closed" } });
      });
      await waitForSocketOpen(socket, connectTimeoutMs);
      if (!sendGeminiJson(socket, defaultSetupMessage(options))) {
        throw new Error("gemini_live_websocket_send_setup_failed");
      }
      return { ok: true, events: await drainQueuedEvents(incomingEvents, drainMs) };
    } catch (error) {
      await closeSocket("connect_failed");
      const message = sanitizeProviderText(
        error instanceof Error ? error.message : String(error || "gemini_live_connect_failed"),
      );
      return { ok: false, error: message, events: [transportErrorEvent(message)] };
    }
  }

  return {
    id: "gemini_live_websocket",
    connect,
    async sendAudioChunk(chunk) {
      if (!isOpenSocket(socket)) {
        return {
          ok: false,
          error: "gemini_live_websocket_not_connected",
          events: [transportErrorEvent("gemini_live_websocket_not_connected")],
        };
      }
      const sent = sendGeminiJson(socket, {
        realtimeInput: {
          audio: {
            mimeType: audioMimeType(chunk),
            data: chunk.dataBase64,
          },
        },
      });
      if (!sent) {
        return {
          ok: false,
          error: "gemini_live_websocket_send_audio_failed",
          events: [transportErrorEvent("gemini_live_websocket_send_audio_failed")],
        };
      }
      return { ok: true, accepted: true, events: await drainQueuedEvents(incomingEvents, drainMs) };
    },
    async sendTextInput(input) {
      if (!isOpenSocket(socket)) {
        return {
          ok: false,
          error: "gemini_live_websocket_not_connected",
          events: [transportErrorEvent("gemini_live_websocket_not_connected")],
        };
      }
      const sent = sendGeminiJson(socket, {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: input.text }] }],
          turnComplete: true,
        },
      });
      if (!sent) {
        return {
          ok: false,
          error: "gemini_live_websocket_send_text_failed",
          events: [transportErrorEvent("gemini_live_websocket_send_text_failed")],
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
          error: "gemini_live_websocket_not_connected",
          events: [transportErrorEvent("gemini_live_websocket_not_connected")],
        };
      }
      const name = input.toolName || "kwwk_computer_use";
      const sent = sendGeminiJson(socket, {
        toolResponse: {
          functionResponses: [
            {
              id: input.callId,
              name,
              response: toolResponsePayload(input),
            },
          ],
        },
      });
      if (!sent) {
        return {
          ok: false,
          error: "gemini_live_websocket_send_tool_result_failed",
          events: [transportErrorEvent("gemini_live_websocket_send_tool_result_failed")],
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
          error: "gemini_live_websocket_not_connected",
          events: [transportErrorEvent("gemini_live_websocket_not_connected")],
        };
      }
      const sent = sendGeminiJson(socket, event);
      if (!sent) {
        return {
          ok: false,
          error: "gemini_live_websocket_send_control_failed",
          events: [transportErrorEvent("gemini_live_websocket_send_control_failed")],
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

function engineErrorEvent(
  engineId: string,
  sessionId: string,
  error: string,
  detail: Record<string, unknown> = {},
): CanonicalConversationEvent {
  return {
    id: `${PROVIDER}_engine_error_${Date.now().toString(36)}`,
    ts: new Date().toISOString(),
    sessionId,
    type: "engine_error",
    engineId,
    error: sanitizeProviderText(error),
    detail: { provider: PROVIDER, providerEventType: "transport.error", ...detail },
  };
}

export function createGeminiLiveConversationEngine(
  options: GeminiLiveConversationEngineOptions,
): ConversationEnginePort {
  const engineId = options.engineId || DEFAULT_ENGINE_ID;
  const transport = options.transport;
  const state = {
    connected: false,
    sessionId: "",
    mapper: null as ReturnType<typeof createGeminiLiveEventMapper> | null,
  };

  function mapperFor(sessionId: string) {
    if (!state.mapper || state.sessionId !== sessionId) {
      state.mapper = createGeminiLiveEventMapper({ engineId, sessionId });
      state.sessionId = sessionId;
    }
    return state.mapper;
  }

  function mapRawEvents(sessionId: string, rawEvents: GeminiLiveRawEvent[]) {
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
      if (!providerErrored) {
        events.push(
          engineErrorEvent(
            engineId,
            sessionId,
            result.error || result.reason || "gemini_live_transport_connect_failed",
            { providerEventType: "transport.connect.error", transportId: transport.id || "" },
          ),
        );
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

  async function disconnect(reason = "operator_surface_closed") {
    const output = await transport.disconnect?.(reason);
    const sessionId = state.sessionId || "";
    state.connected = false;
    return [
      ...mapRawEvents(sessionId, eventsFromTransportOutput(output)),
      {
        id: `${PROVIDER}_engine_disconnected_${Date.now().toString(36)}`,
        ts: new Date().toISOString(),
        sessionId,
        type: "engine_disconnected" as const,
        engineId,
        detail: {
          provider: PROVIDER,
          providerEventType: "transport.disconnected",
          reason,
        },
      },
    ];
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
            ...(state.connected ? {} : { error: "gemini_live_transport_connect_failed" }),
          },
          events,
        };
      }
      if (command.type === "disconnect") {
        return {
          result: { ok: true, engineId, control: command.type },
          events: await disconnect(command.reason || "operator_disconnect"),
        };
      }
      if (command.type === "reconnect") {
        const disconnected = await disconnect(command.reason || "operator_reconnect");
        const connected = await connect(command.sessionId);
        return {
          result: {
            ok: state.connected,
            engineId,
            control: command.type,
            ...(state.connected ? {} : { error: "gemini_live_transport_connect_failed" }),
          },
          events: [...disconnected, ...connected],
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
        const error = "gemini_live_transport_missing_send_control_event";
        return {
          result: { ok: false, engineId, control: command.type, error },
          events: [engineErrorEvent(engineId, command.sessionId, error)],
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
            "gemini_live_transport_connect_failed";
          return { result: { ok: false, error, engineId }, events };
        }
      }
      if (typeof transport.sendAudioChunk !== "function") {
        const error = "gemini_live_transport_missing_send_audio_chunk";
        events.push(
          engineErrorEvent(engineId, chunk.sessionId, error, { sequence: chunk.sequence }),
        );
        return { result: { ok: false, error, engineId }, events };
      }
      const output = await transport.sendAudioChunk(chunk);
      events.push(...mapRawEvents(chunk.sessionId, eventsFromTransportOutput(output)));
      const result = resultFromTransportOutput(output);
      result.engineId = engineId;
      if (result.ok === false && !events.some((event) => event.type === "engine_error")) {
        events.push(
          engineErrorEvent(
            engineId,
            chunk.sessionId,
            result.error || "gemini_live_transport_failed",
            {
              sequence: chunk.sequence,
            },
          ),
        );
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
            "gemini_live_transport_connect_failed";
          return { result: { ok: false, error, engineId }, events };
        }
      }
      if (typeof transport.sendTextInput !== "function") {
        const error = "gemini_live_transport_missing_send_text_input";
        events.push(engineErrorEvent(engineId, input.sessionId, error, { inputMode: "text" }));
        return { result: { ok: false, error, engineId }, events };
      }
      const output = await transport.sendTextInput(input);
      events.push(...mapRawEvents(input.sessionId, eventsFromTransportOutput(output)));
      const result = resultFromTransportOutput(output);
      result.engineId = engineId;
      if (result.ok === false && !events.some((event) => event.type === "engine_error")) {
        events.push(
          engineErrorEvent(
            engineId,
            input.sessionId,
            result.error || "gemini_live_transport_failed",
            {
              inputMode: "text",
            },
          ),
        );
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
            "gemini_live_transport_connect_failed";
          return { result: { ok: false, error, engineId }, events };
        }
      }
      if (typeof transport.sendToolResult !== "function") {
        const error = "gemini_live_transport_missing_send_tool_result";
        events.push(
          engineErrorEvent(engineId, input.sessionId, error, { inputMode: "tool_result" }),
        );
        return { result: { ok: false, error, engineId }, events };
      }
      const output = await transport.sendToolResult(input);
      events.push(...mapRawEvents(input.sessionId, eventsFromTransportOutput(output)));
      const result = resultFromTransportOutput(output);
      result.engineId = engineId;
      if (result.ok === false && !events.some((event) => event.type === "engine_error")) {
        events.push(
          engineErrorEvent(
            engineId,
            input.sessionId,
            result.error || "gemini_live_transport_failed",
            {
              inputMode: "tool_result",
            },
          ),
        );
      }
      return { result, events };
    },
    disconnect,
  };
}
