/* eslint-disable max-lines */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { extname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntimeEvent,
  normalizeConversationTransport,
  validateRuntimeSessionConfig,
  type AvatarRuntimeSessionConfig,
  type ConversationTransport,
  type RuntimeEvent,
  type RuntimeHealth,
} from "../avatar-runtime/contracts.ts";
import {
  acceptWebSocketKey,
  parseWebSocketFrames,
  sendWebSocketClose,
  sendWebSocketText,
} from "./lan-operator-websocket.ts";
import { createLanPeerEvidenceTracker } from "./lan-operator-lan-peer.ts";
import { defaultDebugState, type DebugState } from "./lan-operator-debug-state.ts";
import { buildLanOperatorRuntimeSessionConfig } from "./lan-operator-runtime-config.ts";
import { buildLanOperatorSurfaceHtml } from "./lan-operator-surface-html.ts";
import { buildOperatorWebBundle, buildOperatorWebShellHtml } from "./lan-operator-web-build.ts";
import {
  buildLanOperatorDebugReport,
  cloneDebugState,
  runtimeStatusBody,
} from "./lan-operator-runtime-status.ts";
import {
  recordDebugBundleManifest,
  recordLargeArtifactLink,
  recordReportArtifactAction,
} from "./lan-operator-report-debug.ts";
import {
  recordEngineControlFailed,
  recordEngineControlFinished,
  recordEngineControlStarted,
} from "./lan-operator-engine-control-debug.ts";
import { createConversationEventDrainPump } from "./lan-operator-conversation-event-pump.ts";
import { kwwkRuntimeDetail, mergeKwwkJobState } from "./lan-operator-kwwk-debug.ts";
import {
  appendTimelineRow,
  recordCanonicalTimelineRow,
  recordVoiceChunkTimelineRow,
} from "./lan-operator-timeline-debug.ts";
import {
  recordToolRoutingCanonicalEvent,
  toolRoutingRuntimeDetail,
} from "./lan-operator-tool-routing-debug.ts";
import { buildLanOperatorHostVisualPublisherHtml } from "./lan-operator-host-visual-publisher.ts";
import { buildLanOperatorReachability } from "./lan-operator-reachability.ts";
import { buildLanOperatorSurfaceContext } from "./lan-operator-surface-context.ts";
import {
  assistantOutputRuntimeDetail,
  assistantOutputStateSignature,
  mergeAssistantOutputState,
} from "./lan-operator-output-debug.ts";
import {
  hostVisualRuntimeDetail,
  hostVisualStateSignature,
  mergeHostVisualState,
} from "./lan-operator-visual-debug.ts";
import {
  mergeOperatorVoiceAckTelemetry,
  mergeOperatorVoiceStreamOpened,
  rejectStaleVoiceChunk,
  mergeOperatorVoiceTelemetry,
} from "./lan-operator-voice-debug.ts";
import {
  createDiagnosticConversationEngine,
  type CanonicalConversationEvent,
  type ConversationEngineControlCommand,
  type ConversationEngineControlType,
  type ConversationEnginePort,
  type LanOperatorTextInput,
  type LanOperatorToolResultInput,
} from "./lan-operator-conversation-engine.ts";
import type { LanOperatorConversationTransportSelection } from "./lan-operator-conversation-transport.ts";
import {
  createOpenAIRealtimeConversationEngine,
  createOpenAIRealtimeWebSocketTransport,
} from "./lan-operator-openai-realtime-adapter.ts";
import {
  createGeminiLiveConversationEngine,
  createGeminiLiveWebSocketTransport,
} from "./lan-operator-gemini-live-adapter.ts";
import { buildLanOperatorLiveProviderConfig } from "./lan-operator-live-provider-config.ts";
import type { LanOperatorVoiceChunk, LanOperatorVoiceForwardResult } from "./lan-operator-voice.ts";
import {
  createLanOperatorWorkRuntime,
  type LanOperatorWorkRuntime,
} from "./lan-operator-work-runtime.ts";

export {
  buildLanOperatorRuntimeSessionConfig,
  parseLanOperatorWebrtcIceServers,
} from "./lan-operator-runtime-config.ts";

const DEFAULT_AVATAR_ASSET_ROOT = fileURLToPath(new URL("../../assets/avatar/", import.meta.url));

export interface LanOperatorSurfaceOptions {
  host?: string;
  port?: number;
  sessionId?: string;
  botName?: string;
  conversationTransport?: ConversationTransport;
  conversationTransportSelection?: LanOperatorConversationTransportSelection;
  trustedLanOperatorMode?: boolean;
  lanModeExplicitlyEnabled?: boolean;
  accessToken?: string;
  maxVoiceForwardInFlight?: number;
  conversationEventDrainIntervalMs?: number;
  conversationEngine?: ConversationEnginePort;
  createConversationEngine?: (transport: ConversationTransport) => ConversationEnginePort;
  webrtcIceServers?: Array<Record<string, unknown>>;
  handleVoiceChunk?: (
    chunk: LanOperatorVoiceChunk,
  ) => Promise<LanOperatorVoiceForwardResult | void> | LanOperatorVoiceForwardResult | void;
}

export interface LanOperatorSurfaceListenResult {
  host: string;
  bindHost: string;
  port: number;
  url: string;
}

export interface LanOperatorSurfaceServer {
  config: Readonly<AvatarRuntimeSessionConfig>;
  events: RuntimeEvent[];
  server: Server;
  listen(): Promise<LanOperatorSurfaceListenResult>;
  close(): Promise<void>;
  status(health?: RuntimeHealth): Record<string, unknown>;
  /**
   * Entry point for a real KWWK cursor event (the seam upstream "A" will call,
   * and tests simulate). Records the cursor as real evidence and broadcasts it
   * to connected operator browsers so the stage renders the Cueboard cursor from
   * the real inbound channel — not the demo fixture/button.
   */
  emitKwwkCursor(cursor: Record<string, unknown>): Record<string, unknown>;
}

type WebSocketKind = "events" | "voice" | "visual_operator" | "visual_host";

type WebSocketClient = { id: string; kind: WebSocketKind; socket: Socket };

type TransportKey = keyof DebugState["transport"];

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 18913;
const DEFAULT_MAX_VOICE_FORWARD_IN_FLIGHT = 32;
const DEFAULT_CONVERSATION_EVENT_DRAIN_INTERVAL_MS = 100;

function transportKeyForKind(kind: WebSocketKind | string): TransportKey | null {
  if (kind === "events") return "events";
  if (kind === "voice") return "voice";
  if (kind === "visual_operator") return "visual";
  if (kind === "visual_host") return "hostVisual";
  if (kind === "visual") return "visual";
  if (kind === "hostVisual") return "hostVisual";
  return null;
}

function payloadFromMessage(message: unknown): Record<string, unknown> {
  if (typeof message === "string") return JSON.parse(message) as Record<string, unknown>;
  if (message && typeof message === "object") return message as Record<string, unknown>;
  return {};
}

function createDefaultConversationEngine(transport: ConversationTransport) {
  if (transport === "openai_realtime") {
    return createOpenAIRealtimeConversationEngine({
      transport: createOpenAIRealtimeWebSocketTransport(),
    });
  }
  if (transport === "gemini_live") {
    return createGeminiLiveConversationEngine({
      transport: createGeminiLiveWebSocketTransport(),
    });
  }
  return createDiagnosticConversationEngine();
}

function isRuntimeSwitchLiveTransport(
  transport: ConversationTransport,
): transport is "openai_realtime" | "gemini_live" {
  return transport === "openai_realtime" || transport === "gemini_live";
}

function shouldDrainConversationEvents(transport: ConversationTransport) {
  return transport === "openai_realtime" || transport === "gemini_live";
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readJsonRequestBody(req: IncomingMessage, maxBytes = 64_000) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function htmlResponse(res: ServerResponse, html: string) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function avatarAssetRoots() {
  return [
    process.env.ONEESAMA_AVATAR_ASSET_ROOT,
    process.env.MAB_AVATAR_ASSET_ROOT,
    DEFAULT_AVATAR_ASSET_ROOT,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => resolvePath(value));
}

function avatarAssetContentType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    default:
      return "video/mp4";
  }
}

