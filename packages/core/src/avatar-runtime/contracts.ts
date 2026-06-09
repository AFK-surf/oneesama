export type SurfaceKind = "google_meet" | "local_browser" | "lan_operator" | "embedded";

export type ConversationTransport =
  | "agents_sdk"
  | "gemini_live"
  | "mock"
  | "openai_realtime"
  | "webrtc_mock";

export type RuntimeAudioInput = "meet_remote_audio" | "local_mic" | "synthetic" | "none";
export type RuntimeTextInput = "meet_chat" | "caption" | "local_text" | "worker_internal";
export type RuntimeAudioOutput = "meet_sender" | "local_speaker" | "avatar_bus_only" | "none";
export type RuntimeVideoOutput = "meet_camera" | "dom_canvas" | "capture_track" | "none";
export type RuntimeLoopGuard = "push_to_talk" | "aec" | "headphones_required";
export type RuntimeStatusView = "summary" | "diagnostic" | "trace";
export type RuntimeHealth = "starting" | "ready" | "degraded" | "failed" | "stopped";
export type RuntimeEventSeverity = "debug" | "info" | "warn" | "error";
export type RuntimeEventPhase =
  | "init"
  | "join"
  | "media"
  | "realtime"
  | "tool"
  | "guard"
  | "shutdown";

/**
 * Surface capabilities advertise host-specific tools or ports that the engine
 * may expose. Tool dispatch, worker execution, and function_call_output delivery
 * stay inside the ConversationEngine/ToolRegistry loop, not in surface adapters.
 */
export interface SurfaceCapability {
  name: string;
  toolName?: string;
  description: string;
  surfaceOnly?: boolean;
  enabled: boolean;
}

export interface RuntimeInputPolicy {
  audioInputs: RuntimeAudioInput[];
  textInputs: RuntimeTextInput[];
  continuousMic?: boolean;
  pushToTalk?: boolean;
  echoCancellationRequired?: boolean;
  explicitLoopGuard?: RuntimeLoopGuard;
}

export interface RuntimeOutputPolicy {
  audioOutputs: RuntimeAudioOutput[];
  videoOutputs: RuntimeVideoOutput[];
  allowLocalSpeaker?: boolean;
}

export interface RuntimeDiagnosticsConfig {
  eventLogEnabled: boolean;
  defaultStatusView: RuntimeStatusView;
  retainTraceArtifacts?: boolean;
  redactByDefault: boolean;
}

export interface AvatarRuntimeSessionConfig {
  sessionId: string;
  botName: string;
  surfaceKind: SurfaceKind;
  conversationTransport: ConversationTransport;
  renderer?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  inputPolicy: RuntimeInputPolicy;
  outputPolicy: RuntimeOutputPolicy;
  capabilities: SurfaceCapability[];
  diagnostics?: RuntimeDiagnosticsConfig;
}

export interface RuntimeEvent {
  ts: string;
  sessionId: string;
  surfaceKind: SurfaceKind;
  conversationTransport: ConversationTransport;
  phase: RuntimeEventPhase;
  event: string;
  severity: RuntimeEventSeverity;
  summary: string;
  detail?: Record<string, unknown>;
  redaction?: "none" | "omitted" | "hashed" | "summarized";
  correlation?: {
    turnId?: string;
    responseId?: string;
    toolCallId?: string;
    trackId?: string;
    capabilityName?: string;
    workerJobId?: string;
  };
}

export interface RuntimeStatusSnapshot {
  view: RuntimeStatusView;
  summary: string;
  health: RuntimeHealth;
  surfaceKind: SurfaceKind;
  conversationTransport: ConversationTransport;
  capabilities?: string[];
  warnings?: string[];
  errors?: string[];
  trace?: RuntimeEvent[];
}

export interface RuntimeInitScript {
  category: "avatar" | "realtime" | "local_dialog" | "screen_share" | "worker_result";
  content: string;
  event: RuntimeEvent;
}

export interface RuntimeSessionHandle {
  sessionId: string;
}

export interface SurfaceStartResult {
  ok: boolean;
  events?: RuntimeEvent[];
  [key: string]: unknown;
}

export interface SurfaceStopResult {
  ok: boolean;
  events?: RuntimeEvent[];
  [key: string]: unknown;
}

export interface SurfaceStatus {
  snapshot: RuntimeStatusSnapshot;
  events?: RuntimeEvent[];
}

export interface SurfaceAdapter {
  kind: SurfaceKind;
  capabilities(): SurfaceCapability[];
  buildInitScripts(config: AvatarRuntimeSessionConfig): RuntimeInitScript[];
  start?(session: RuntimeSessionHandle): Promise<SurfaceStartResult>;
  stop?(reason?: string): Promise<SurfaceStopResult>;
  status?(): SurfaceStatus;
}

