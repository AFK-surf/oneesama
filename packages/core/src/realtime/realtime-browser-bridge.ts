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
    captureMeetAudioForTranscript?: boolean;
    meetAudioCaptureChunkMs?: number;
    fallbackToLocalMic: boolean;
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
    captureMeetAudioForTranscript: false,
    meetAudioCaptureChunkMs: 5000,
    fallbackToLocalMic: false,
    instructions: "",
    tools: [],
    session: {},
    sendSessionUpdateOnConnect: true,
    autoRespondToWorkerToolCalls: true,
    autoRespondToMeetToolCalls: true,
    observeMeetChat: true,
    botName: "Meeting Avatar Bot",
    ...window.MAB_REALTIME_BRIDGE_CONFIG,
  };
  const {
    realtimeReconnectDelayMs,
    formatRealtimeErrorValue,
    shouldRetryRealtimeConnectStatus,
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
      localAudioTrackAdded: false,
      localAudioFallbackEnabled: Boolean(config.fallbackToLocalMic),
      localAudioRoutedToRealtimeMix: false,
      localAudioMixTrackId: "",
      recvOnlyAudioTransceiverAdded: false,
      realtimeInputPlaceholderAdded: false,
      realtimeInputGateOpen: true,
      meetAudioForwardingEnabled: config.forwardMeetAudioToRealtime !== false,
      meetAudioContextState: "",
      meetAudioTracksForwarded: 0,
      meetAudioSourcesActive: 0,
      meetAudioTrackStates: [],
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
      participantAudioTracksDiscovered: 0,
      participantAudioTracksAdded: 0,
      participantAudioForwardingEnabled: Boolean(config.includeParticipantAudio),
      participantAudioSources: [],
      dataChannelMessagesReceived: 0,
      lastInboundEventAt: "",
      lastInboundEventType: "",
      lastOutboundEventAt: "",
      lastOutboundEventType: "",
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
      currentInput: "",
      output: [],
      input: [],
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
  let meetAudioRecorder = null;
  let meetAudioRecorderStopResolve = null;
  let meetAudioCaptureUploadChain = Promise.resolve();
  let meetAudioCaptureSequence = 0;
  let routingSilenceSource = null;
  let localMicFallbackStream = null;
  let localMicFallbackSource = null;
  let routingAudioResumeListenersInstalled = false;
  let silentMeetAudioTrack = null;
  let realtimeInputGateReopenTimer = 0;
  let primaryMeetAudioSender = null;
  let peerConnectionHookInstalled = false;
  let reconnectTimer = null;
  let reconnectGeneration = 0;
  const observedMeetChatKeys = new Set();
  const pendingMeetAudioTracks = [];
  const routedMeetAudioTrackIds = new Set();
  const routedMeetAudioSources = [];
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