async function avatarAssetResponse(res: ServerResponse, pathname: string) {
  const relativePath = decodeURIComponent(pathname.replace(/^\/assets\/avatar\/+/, ""));
  for (const root of avatarAssetRoots()) {
    const filePath = resolvePath(root, relativePath);
    const rel = relative(root, filePath);
    if (!rel || rel.startsWith("..") || rel.includes("..")) continue;
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;
    res.writeHead(200, {
      "content-type": avatarAssetContentType(filePath),
      "content-length": String(info.size),
      "cache-control": "public, max-age=60",
      "accept-ranges": "bytes",
    });
    createReadStream(filePath).pipe(res);
    return;
  }
  return jsonResponse(res, 404, { ok: false, error: "avatar_asset_not_found" });
}

export function createLanOperatorSurfaceServer(
  options: LanOperatorSurfaceOptions = {},
): LanOperatorSurfaceServer {
  const rawConfig = buildLanOperatorRuntimeSessionConfig(options);
  const validation = validateRuntimeSessionConfig(rawConfig);
  if (!validation.ok || !validation.config) {
    throw new Error(`lan_operator runtime config invalid: ${validation.errors.join("; ")}`);
  }
  let config = validation.config;
  const events = [...validation.events];
  const debug = defaultDebugState();
  const trustedLanOperatorMode = options.trustedLanOperatorMode ?? true;
  const lanModeExplicitlyEnabled = options.lanModeExplicitlyEnabled ?? trustedLanOperatorMode;
  // When set, every WS upgrade and HTTP route (except static avatar assets)
  // requires this token (?token= query or Authorization: Bearer). The server
  // binds beyond localhost, so this is what stands between the LAN and the
  // engine controls once the surface drives a real meeting.
  const accessToken = String(
    options.accessToken ?? process.env.MAB_LAN_OPERATOR_TOKEN ?? "",
  ).trim();
  let liveProviderConfig = buildLanOperatorLiveProviderConfig({
    selectedTransport: config.conversationTransport,
    conversationTransportSelection: options.conversationTransportSelection || null,
  });
  Object.assign(debug.surfaceContext, {
    trustedLanOperatorMode,
    lanModeExplicitlyEnabled,
    conversationTransportSelection: options.conversationTransportSelection || null,
    liveProviderConfig,
    lanReachability: buildLanOperatorReachability({
      bindHost: options.host || DEFAULT_HOST,
      port: Number(options.port ?? DEFAULT_PORT),
      trustedLanOperatorMode,
      lanModeExplicitlyEnabled,
    }),
  });
  const html = buildLanOperatorSurfaceHtml(config, { liveProviderConfig });
  const clients = new Set<WebSocketClient>();
  const maxVoiceForwardInFlight = Math.max(
    1,
    Number(options.maxVoiceForwardInFlight || DEFAULT_MAX_VOICE_FORWARD_IN_FLIGHT),
  );
  const conversationEventDrainIntervalMs = Math.max(
    0,
    Number(
      options.conversationEventDrainIntervalMs ?? DEFAULT_CONVERSATION_EVENT_DRAIN_INTERVAL_MS,
    ),
  );
  const conversationEngineFactory =
    options.createConversationEngine || createDefaultConversationEngine;
  let conversationEngine =
    options.conversationEngine || conversationEngineFactory(config.conversationTransport);
  let providerSwitchInFlight = false;
  debug.conversation.engineId = conversationEngine.id;
  debug.conversation.provider.adapterKind = config.conversationTransport;
  let health: RuntimeHealth = "ready";
  let visualCompositionSignature = "";
  let hostVisualSignature = "";
  let assistantOutputSignature = "";
  const lanPeerTracker = createLanPeerEvidenceTracker();

  function updateSurfaceContext(clientContext: Record<string, unknown> = {}) {
    debug.surfaceContext = buildLanOperatorSurfaceContext(config, debug, clientContext);
    return debug.surfaceContext;
  }
  updateSurfaceContext();

  function recordEvent(
    phase: RuntimeEvent["phase"],
    event: string,
    summary: string,
    detail: Record<string, unknown> = {},
    severity: RuntimeEvent["severity"] = "info",
  ) {
    const runtimeEvent = createRuntimeEvent(config, {
      phase,
      event,
      severity,
      summary,
      detail,
      redaction: "summarized",
    });
    events.push(runtimeEvent);
    for (const client of clients) {
      if (client.kind === "events") {
        sendWebSocketText(client.socket, {
          type: "runtime_event",
          event: runtimeEvent,
          debug: cloneDebugState(debug),
        });
      }
    }
    return runtimeEvent;
  }

  function runtimeSwitchSelection(
    transport: "openai_realtime" | "gemini_live",
    providerKeySource: string,
  ): LanOperatorConversationTransportSelection {
    return {
      schema: "oneesama.lan_operator_conversation_transport_selection.v1",
      transport,
      source: "runtime_provider_switch",
      explicit: true,
      apiKeyConfigured: Boolean(providerKeySource),
      apiKeySource: providerKeySource,
      diagnosticFallback: false,
      fallbackReason: providerKeySource ? "" : `${transport}_api_key_missing`,
    };
  }

  function resetConversationDebugState(
    transport: "openai_realtime" | "gemini_live",
    engine: ConversationEnginePort,
  ) {
    const freshDebug = defaultDebugState();
    debug.output = freshDebug.output;
    debug.toolRouting = freshDebug.toolRouting;
    debug.timeline = freshDebug.timeline;
    debug.conversation = freshDebug.conversation;
    debug.conversation.engineId = engine.id;
    debug.conversation.status = "not_connected";
    debug.conversation.provider.adapterKind = transport;
  }

  function rebuildLiveProviderConfig(
    transport: "openai_realtime" | "gemini_live",
    selection: LanOperatorConversationTransportSelection | null,
  ) {
    liveProviderConfig = buildLanOperatorLiveProviderConfig({
      selectedTransport: transport,
      conversationTransportSelection: selection,
    });
    Object.assign(debug.surfaceContext, {
      conversationTransportSelection: selection,
      liveProviderConfig,
    });
    return liveProviderConfig;
  }

  async function disconnectConversationEngineForProviderSwitch(
    engine: ConversationEnginePort,
    targetTransport: "openai_realtime" | "gemini_live",
  ) {
    if (!engine.disconnect) return;
    try {
      const disconnectEvents = await engine.disconnect(`provider_switch_to_${targetTransport}`);
      recordCanonicalConversationEvents(disconnectEvents || []);
    } catch (error) {
      recordEvent(
        "realtime",
        "conversation_provider_switch_disconnect_failed",
        "Previous conversation engine disconnect failed during provider switch",
        {
          engineId: engine.id,
          targetTransport,
          error: String((error as Error)?.message || error),
        },
        "warn",
      );
    }
  }

  async function switchConversationProvider(payload: Record<string, unknown>) {
    if (providerSwitchInFlight) {
      return {
        status: 409,
        body: { ok: false, error: "conversation_provider_switch_in_flight" },
      };
    }
    let targetTransport: ConversationTransport;
    try {
      targetTransport = normalizeConversationTransport(payload.transport || payload.provider);
    } catch (error) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "conversation_provider_switch_transport_invalid",
          detail: String((error as Error)?.message || error),
        },
      };
    }
    if (!isRuntimeSwitchLiveTransport(targetTransport)) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "conversation_provider_switch_transport_unsupported",
          transport: targetTransport,
        },
      };
    }

    const candidateProviderConfig = buildLanOperatorLiveProviderConfig({
      selectedTransport: targetTransport,
      conversationTransportSelection: null,
    });
    const targetProvider = candidateProviderConfig.providers.find(
      (provider) => provider.transport === targetTransport,
    );
    if (!targetProvider?.keyConfigured) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "conversation_provider_key_missing",
          transport: targetTransport,
          acceptedKeyEnv: targetProvider?.acceptedKeyEnv || [],
        },
      };
    }

    providerSwitchInFlight = true;
    try {
      const previousTransport = config.conversationTransport;
      if (previousTransport !== targetTransport) {
        const nextConfig = buildLanOperatorRuntimeSessionConfig({
          sessionId: config.sessionId,
          botName: config.botName,
          conversationTransport: targetTransport,
          webrtcIceServers: options.webrtcIceServers || [],
        });
        const nextValidation = validateRuntimeSessionConfig(nextConfig);
        if (!nextValidation.ok || !nextValidation.config) {
          return {
            status: 400,
            body: {
              ok: false,
              error: "conversation_provider_switch_config_invalid",
              errors: nextValidation.errors,
            },
          };
        }
        await disconnectConversationEngineForProviderSwitch(conversationEngine, targetTransport);
        config = nextValidation.config;
        events.push(...nextValidation.events);
        conversationEngine = conversationEngineFactory(targetTransport);
        const selection = runtimeSwitchSelection(targetTransport, targetProvider.keySource);
        rebuildLiveProviderConfig(targetTransport, selection);
        resetConversationDebugState(targetTransport, conversationEngine);
        updateSurfaceContext({
          providerSwitch: targetTransport,
          previousTransport,
          source: "runtime_provider_switch",
        });
        recordEvent(
          "realtime",
          "conversation_provider_switched",
          "Conversation provider switched",
          {
            previousTransport,
            conversationTransport: targetTransport,
            engineId: conversationEngine.id,
            keySource: targetProvider.keySource,
          },
        );
      } else {
        const selection = runtimeSwitchSelection(targetTransport, targetProvider.keySource);
        rebuildLiveProviderConfig(targetTransport, selection);
        updateSurfaceContext({
          providerSwitch: targetTransport,
          previousTransport,
          source: "runtime_provider_switch",
        });
      }
      if (payload.connect !== false) {
        await handleEngineControl({
          control: {
            type: "connect",
            reason: "provider_switch",
            detail: {
              from: previousTransport,
              to: targetTransport,
              source: "runtime_provider_switch",
            },
          },
        });
      }
      const body = runtimeStatusBody(config, events, debug, health);
      return {
        status: 200,
        body: {
          ok: true,
          previousTransport,
          conversationTransport: config.conversationTransport,
          engineId: conversationEngine.id,
          liveProviderConfig,
          snapshot: body.snapshot,
          debug: body.debug,
          recentEvents: body.recentEvents,
        },
      };
    } finally {
      providerSwitchInFlight = false;
    }
  }

  function mergeTransportState(
    keyOrKind: TransportKey | WebSocketKind | string,
    patch: Partial<DebugState["transport"][TransportKey]>,
    input: { event?: string; ok?: boolean; blocker?: string | null } = {},
  ) {
    const key = transportKeyForKind(keyOrKind) || (keyOrKind as TransportKey);
    if (!debug.transport[key]) return null;
    const previous = debug.transport[key];
    debug.transport[key] = {
      ...debug.transport[key],
      ...patch,
    };
    const changed =
      previous.state !== debug.transport[key].state ||
      previous.reconnectCount !== debug.transport[key].reconnectCount ||
      Boolean(input.event);
    if (changed) {
      appendTimelineRow(debug, {
        at: new Date().toISOString(),
        layer: "transport",
        event: input.event || `transport_${key}_${debug.transport[key].state}`,
        ok: input.ok ?? debug.transport[key].state !== "failed",
        turnId: debug.timeline.currentTurnId,
        responseId: null,
        blocker: input.blocker || debug.transport[key].lastError || null,
        detail: { channel: key, ...debug.transport[key] },
      });
    }
    return debug.transport[key];
  }

  function stringDetailValue(detail: Record<string, unknown> | undefined, key: string) {
    const value = detail?.[key];
    return value == null ? null : String(value);
  }

  function providerEventDrilldown(
    event: CanonicalConversationEvent,
    provider: string,
    providerEventType: string,
  ) {
    const detail = (event.detail || {}) as Record<string, unknown>;
    const providerEventId = stringDetailValue(detail, "providerEventId");
    const callId = stringDetailValue(detail, "callId");
    const toolName = stringDetailValue(detail, "name") || stringDetailValue(detail, "toolName");
    const status = stringDetailValue(detail, "status");
    const reason = stringDetailValue(detail, "reason");
    const error = stringDetailValue(detail, "error");
    const inputMode = stringDetailValue(detail, "inputMode");
    const itemType = stringDetailValue(detail, "itemType");
    const detailKeys = Object.keys(detail).sort().slice(0, 24);
    const summary = [
      providerEventId ? `event:${providerEventId}` : "",
      callId ? `call:${callId}` : "",
      toolName ? `tool:${toolName}` : "",
      status ? `status:${status}` : "",
      reason ? `reason:${reason}` : "",
      error ? `error:${error}` : "",
      inputMode ? `input:${inputMode}` : "",
      itemType ? `item:${itemType}` : "",
    ]
      .filter(Boolean)
      .join(" / ");
    return {
      ts: event.ts,
      provider,
      providerEventType,
      providerEventId,
      canonicalType: event.type,
      turnId: event.turnId || null,
      responseId: event.responseId || null,
      itemId: event.itemId || null,
      callId,
      toolName,
      status,
      reason,
      error,
      inputMode,
      itemType,
      detailKeys,
      summary,
    };
  }

  function recordCanonicalConversationEvents(canonicalEvents: CanonicalConversationEvent[] = []) {
    for (const event of canonicalEvents) {
      const safeEvent = event.sessionId ? event : { ...event, sessionId: config.sessionId };
      const providerEventType = String(safeEvent.detail?.providerEventType || "");
      if (providerEventType) {
        const provider = String(
          safeEvent.detail?.provider || safeEvent.detail?.source || config.conversationTransport,
        );
        debug.conversation.provider.adapterKind = provider;
        debug.conversation.provider.rawEventDrilldownAvailable = true;
        debug.conversation.provider.latestProviderEventType = providerEventType;
        debug.conversation.provider.providerEventCounts[providerEventType] =
          Number(debug.conversation.provider.providerEventCounts[providerEventType] || 0) + 1;
        debug.conversation.provider.recentEvents = [
          ...debug.conversation.provider.recentEvents,
          providerEventDrilldown(safeEvent, provider, providerEventType),
        ].slice(-40);
      }
      debug.conversation.status =
        safeEvent.type === "engine_error"
          ? "failed"
          : safeEvent.type === "engine_disconnected"
            ? "not_connected"
            : "connected";
      debug.conversation.lastEventAt = safeEvent.ts;
      debug.conversation.eventCounts[safeEvent.type] =
        Number(debug.conversation.eventCounts[safeEvent.type] || 0) + 1;
      if (safeEvent.type === "engine_error") {
        debug.conversation.errors.push({
          ts: safeEvent.ts,
          error: String(safeEvent.error || safeEvent.detail?.error || "engine_error"),
        });
        debug.conversation.errors = debug.conversation.errors.slice(-20);
      }
      debug.conversation.canonicalEvents = [...debug.conversation.canonicalEvents, safeEvent].slice(
        -80,
      );
      recordCanonicalTimelineRow(debug, safeEvent);
      const toolRouting = recordToolRoutingCanonicalEvent(debug, safeEvent);
      for (const client of clients) {
        if (client.kind === "events") {
          sendWebSocketText(client.socket, {
            type: "canonical_conversation_event",
            event: safeEvent,
            debug: cloneDebugState(debug),
          });
        }
      }
      if (toolRouting) {
        recordEvent(
          "tool",
          "tool_routing_state_updated",
          "Tool routing state updated",
          toolRoutingRuntimeDetail(debug),
          toolRouting.argumentSafety.ok || safeEvent.type !== "tool_call_completed"
            ? "info"
            : "warn",
        );
      }
      recordEvent("realtime", `conversation_${safeEvent.type}`, "Canonical conversation event", {
        id: safeEvent.id,
        type: safeEvent.type,
        engineId: safeEvent.engineId,
        turnId: safeEvent.turnId || "",
        responseId: safeEvent.responseId || "",
      });
    }
  }

  function isEngineControlType(value: string): value is ConversationEngineControlType {
    return [
      "connect",
      "disconnect",
      "cancel_response",
      "clear_audio_buffer",
      "drain_events",
      "set_voice_armed",
      "set_voice_muted",
      "reset_session",
      "reconnect",
    ].includes(value);
  }

  async function handleEngineControl(payload: Record<string, unknown>) {
    const engine = conversationEngine;
    const control = (payload.control || payload) as Record<string, unknown>;
    const controlType = String(control.type || "");
    if (!isEngineControlType(controlType)) {
      recordEvent(
        "guard",
        "engine_control_rejected",
        "Engine control rejected",
        { type: controlType },
        "warn",
      );
      return;
    }
    const command: ConversationEngineControlCommand = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId: config.sessionId,
      type: controlType,
      reason: String(control.reason || "operator_debug_panel"),
      responseId: String(control.responseId || ""),
      detail:
        control.detail && typeof control.detail === "object" && !Array.isArray(control.detail)
          ? (control.detail as Record<string, unknown>)
          : {},
    };
    recordEngineControlStarted(debug, command);
    updateSurfaceContext({ control: command.type });
    recordEvent("realtime", "engine_control_started", "Engine control started", { command });
    try {
      const output = engine.control
        ? await engine.control(command)
        : { result: { ok: false, error: "conversation_engine_control_missing" }, events: [] };
      recordCanonicalConversationEvents(output.events || []);
      recordEngineControlFinished(debug, output);
      recordEvent(
        "realtime",
        output.result?.ok === false ? "engine_control_failed" : "engine_control_completed",
        "Engine control completed",
        { command, result: output.result || { ok: true } },
        output.result?.ok === false ? "warn" : "info",
      );
    } catch (error) {
      recordEngineControlFailed(debug, error);
      recordEvent(
        "realtime",
        "engine_control_failed",
        "Engine control failed",
        { command, error: String((error as Error)?.message || error) },
        "warn",
      );
    }
  }

  async function handleTextInput(payload: Record<string, unknown>) {
    const engine = conversationEngine;
    const payloadSessionId = String(payload.sessionId || "");
    if (payloadSessionId && payloadSessionId !== config.sessionId) {
      recordEvent(
        "guard",
        "operator_text_input_rejected",
        "Operator text input rejected",
        {
          reason: "session_id_mismatch",
          sessionId: payloadSessionId,
          expectedSessionId: config.sessionId,
        },
        "warn",
      );
      return;
    }
    const text = String(payload.text || "").trim();
    if (!text) {
      recordEvent(
        "guard",
        "operator_text_input_rejected",
        "Operator text input rejected",
        { reason: "empty_text" },
        "warn",
      );
      return;
    }
    const textInput: LanOperatorTextInput = {
      id: String(payload.inputId || payload.id || randomUUID()),
      ts: new Date().toISOString(),
      sessionId: payloadSessionId || config.sessionId,
      text,
      source: String(payload.source || "operator_text_input"),
      monotonicMs: Number.isFinite(Number(payload.monotonicMs))
        ? Number(payload.monotonicMs)
        : null,
      surfaceContext:
        payload.surfaceContext && typeof payload.surfaceContext === "object"
          ? (payload.surfaceContext as Record<string, unknown>)
          : {},
    };
    textInput.surfaceContext = updateSurfaceContext(textInput.surfaceContext);
    recordEvent("realtime", "operator_text_input_received", "Operator text input received", {
      inputId: textInput.id,
      source: textInput.source,
      textLength: text.length,
      surfaceContext: textInput.surfaceContext || {},
    });
    const output = engine.receiveTextInput
      ? await engine.receiveTextInput(textInput)
      : {
          result: {
            ok: false,
            error: "conversation_engine_text_input_missing",
            engineId: engine.id,
          },
          events: [
            {
              id: `operator_text_engine_error_${Date.now().toString(36)}`,
              ts: new Date().toISOString(),
              sessionId: textInput.sessionId,
              type: "engine_error" as const,
              engineId: engine.id,
              error: "conversation_engine_text_input_missing",
              detail: { inputMode: "text", inputId: textInput.id },
            },
          ],
        };
    recordCanonicalConversationEvents(output.events || []);
    recordEvent(
      "realtime",
      output.result?.ok === false ? "operator_text_input_failed" : "operator_text_input_completed",
      "Operator text input completed",
      { inputId: textInput.id, result: output.result || { ok: true } },
      output.result?.ok === false ? "warn" : "info",
    );
  }

  function objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  async function handleToolResult(payload: Record<string, unknown>) {
    const engine = conversationEngine;
    const callId = String(payload.callId || payload.call_id || debug.toolRouting.callId || "");
    if (!callId) {
      recordEvent(
        "guard",
        "conversation_tool_result_rejected",
        "Conversation tool result rejected",
        { reason: "missing_call_id" },
        "warn",
      );
      return null;
    }
    const output = payload.output ?? payload.result ?? payload.toolResult ?? {};
    const toolResult: LanOperatorToolResultInput = {
      id: String(payload.resultId || payload.id || randomUUID()),
      ts: new Date().toISOString(),
      sessionId: String(payload.sessionId || "") || config.sessionId,
      callId,
      itemId:
        String(payload.itemId || payload.item_id || debug.toolRouting.itemId || "") || undefined,
      turnId: String(payload.turnId || debug.timeline.currentTurnId || "") || undefined,
      responseId:
        String(payload.responseId || debug.output.assistantText.lastResponseId || "") || undefined,
      toolName: String(
        payload.toolName || payload.name || debug.toolRouting.actualTool || "kwwk_computer_use",
      ),
      jobId: String(payload.jobId || payload.job_id || debug.kwwk.currentJobId || ""),
      status: String(payload.status || debug.kwwk.status || "completed"),
      output: typeof output === "string" ? output : objectValue(output),
      source: String(payload.source || "kwwk"),
      surfaceContext: updateSurfaceContext(objectValue(payload.surfaceContext)),
    };
    recordEvent("tool", "conversation_tool_result_received", "Conversation tool result received", {
      callId: toolResult.callId,
      jobId: toolResult.jobId || "",
      status: toolResult.status,
      source: toolResult.source,
    });
    const engineOutput = engine.receiveToolResult
      ? await engine.receiveToolResult(toolResult)
      : {
          result: {
            ok: false,
            error: "conversation_engine_tool_result_missing",
            engineId: engine.id,
          },
          events: [
            {
              id: `operator_tool_result_engine_error_${Date.now().toString(36)}`,
              ts: new Date().toISOString(),
              sessionId: toolResult.sessionId,
              type: "engine_error" as const,
              engineId: engine.id,
              error: "conversation_engine_tool_result_missing",
              detail: { inputMode: "tool_result", callId: toolResult.callId },
            },
          ],
        };
    recordCanonicalConversationEvents(engineOutput.events || []);
    recordEvent(
      "tool",
      engineOutput.result?.ok === false
        ? "conversation_tool_result_failed"
        : "conversation_tool_result_delivered",
      "Conversation tool result delivered",
      {
        callId: toolResult.callId,
        jobId: toolResult.jobId || "",
        result: engineOutput.result || { ok: true },
      },
      engineOutput.result?.ok === false ? "warn" : "info",
    );
    return engineOutput;
  }

  async function handleToolCancel(payload: Record<string, unknown>) {
    const ts = new Date().toISOString();
    const callId = String(payload.callId || payload.call_id || debug.toolRouting.callId || "");
    const jobId = String(payload.jobId || payload.job_id || debug.kwwk.currentJobId || "");
    const reason = String(payload.reason || "operator_cancelled");
    if (!callId) {
      recordEvent(
        "guard",
        "tool_cancel_rejected",
        "Tool cancel rejected",
        { reason: "missing_call_id" },
        "warn",
      );
      return;
    }
    Object.assign(debug.toolRouting.cancel, {
      requestedCount: debug.toolRouting.cancel.requestedCount + 1,
      lastRequestedAt: ts,
      lastCallId: callId,
      lastJobId: jobId || null,
      lastReason: reason,
      lastResult: "requested",
      lastError: null,
    });
    debug.toolRouting.status = "cancelled";
    debug.toolRouting.lastUpdatedAt = ts;
    appendTimelineRow(debug, {
      at: ts,
      layer: "tool_routing",
      event: "tool_cancel_requested",
      ok: false,
      turnId: String(payload.turnId || debug.timeline.currentTurnId || "") || null,
      responseId:
        String(payload.responseId || debug.output.assistantText.lastResponseId || "") || null,
      blocker: reason,
      detail: { callId, jobId, reason },
    });
    mergeKwwkJobState(debug, {
      status: "cancelled",
      blocker: reason,
      jobId,
      action: { kind: "cancel", label: reason, status: "cancelled" },
    });
    recordEvent(
      "tool",
      "tool_cancel_requested",
      "Tool cancel requested",
      { callId, jobId, reason },
      "warn",
    );
    const engineOutput = await handleToolResult({
      ...payload,
      callId,
      jobId,
      status: "cancelled",
      source: "operator_debug_panel",
      output: { ok: false, cancelled: true, blocker: reason, reason },
    });
    const ok = engineOutput?.result?.ok !== false;
    Object.assign(debug.toolRouting.cancel, {
      lastResult: ok ? "delivered" : "failed",
      lastError: ok
        ? null
        : String(
            engineOutput?.result?.error ||
              engineOutput?.result?.reason ||
              "tool_cancel_delivery_failed",
          ),
    });
    recordEvent(
      "tool",
      ok ? "tool_cancel_delivered" : "tool_cancel_failed",
      "Tool cancel delivered",
      { callId, jobId, result: debug.toolRouting.cancel.lastResult },
      ok ? "info" : "warn",
    );
  }

  async function handleOperatorEvent(message: unknown) {
    const payload = payloadFromMessage(message);
    const type = String(payload.type || "");
    if (type === "operator_connection_state") {
      const label = String(payload.label || "");
      const connection = (payload.connection || {}) as Record<string, unknown>;
      mergeTransportState(label, {
        state: String(connection.state || "closed") as never,
        connectCount: Number(connection.connectCount) || 0,
        reconnectCount: Number(connection.reconnectCount) || 0,
        lastConnectedAt: String(connection.lastConnectedAt || "") || null,
        lastDisconnectedAt: String(connection.lastDisconnectedAt || "") || null,
        lastPacketAt: String(connection.lastPacketAt || "") || null,
        lastError: String(connection.lastError || "") || null,
        rttMs: connection.rttMs == null ? null : Number(connection.rttMs) || 0,
        nextReconnectAt: String(connection.nextReconnectAt || "") || null,
      });
      recordEvent(
        "media",
        "operator_connection_state_updated",
        "Operator connection state updated",
        {
          label,
          connection: debug.transport[transportKeyForKind(label) || (label as TransportKey)],
        },
      );
      return;
    }
    if (type === "engine_control") {
      await handleEngineControl(payload as Record<string, unknown>);
      return;
    }
    if (type === "operator_text_input") {
      await handleTextInput(payload as Record<string, unknown>);
      return;
    }
    if (type === "tool_cancel") {
      await handleToolCancel(payload as Record<string, unknown>);
      return;
    }
    if (type === "work_run") {
      await handleWorkRun(payload as Record<string, unknown>);
      return;
    }
    if (type === "conversation_tool_result" || type === "tool_result") {
      await handleToolResult(payload as Record<string, unknown>);
      return;
    }
    if (
      type === "operator_mic_armed" ||
      type === "operator_mic_disarmed" ||
      type === "operator_mic_muted" ||
      type === "operator_mic_blocked" ||
      type === "operator_voice_devices_refreshed" ||
      type === "operator_local_vad_configured"
    ) {
      mergeOperatorVoiceTelemetry(debug, payload as Record<string, unknown>);
      recordEvent("media", type, "Operator voice telemetry updated", {
        armed: debug.voice.armed,
        muted: debug.voice.muted,
        captureStatus: debug.voice.captureStatus,
        captureError: debug.voice.captureError,
        availableDeviceCount: debug.voice.availableDeviceCount,
        localVad: debug.voice.localVad,
        surfaceContext: updateSurfaceContext({ voiceEvent: type }),
      });
      return;
    }
    if (type === "operator_voice_chunk_ack_observed") {
      mergeOperatorVoiceAckTelemetry(debug, payload as Record<string, unknown>);
      recordEvent("media", type, "Operator voice chunk ack observed", {
        ackCount: debug.voice.ackCount,
        sequence: debug.voice.lastAckSequence,
        ackRttMs: debug.voice.lastAckRttMs,
        maxAckRttMs: debug.voice.maxAckRttMs,
        ackClock: debug.voice.ackClock,
      });
      return;
    }
    if (type === "composition_state" && payload.composition) {
      const composition =
        payload.composition && typeof payload.composition === "object"
          ? (payload.composition as Record<string, unknown>)
          : {};
      debug.visual.composition = {
        ...debug.visual.composition,
        ...composition,
        mode: "operator_side",
      };
      const nextSignature = JSON.stringify({
        localComposedTrack: debug.visual.composition.localComposedTrack,
        trackId: debug.visual.composition.trackId,
        trackReadyState: debug.visual.composition.trackReadyState,
        width: debug.visual.composition.width,
        height: debug.visual.composition.height,
        targetFps: debug.visual.composition.targetFps,
        layoutRevision: debug.visual.composition.layoutRevision,
        focusedSourceId: debug.visual.composition.focusedSourceId,
        overlayCount: debug.visual.composition.overlayCount,
      });
      if (nextSignature === visualCompositionSignature) return;
      visualCompositionSignature = nextSignature;
      updateSurfaceContext({ visualEvent: "composition_state" });
      recordEvent("media", "operator_visual_composition_updated", "Operator composition updated", {
        layoutRevision: debug.visual.composition.layoutRevision,
        localComposedTrack: debug.visual.composition.localComposedTrack,
        trackId: debug.visual.composition.trackId,
        trackReadyState: debug.visual.composition.trackReadyState,
        width: debug.visual.composition.width,
        height: debug.visual.composition.height,
        targetFps: debug.visual.composition.targetFps,
        focusedSourceId: debug.visual.composition.focusedSourceId,
      });
      return;
    }
    if (type === "host_visual_stream_state" && payload.visual) {
      mergeHostVisualState(debug, payload.visual as Partial<DebugState["visual"]>);
      const nextSignature = hostVisualStateSignature(debug);
      if (nextSignature === hostVisualSignature) return;
      hostVisualSignature = nextSignature;
      updateSurfaceContext({ visualEvent: "host_visual_stream_state" });
      recordEvent(
        "media",
        "host_visual_stream_state_updated",
        "Host Visual Stream state updated",
        hostVisualRuntimeDetail(debug),
      );
      return;
    }
    if (type === "assistant_output_state" && payload.output) {
      mergeAssistantOutputState(debug, payload.output as Partial<DebugState["output"]>);
      const nextSignature = assistantOutputStateSignature(debug);
      if (nextSignature === assistantOutputSignature) return;
      assistantOutputSignature = nextSignature;
      const audioStatus = debug.output.assistantAudio.status;
      if (audioStatus === "failed" || audioStatus === "blocked") {
        appendTimelineRow(debug, {
          at: new Date().toISOString(),
          layer: "output_audio",
          event: audioStatus === "failed" ? "assistant_audio_failed" : "assistant_audio_blocked",
          ok: false,
          turnId: debug.timeline.currentTurnId,
          responseId:
            debug.timeline.rows.findLast(
              (row) => row.responseId === debug.output.assistantText.lastResponseId,
            )?.turnId === debug.timeline.currentTurnId
              ? debug.output.assistantText.lastResponseId
              : null,
          blocker:
            debug.output.assistantAudio.lastError ||
            (audioStatus === "failed" ? "assistant_audio_failed" : "assistant_audio_blocked"),
          detail: assistantOutputRuntimeDetail(debug),
        });
      }
      recordEvent(
        "media",
        "assistant_output_state_updated",
        "Assistant output state updated",
        assistantOutputRuntimeDetail(debug),
      );
      return;
    }
    if (type === "debug_report_artifact") {
      const action = String(payload.action || "");
      if (action === "copy" || action === "download" || action === "mark") {
        const label = String(payload.label || "");
        const note = String(payload.note || "");
        recordReportArtifactAction(debug, action, { label, note });
        recordEvent("tool", "debug_report_artifact_recorded", "Debug report artifact recorded", {
          action,
          label,
          note,
        });
      }
      if (action === "link") {
        recordLargeArtifactLink(debug, payload as Record<string, unknown>);
        recordEvent(
          "tool",
          "debug_large_artifact_link_recorded",
          "Debug large artifact link recorded",
          {
            label: String(payload.label || ""),
            kind: String(payload.kind || ""),
            href: String(payload.href || ""),
            bytes: Number(payload.bytes) || null,
            policy: "linked_only",
          },
        );
      }
      if (action === "bundle") {
        recordDebugBundleManifest(debug, payload as Record<string, unknown>);
        recordEvent("tool", "debug_report_bundle_recorded", "Debug report bundle recorded", {
          label: String(payload.label || ""),
          bundleId: String(payload.bundleId || ""),
          entryCount: Number(payload.entryCount || 0),
        });
      }
      return;
    }
    if (type === "kwwk_cursor_event") {
      emitKwwkCursor((payload.cursor || payload) as Record<string, unknown>);
      return;
    }
    if (type === "kwwk_job_state") {
      mergeKwwkJobState(debug, (payload.kwwk || payload) as Record<string, unknown>);
      updateSurfaceContext({ kwwkStatus: debug.kwwk.status, kwwkTarget: debug.kwwk.target });
      recordEvent(
        "tool",
        "kwwk_job_state_updated",
        "KWWK job state updated",
        kwwkRuntimeDetail(debug),
        debug.kwwk.status === "blocked" || debug.kwwk.status === "failed" ? "warn" : "info",
      );
      return;
    }
    if (type === "visual_overlay_event" && payload.overlay) {
      debug.visual.composition.overlayCount += 1;
      updateSurfaceContext({ visualEvent: "visual_overlay_event" });
      recordEvent("tool", "operator_visual_overlay_event", "Operator visual overlay received", {
        overlay: payload.overlay,
      });
      return;
    }
    recordEvent("realtime", "operator_surface_event", "Operator surface event received", {
      type,
    });
  }

  function emitKwwkCursor(input: Record<string, unknown> = {}) {
    const clamp01 = (value: unknown) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
    };
    const x = clamp01(input.x);
    const y = clamp01(input.y);
    const holdMs = Number(input.holdMs);
    const cursor: Record<string, unknown> = {
      x: x ?? 0.5,
      y: y ?? 0.5,
      kind: String(input.kind || "move"),
      label: String(input.label || ""),
      sourceId: String(input.sourceId || ""),
      ...(Number.isFinite(holdMs) ? { holdMs } : {}),
    };
    // Real cursor evidence — increments the SLO-relevant count via the operator
    // path (distinct from the demo fixture, which never touches server state).
    debug.kwwk.cursorEventCount += 1;
    const envelope = { sessionId: config.sessionId, type: "kwwk_cursor", cursor };
    for (const client of clients) {
      if (client.kind === "events") sendWebSocketText(client.socket, envelope);
    }
    recordEvent("tool", "kwwk_cursor_event", "KWWK cursor event", { cursor }, "info");
    return cursor;
  }

  // Work pipeline: a typed command runs the full loop in a server-side work
  // browser, streamed back to the operator UI. Lazily created on first use so
  // the Playwright browser never launches unless the surface is asked to work.
  let workRuntime: LanOperatorWorkRuntime | null = null;
  function broadcastToEvents(envelope: Record<string, unknown>) {
    for (const client of clients) {
      if (client.kind === "events") sendWebSocketText(client.socket, envelope);
    }
  }
  function ensureWorkRuntime(): LanOperatorWorkRuntime {
    if (workRuntime) return workRuntime;
    workRuntime = createLanOperatorWorkRuntime({
      axApp: process.env.MAB_LAN_OPERATOR_WORK_AX_APP || undefined,
      onEvent: (event) =>
        broadcastToEvents({ sessionId: config.sessionId, type: "work_event", event }),
      onFrame: (frame) =>
        broadcastToEvents({ sessionId: config.sessionId, type: "work_frame", frame }),
    });
    return workRuntime;
  }
  async function handleWorkRun(payload: Record<string, unknown>) {
    const command = String(payload.command || payload.text || "").trim();
    if (!command) {
      broadcastToEvents({
        sessionId: config.sessionId,
        type: "work_event",
        event: { type: "error", detail: { reason: "work_command_empty" } },
      });
      return;
    }
    recordEvent("tool", "work_run_requested", "Work run requested", { command }, "info");
    const runtime = ensureWorkRuntime();
    const outcome = await runtime.run(command);
    recordEvent("tool", "work_run_finished", "Work run finished", { command, ...outcome }, "info");
  }

  async function forwardVoiceChunk(chunk: LanOperatorVoiceChunk) {
    const engine = conversationEngine;
    if (!options.handleVoiceChunk && !engine) return;
    if (debug.voice.forwardInFlight >= maxVoiceForwardInFlight) {
      debug.voice.forwardBackpressureDrops += 1;
      recordEvent(
        "guard",
        "operator_voice_chunk_forward_dropped",
        "Operator voice chunk dropped by forward backpressure",
        {
          sequence: chunk.sequence,
          inFlight: debug.voice.forwardInFlight,
          maxInFlight: maxVoiceForwardInFlight,
        },
        "warn",
      );
      return;
    }
    debug.voice.forwardInFlight += 1;
    try {
      const engineOutput = await engine.receiveVoiceChunk(chunk);
      recordCanonicalConversationEvents(engineOutput.events || []);
      const legacyResult = options.handleVoiceChunk
        ? await options.handleVoiceChunk(chunk)
        : undefined;
      const result = legacyResult || engineOutput.result || { ok: true };
      if (result?.ok === false) {
        debug.voice.forwardFailures += 1;
        debug.voice.lastForwardError = String(
          result.error || result.reason || "voice_forward_failed",
        );
        appendTimelineRow(debug, {
          at: new Date().toISOString(),
          layer: "audio_input",
          event: "operator_voice_chunk_forward_failed",
          ok: false,
          turnId: debug.timeline.currentTurnId,
          responseId: null,
          blocker: debug.voice.lastForwardError,
          detail: {
            sequence: chunk.sequence,
            source: chunk.source,
            error: debug.voice.lastForwardError,
          },
        });
        recordEvent(
          "realtime",
          "operator_voice_chunk_forward_failed",
          "Operator voice chunk forward failed",
          {
            sequence: chunk.sequence,
            error: debug.voice.lastForwardError,
          },
          "warn",
        );
        return;
      }
      debug.voice.forwardedChunks += 1;
      debug.voice.lastForwardAt = new Date().toISOString();
      debug.voice.lastForwardError = null;
    } catch (error) {
      debug.voice.forwardFailures += 1;
      debug.voice.lastForwardError = String((error as Error)?.message || error);
      appendTimelineRow(debug, {
        at: new Date().toISOString(),
        layer: "audio_input",
        event: "operator_voice_chunk_forward_failed",
        ok: false,
        turnId: debug.timeline.currentTurnId,
        responseId: null,
        blocker: debug.voice.lastForwardError,
        detail: {
          sequence: chunk.sequence,
          source: chunk.source,
          error: debug.voice.lastForwardError,
        },
      });
      recordEvent(
        "realtime",
        "operator_voice_chunk_forward_failed",
        "Operator voice chunk forward failed",
        {
          sequence: chunk.sequence,
          error: debug.voice.lastForwardError,
        },
        "warn",
      );
    } finally {
      debug.voice.forwardInFlight = Math.max(0, debug.voice.forwardInFlight - 1);
    }
  }

  async function handleVoiceMessage(
    message: unknown,
    ack?: (payload: Record<string, unknown>) => void,
  ) {
    const payload = payloadFromMessage(message);
    if (payload.type === "operator_voice_stream_opened") {
      recordEvent(
        "media",
        "operator_voice_stream_opened",
        "Operator voice stream opened",
        mergeOperatorVoiceStreamOpened(debug, payload as Record<string, unknown>),
      );
      return;
    }
    if (payload.type !== "voice_chunk") {
      recordEvent("media", "operator_voice_event", "Operator voice websocket event received", {
        type: payload.type,
      });
      return;
    }
    const payloadSessionId = String(payload.sessionId || "");
    if (payloadSessionId && payloadSessionId !== config.sessionId) {
      recordEvent(
        "guard",
        "operator_voice_chunk_rejected",
        "Operator voice chunk rejected",
        {
          reason: "session_id_mismatch",
          sessionId: payloadSessionId,
          expectedSessionId: config.sessionId,
        },
        "warn",
      );
      return;
    }
    const payloadStreamId = String(payload.voiceStreamId || payload.streamId || "");
    if (
      debug.voice.activeStreamId &&
      payloadStreamId &&
      payloadStreamId !== debug.voice.activeStreamId
    ) {
      recordEvent(
        "guard",
        "operator_voice_chunk_rejected",
        "Operator voice chunk rejected",
        rejectStaleVoiceChunk(debug, payloadStreamId),
        "warn",
      );
      return;
    }
    const sequence = Number(payload.sequence);
    const previousSequence = debug.voice.lastSequence;
    if (previousSequence != null && Number.isFinite(sequence) && sequence > previousSequence + 1) {
      debug.voice.dropsDetected += sequence - previousSequence - 1;
    }
    debug.voice.chunksReceived += 1;
    debug.voice.lastSequence = Number.isFinite(sequence) ? sequence : previousSequence;
    const receivedAt = new Date().toISOString();
    const sentAt = typeof payload.sentAt === "string" ? payload.sentAt : null;
    const sentAtMs = sentAt ? Date.parse(sentAt) : Number.NaN;
    const receivedAtMs = Date.parse(receivedAt);
    const receiveLagMs =
      Number.isFinite(sentAtMs) && Number.isFinite(receivedAtMs)
        ? Math.max(0, receivedAtMs - sentAtMs)
        : null;
    debug.voice.lastChunkAt = receivedAt;
    debug.voice.lastChunkSentAt = sentAt;
    debug.voice.lastChunkReceivedAt = receivedAt;
    debug.voice.lastReceiveLagMs = receiveLagMs;
    if (receiveLagMs != null) {
      debug.voice.maxReceiveLagMs = Math.max(debug.voice.maxReceiveLagMs ?? 0, receiveLagMs);
    }
    debug.voice.sampleRate = Number(payload.sampleRate) || null;
    debug.voice.channels = Number(payload.channels) || null;
    debug.voice.durationMs = Number(payload.durationMs) || null;
    debug.voice.lastEnergy = Number(payload.energy) || 0;
    mergeOperatorVoiceTelemetry(debug, payload as Record<string, unknown>);
    const dataBase64 = String(payload.dataBase64 || "");
    let bytes = 0;
    if (typeof payload.dataBase64 === "string") {
      bytes = Buffer.from(payload.dataBase64, "base64").length;
      debug.voice.bytesReceived += bytes;
    }
    const voiceChunk: LanOperatorVoiceChunk = {
      sessionId: payloadSessionId || config.sessionId,
      sequence: debug.voice.lastSequence,
      voiceStreamId: payloadStreamId || debug.voice.activeStreamId,
      voiceStreamGeneration: Number.isFinite(Number(payload.voiceStreamGeneration))
        ? Number(payload.voiceStreamGeneration)
        : debug.voice.activeStreamGeneration,
      monotonicMs: Number.isFinite(Number(payload.monotonicMs))
        ? Number(payload.monotonicMs)
        : null,
      sentAt,
      receivedAt,
      receiveLagMs,
      sampleRate: debug.voice.sampleRate,
      channels: debug.voice.channels,
      durationMs: debug.voice.durationMs,
      energy: debug.voice.lastEnergy || 0,
      bytes,
      dataBase64,
      source: String(payload.source || "operator_voice_pcm16"),
      surfaceContext: updateSurfaceContext(
        payload.surfaceContext && typeof payload.surfaceContext === "object"
          ? (payload.surfaceContext as Record<string, unknown>)
          : {},
      ),
    };
    recordVoiceChunkTimelineRow(debug, voiceChunk, {
      bytes,
      shouldRecord: debug.voice.chunksReceived === 1 || debug.voice.dropsDetected > 0,
    });
    ack?.({
      type: "operator_voice_chunk_ack",
      sessionId: voiceChunk.sessionId,
      sequence: voiceChunk.sequence,
      source: voiceChunk.source,
      sentAt,
      receivedAt,
      receiveLagMs,
      serverAt: new Date().toISOString(),
    });
    await forwardVoiceChunk(voiceChunk);
    recordEvent("media", "operator_voice_chunk_received", "Operator voice chunk received", {
      sequence: debug.voice.lastSequence,
      voiceStreamId: voiceChunk.voiceStreamId,
      voiceStreamGeneration: voiceChunk.voiceStreamGeneration,
      sampleRate: debug.voice.sampleRate,
      channels: debug.voice.channels,
      durationMs: debug.voice.durationMs,
      energy: debug.voice.lastEnergy,
      sentAt,
      receivedAt,
      receiveLagMs,
      receiveLagClock: debug.voice.receiveLagClock,
      dropsDetected: debug.voice.dropsDetected,
      source: voiceChunk.source,
      bytes,
      forwardedChunks: debug.voice.forwardedChunks,
      forwardFailures: debug.voice.forwardFailures,
      forwardBackpressureDrops: debug.voice.forwardBackpressureDrops,
    });
  }

  function relayVisualSignal(client: WebSocketClient, message: unknown) {
    const payload = payloadFromMessage(message);
    const payloadSessionId = String(payload.sessionId || "");
    if (payloadSessionId && payloadSessionId !== config.sessionId) {
      recordEvent(
        "guard",
        "host_visual_signal_rejected",
        "Host Visual Stream signal rejected",
        {
          reason: "session_id_mismatch",
          sessionId: payloadSessionId,
          expectedSessionId: config.sessionId,
        },
        "warn",
      );
      return;
    }
    const targetKind: WebSocketKind =
      client.kind === "visual_host" ? "visual_operator" : "visual_host";
    const envelope = { sessionId: config.sessionId, ...payload };
    for (const target of clients) {
      if (target.kind === targetKind) sendWebSocketText(target.socket, envelope);
    }
    const source =
      payload.source && typeof payload.source === "object"
        ? (payload.source as Record<string, unknown>)
        : {};
    recordEvent("media", "host_visual_signal_relayed", "Host Visual Stream signal relayed", {
      from: client.kind,
      to: targetKind,
      type: String(payload.type || ""),
      sourceId: String(payload.sourceId || source.id || ""),
    });
  }

  function handleUpgrade(req: IncomingMessage, socket: Socket) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const kind: WebSocketKind | null =
      url.pathname === "/operator/events/ws"
        ? "events"
        : url.pathname === "/operator/voice/ws"
          ? "voice"
          : url.pathname === "/operator/visual/ws"
            ? "visual_operator"
            : url.pathname === "/host/visual/ws"
              ? "visual_host"
              : null;
    const key = req.headers["sec-websocket-key"];
    if (!kind || typeof key !== "string") {
      socket.destroy();
      return;
    }
    if (!requestAuthorized(req, url)) {
      recordEvent(
        "guard",
        "operator_ws_unauthorized",
        "Operator WebSocket upgrade rejected",
        { path: url.pathname, kind },
        "warn",
      );
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptWebSocketKey(key)}`,
        "",
        "",
      ].join("\r\n"),
    );
    const client: WebSocketClient = { id: randomUUID(), kind, socket };
    clients.add(client);
    const connectedPeerEvidence = lanPeerTracker.connected({
      id: client.id,
      kind,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      remoteFamily: socket.remoteFamily,
    });
    debug.surfaceContext.lanPeerEvidence = connectedPeerEvidence;
    mergeTransportState(
      kind,
      {
        state: "open",
        connectCount: debug.transport[transportKeyForKind(kind) || "events"].connectCount + 1,
        lastConnectedAt: new Date().toISOString(),
        lastPacketAt: new Date().toISOString(),
        lastError: null,
        nextReconnectAt: null,
      },
      { event: `operator_${kind}_websocket_connected` },
    );
    if (kind === "voice") debug.voice.websocketConnections += 1;
    if (kind === "visual_host") {
      debug.visual.hostPublisherConnections += 1;
      debug.visual.connectionState = "connecting";
    }
    if (kind === "visual_operator") {
      debug.visual.receiverWebSocketState = "open";
      debug.visual.connectionState = "connecting";
    }
    recordEvent("init", `operator_${kind}_websocket_connected`, "Operator websocket connected", {
      kind,
      clientId: client.id,
      lanPeerEvidence: connectedPeerEvidence,
    });
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      debug.surfaceContext.lanPeerEvidence = lanPeerTracker.packet(client.id);
      buffered = parseWebSocketFrames(socket, Buffer.from(chunk), buffered, (message) => {
        try {
          const payload = typeof message === "string" ? JSON.parse(message) : {};
          mergeTransportState(kind, { lastPacketAt: new Date().toISOString() });
          if (kind === "events" && payload.type === "operator_connection_ping") {
            sendWebSocketText(socket, {
              type: "operator_connection_pong",
              pingId: payload.pingId,
              sentAt: payload.sentAt,
              serverAt: new Date().toISOString(),
            });
            return;
          }
          if (payload.type === "operator_connection_state") {
            void handleOperatorEvent(payload).catch((error) => {
              recordEvent(
                "guard",
                "operator_connection_state_rejected",
                "Operator connection state message rejected",
                { kind, error: String((error as Error)?.message || error) },
                "warn",
              );
            });
            return;
          }
          if (kind === "events") {
            void handleOperatorEvent(payload).catch((error) => {
              recordEvent(
                "guard",
                "operator_event_message_rejected",
                "Operator event websocket message rejected",
                { kind, error: String((error as Error)?.message || error) },
                "warn",
              );
            });
          }
          if (kind === "visual_operator" || kind === "visual_host")
            relayVisualSignal(client, payload);
          if (kind === "voice") {
            void handleVoiceMessage(payload, (ack) => sendWebSocketText(socket, ack)).catch(
              (error) => {
                recordEvent(
                  "guard",
                  "operator_voice_message_rejected",
                  "Operator voice websocket message rejected",
                  { kind, error: String((error as Error)?.message || error) },
                  "warn",
                );
              },
            );
          }
        } catch (error) {
          recordEvent(
            "guard",
            "operator_websocket_message_rejected",
            "Operator websocket message rejected",
            { kind, error: String((error as Error)?.message || error) },
            "warn",
          );
        }
      });
    });
    socket.on("error", (error) => {
      mergeTransportState(
        kind,
        {
          state: "failed",
          lastError: String((error as Error)?.message || error),
        },
        { event: `operator_${kind}_websocket_error`, ok: false },
      );
      recordEvent(
        "guard",
        `operator_${kind}_websocket_error`,
        "Operator websocket error",
        { kind, clientId: client.id, error: String((error as Error)?.message || error) },
        "warn",
      );
    });
    socket.on("close", () => {
      clients.delete(client);
      const closedPeerEvidence = lanPeerTracker.closed(client.id);
      debug.surfaceContext.lanPeerEvidence = closedPeerEvidence;
      if (kind === "voice") {
        debug.voice.websocketConnections = Math.max(0, debug.voice.websocketConnections - 1);
      }
      if (kind === "visual_host") {
        debug.visual.hostPublisherConnections = Math.max(
          0,
          debug.visual.hostPublisherConnections - 1,
        );
      }
      if (kind === "visual_operator") {
        debug.visual.receiverWebSocketState = "closed";
        debug.visual.connectionState = debug.visual.trackCount > 0 ? "degraded" : "not_connected";
      }
      mergeTransportState(
        kind,
        {
          state: "closed",
          lastDisconnectedAt: new Date().toISOString(),
        },
        { event: `operator_${kind}_websocket_closed` },
      );
      recordEvent("shutdown", `operator_${kind}_websocket_closed`, "Operator websocket closed", {
        kind,
        clientId: client.id,
        lanPeerEvidence: closedPeerEvidence,
      });
    });
  }

  function requestAuthorized(req: IncomingMessage, url: URL) {
    if (!accessToken) return true;
    if (url.searchParams.get("token") === accessToken) return true;
    return String(req.headers.authorization || "") === `Bearer ${accessToken}`;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      // Static avatar media is exempt (no control surface, referenced by
      // in-page runtimes); everything else is gated when a token is set.
      if (!url.pathname.startsWith("/assets/avatar/") && !requestAuthorized(req, url)) {
        recordEvent(
          "guard",
          "operator_request_unauthorized",
          "Operator HTTP request rejected",
          { path: url.pathname, method: String(req.method || "") },
          "warn",
        );
        return jsonResponse(res, 401, { ok: false, error: "unauthorized" });
      }
      // The React surface is the canonical operator (/operator). The legacy
      // string surface stays at the root (/) and /operator-legacy as a fallback
      // (it still carries the full debug/telemetry/diagnostics cockpit).
      if (
        req.method === "GET" &&
        (url.pathname === "/" ||
          url.pathname === "/operator-legacy" ||
          url.pathname === "/operator-legacy/")
      )
        return htmlResponse(res, html);
      if (req.method === "GET" && (url.pathname === "/operator" || url.pathname === "/operator/")) {
        const bundleUrl = accessToken
          ? `/operator/app.js?token=${encodeURIComponent(accessToken)}`
          : "/operator/app.js";
        return htmlResponse(
          res,
          buildOperatorWebShellHtml(
            {
              sessionId: config.sessionId,
              token: accessToken || undefined,
              conversationTransport: config.conversationTransport,
              botName: config.botName,
              webrtcIceServers: options.webrtcIceServers || [],
            },
            bundleUrl,
          ),
        );
      }
      // Back-compat: the old gating route for the React surface.
      if (
        req.method === "GET" &&
        (url.pathname === "/operator2" || url.pathname === "/operator2/")
      ) {
        res.writeHead(302, {
          location: accessToken
            ? `/operator?token=${encodeURIComponent(accessToken)}`
            : "/operator",
        });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/operator/app.js") {
        try {
          const bundle = await buildOperatorWebBundle();
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(bundle);
        } catch (error) {
          res.writeHead(500, { "content-type": "text/javascript; charset=utf-8" });
          res.end(
            `document.body.innerHTML='<pre style="padding:16px;color:#b5322b">operator web bundle build failed:\\n'+${JSON.stringify(
              String(error instanceof Error ? error.message : error),
            )}+'</pre>'`,
          );
        }
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/assets/avatar/")) {
        return avatarAssetResponse(res, url.pathname);
      }
      if (req.method === "GET" && url.pathname === "/host-visual") {
        return htmlResponse(
          res,
          buildLanOperatorHostVisualPublisherHtml(config, {
            sourceId: url.searchParams.get("sourceId") || "host-app",
            label: url.searchParams.get("label") || "App view",
            kind: url.searchParams.get("kind") || "desktop_app",
            diagnostic: url.searchParams.get("diagnostic") === "1",
            avatar: url.searchParams.get("avatar") === "1",
            avatarPreset: url.searchParams.get("avatarPreset") || "",
            avatarRenderer: url.searchParams.get("avatarRenderer") || "",
            embed: url.searchParams.get("embed") === "1",
          }),
        );
      }
      if (req.method === "POST" && url.pathname === "/runtime/provider") {
        const payload = await readJsonRequestBody(req);
        const result = await switchConversationProvider(payload);
        return jsonResponse(res, result.status, result.body);
      }
      if (req.method === "GET" && url.pathname === "/runtime/status") {
        return jsonResponse(res, 200, runtimeStatusBody(config, events, debug, health));
      }
      if (req.method === "GET" && url.pathname === "/runtime/events") {
        return jsonResponse(res, 200, { ok: true, events });
      }
      if (req.method === "GET" && url.pathname === "/runtime/report") {
        return jsonResponse(res, 200, {
          ok: true,
          report: buildLanOperatorDebugReport(config, events, debug, health),
        });
      }
      return jsonResponse(res, 404, { ok: false, error: "not_found" });
    })().catch((error) => {
      health = "failed";
      recordEvent(
        "guard",
        "lan_operator_surface_request_failed",
        "LAN operator surface request failed",
        { error: String((error as Error)?.message || error) },
        "error",
      );
      jsonResponse(res, 500, { ok: false, error: String((error as Error)?.message || error) });
    });
  });
  server.on("upgrade", handleUpgrade);
  const conversationEventDrainPump = createConversationEventDrainPump({
    conversationEngine: () => conversationEngine,
    sessionId: () => config.sessionId,
    onEvents: recordCanonicalConversationEvents,
    onFailure: (detail) =>
      recordEvent(
        "realtime",
        "conversation_event_drain_failed",
        "Conversation event drain failed",
        detail,
        "warn",
      ),
  });
  const conversationEventDrainTimer =
    conversationEventDrainIntervalMs > 0
      ? setInterval(() => {
          if (shouldDrainConversationEvents(config.conversationTransport)) {
            void conversationEventDrainPump.drain();
          }
        }, conversationEventDrainIntervalMs)
      : null;
  conversationEventDrainTimer?.unref?.();

  return {
    get config() {
      return config;
    },
    events,
    server,
    async listen() {
      const bindHost = options.host || DEFAULT_HOST;
      const port = Number(options.port ?? DEFAULT_PORT);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bindHost, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      const host = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
      debug.surfaceContext.lanReachability = buildLanOperatorReachability({
        bindHost,
        port: address.port,
        trustedLanOperatorMode,
        lanModeExplicitlyEnabled,
      });
      updateSurfaceContext();
      return {
        host,
        bindHost,
        port: address.port,
        url: `http://${host}:${address.port}/`,
      };
    },
    async close() {
      if (conversationEventDrainTimer) clearInterval(conversationEventDrainTimer);
      await workRuntime?.close().catch(() => {});
      for (const client of clients) sendWebSocketClose(client.socket);
      clients.clear();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    status(nextHealth: RuntimeHealth = health) {
      return runtimeStatusBody(config, events, debug, nextHealth);
    },
    emitKwwkCursor(cursor: Record<string, unknown>) {
      return emitKwwkCursor(cursor);
    },
  };
}