export interface RuntimeValidationResult {
  ok: boolean;
  config?: AvatarRuntimeSessionConfig;
  errors: string[];
  events: RuntimeEvent[];
}

function freezeRuntimeSessionConfig(
  config: AvatarRuntimeSessionConfig,
): Readonly<AvatarRuntimeSessionConfig> {
  Object.freeze(config.capabilities);
  for (const capability of config.capabilities) Object.freeze(capability);
  Object.freeze(config.inputPolicy.audioInputs);
  Object.freeze(config.inputPolicy.textInputs);
  Object.freeze(config.inputPolicy);
  Object.freeze(config.outputPolicy.audioOutputs);
  Object.freeze(config.outputPolicy.videoOutputs);
  Object.freeze(config.outputPolicy);
  if (config.diagnostics) Object.freeze(config.diagnostics);
  return Object.freeze(config);
}

const SURFACE_KIND_ALIASES: Record<string, SurfaceKind> = {
  google_meet: "google_meet",
  "google-meet": "google_meet",
  meet: "google_meet",
  local_browser: "local_browser",
  "local-browser": "local_browser",
  browser: "local_browser",
  local: "local_browser",
  lan_operator: "lan_operator",
  "lan-operator": "lan_operator",
  operator: "lan_operator",
  embedded: "embedded",
  iframe: "embedded",
};

const TRANSPORT_ALIASES: Record<string, ConversationTransport> = {
  agents_sdk: "agents_sdk",
  "agents-sdk": "agents_sdk",
  "openai-agents": "agents_sdk",
  "openai-agents-sdk": "agents_sdk",
  openai_realtime: "openai_realtime",
  "openai-realtime": "openai_realtime",
  realtime: "openai_realtime",
  gemini_live: "gemini_live",
  "gemini-live": "gemini_live",
  gemini: "gemini_live",
  gemini_realtime: "gemini_live",
  "gemini-realtime": "gemini_live",
  webrtc: "agents_sdk",
  mock: "mock",
  webrtc_mock: "webrtc_mock",
  "webrtc-mock": "webrtc_mock",
};

export function normalizeSurfaceKind(value: unknown): SurfaceKind {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  const normalized = SURFACE_KIND_ALIASES[key];
  if (!normalized) throw new Error(`unknown surface kind: ${String(value || "")}`);
  return normalized;
}

export function normalizeConversationTransport(value: unknown): ConversationTransport {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  const normalized = TRANSPORT_ALIASES[key];
  if (!normalized) throw new Error(`unknown conversation transport: ${String(value || "")}`);
  return normalized;
}

export function defaultRuntimeDiagnosticsConfig(
  overrides: Partial<RuntimeDiagnosticsConfig> = {},
): RuntimeDiagnosticsConfig {
  const defaultStatusView = overrides.defaultStatusView || "summary";
  return {
    eventLogEnabled: overrides.eventLogEnabled !== false,
    defaultStatusView: defaultStatusView === "trace" ? "summary" : defaultStatusView,
    retainTraceArtifacts: Boolean(overrides.retainTraceArtifacts),
    redactByDefault: overrides.redactByDefault !== false,
  };
}

function duplicateCapabilityKeys(capabilities: SurfaceCapability[], field: "name" | "toolName") {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const capability of capabilities) {
    const value = String(capability[field] || "").trim();
    if (!value) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].toSorted();
}

function cloneCapabilities(value: unknown, errors: string[]): SurfaceCapability[] {
  if (!Array.isArray(value)) {
    errors.push("surface capabilities must be an array");
    return [];
  }
  return value.map((capability) => Object.assign({}, capability));
}

function policyValues<T extends string>(value: unknown, label: string, errors: string[]): T[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  return value as T[];
}

export function createRuntimeEvent(
  config: Pick<AvatarRuntimeSessionConfig, "sessionId" | "surfaceKind" | "conversationTransport">,
  event: Omit<RuntimeEvent, "ts" | "sessionId" | "surfaceKind" | "conversationTransport"> & {
    ts?: string;
  },
): RuntimeEvent {
  return {
    ts: event.ts || new Date().toISOString(),
    sessionId: config.sessionId,
    surfaceKind: config.surfaceKind,
    conversationTransport: config.conversationTransport,
    phase: event.phase,
    event: event.event,
    severity: event.severity,
    summary: event.summary,
    detail: event.detail,
    redaction: event.redaction || "summarized",
    correlation: event.correlation,
  };
}

