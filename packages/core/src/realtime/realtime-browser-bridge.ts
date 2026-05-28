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
  allowGenericMediaElementAudioDiscovery?: boolean;
  captureMeetAudioForTranscript?: boolean;
  meetAudioCaptureChunkMs?: number;
  meetAudioInputGain?: number;
  meetAudioEnergyStaleMs?: number;
  instructions: string;
  tools: any[];
  toolChoice?: string;
  session: RealtimeSessionShape;
  sendSessionUpdateOnConnect: boolean;
  autoRespondToWorkerToolCalls: boolean;
  autoRespondToMeetToolCalls: boolean;
  dryRunLocalTools?: boolean;
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

function isGoogleMeetDocument() {
  return window.location.hostname === "meet.google.com";
}

function shouldRouteGenericMediaElementAudio() {
  if (typeof config.allowGenericMediaElementAudioDiscovery === "boolean") {
    return config.allowGenericMediaElementAudioDiscovery;
  }
  return !isGoogleMeetDocument();
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
  captureMeetAudioForTranscript: false,
  meetAudioCaptureChunkMs: 5000,
  meetAudioInputGain: undefined,
  meetAudioEnergyStaleMs: 10000,
  instructions: "",
  tools: [],
  session: {},
  sendSessionUpdateOnConnect: true,
  autoRespondToWorkerToolCalls: true,
  autoRespondToMeetToolCalls: true,
  observeMeetChat: true,
  botName: "Meeting Avatar Bot",
  ...rawBridgeConfig,
};
config.meetAudioInputGain = normalizeMeetAudioInputGain(
  (rawBridgeConfig as Record<string, unknown>).meetAudioInputGain,
  defaultMeetAudioInputGainForSource(config.meetAudioInputSource),
);
const {
  realtimeReconnectDelayMs,
  formatRealtimeErrorValue,
  shouldRetryRealtimeConnectStatus,
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
  buildWorkerResultVoiceText,
  buildWorkerResultText,
  isNoActionWorkerJob,
} = (window as any).__MAB_REALTIME_WORKER_RESULT_HELPERS;

const state = {
  ok: true,
  mode: config.mode,
  sessionId: String(config.sessionId || ""),
  agentRuntime: {
    requested: String(config.agentRuntime || ""),
    active: config.mode === "mock" ? "raw" : "",
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
    outputAudioActive: false,
    lastOutputAudioStartedAt: "",
    lastOutputAudioStoppedAt: "",
    lastInputSpeechStartedAt: "",
    cancelledResponses: 0,
    userSpeechCancels: 0,
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
    tokenUrl: config.tokenUrl,
    sdpUrl: config.sdpUrl,
    dataChannelOpen: config.mode === "mock",
    peerConnectionState: "",
    remoteAudioAttached: false,
    remoteAudioRoutedToAvatarBus: false,
    mockRemoteAudioInjected: false,
    recvOnlyAudioTransceiverAdded: false,
    realtimeInputPlaceholderAdded: false,
    currentRealtimeInputTrackId: "",
    currentRealtimeInputSource: "",
    currentRealtimeInputIsRoutingMix: false,
    realtimeAudioSenderStats: null as null | Record<string, unknown>,
    realtimeAgentSDKInputTrackIds: [],
    lastRealtimeInputReplaceReason: "",
    lastRealtimeInputReplaceAt: "",
    realtimeInputGateOpen: true,
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
    captionTurnsInjected: 0,
    captionTurnsPending: 0,
    lastCaptionTurnAt: "",
    lastCaptionTurnSpeaker: "",
    lastCaptionTurnText: "",
    lastCaptionTurnTextChars: 0,
    sentDataChannelMessages: [],
    lastTokenError: null as null | Record<string, unknown>,
    lastSdpError: null as null | Record<string, unknown>,
    reconnectAttempts: 0,
    reconnecting: false,
    lastReconnectAt: "",
    lastReconnectReason: "",
  },
  transcripts: {
    currentOutput: "",
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
    cache: {
      identity: null,
      meetingAwareness: null,
      currentTask: null,
    },
  },
};
const participantStreams = [];
const participantTrackIds = new Set();
const addedParticipantTrackIds = new Set();
const injectedWorkerJobIds = new Set();
const handledLocalToolCallIds = new Set();
let activePeerConnection = null;
let activeRealtimeAgentSession = null;
let activeRealtimeAgentTransport = null;
let realtimeAudioSender = null;
let routingAudioContext = null;
let routingInputGate = null;
let routingDestination = null;
let routingAnalyser = null;
let routingAnalyserBuffer = null;
let routingEnergyTimer = 0;
let realtimeAudioSenderStatsTimer = 0;
let meetAudioRecorder = null;
let meetAudioRecorderStopResolve = null;
let meetAudioCaptureUploadChain = Promise.resolve();
let meetAudioCaptureSequence = 0;
let routingSilenceSource = null;
let routingAudioResumeListenersInstalled = false;
let silentMeetAudioTrack = null;
let realtimeInputGateReopenTimer = 0;
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

function rememberSdpError(detail: Record<string, unknown>) {
  state.connection.lastSdpError = {
    ts: new Date().toISOString(),
    ...detail,
  };
  recordTimeline("realtime_sdp_error", state.connection.lastSdpError);
  updateFeedback();
}

function clearRecoveredConnectionErrors() {
  state.connection.lastTokenError = null;
  state.connection.lastSdpError = null;
  state.errors = state.errors.filter((entry) => {
    const message = String(entry?.message || "");
    return (
      !message.startsWith("Realtime SDP exchange failed:") &&
      !message.startsWith("Realtime client secret")
    );
  });
}

function scheduleConnectFailureRetry(error) {
  const detail = error?.realtimeSdpError || error?.realtimeTokenError;
  if (!detail || detail.retryable !== true) return false;
  const status = Number(detail.status || 0);
  const delayMs = realtimeReconnectDelayMs(
    status,
    Number(detail.retryAfterMs || 0),
    Number(state.connection.reconnectAttempts || 0) + 1,
  );
  recordTimeline("realtime_connect_retry_requested", {
    reason: detail.reason || "sdp_exchange_failed",
    status,
    delayMs,
  });
  window.setTimeout(() => {
    scheduleRealtimeReconnect(String(detail.reason || "sdp_exchange_failed"), delayMs);
  }, 0);
  return true;
}

function recordTimeline(type, detail = {}) {
  state.timeline.push({
    ts: new Date().toISOString(),
    type,
    detail: {
      session_id: state.sessionId || String(config.sessionId || ""),
      ...detail,
    },
  });
  state.timeline = state.timeline.slice(-120);
}

const {
  buildCompactedHistory,
  compactRealtimeHistory,
  currentHistorySnapshot,
  maybeCompactRealtimeHistory,
  pushSessionContext,
  rememberInboundEvent,
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
