/* eslint-disable no-unused-vars */
interface RealtimeSessionShape {
  type?: string;
  model?: string;
  output_modalities?: string[];
  outputModalities?: string[];
  modalities?: string[];
  audio?: {
    input?: {
      format?: Record<string, unknown>;
      turn_detection?: unknown;
      transcription?: unknown;
      [key: string]: unknown;
    };
    output?: {
      format?: Record<string, unknown>;
      voice?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  turn_detection?: unknown;
  instructions?: string;
  tools?: unknown[];
  voice?: string;
  [key: string]: unknown;
}

interface RealtimeBridgeConfig {
  mode: string;
  agentRuntime?: string;
  agentSDKVersion?: string;
  realtimeRuntimePlacement?: string;
  realtimePageRole?: string;
  allowInlineAgentsSDKDiagnostic?: boolean;
  sessionId?: string;
  toolCallbackToken?: string;
  autoRespondToWorkerResults: boolean;
  autoRespondToAvatarToolCalls: boolean;
  autoConnect: boolean;
  autoReconnect?: boolean;
  tokenUrl: string;
  sdpUrl: string;
  workerDelegateUrl: string;
  workerStatusUrl: string;
  includeParticipantAudio: boolean;
  forwardMeetAudioToRealtime: boolean;
  meetAudioInputSource?: string;
  allowHostMeetAudioPcmInput?: boolean;
  allowParticipantAudioStreamEvents?: boolean;
  captureMeetAudioForTranscript?: boolean;
  meetAudioCaptureChunkMs?: number;
  meetAudioInputGain?: number;
  meetAudioEnergyStaleMs?: number;
  selfEchoSuppressionWindowMs?: number;
  instructions: string;
  tools: any[];
  toolChoice?: string;
  session: RealtimeSessionShape;
  sendSessionUpdateOnConnect: boolean;
  autoRespondToWorkerToolCalls: boolean;
  autoRespondToMeetToolCalls: boolean;
  dryRunLocalTools?: boolean;
  directTextTurnToolRouting?: boolean;
  allowMockToolSimulation?: boolean;
  allowCustomRealtimeServerEvents?: boolean;
  observeMeetChat: boolean;
  botName: string;
  simulateRemoteAudio?: boolean;
  rtcConfiguration?: RTCConfiguration;
  openaiRealtimeBaseUrl?: string;
  [key: string]: unknown;
}

const DEFAULT_MEET_AUDIO_INPUT_GAIN = 48;
// Recappi captures normalized Chrome process audio; never reuse the weak WebRTC
// receiver compensation gain here or the input clips before Realtime VAD.
const DEFAULT_RECAPPI_PROCESS_AUDIO_INPUT_GAIN = 1;
const MAX_MEET_AUDIO_INPUT_GAIN = 64;

function defaultMeetAudioInputGainForSource(source: unknown) {
  return source === "recappi_process_audio"
    ? DEFAULT_RECAPPI_PROCESS_AUDIO_INPUT_GAIN
    : DEFAULT_MEET_AUDIO_INPUT_GAIN;
}

function normalizeMeetAudioInputGain(value: unknown, fallback = DEFAULT_MEET_AUDIO_INPUT_GAIN) {
  const gain = Number(value);
  const fallbackGain = Number(fallback);
  const selected =
    Number.isFinite(gain) && gain > 0
      ? gain
      : Number.isFinite(fallbackGain) && fallbackGain > 0
        ? fallbackGain
        : DEFAULT_MEET_AUDIO_INPUT_GAIN;
  return Math.max(0.1, Math.min(selected, MAX_MEET_AUDIO_INPUT_GAIN));
}

function shouldRouteGenericMediaElementAudio() {
  return window.location.hostname !== "meet.google.com";
}

const rawBridgeConfig = window.MAB_REALTIME_BRIDGE_CONFIG || {};

const config: RealtimeBridgeConfig = {
  mode: "mock",
  agentRuntime: "agents-sdk",
  agentSDKVersion: "",
  sessionId: "",
  toolCallbackToken: "",
  autoRespondToWorkerResults: true,
  autoRespondToAvatarToolCalls: true,
  autoConnect: false,
  tokenUrl: "/realtime/client-secret",
  sdpUrl: "",
  workerDelegateUrl: "/worker/delegate",
  workerStatusUrl: "/worker/status",
  includeParticipantAudio: false,
  forwardMeetAudioToRealtime: true,
  meetAudioInputSource: "webrtc",
  allowHostMeetAudioPcmInput: false,
  allowParticipantAudioStreamEvents: false,
  captureMeetAudioForTranscript: false,
  meetAudioCaptureChunkMs: 5000,
  meetAudioInputGain: undefined,
  meetAudioEnergyStaleMs: 10000,
  selfEchoSuppressionWindowMs: 350,
  instructions: "",
  tools: [],
  session: {},
  sendSessionUpdateOnConnect: true,
  autoRespondToWorkerToolCalls: true,
  autoRespondToMeetToolCalls: true,
  allowMockToolSimulation: false,
  allowCustomRealtimeServerEvents: false,
  observeMeetChat: true,
  botName: "Meeting Avatar Bot",
  ...rawBridgeConfig,
};
config.meetAudioInputGain = normalizeMeetAudioInputGain(
  (rawBridgeConfig as Record<string, unknown>).meetAudioInputGain,
  defaultMeetAudioInputGainForSource(config.meetAudioInputSource),
);
const realtimeRuntimePlacement = String(config.realtimeRuntimePlacement || "sidecar");
const realtimePageRole = String(config.realtimePageRole || "generic");
const allowInlineAgentsSDKDiagnostic = config.allowInlineAgentsSDKDiagnostic === true;
const {
  formatRealtimeErrorValue,
  classifyRealtimeConnectFailure,
  readResponseText,
  parseJsonObject,
  responseRequestId,
  retryAfterDetail,
  shouldAutoConnectInCurrentDocument,
} = (window as any).__MAB_REALTIME_CONNECTION_HELPERS;
const { normalizeToolNames, defaultRealtime2Session, buildSessionUpdateEvent } = (window as any)
  .__MAB_REALTIME_SESSION_HELPERS;
const {
  buildWorkerResultChatText,
  shouldSendWorkerResultToMeetChat,
  shouldVoiceAckWorkerResult,
  buildWorkerResultVoiceText,
  buildWorkerResultText,
  isNoActionWorkerJob,
} = (window as any).__MAB_REALTIME_WORKER_RESULT_HELPERS;

const state = {
  ok: true,
  mode: config.mode,
  sessionId: String(config.sessionId || ""),
  realtimeRuntimePlacement,
  realtimePageRole,
  sdkOwner: realtimeRuntimePlacement === "sidecar" ? "sidecar" : "meet-page",
  agentRuntime: {
    requested: String(config.agentRuntime || ""),
    active: config.mode === "mock" ? "mock" : "",
    sdkVersion: String(config.agentSDKVersion || ""),
    bundleGlobal: "",
    sdkConnected: false,
    sdkToolNames: [],
    fallbackReason: "",
  },
  connected: config.mode === "mock",
  connecting: false,
  outbound: [],
  errors: [],
  workerResults: [],
  responsesRequested: 0,
  protection: {
    injectedWorkerJobIds: [],
    duplicateWorkerResultsSkipped: 0,
    handledLocalToolCallIds: [],
    duplicateLocalToolCallsSkipped: 0,
    activeResponseId: "",
    lastInputSpeechStartedAt: "",
    cancelledResponses: 0,
    nativeInterruption: {
      speech_started_at: "",
      api_interruption_at: "",
      response_cancelled_at: "",
      avatar_audio_stopped_at: "",
      truncate_sent_at: "",
      last_self_echo_suppressed_at: "",
      last_self_echo_reason: "",
      self_echo_suppressed_count: 0,
      last_self_echo_evidence: null,
      last_output_item_id: "",
      last_output_content_index: 0,
      last_output_audio_started_at: "",
      last_output_audio_event_at: "",
      last_output_audio_elapsed_ms: 0,
      truncate_count: 0,
      avatar_audio_stop_count: 0,
      last_event_type: "",
      last_source: "",
      last_stop_result: null,
    },
  },
  avatarTools: {
    calls: [],
    errors: [],
  },
  workerTools: {
    calls: [],
    errors: [],
  },
  meetTools: {
    calls: [],
    errors: [],
  },
  workspaceTools: {
    calls: [],
    errors: [],
  },
  meetingEvents: [],
  turnPolicy: {
    decisions: [],
    events: [],
    appControlJobs: {},
    manualFunctionalTurns: [],
  },
  meetChat: {
    observerInstalled: false,
    messages: [],
    links: [],
    errors: [],
    lastObservedAt: "",
    injected: 0,
  },
  session: {
    configured: false,
    updateEventsSent: 0,
    lastUpdateChannel: "",
    lastUpdateAt: "",
    instructionsLength: 0,
    toolNames: [],
  },
  connection: {
    mode: config.mode,
    requestedMode: config.mode,
    tokenUrl: config.tokenUrl,
    sdpUrl: config.sdpUrl,
    dataChannelOpen: config.mode === "mock",
    peerConnectionState: "",
    remoteAudioAttached: false,
    remoteAudioRoutedToAvatarBus: false,
    realtimeOutputAudioPort: null as null | Record<string, unknown>,
    sidecarOutputPcmChunks: 0,
    sidecarOutputPcmLastChunkAt: "",
    sidecarOutputPcmLastError: "",
    realtimeRemoteAudioTrackStats: null as null | Record<string, unknown>,
    recvOnlyAudioTransceiverAdded: false,
    realtimeInputPlaceholderAdded: false,
    currentRealtimeInputTrackId: "",
    currentRealtimeInputSource: "",
    currentRealtimeInputIsRoutingMix: false,
    realtimeAudioSenderStats: null as null | Record<string, unknown>,
    realtimeAgentSDKInputTrackIds: [],
    realtimeAgentSDKInputSenderTrackId: "",
    lastRealtimeInputReplaceReason: "",
    lastRealtimeInputReplaceAt: "",
    meetAudioInputGain: normalizeMeetAudioInputGain(config.meetAudioInputGain),
    meetAudioEnergyStaleMs: Math.max(1000, Number(config.meetAudioEnergyStaleMs || 10000)),
    meetAudioForwardingEnabled: config.forwardMeetAudioToRealtime !== false,
    meetAudioContextState: "",
    meetAudioTracksForwarded: 0,
    meetMediaElementsScanned: 0,
    meetMediaElementStates: [],
    meetMediaElementAudioTracksAdded: 0,
    meetMediaElementDiscoverySkipped: false,
    meetMediaElementDiscoverySkipLogged: false,
    participantAudioElementDiscoverySkipped: false,
    participantAudioElementDiscoverySkipLogged: false,
    pendingMeetAudioTrackCount: 0,
    meetAudioSourcesActive: 0,
    meetAudioSourcesUnmuted: 0,
    meetAudioTrackStates: [],
    meetAudioEnergy: {
      rms: 0,
      peak: 0,
      observed: false,
      lastEnergyAt: "",
      lastCheckedAt: "",
      silenceMs: 0,
      thresholdRms: 0.003,
      thresholdPeak: 0.01,
    },
    realtimeInputEnergy: {
      rms: 0,
      peak: 0,
      observed: false,
      lastEnergyAt: "",
      lastCheckedAt: "",
    },
    meetAudioEnergyLogged: false,
    lastMeetAudioTrackId: "",
    meetAudioCapture: {
      enabled: Boolean(config.captureMeetAudioForTranscript),
      supported: false,
      sinkAvailable: false,
      recording: false,
      startedAt: "",
      stoppedAt: "",
      mimeType: "",
      chunks: 0,
      bytes: 0,
      lastChunkAt: "",
      errors: [],
    },
    hostMeetAudioInput: {
      enabled: Boolean(config.allowHostMeetAudioPcmInput),
      connected: false,
      sampleRate: 0,
      channels: 0,
      chunks: 0,
      samplesReceived: 0,
      samplesQueued: 0,
      lastRawRms: 0,
      lastRawPeak: 0,
      lastChunkAt: "",
      lastPushAt: "",
      source: "",
      errors: [],
    },
    duplicateMeetAudioSendersMuted: 0,
    primaryMeetAudioSenderTrackId: "",
    primaryMeetAudioSenderUsingAvatarBus: false,
    primaryMeetAudioSenderStats: null as null | Record<string, unknown>,
    primaryMeetAudioSenderAttachAttempts: 0,
    lastPrimaryMeetAudioAttachAt: "",
    lastPrimaryMeetAudioAttachError: "",
    participantAudioTracksDiscovered: 0,
    participantAudioTracksAdded: 0,
    participantAudioForwardingEnabled: Boolean(config.includeParticipantAudio),
    participantAudioSources: [],
    dataChannelMessagesReceived: 0,
    openaiSessionId: "",
    lastInboundEventAt: "",
    lastInboundEventType: "",
    lastOutboundEventAt: "",
    lastOutboundEventType: "",
    blockedUserTextEvents: 0,
    captionTurnsObserved: 0,
    lastCaptionTurnAt: "",
    lastCaptionTurnSpeaker: "",
    lastCaptionTurnText: "",
    lastCaptionTurnTextChars: 0,
    sentDataChannelMessages: [],
    lastTokenError: null as null | Record<string, unknown>,
    reconnectAttempts: 0,
    reconnecting: false,
    lastReconnectAt: "",
    lastReconnectReason: "",
  },
  transcripts: {
    currentInput: "",
    currentOutput: "",
    input: [],
    output: [],
  },
  inbound: [],
  timeline: [],
  feedback: {
    status: "initializing",
    summary: "Realtime bridge is initializing.",
    blockers: [],
    checks: {},
    audioInputPolicy: null,
    failureMatrix: {},
    runtimeState: null,
    updatedAt: new Date().toISOString(),
  },
  audioInputPolicy: null,
  runtimeState: {
    status: "initializing",
    phase: "initializing",
    reason: "initializing",
    blockers: [],
    audioInputReady: false,
    audioInputSource: "",
    canSpeak: false,
    toolTurnsHealthy: true,
    updatedAt: new Date().toISOString(),
  },
  contextHealth: {
    enabled: true,
    itemsCount: 0,
    tokenEstimate: 0,
    nextCompactThreshold: 80000,
    recentItemsRetained: 20,
    refreshCount: 0,
    compactCount: 0,
    dedupeSkips: 0,
    lastRefreshAt: "",
    lastRefreshReason: "",
    lastCompactAt: "",
    lastCompactReason: "",
    lastCompactBeforeItems: 0,
    lastCompactAfterItems: 0,
    lastSummaryChars: 0,
    lastSignature: "",
    lastSignatureAt: 0,
    lastHistoryTail: [],
    latestFunctionalTurn: null,
    cache: {
      identity: null,
      meetingAwareness: null,
      currentTask: null,
    },
  },
};
const participantStreams = [];
const participantTrackIds = new Set();
const injectedWorkerJobIds = new Set();
const handledLocalToolCallIds = new Set();
let activePeerConnection = null;
let activeRealtimeAgentSession = null;
let activeRealtimeAgentTransport = null;
let realtimeAudioSender = null;
let routingAudioContext = null;
let routingInputGate = null;
let routingDestination = null;
let realtimeInputDestination = null;
let routingAnalyser = null;
let routingAnalyserBuffer = null;
let routingEnergyTimer = 0;
let realtimeInputAnalyser = null;
let realtimeInputAnalyserBuffer = null;
let realtimeInputEnergyTimer = 0;
let realtimeInputMonitorSource = null;
let meetAudioRecorder = null;
let meetAudioRecorderStopResolve = null;
let meetAudioCaptureUploadChain = Promise.resolve();
let meetAudioCaptureSequence = 0;
let routingSilenceSource = null;
let routingAudioResumeListenersInstalled = false;
let silentMeetAudioTrack = null;
let primaryMeetAudioSender = null;
let primaryMeetAudioSenderStatsTimer = 0;
let primaryMeetAudioSenderAttachRetryTimer = 0;
const primaryMeetAudioSenderAttachInFlight = new WeakSet();
let peerConnectionHookInstalled = false;
let reconnectTimer = null;
let reconnectGeneration = 0;
const observedMeetChatKeys = new Set();
const pendingMeetAudioTracks = [];
const routedMeetAudioTrackIds = new Set();
const routedMeetAudioSources = [];
const routedMeetMediaElements = new WeakSet();
const { isLocalToolName, localWorkspaceTools } = (window as any)
  .__MAB_REALTIME_LOCAL_TOOL_ROUTER_HELPERS;
function randomEventId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function rememberError(error) {
  state.errors.push({
    ts: new Date().toISOString(),
    message: String((error && error.message) || error).slice(0, 600),
  });
  state.errors = state.errors.slice(-50);
  updateFeedback();
}
function clearRecoveredConnectionErrors() {
  state.connection.lastTokenError = null;
  state.errors = state.errors.filter((entry) => {
    const message = String(entry?.message || "");
    return !message.startsWith("Realtime client secret");
  });
}

function recordTimeline(type, detail = {}) {
  const entry = {
    ts: new Date().toISOString(),
    type,
    detail: { session_id: state.sessionId || String(config.sessionId || ""), ...detail },
  };
  state.timeline.push(entry);
  state.timeline = state.timeline.slice(-120);
}

const {
  buildCompactedHistory,
  compactRealtimeHistory,
  currentHistorySnapshot,
  maybeCompactRealtimeHistory,
  pushSessionContext,
  rememberInboundEvent,
  recordManualFunctionalTextTurn,
  rememberSessionContext,
  summarizeRealtimeEvent,
  updateContextHealthFromHistory,
  updateFeedback,
} = (window as any).__MAB_REALTIME_CONTEXT_HELPERS.create({
  config,
  state,
  getRealtimeAgentSession: () => activeRealtimeAgentSession,
  recordTimeline,
  sendRealtimeEvent,
});