export function validateRuntimeSessionConfig(
  rawConfig: AvatarRuntimeSessionConfig,
): RuntimeValidationResult {
  const errors: string[] = [];
  let surfaceKind: SurfaceKind;
  let conversationTransport: ConversationTransport;

  try {
    surfaceKind = normalizeSurfaceKind(rawConfig.surfaceKind);
  } catch (error) {
    surfaceKind = rawConfig.surfaceKind;
    errors.push(String((error as Error).message || error));
  }

  try {
    conversationTransport = normalizeConversationTransport(rawConfig.conversationTransport);
  } catch (error) {
    conversationTransport = rawConfig.conversationTransport;
    errors.push(String((error as Error).message || error));
  }

  const config: AvatarRuntimeSessionConfig = {
    ...rawConfig,
    surfaceKind,
    conversationTransport,
    capabilities: cloneCapabilities(rawConfig.capabilities, errors),
    diagnostics: defaultRuntimeDiagnosticsConfig(rawConfig.diagnostics),
  };

  const audioInputs = new Set<RuntimeAudioInput>(
    policyValues(config.inputPolicy?.audioInputs, "inputPolicy.audioInputs", errors),
  );
  const audioOutputs = new Set<RuntimeAudioOutput>(
    policyValues(config.outputPolicy?.audioOutputs, "outputPolicy.audioOutputs", errors),
  );
  const textInputs = policyValues<RuntimeTextInput>(
    config.inputPolicy?.textInputs,
    "inputPolicy.textInputs",
    errors,
  );
  const videoOutputs = policyValues<RuntimeVideoOutput>(
    config.outputPolicy?.videoOutputs,
    "outputPolicy.videoOutputs",
    errors,
  );
  const duplicateCapabilityNames = duplicateCapabilityKeys(config.capabilities, "name");
  const duplicateToolNames = duplicateCapabilityKeys(config.capabilities, "toolName");

  for (const name of duplicateCapabilityNames) {
    errors.push(`surface capability name must be unique within a runtime session: ${name}`);
  }
  for (const toolName of duplicateToolNames) {
    errors.push(`surface capability toolName must be unique within a runtime session: ${toolName}`);
  }

  if (config.surfaceKind === "google_meet") {
    if (audioInputs.has("local_mic")) {
      errors.push("google_meet runtime must not use local_mic as a Realtime input");
    }
    if (audioOutputs.has("local_speaker")) {
      errors.push("google_meet runtime must not use local_speaker as a Realtime output");
    }
  }

  if (
    config.surfaceKind === "local_browser" &&
    audioInputs.has("local_mic") &&
    audioOutputs.has("local_speaker") &&
    config.inputPolicy?.continuousMic &&
    !config.inputPolicy?.explicitLoopGuard
  ) {
    errors.push(
      "local_browser runtime must reject continuous local_mic + local_speaker without explicitLoopGuard",
    );
  }

  if (rawConfig.diagnostics?.defaultStatusView === "trace") {
    errors.push("runtime diagnostics defaultStatusView must not be trace");
  }

  const events = [
    createRuntimeEvent(config, {
      phase: "init",
      event: errors.length ? "runtime_session_validation_rejected" : "runtime_session_validated",
      severity: errors.length ? "error" : "info",
      summary: errors.length
        ? "Runtime session config failed validation"
        : "Runtime session config passed validation",
      detail: {
        errors,
        capabilityNames: config.capabilities.map((capability) => capability.name),
        duplicateCapabilityNames,
        duplicateToolNames,
        audioInputs: [...audioInputs],
        audioOutputs: [...audioOutputs],
        textInputs,
        videoOutputs,
        defaultStatusView: config.diagnostics?.defaultStatusView,
      },
      redaction: "summarized",
    }),
  ];

  return {
    ok: errors.length === 0,
    config: errors.length === 0 ? freezeRuntimeSessionConfig(config) : config,
    errors,
    events,
  };
}

export function buildRuntimeStatusSnapshot({
  config,
  view,
  health = "starting",
  summary,
  events = [],
  warnings = [],
  errors = [],
}: {
  config: AvatarRuntimeSessionConfig;
  view?: RuntimeStatusView;
  health?: RuntimeHealth;
  summary?: string;
  events?: RuntimeEvent[];
  warnings?: string[];
  errors?: string[];
}): RuntimeStatusSnapshot {
  const requestedView = view || config.diagnostics?.defaultStatusView || "summary";
  const safeView = requestedView === "trace" ? "diagnostic" : requestedView;
  const snapshot: RuntimeStatusSnapshot = {
    view: safeView,
    summary: summary || `${config.surfaceKind} runtime is ${health}`,
    health,
    surfaceKind: config.surfaceKind,
    conversationTransport: config.conversationTransport,
  };

  if (safeView === "diagnostic") {
    snapshot.capabilities = config.capabilities.map((capability) => capability.name);
    snapshot.warnings = warnings;
    snapshot.errors = errors;
  }

  if (view === "trace") {
    return {
      ...snapshot,
      view,
      trace: events,
    };
  }

  return snapshot;
}
