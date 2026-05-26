(() => {
  if (window.__meetingAvatarRealtimeBridge) return;
  if (window.top !== window) return;
  window.__meetingAvatarRealtimeBridge = true;

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
  const LOCAL_AVATAR_TOOLS = new Set([
    "set_avatar_expression",
    "set_avatar_action",
    "update_avatar_state",
  ]);
  const LOCAL_WORKER_TOOLS = new Set([
    "delegate_to_worker",
    "worker_status",
    "delegate_to_codex",
    "delegate_status",
  ]);
  const LOCAL_MEET_TOOLS = new Set([
    "send_meet_chat",
    "present_video_stage",
    "stop_video_stage",
    "list_shareable_windows",
    "share_existing_app_window",
    "list_shareable_apps",
    "present_app_share",
    "read_meet_chat",
    "meet_participants",
    "active_speaker",
  ]);
  const LOCAL_WORKSPACE_TOOLS = new Set([
    "current_user_identity",
    "resolve_speaker_identity",
    "search_team_members",
    "linear_query",
    "linear_user_issues",
    "google_calendar",
    "calendar_attendees",
    "slack_search",
    "notion_search",
    "github_search",
    "fetch_url",
    "open_shared_browser_surface",
    "create_shared_workspace",
    "control_shared_app_window",
    "control_shared_browser_surface",
    "stop_shared_browser_surface",
    "start_demo_surface",
    "start_demo_execution",
    "control_demo_surface",
    "cancel_demo_surface",
    "memory_write",
    "memory_read",
    "now",
  ]);

  function isLocalToolName(name) {
    return (
      LOCAL_AVATAR_TOOLS.has(name) ||
      LOCAL_WORKER_TOOLS.has(name) ||
      LOCAL_MEET_TOOLS.has(name) ||
      LOCAL_WORKSPACE_TOOLS.has(name)
    );
  }

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

  function ensureMeetAudioRoutingContext() {
    if (routingDestination) return routingDestination;
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    routingAudioContext = routingAudioContext || new AudioContextImpl({ sampleRate: 48000 });
    state.connection.meetAudioContextState = routingAudioContext.state || "";
    routingInputGate = routingInputGate || routingAudioContext.createGain();
    routingInputGate.gain.value = 1;
    routingDestination = routingDestination || routingAudioContext.createMediaStreamDestination();
    routingInputGate.connect(routingDestination);
    routingSilenceSource = routingSilenceSource || routingAudioContext.createConstantSource();
    routingSilenceSource.offset.value = 0;
    routingSilenceSource.connect(routingInputGate);
    routingSilenceSource.start();
    recordTimeline("meet_audio_routing_ready", {
      outputTrackId: routingDestination.stream.getAudioTracks()[0]?.id || "",
      audioContextState: routingAudioContext.state || "",
    });
    installMeetAudioResumeListeners();
    resumeMeetAudioRoutingContext("routing-ready");
    return routingDestination;
  }

  function resumeMeetAudioRoutingContext(reason = "") {
    if (!routingAudioContext) return;
    state.connection.meetAudioContextState = routingAudioContext.state || "";
    if (routingAudioContext.state !== "suspended") return;
    routingAudioContext
      .resume()
      .then(() => {
        state.connection.meetAudioContextState = routingAudioContext.state || "";
        recordTimeline("meet_audio_context_resumed", {
          reason,
          state: routingAudioContext.state || "",
        });
        return updateFeedback();
      })
      .catch((error) => {
        recordTimeline("meet_audio_context_resume_failed", {
          reason,
          error: String((error && error.message) || error).slice(0, 240),
        });
      });
  }

  function installMeetAudioResumeListeners() {
    if (routingAudioResumeListenersInstalled) return;
    routingAudioResumeListenersInstalled = true;
    const resume = () => resumeMeetAudioRoutingContext("user-gesture");
    window.addEventListener("pointerdown", resume, { capture: true, passive: true });
    window.addEventListener("keydown", resume, { capture: true });
    window.addEventListener("click", resume, { capture: true, passive: true });
  }

  function setRealtimeInputGate(open, reason = "") {
    if (!routingInputGate || !routingAudioContext) return;
    if (!open && realtimeInputGateReopenTimer) {
      window.clearTimeout(realtimeInputGateReopenTimer);
      realtimeInputGateReopenTimer = 0;
    }
    const target = open ? 1 : 0;
    try {
      routingInputGate.gain.setTargetAtTime(target, routingAudioContext.currentTime, 0.015);
    } catch {
      routingInputGate.gain.value = target;
    }
    state.connection.realtimeInputGateOpen = open;
    recordTimeline("realtime_input_gate", { open, reason });
    updateFeedback();
  }

  function scheduleRealtimeInputGateOpen(reason = "", delayMs = 1200) {
    if (realtimeInputGateReopenTimer) window.clearTimeout(realtimeInputGateReopenTimer);
    realtimeInputGateReopenTimer = window.setTimeout(
      () => {
        realtimeInputGateReopenTimer = 0;
        setRealtimeInputGate(true, reason || "delayed-open");
      },
      Math.max(0, delayMs),
    );
    recordTimeline("realtime_input_gate_open_scheduled", { reason, delayMs });
    updateFeedback();
  }

  function replaceRealtimeInputWithRoutingMix(reason = "meet-audio") {
    if (!realtimeAudioSender || !routingDestination) return false;
    const [mixedTrack] = routingDestination.stream.getAudioTracks();
    if (!mixedTrack) return false;
    realtimeAudioSender
      .replaceTrack(mixedTrack)
      .then(() => {
        recordTimeline("realtime_input_replace_track", {
          reason,
          trackId: mixedTrack.id,
          meetAudioTracksForwarded: state.connection.meetAudioTracksForwarded,
        });
        return updateFeedback();
      })
      .catch((error) => rememberError(error));
    return true;
  }

  function routeLocalMicFallbackToRealtimeMix(track, stream) {
    if (!track || track.kind !== "audio") return false;
    if (state.connection.meetAudioForwardingEnabled !== true) return false;
    if (localMicFallbackSource) return true;
    ensureMeetAudioRoutingContext();
    try {
      localMicFallbackStream = new MediaStream([track]);
      localMicFallbackSource = routingAudioContext.createMediaStreamSource(localMicFallbackStream);
      localMicFallbackSource.connect(routingInputGate);
      state.connection.localAudioRoutedToRealtimeMix = true;
      state.connection.localAudioMixTrackId = track.id || "";
      recordTimeline("local_audio_routed_to_realtime_mix", {
        trackId: track.id || "",
        streamId: stream?.id || "",
      });
      updateFeedback();
      return true;
    } catch (error) {
      recordTimeline("local_audio_route_to_realtime_mix_error", {
        error: String((error && error.message) || error).slice(0, 240),
      });
      rememberError(error);
      return false;
    }
  }

  function updateMeetAudioCaptureState(patch: Record<string, unknown> = {}) {
    state.connection.meetAudioCapture = {
      ...state.connection.meetAudioCapture,
      ...patch,
    } as typeof state.connection.meetAudioCapture;
    updateFeedback();
  }

  function meetAudioCaptureSinkAvailable() {
    return (
      typeof window.__meetingAvatarMeetAudioCaptureChunk === "function" &&
      typeof window.__meetingAvatarMeetAudioCaptureEvent === "function"
    );
  }

  function supportedMeetAudioCaptureMimeType() {
    if (typeof MediaRecorder !== "function") return "";
    for (const mimeType of ["audio/webm;codecs=opus", "audio/webm"]) {
      try {
        if (MediaRecorder.isTypeSupported?.(mimeType)) return mimeType;
      } catch {
        // Keep trying the next candidate.
      }
    }
    return "";
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("loadend", () => {
        const result = String(reader.result || "");
        resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
      }, { once: true });
      reader.addEventListener("error", () => reject(reader.error || new Error("audio_chunk_read_failed")), { once: true });
      reader.readAsDataURL(blob);
    });
  }

  function rememberMeetAudioCaptureError(stage, error) {
    const entry = {
      ts: new Date().toISOString(),
      stage,
      error: String((error && error.message) || error).slice(0, 400),
    };
    updateMeetAudioCaptureState({
      errors: [...(state.connection.meetAudioCapture?.errors || []), entry].slice(-20),
    });
    recordTimeline("meet_audio_capture_error", entry);
  }

  function uploadMeetAudioBlob(blob) {
    if (!blob?.size) return meetAudioCaptureUploadChain;
    meetAudioCaptureSequence += 1;
    const sequence = meetAudioCaptureSequence;
    meetAudioCaptureUploadChain = meetAudioCaptureUploadChain
      .then(async () => {
        const base64 = await blobToBase64(blob);
        const payload = {
          sessionId: state.sessionId,
          sequence,
          mimeType: blob.type || state.connection.meetAudioCapture?.mimeType || "",
          bytes: blob.size,
          base64,
        };
        const result = (await window.__meetingAvatarMeetAudioCaptureChunk(payload)) as {
          ok?: boolean;
          error?: string;
          reason?: string;
          chunks?: number;
          bytes?: number;
        };
        if (!result?.ok) throw new Error(result?.error || result?.reason || "audio_chunk_rejected");
        return updateMeetAudioCaptureState({
          chunks: result.chunks || sequence,
          bytes: result.bytes || (state.connection.meetAudioCapture?.bytes || 0) + blob.size,
          lastChunkAt: new Date().toISOString(),
        });
      })
      .catch((error) => {
        rememberMeetAudioCaptureError("chunk_upload", error);
      });
    return meetAudioCaptureUploadChain;
  }

  async function emitMeetAudioCaptureEvent(type, detail = {}) {
    if (!meetAudioCaptureSinkAvailable()) return { ok: false, error: "capture_sink_unavailable" };
    return await window.__meetingAvatarMeetAudioCaptureEvent({
      sessionId: state.sessionId,
      type,
      ...detail,
    });
  }

  function maybeStartMeetAudioCapture(reason = "meet-audio-forwarded") {
    if (!config.captureMeetAudioForTranscript)
      return { ok: true, skipped: true, reason: "disabled" };
    const mimeType = supportedMeetAudioCaptureMimeType();
    const sinkAvailable = meetAudioCaptureSinkAvailable();
    updateMeetAudioCaptureState({
      enabled: true,
      supported: Boolean(mimeType),
      sinkAvailable,
      mimeType: state.connection.meetAudioCapture?.mimeType || mimeType,
    });
    if (!sinkAvailable) return { ok: false, error: "capture_sink_unavailable" };
    if (!mimeType) return { ok: false, error: "media_recorder_audio_webm_unsupported" };
    if (meetAudioRecorder?.state === "recording") return { ok: true, recording: true };
    if (!routingDestination) return { ok: false, error: "routing_destination_missing" };
    const tracks = routingDestination.stream?.getAudioTracks?.() || [];
    if (!tracks.length) return { ok: false, error: "routing_stream_has_no_audio_track" };
    try {
      meetAudioRecorder = new MediaRecorder(routingDestination.stream, { mimeType });
      meetAudioRecorder.addEventListener("dataavailable", (event) => {
        uploadMeetAudioBlob(event.data);
      });
      meetAudioRecorder.addEventListener("start", () => {
        const startedAt = new Date().toISOString();
        updateMeetAudioCaptureState({
          recording: true,
          startedAt,
          stoppedAt: "",
          mimeType,
        });
        emitMeetAudioCaptureEvent("started", { mimeType }).catch((error) =>
          rememberMeetAudioCaptureError("event_start", error),
        );
        recordTimeline("meet_audio_capture_started", { reason, mimeType });
      });
      meetAudioRecorder.addEventListener("stop", () => {
        meetAudioCaptureUploadChain
          .then(() => emitMeetAudioCaptureEvent("stopped", { mimeType }))
          .catch((error) => rememberMeetAudioCaptureError("event_stop", error))
          .finally(() => {
            updateMeetAudioCaptureState({
              recording: false,
              stoppedAt: new Date().toISOString(),
            });
            const resolve = meetAudioRecorderStopResolve;
            meetAudioRecorderStopResolve = null;
            if (resolve) resolve(state.connection.meetAudioCapture);
          });
      });
      meetAudioRecorder.addEventListener("error", (event) => {
        rememberMeetAudioCaptureError("media_recorder", event.error || "media_recorder_error");
      });
      meetAudioRecorder.start(Number(config.meetAudioCaptureChunkMs || 5000) || 5000);
      return { ok: true, started: true, mimeType };
    } catch (error) {
      rememberMeetAudioCaptureError("start", error);
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  function stopMeetAudioCapture(reason = "manual_stop") {
    if (!meetAudioRecorder || meetAudioRecorder.state === "inactive") {
      updateMeetAudioCaptureState({ recording: false });
      return Promise.resolve({
        ok: true,
        stopped: false,
        state: state.connection.meetAudioCapture,
      });
    }
    return new Promise((resolve) => {
      meetAudioRecorderStopResolve = (captureState) =>
        resolve({ ok: true, stopped: true, reason, state: captureState });
      try {
        meetAudioRecorder.requestData?.();
        meetAudioRecorder.stop();
      } catch (error) {
        meetAudioRecorderStopResolve = null;
        rememberMeetAudioCaptureError("stop", error);
        resolve({
          ok: false,
          stopped: false,
          reason,
          error: String((error && error.message) || error),
          state: state.connection.meetAudioCapture,
        });
      }
    });
  }

  function forwardMeetAudioTrackToRealtime(track, detail = {}) {
    if (!track || track.kind !== "audio") return false;
    if (!state.connection.meetAudioForwardingEnabled) return false;
    if (routedMeetAudioTrackIds.has(track.id)) return false;
    routedMeetAudioTrackIds.add(track.id);
    ensureMeetAudioRoutingContext();
    try {
      const stream = new MediaStream([track]);
      const source = routingAudioContext.createMediaStreamSource(stream);
      source.connect(routingInputGate);
      routedMeetAudioSources.push({
        track,
        stream,
        source,
        detail,
        addedAt: new Date().toISOString(),
      });
      state.connection.meetAudioSourcesActive = routedMeetAudioSources.filter(
        (entry) => entry.track?.readyState === "live",
      ).length;
      state.connection.meetAudioTrackStates = routedMeetAudioSources.slice(-10).map((entry) => ({
        trackId: entry.track?.id || "",
        readyState: entry.track?.readyState || "",
        enabled: entry.track?.enabled !== false,
        muted: entry.track?.muted === true,
        source: entry.detail?.source || "",
        label: entry.detail?.label || entry.track?.label || "",
      }));
      state.connection.meetAudioTracksForwarded += 1;
      state.connection.lastMeetAudioTrackId = track.id;
      recordTimeline("meet_audio_track_forwarded", {
        trackId: track.id,
        label: track.label || "",
        sourcesRetained: routedMeetAudioSources.length,
        ...detail,
      });
      if (!realtimeAudioSender) {
        pendingMeetAudioTracks.push(track);
        recordTimeline("meet_audio_track_pending", { trackId: track.id });
        maybeStartMeetAudioCapture("meet-audio-pending");
        updateFeedback();
        return true;
      }
      replaceRealtimeInputWithRoutingMix("meet-audio-forwarded");
      maybeStartMeetAudioCapture("meet-audio-forwarded");
      updateFeedback();
      return true;
    } catch (error) {
      rememberError(error);
      return false;
    }
  }

  function flushPendingMeetAudioTracks() {
    if (!realtimeAudioSender || !pendingMeetAudioTracks.length) return;
    pendingMeetAudioTracks.splice(0);
    replaceRealtimeInputWithRoutingMix("pending-meet-audio-flush");
  }

  function isRoutingDestinationTrack(track: MediaStreamTrack | null | undefined) {
    if (!track || !routingDestination) return false;
    return routingDestination.stream.getAudioTracks().includes(track);
  }

  function silenceDuplicateMeetAudioSender(sender, pcId, source) {
    if (!sender || !silentMeetAudioTrack || sender === primaryMeetAudioSender) return;
    sender
      .replaceTrack(silentMeetAudioTrack.clone())
      .then(() => {
        state.connection.duplicateMeetAudioSendersMuted += 1;
        recordTimeline("duplicate_meet_audio_sender_muted", { pcId, source });
        return updateFeedback();
      })
      .catch((error) => rememberError(error));
  }

  function handleMeetOutboundAudioSender(pc, pcId, sender, track, source) {
    if (!sender || !track || track.kind !== "audio") return;
    if (pc === activePeerConnection) return;
    if (!primaryMeetAudioSender) {
      primaryMeetAudioSender = sender;
      recordTimeline("primary_meet_audio_sender_selected", { pcId, source, trackId: track.id });
      return;
    }
    if (sender !== primaryMeetAudioSender) {
      silenceDuplicateMeetAudioSender(sender, pcId, source);
    }
  }

  function isMeetingAvatarScreenShareTrack(track) {
    if (!track || track.kind !== "video") return false;
    const label = String(track.label || "");
    let settings = {};
    try {
      settings = track.getSettings?.() || {};
    } catch {
      settings = {};
    }
    return (
      track.contentHint === "detail" ||
      /meeting avatar bot synthetic display|meeting-avatar-screen-share|synthetic display/i.test(
        label,
      ) ||
      Boolean((settings as { displaySurface?: unknown }).displaySurface)
    );
  }

  function handleMeetOutboundVideoSender(pc, pcId, sender, track, source) {
    if (!sender || !track || track.kind !== "video") return;
    if (pc === activePeerConnection || !isMeetingAvatarScreenShareTrack(track)) return;
    try {
      track.contentHint = "detail";
    } catch {
      // Best-effort encoder hint.
    }
    const optimize = async () => {
      if (typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function")
        return;
      const parameters = sender.getParameters() || {};
      parameters.degradationPreference = "maintain-resolution";
      if (Array.isArray(parameters.encodings) && parameters.encodings.length > 0) {
        parameters.encodings = parameters.encodings.map((encoding) => ({
          ...encoding,
          maxBitrate: Math.max(Number(encoding.maxBitrate) || 0, 8_000_000),
          priority: "high",
          networkPriority: "high",
        }));
      }
      await sender.setParameters(parameters);
      recordTimeline("screen_share_video_sender_optimized", {
        pcId,
        source,
        trackId: track.id,
        contentHint: track.contentHint || "",
        degradationPreference: parameters.degradationPreference || "",
        maxBitrate: parameters.encodings?.[0]?.maxBitrate || null,
      });
    };
    optimize().catch((error) => {
      recordTimeline("screen_share_video_sender_optimize_failed", {
        pcId,
        source,
        trackId: track.id,
        error: String((error && error.message) || error).slice(0, 240),
      });
    });
  }

  function instrumentMeetSender(pc, pcId, sender, source) {
    if (!sender || sender.__meetingAvatarRealtimeInstrumented) return sender;
    sender.__meetingAvatarRealtimeInstrumented = true;
    const originalReplaceTrack = sender.replaceTrack?.bind(sender);
    if (originalReplaceTrack) {
      sender.replaceTrack = async function (track) {
        const result = await originalReplaceTrack(track);
        handleMeetOutboundAudioSender(pc, pcId, sender, track, `${source}.replaceTrack`);
        handleMeetOutboundVideoSender(pc, pcId, sender, track, `${source}.replaceTrack`);
        return result;
      };
    }
    if (sender.track?.kind === "audio") {
      handleMeetOutboundAudioSender(pc, pcId, sender, sender.track, source);
    }
    if (sender.track?.kind === "video") {
      handleMeetOutboundVideoSender(pc, pcId, sender, sender.track, source);
    }
    return sender;
  }

  function scanMeetOutboundSenders(pc, pcId) {
    if (pc === activePeerConnection || typeof pc.getSenders !== "function") return;
    pc.getSenders().forEach((sender, index) => instrumentMeetSender(pc, pcId, sender, `scan[${index}]`));
  }
  function scanMeetInboundReceivers(pc, pcId) {
    if (pc === activePeerConnection || typeof pc.getReceivers !== "function") return;
    pc.getReceivers().forEach((receiver, index) => {
      const track = receiver?.track;
      if (track?.kind === "audio" && track.readyState !== "ended") {
        forwardMeetAudioTrackToRealtime(track, { pcId, source: `scanReceiver[${index}]` });
      }
    });
  }

  function installMeetPeerConnectionHook() {
    if (peerConnectionHookInstalled || window.__meetingAvatarRealtimePeerConnectionHook) return;
    if (typeof window.RTCPeerConnection !== "function") return;
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    let pcCounter = 0;
    function HookedRTCPeerConnection(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      const pc = new OriginalRTCPeerConnection(...args);
      const pcId = ++pcCounter;
      recordTimeline("peer_connection_created", { pcId });

      const originalAddTrack = pc.addTrack?.bind(pc);
      if (originalAddTrack) {
        pc.addTrack = function (track, ...streams) {
          const sender = originalAddTrack(track, ...streams);
          instrumentMeetSender(pc, pcId, sender, "addTrack");
          return sender;
        };
      }

      const originalAddTransceiver = pc.addTransceiver?.bind(pc);
      if (originalAddTransceiver) {
        pc.addTransceiver = function (trackOrKind, init) {
          const transceiver = originalAddTransceiver(trackOrKind, init);
          instrumentMeetSender(pc, pcId, transceiver.sender, "addTransceiver");
          if (trackOrKind && typeof trackOrKind === "object") {
            handleMeetOutboundAudioSender(
              pc,
              pcId,
              transceiver.sender,
              trackOrKind,
              "addTransceiver(track)",
            );
            handleMeetOutboundVideoSender(
              pc,
              pcId,
              transceiver.sender,
              trackOrKind,
              "addTransceiver(track)",
            );
          }
          return transceiver;
        };
      }

      pc.addEventListener("track", (event) => {
        if (pc === activePeerConnection) return;
        if (!event.track || event.track.kind !== "audio") return;
        forwardMeetAudioTrackToRealtime(event.track, { pcId, source: "pc.track" });
      });

      const timer = window.setInterval(() => {
        if (pc.connectionState === "closed") {
          window.clearInterval(timer);
          return;
        }
        scanMeetOutboundSenders(pc, pcId);
        scanMeetInboundReceivers(pc, pcId);
      }, 1000);

      return pc;
    }
    HookedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
    Object.setPrototypeOf(HookedRTCPeerConnection, OriginalRTCPeerConnection);
    window.RTCPeerConnection = HookedRTCPeerConnection as unknown as typeof RTCPeerConnection;
    window.__meetingAvatarRealtimePeerConnectionHook = true;
    peerConnectionHookInstalled = true;
    recordTimeline("meet_peer_connection_hook_installed");
  }

  installMeetPeerConnectionHook();

  function rememberAvatarToolCall(call) {
    state.avatarTools.calls.push({ ts: new Date().toISOString(), ...call });
    state.avatarTools.calls = state.avatarTools.calls.slice(-40);
  }

  function rememberAvatarToolError(error, detail = {}) {
    state.avatarTools.errors.push({
      ts: new Date().toISOString(),
      message: String((error && error.message) || error).slice(0, 400),
      ...detail,
    });
    state.avatarTools.errors = state.avatarTools.errors.slice(-20);
  }

  function rememberWorkerToolCall(call) {
    state.workerTools.calls.push({ ts: new Date().toISOString(), ...call });
    state.workerTools.calls = state.workerTools.calls.slice(-40);
  }

  function rememberWorkerToolError(error, detail = {}) {
    state.workerTools.errors.push({
      ts: new Date().toISOString(),
      message: String((error && error.message) || error).slice(0, 400),
      ...detail,
    });
    state.workerTools.errors = state.workerTools.errors.slice(-20);
  }

  function rememberMeetToolCall(call) {
    state.meetTools.calls.push({ ts: new Date().toISOString(), ...call });
    state.meetTools.calls = state.meetTools.calls.slice(-40);
  }

  function rememberMeetToolError(error, detail = {}) {
    state.meetTools.errors.push({
      ts: new Date().toISOString(),
      message: String((error && error.message) || error).slice(0, 400),
      ...detail,
    });
    state.meetTools.errors = state.meetTools.errors.slice(-20);
  }

  function rememberWorkspaceToolCall(call) {
    state.workspaceTools.calls.push({ ts: new Date().toISOString(), ...call });
    state.workspaceTools.calls = state.workspaceTools.calls.slice(-40);
  }

  function rememberWorkspaceToolError(error, detail = {}) {
    state.workspaceTools.errors.push({
      ts: new Date().toISOString(),
      message: String((error && error.message) || error).slice(0, 400),
      ...detail,
    });
    state.workspaceTools.errors = state.workspaceTools.errors.slice(-20);
  }

  function sendRealtimeEvent(event) {
    const stamped = {
      ...event,
      event_id: event.event_id || `evt_${randomEventId()}`,
    };
    state.outbound.push({ ts: new Date().toISOString(), event: stamped });
    state.outbound = state.outbound.slice(-100);
    state.connection.lastOutboundEventAt = new Date().toISOString();
    state.connection.lastOutboundEventType = stamped.type || "";
    recordTimeline("realtime_outbound", summarizeRealtimeEvent(stamped));
    updateFeedback();

    if (state.agentRuntime.active === "agents-sdk" && activeRealtimeAgentTransport?.sendEvent) {
      if (stamped.type === "response.cancel" && activeRealtimeAgentSession?.interrupt) {
        activeRealtimeAgentSession.interrupt();
      } else {
        activeRealtimeAgentTransport.sendEvent(stamped);
      }
      state.connection.sentDataChannelMessages.push({
        ts: new Date().toISOString(),
        payload: JSON.stringify(stamped),
        runtime: "agents-sdk",
      });
      state.connection.sentDataChannelMessages =
        state.connection.sentDataChannelMessages.slice(-100);
      return "agents-sdk-transport";
    }

    const dataChannel = window.MAB_REALTIME_DATA_CHANNEL || window.MAB_REALTIME_DC;
    if (dataChannel?.readyState === "open" && typeof dataChannel.send === "function") {
      if (
        state.connection.peerConnectionState === "failed" ||
        state.connection.peerConnectionState === "closed"
      ) {
        scheduleRealtimeReconnect(`send_${state.connection.peerConnectionState}`, 0);
      }
      dataChannel.send(JSON.stringify(stamped));
      return "data-channel";
    }

    if (state.connection.mode !== "mock" && state.connection.mode !== "webrtc-mock") {
      scheduleRealtimeReconnect("send_without_open_data_channel", 0);
    }
    window.dispatchEvent(new CustomEvent("meeting-avatar-realtime-event", { detail: stamped }));
    return "custom-event";
  }

  const {
    extractLocalToolCall,
    runLocalAvatarTool,
    updateAvatarHudStatus,
    postJson,
    localServiceUrl,
    runLocalWorkerTool,
    runLocalWorkspaceTool,
  } = (window as any).__MAB_REALTIME_LOCAL_TOOL_HELPERS.create({
    config,
    state,
    localWorkspaceTools: LOCAL_WORKSPACE_TOOLS,
    isLocalToolName,
    recordTimeline,
    rememberAvatarToolError,
  });
  const {
    sendMeetChat,
    readMeetChat: _readMeetChat,
    installMeetChatObserver,
    runLocalMeetTool,
  } = (window as any).__MAB_REALTIME_MEET_CHAT_HELPERS.create({
    config,
    state,
    observedMeetChatKeys,
    postJson,
    localServiceUrl,
    recordTimeline,
    sendRealtimeEvent,
    updateFeedback,
  });

  const meetingEventHelpers = (window as any).__MAB_REALTIME_MEETING_EVENT_HELPERS.create({
    config,
    state,
    recordTimeline,
  });

  const {
    deliverFunctionToolResult,
    prepareFunctionToolResult,
    deliverWorkerResult,
    rememberSuppressedWorkerResult,
    shouldDeliverWorkerResult,
  } = (window as any).__MAB_REALTIME_TURN_POLICY_HELPERS.create({
    config,
    state,
    sendRealtimeEvent,
    sendMeetChat,
    recordTimeline,
    buildWorkerResultChatText,
    shouldSendWorkerResultToMeetChat,
    buildWorkerResultVoiceText,
    buildWorkerResultText,
    meetingEvents: meetingEventHelpers,
  });

  const { createMockDataChannel, routeRemoteAudioStream, injectMockRemoteAudio } = (
    window as any
  ).__MAB_REALTIME_AUDIO_OUTPUT_HELPERS.create({
    state,
    rememberError,
    recordTimeline,
    updateFeedback,
  });

  interface BuildSessionUpdateOptions {
    session?: RealtimeSessionShape & { schema?: string; session_schema?: string };
    instructions?: string;
    tools?: any[];
    toolChoice?: string;
    sessionSchema?: string;
  }

  function sendSessionUpdate(options: BuildSessionUpdateOptions = {}) {
    const event = buildSessionUpdateEvent({
      session: config.session,
      instructions: config.instructions,
      tools: config.tools,
      toolChoice: config.toolChoice,
      ...options,
    });
    if (!Object.keys(event.session || {}).length)
      return { ok: true, skipped: true, reason: "empty_session_update" };
    const channel = sendRealtimeEvent(event);
    state.session.configured = true;
    state.session.updateEventsSent += 1;
    state.session.lastUpdateChannel = channel;
    state.session.lastUpdateAt = new Date().toISOString();
    state.session.instructionsLength = String(event.session?.instructions || "").length;
    state.session.toolNames = normalizeToolNames((event.session?.tools as any[] | undefined) || []);
    updateFeedback();
    return { ok: true, channel, event };
  }

  function injectCurrentUserContext() {
    const currentUser = (config.currentUser || {}) as Record<string, unknown>;
    const configuredName = String(currentUser.name || "").trim();
    const spokenName = String(
      currentUser.englishName || currentUser.english || currentUser.name || "",
    ).trim();
    const name = spokenName || configuredName;
    if (!name) return { ok: true, skipped: true, reason: "no_current_user_context" };
    const identity = {
      resolved: true,
      role: "current_user",
      isCurrentUser: true,
      canonicalName: name,
      preferredName: spokenName || name,
      confidence: "high",
      evidence:
        configuredName && configuredName !== spokenName
          ? ["runtime_current_user_config", "runtime_alias_not_spoken_name"]
          : ["runtime_current_user_config"],
    };
    return pushSessionContext({
      reason: "current_user_bootstrap",
      kind: "identity",
      value: identity,
      force: true,
    });
  }

  function configureRealtimeSession() {
    if (config.sendSessionUpdateOnConnect === false) return { ok: true, skipped: true };
    const sessionUpdate = sendSessionUpdate();
    const identityContext = injectCurrentUserContext();
    return { ok: true, sessionUpdate, identityContext };
  }

  function shouldUseRealtimeAgentSDK(runtime = config.agentRuntime) {
    return ["agents-sdk", "openai-agents", "openai-agents-sdk"].includes(
      String(runtime || "").toLowerCase(),
    );
  }

  function getRealtimeAgentsSDKNamespace() {
    const namespace = (window as any).OpenAIAgentsRealtime || (window as any).openaiAgentsRealtime;
    if (namespace?.RealtimeAgent && namespace?.RealtimeSession && namespace?.tool) {
      state.agentRuntime.bundleGlobal = "OpenAIAgentsRealtime";
      return namespace;
    }
    return null;
  }

  async function mintRealtimeClientSecretForSDK(connectionConfig) {
    let response;
    try {
      response = await fetch(connectionConfig.tokenUrl || config.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...connectionConfig.session,
          instructions: connectionConfig.instructions,
          tools: connectionConfig.tools,
          toolChoice: connectionConfig.toolChoice,
        }),
      });
    } catch (tokenFetchError) {
      const detail = {
        status: 0,
        ok: false,
        retryable: true,
        retryAfter: "",
        retryAfterMs: 0,
        requestId: "",
        error: String((tokenFetchError && tokenFetchError.message) || tokenFetchError).slice(
          0,
          500,
        ),
        reason: "realtime_token_fetch_failed",
      };
      state.connection.lastTokenError = {
        ts: new Date().toISOString(),
        ...detail,
      };
      recordTimeline("realtime_token_error", state.connection.lastTokenError);
      const error = new Error(`Realtime client secret fetch failed: ${detail.error}`);
      const typedError = error as Error & { realtimeTokenError?: Record<string, unknown> };
      typedError.realtimeTokenError = detail;
      throw error;
    }
    const text = await readResponseText(response);
    const body = parseJsonObject(text);
    const value = body.value || body.client_secret?.value || body.secret?.value;
    if (!response.ok || !value) {
      const retry = retryAfterDetail(response);
      const retryable = shouldRetryRealtimeConnectStatus(response.status);
      const requestId = responseRequestId(response);
      state.connection.lastTokenError = {
        ts: new Date().toISOString(),
        status: response.status,
        ok: response.ok,
        retryable,
        ...retry,
        requestId,
        error: body.error || "",
        detail: body.detail || null,
        body: text.slice(0, 1000),
        reason:
          response.status === 429 ? "realtime_token_rate_limited" : "realtime_token_request_failed",
      };
      recordTimeline("realtime_token_error", state.connection.lastTokenError);
      const error = new Error(
        [
          response.ok
            ? "Realtime client secret response did not include a value"
            : "Realtime client secret request failed:",
          formatRealtimeErrorValue(body.error) || (!response.ok ? "" : "missing value"),
          `status=${response.status}`,
          retry.retryAfter ? `retry_after=${retry.retryAfter}` : "",
          requestId ? `request_id=${requestId}` : "",
          body.detail ? `detail=${JSON.stringify(body.detail)}` : "",
          text && !body.error ? `body=${text.slice(0, 240)}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      const typedError = error as Error & { realtimeTokenError?: Record<string, unknown> };
      typedError.realtimeTokenError = state.connection.lastTokenError;
      throw error;
    }
    return value;
  }

  async function runLocalToolForSDK(name, args = {}, callId = "") {
    recordTimeline("realtime_agent_sdk_tool_start", { name, callId });
    const kind = LOCAL_WORKER_TOOLS.has(name) ? "worker"
      : LOCAL_MEET_TOOLS.has(name) ? "meet"
        : LOCAL_WORKSPACE_TOOLS.has(name) ? "workspace"
          : "avatar";
    try {
      const result = kind === "worker" ? await runLocalWorkerTool(name, args)
        : kind === "meet" ? await runLocalMeetTool(name, args)
          : kind === "workspace" ? await runLocalWorkspaceTool(name, args)
            : runLocalAvatarTool(name, args);
      const delivery = prepareFunctionToolResult({ kind, name, callId, result }, { sendOutput: false });
      const call = { name, callId, arguments: args, result, runtime: "agents-sdk", delivery };
      if (kind === "worker") rememberWorkerToolCall(call);
      else if (kind === "meet") rememberMeetToolCall(call);
      else if (kind === "workspace") rememberWorkspaceToolCall(call);
      else rememberAvatarToolCall(call);
      recordTimeline("realtime_agent_sdk_tool_end", { name, callId, ok: true });
      updateFeedback();
      return { result, delivery };
    } catch (error) {
      recordTimeline("realtime_agent_sdk_tool_end", {
        name,
        callId,
        ok: false,
        error: String((error && error.message) || error).slice(0, 300),
      });
      if (kind === "worker") rememberWorkerToolError(error, { name, callId });
      else if (kind === "meet") rememberMeetToolError(error, { name, callId });
      else if (kind === "workspace") rememberWorkspaceToolError(error, { name, callId });
      else rememberAvatarToolError(error, { name, callId });
      throw error;
    }
  }

  function buildRealtimeAgentSDKTools(namespace, tools = []) {
    const sdkTools = [];
    for (const toolConfig of tools) {
      const name = toolConfig?.name || "";
      if (!name || !isLocalToolName(name)) continue;
      sdkTools.push(
        namespace.tool({
          name,
          description: toolConfig.description || `Local ${name} tool`,
          parameters: toolConfig.parameters || { type: "object", properties: {}, required: [] },
          strict: false,
          execute: async (input, _context, details) => {
            const callId =
              details?.toolCall?.callId ||
              details?.toolCall?.call_id ||
              details?.callId ||
              details?.call_id ||
              "";
            const execution = await runLocalToolForSDK(name, input || {}, callId);
            const output = JSON.stringify(execution.delivery?.modelResult || execution.result);
            return execution.delivery?.policy?.autoRespond === false && namespace.backgroundResult
              ? namespace.backgroundResult(output)
              : output;
          },
        }),
      );
    }
    state.agentRuntime.sdkToolNames = sdkTools.map((entry) => entry.name || "");
    return sdkTools;
  }

  function createMockRealtimeAgentTransport() {
    const listeners = new Map();
    const emit = (type, event = {}) => {
      const callbacks = listeners.get(type) || [];
      for (const callback of callbacks) callback(event);
    };
    const transport = {
      status: "disconnected",
      muted: false,
      on(type, callback) {
        const callbacks = listeners.get(type) || [];
        callbacks.push(callback);
        listeners.set(type, callbacks);
        return this;
      },
      off(type, callback) {
        const callbacks = listeners.get(type) || [];
        listeners.set(
          type,
          callbacks.filter((entry) => entry !== callback),
        );
        return this;
      },
      once(type, callback) {
        const wrapped = (event) => {
          transport.off(type, wrapped);
          callback(event);
        };
        transport.on(type, wrapped);
        return this;
      },
      emit,
      async connect(options) {
        transport.status = "connecting";
        recordTimeline("realtime_agent_sdk_mock_connecting", {
          model: options?.model || "",
          hasApiKey: Boolean(options?.apiKey),
        });
        transport.status = "connected";
        emit("transport_event", { type: "connected", model: options?.model || "" });
      },
      close() {
        transport.status = "disconnected";
        emit("transport_event", { type: "disconnected" });
      },
      sendEvent(event) {
        state.connection.sentDataChannelMessages.push({
          ts: new Date().toISOString(),
          payload: JSON.stringify(event),
          runtime: "agents-sdk",
        });
        state.connection.sentDataChannelMessages =
          state.connection.sentDataChannelMessages.slice(-100);
        emit("transport_event", event);
      },
      requestResponse(response = {}) {
        transport.sendEvent({ type: "response.create", response: response || {} });
      },
      sendMessage(message, otherEventData = {}, options: { triggerResponse?: boolean } = {}) {
        transport.sendEvent({ type: "conversation.item.create", message, ...otherEventData });
        if (options.triggerResponse) transport.requestResponse();
      },
      addImage(image) {
        transport.sendEvent({ type: "conversation.item.create", image });
      },
      sendAudio(_audio, options: { commit?: boolean } = {}) {
        transport.sendEvent({ type: "input_audio_buffer.append", commit: options.commit === true });
      },
      updateSessionConfig(sessionConfig) {
        transport.sendEvent({ type: "session.update", session: sessionConfig || {} });
      },
      sendFunctionCallOutput(toolCall, output, startResponse) {
        transport.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: toolCall?.callId || toolCall?.call_id || "",
            output,
          },
        });
        if (startResponse) transport.requestResponse();
      },
      mute(muted) {
        transport.muted = Boolean(muted);
      },
      interrupt() {
        transport.sendEvent({ type: "response.cancel" });
      },
      resetHistory(oldHistory = [], newHistory = []) {
        state.connection.sentDataChannelMessages.push({
          ts: new Date().toISOString(),
          payload: JSON.stringify({
            type: "mock.reset_history",
            oldItems: Array.isArray(oldHistory) ? oldHistory.length : 0,
            newItems: Array.isArray(newHistory) ? newHistory.length : 0,
          }),
          runtime: "agents-sdk",
        });
        state.connection.sentDataChannelMessages =
          state.connection.sentDataChannelMessages.slice(-100);
        emit("transport_event", {
          type: "history_updated",
          oldItems: Array.isArray(oldHistory) ? oldHistory.length : 0,
          newItems: Array.isArray(newHistory) ? newHistory.length : 0,
        });
      },
      sendMcpResponse() {},
    };
    return transport;
  }

  function createRealtimeAgentSDKTransport(namespace, connectionConfig) {
    if (connectionConfig.mode === "agents-sdk-mock") return createMockRealtimeAgentTransport();
    const audioElement = document.createElement("audio");
    audioElement.autoplay = true;
    audioElement.dataset.meetingAvatarRealtimeAudio = "true";
    document.body.appendChild(audioElement);
    ensureMeetAudioRoutingContext();
    const baseUrl =
      String(connectionConfig.openaiRealtimeBaseUrl || "").trim() ||
      String(connectionConfig.sdpUrl || "https://api.openai.com/v1/realtime/calls").replace(
        /\/realtime\/calls\/?$/,
        "",
      );
    const transport = new namespace.OpenAIRealtimeWebRTC({
      audioElement,
      mediaStream: routingDestination?.stream,
      baseUrl: baseUrl.replace(/\/realtime\/?$/, ""),
      changePeerConnection: async (pc) => {
        activePeerConnection = pc;
        window.MAB_REALTIME_PEER_CONNECTION = pc;
        state.connection.peerConnectionState = pc.connectionState || "new";
        recordTimeline("realtime_agent_sdk_peer_connection", {
          state: state.connection.peerConnectionState,
        });
        pc.addEventListener("connectionstatechange", () => {
          state.connection.peerConnectionState = pc.connectionState;
          state.connected =
            pc.connectionState === "connected" || pc.connectionState === "completed";
          recordTimeline("realtime_agent_sdk_peer_connection", { state: pc.connectionState });
          updateFeedback();
        });
        pc.addEventListener("track", (event) => {
          state.connection.remoteAudioAttached = true;
          routeRemoteAudioStream(event.streams?.[0]).catch(rememberError);
          updateFeedback();
        });
        return pc;
      },
    });
    return transport;
  }

  function installRealtimeAgentSDKEventHandlers(session, transport) {
    const record = (type) => (event) => {
      const eventType = event?.type || type;
      recordTimeline(`realtime_agent_sdk_${type}`, {
        eventType,
        agent: event?.agent?.name || event?.agent || "",
        tool: event?.tool?.name || event?.name || "",
        handoff: event?.handoff?.targetAgent?.name || event?.handoff || "",
      });
      rememberInboundEvent({ type: `agents_sdk.${eventType}` }, "agents-sdk");
      if (type === "history_updated") {
        const history = Array.isArray(event) ? event : currentHistorySnapshot();
        updateContextHealthFromHistory(history);
        maybeCompactRealtimeHistory("history_updated");
      }
      updateFeedback();
    };
    for (const eventName of [
      "agent_start",
      "agent_end",
      "agent_handoff",
      "tool_start",
      "tool_end",
      "error",
      "audio_start",
      "audio_stopped",
      "audio_interrupted",
      "history_updated",
      "history_added",
    ]) {
      session?.on?.(eventName, record(eventName));
    }
    transport?.on?.("transport_event", (event) => {
      recordTimeline("realtime_agent_sdk_transport_event", summarizeRealtimeEvent(event));
      if (event && typeof event === "object") {
        rememberInboundEvent({ ...event, __meetingAvatarInboundRecorded: true }, "agents-sdk");
      }
    });
  }

  async function connectRealtimeAgentSDK(connectionConfig) {
    const namespace = getRealtimeAgentsSDKNamespace();
    if (!namespace) {
      state.agentRuntime.fallbackReason = "openai_agents_realtime_bundle_missing";
      throw new Error("OpenAI Agents Realtime SDK bundle is not loaded");
    }
    const ephemeralKey = await mintRealtimeClientSecretForSDK(connectionConfig);
    const tools = buildRealtimeAgentSDKTools(namespace, connectionConfig.tools || []);
    const agent = new namespace.RealtimeAgent({
      name: connectionConfig.botName || "Meeting Avatar Bot",
      instructions: connectionConfig.instructions || "",
      tools,
      voice:
        connectionConfig.session?.audio?.output?.voice ||
        connectionConfig.session?.voice ||
        "marin",
    });
    const transport = createRealtimeAgentSDKTransport(namespace, connectionConfig);
    const session = new namespace.RealtimeSession(agent, {
      model: connectionConfig.session?.model || "gpt-realtime-2",
      transport,
      config: defaultRealtime2Session(connectionConfig.session || {}),
      historyStoreAudio: false,
      context: {
        session_id: state.sessionId || String(config.sessionId || ""),
        botName: connectionConfig.botName || "",
      },
      groupId: state.sessionId || String(config.sessionId || ""),
      traceMetadata: { session_id: state.sessionId || String(config.sessionId || "") },
    });
    activeRealtimeAgentSession = session;
    activeRealtimeAgentTransport = transport;
    installRealtimeAgentSDKEventHandlers(session, transport);
    await session.connect({
      apiKey: ephemeralKey,
      model: connectionConfig.session?.model || "gpt-realtime-2",
    });
    state.connected = true;
    state.connection.dataChannelOpen = true;
    state.connection.peerConnectionState = "sdk-connected";
    state.agentRuntime.active = "agents-sdk";
    state.agentRuntime.sdkConnected = true;
    state.session.configured = true;
    state.session.instructionsLength = String(connectionConfig.instructions || "").length;
    state.session.toolNames = normalizeToolNames(connectionConfig.tools || []);
    updateContextHealthFromHistory(currentHistorySnapshot());
    injectCurrentUserContext();
    recordTimeline("realtime_agent_sdk_connected", {
      tools: state.session.toolNames,
      sdkVersion: state.agentRuntime.sdkVersion,
    });
    installMeetChatObserver().catch((error) => {
      state.meetChat.errors.push({
        ts: new Date().toISOString(),
        message: String((error && error.message) || error).slice(0, 300),
      });
      state.meetChat.errors = state.meetChat.errors.slice(-20);
    });
    window.dispatchEvent(
      new CustomEvent("meeting-avatar-realtime-connected", {
        detail: { mode: state.connection.mode, agentRuntime: "agents-sdk" },
      }),
    );
    updateFeedback();
    return { ok: true, mode: state.connection.mode, agentRuntime: "agents-sdk" };
  }

  function cleanupRealtimeConnection(reason = "cleanup") {
    reconnectGeneration += 1;
    if (realtimeInputGateReopenTimer) {
      window.clearTimeout(realtimeInputGateReopenTimer);
      realtimeInputGateReopenTimer = 0;
    }
    try {
      activeRealtimeAgentSession?.close?.();
    } catch {
      // Best-effort close before reconnecting.
    }
    try {
      activeRealtimeAgentTransport?.close?.();
    } catch {
      // Best-effort close before reconnecting.
    }
    const channel = window.MAB_REALTIME_DATA_CHANNEL || window.MAB_REALTIME_DC;
    try {
      if (channel && channel.readyState !== "closed") channel.close();
    } catch {
      // Best-effort close before reconnecting.
    }
    try {
      activePeerConnection?.getSenders?.().forEach((sender) => {
        if (
          sender.track &&
          sender.track !== silentMeetAudioTrack &&
          !isRoutingDestinationTrack(sender.track)
        ) {
          sender.track.stop?.();
        }
      });
    } catch {
      // Best-effort cleanup.
    }
    try {
      activePeerConnection?.close?.();
    } catch {
      // Best-effort cleanup.
    }
    try {
      localMicFallbackSource?.disconnect?.();
    } catch {
      // Best-effort cleanup.
    }
    try {
      localMicFallbackStream?.getTracks?.().forEach((track) => track.stop?.());
    } catch {
      // Best-effort cleanup.
    }
    activePeerConnection = null;
    activeRealtimeAgentSession = null;
    activeRealtimeAgentTransport = null;
    realtimeAudioSender = null;
    localMicFallbackSource = null;
    localMicFallbackStream = null;
    window.MAB_REALTIME_DATA_CHANNEL = null;
    window.MAB_REALTIME_DC = null;
    window.MAB_REALTIME_PEER_CONNECTION = null;
    state.connected = false;
    state.agentRuntime.sdkConnected = false;
    state.agentRuntime.active = "";
    state.connection.dataChannelOpen = false;
    if (state.connection.peerConnectionState !== "mock-connected") {
      state.connection.peerConnectionState = reason;
    }
    recordTimeline("realtime_connection_cleanup", { reason });
    updateFeedback();
  }

  function scheduleRealtimeReconnect(reason = "peer_connection_failed", delayMs = 750) {
    if (config.autoReconnect === false)
      return { ok: false, skipped: true, reason: "auto_reconnect_disabled" };
    if (state.connection.mode === "mock" || state.connection.mode === "webrtc-mock")
      return { ok: false, skipped: true, reason: "mock_mode" };
    if (reconnectTimer || state.connection.reconnecting || state.connecting) {
      return { ok: true, scheduled: Boolean(reconnectTimer), reason: "already_reconnecting" };
    }
    state.connection.reconnectAttempts += 1;
    state.connection.reconnecting = true;
    state.connection.lastReconnectAt = new Date().toISOString();
    state.connection.lastReconnectReason = reason;
    recordTimeline("realtime_reconnect_scheduled", {
      reason,
      attempt: state.connection.reconnectAttempts,
      delayMs,
    });
    updateFeedback();
    reconnectTimer = window.setTimeout(async () => {
      reconnectTimer = null;
      cleanupRealtimeConnection(reason);
      try {
        await connectRealtime();
      } finally {
        state.connection.reconnecting = false;
        updateFeedback();
      }
    }, delayMs);
    return { ok: true, scheduled: true, reason };
  }

  function rememberInjectedWorkerJob(jobId) {
    if (!jobId) return false;
    if (injectedWorkerJobIds.has(jobId)) {
      state.protection.duplicateWorkerResultsSkipped += 1;
      return true;
    }
    injectedWorkerJobIds.add(jobId);
    state.protection.injectedWorkerJobIds = Array.from(injectedWorkerJobIds).slice(-50);
    return false;
  }

  function cancelActiveResponse(reason = "interrupt", options: { force?: boolean } = {}) {
    const responseId = state.protection.activeResponseId;
    if (!responseId && !state.protection.outputAudioActive && !options.force)
      return { ok: true, skipped: true, reason: "no_active_response" };
    const event: Record<string, unknown> = { type: "response.cancel" };
    if (responseId) event.response_id = responseId;
    const channel = sendRealtimeEvent(event);
    state.protection.cancelledResponses += 1;
    const cancelledResponseId = responseId;
    state.protection.activeResponseId = "";
    state.protection.outputAudioActive = false;
    return { ok: true, channel, responseId: cancelledResponseId, reason };
  }

  function handleRealtimeServerEvent(detail) {
    const event = detail || {};
    if (event.type === "response.created" && event.response?.id) {
      state.protection.activeResponseId = event.response.id;
      setRealtimeInputGate(false, "response-created");
    }
    if (
      event.type === "output_audio_buffer.started" ||
      event.type === "response.output_audio.delta"
    ) {
      window.MAB_AVATAR_AUDIO_BUS?.setSyntheticSpeech?.(true);
      state.protection.outputAudioActive = true;
      if (event.type === "output_audio_buffer.started") {
        state.protection.lastOutputAudioStartedAt = new Date().toISOString();
      }
      setRealtimeInputGate(false, event.type);
    }
    if (event.type === "input_audio_buffer.speech_started") {
      state.protection.lastInputSpeechStartedAt = new Date().toISOString();
      const result = cancelActiveResponse("user_speech_started");
      if (!result.skipped) state.protection.userSpeechCancels += 1;
      setRealtimeInputGate(true, "user-speech-started");
    }
    if (
      ["response.done", "response.cancelled", "response.failed"].includes(event.type) &&
      event.response?.id &&
      event.response.id === state.protection.activeResponseId
    ) {
      state.protection.activeResponseId = "";
    }
    if (
      event.type === "response.done" ||
      event.type === "response.cancelled" ||
      event.type === "response.failed" ||
      event.type === "output_audio_buffer.stopped" ||
      event.type === "response.output_audio.done"
    ) {
      window.MAB_AVATAR_AUDIO_BUS?.setSyntheticSpeech?.(false);
      state.protection.outputAudioActive = false;
      scheduleRealtimeInputGateOpen(event.type, 1200);
    }
    handleLocalToolCallEvent(event);
  }

  function handleLocalToolCallEvent(event: unknown) {
    const toolCall = extractLocalToolCall(event);
    if (!toolCall) return null;
    const toolCallKey = toolCall.callId ? `${toolCall.name}:${toolCall.callId}` : "";
    if (toolCallKey && handledLocalToolCallIds.has(toolCallKey)) {
      state.protection.duplicateLocalToolCallsSkipped += 1;
      recordTimeline("duplicate_local_tool_call_skipped", {
        name: toolCall.name,
        callId: toolCall.callId,
        eventType: (event as { type?: string })?.type,
      });
      updateFeedback();
      return { ok: true, duplicate: true, name: toolCall.name, callId: toolCall.callId };
    }
    if (toolCallKey) {
      handledLocalToolCallIds.add(toolCallKey);
      state.protection.handledLocalToolCallIds = Array.from(handledLocalToolCallIds).slice(-80);
    }
    if (LOCAL_WORKER_TOOLS.has(toolCall.name)) {
      return runLocalWorkerTool(toolCall.name, toolCall.arguments)
        .then((result) => {
          const delivery = deliverFunctionToolResult({
            kind: "worker",
            name: toolCall.name,
            callId: toolCall.callId,
            result,
          });
          rememberWorkerToolCall({
            name: toolCall.name,
            callId: toolCall.callId,
            arguments: toolCall.arguments,
            result,
            delivery,
          });
          return { ok: true, result, delivery };
        })
        .catch((error) => {
          rememberWorkerToolError(error, { name: toolCall.name, callId: toolCall.callId });
          return { ok: false, error: String((error && error.message) || error) };
        });
    }
    if (LOCAL_MEET_TOOLS.has(toolCall.name)) {
      return runLocalMeetTool(toolCall.name, toolCall.arguments)
        .then((result) => {
          const delivery = deliverFunctionToolResult({
            kind: "meet",
            name: toolCall.name,
            callId: toolCall.callId,
            result,
          });
          rememberMeetToolCall({
            name: toolCall.name,
            callId: toolCall.callId,
            arguments: toolCall.arguments,
            result,
            delivery,
          });
          return { ok: true, result, delivery };
        })
        .catch((error) => {
          rememberMeetToolError(error, { name: toolCall.name, callId: toolCall.callId });
          return { ok: false, error: String((error && error.message) || error) };
        });
    }
    if (LOCAL_WORKSPACE_TOOLS.has(toolCall.name)) {
      return runLocalWorkspaceTool(toolCall.name, toolCall.arguments)
        .then((result) => {
          const delivery = deliverFunctionToolResult({
            kind: "workspace",
            name: toolCall.name,
            callId: toolCall.callId,
            result,
          });
          rememberWorkspaceToolCall({
            name: toolCall.name,
            callId: toolCall.callId,
            arguments: toolCall.arguments,
            result,
            delivery,
          });
          return { ok: true, result, delivery };
        })
        .catch((error) => {
          rememberWorkspaceToolError(error, { name: toolCall.name, callId: toolCall.callId });
          return { ok: false, error: String((error && error.message) || error) };
        });
    }
    try {
      const result = runLocalAvatarTool(toolCall.name, toolCall.arguments);
      const delivery = deliverFunctionToolResult({
        kind: "avatar",
        name: toolCall.name,
        callId: toolCall.callId,
        result,
      });
      rememberAvatarToolCall({
        name: toolCall.name,
        callId: toolCall.callId,
        arguments: toolCall.arguments,
        result,
        delivery,
      });
      return { ok: true, result, delivery };
    } catch (error) {
      rememberAvatarToolError(error, { name: toolCall.name, callId: toolCall.callId });
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  function rememberParticipantSource(
    label: string | undefined,
    stream: MediaStream,
    tracks: MediaStreamTrack[],
  ) {
    const source = {
      ts: new Date().toISOString(),
      label: label || "participant-audio",
      streamId: stream.id || "",
      trackIds: tracks.map((track) => track.id),
    };
    state.connection.participantAudioSources.push(source);
    state.connection.participantAudioSources = state.connection.participantAudioSources.slice(-20);
  }

  function addParticipantTracksToPeerConnection(pc) {
    if (!pc) return 0;
    if (!state.connection.participantAudioForwardingEnabled) {
      return 0;
    }
    let added = 0;
    for (const stream of participantStreams) {
      for (const track of stream.getAudioTracks()) {
        if (addedParticipantTrackIds.has(track.id)) continue;
        pc.addTrack(track, stream);
        addedParticipantTrackIds.add(track.id);
        added += 1;
      }
    }
    state.connection.participantAudioTracksAdded += added;
    return added;
  }

  async function addLocalMicTrackToPeerConnection(pc) {
    if (!pc || state.connection.localAudioTrackAdded === true) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const [track] = stream.getAudioTracks();
      if (!track) {
        recordTimeline("local_audio_track_skipped", { reason: "local_mic_no_audio_track" });
        updateFeedback();
        return false;
      }
      realtimeAudioSender = pc.addTrack(track, stream);
      state.connection.localAudioTrackAdded = true;
      recordTimeline("local_audio_track_added", { trackId: track.id });
      routeLocalMicFallbackToRealtimeMix(track, stream);
      updateFeedback();
      return true;
    } catch (error) {
      const message = String((error && error.message) || error).slice(0, 500);
      recordTimeline("local_audio_track_error", { error: message });
      rememberError(error);
      updateFeedback();
      return false;
    }
  }

  interface ParticipantStreamOptions {
    label?: string;
  }

  function registerParticipantAudioStream(
    stream: MediaStream | null | undefined,
    options: ParticipantStreamOptions = {},
  ) {
    try {
      const tracks = stream?.getAudioTracks?.() || [];
      const freshTracks = tracks.filter((track) => !participantTrackIds.has(track.id));
      if (!freshTracks.length) return { ok: true, added: 0, duplicate: tracks.length > 0 };
      for (const track of freshTracks) participantTrackIds.add(track.id);
      participantStreams.push(stream);
      state.connection.participantAudioTracksDiscovered += freshTracks.length;
      rememberParticipantSource(options.label, stream, freshTracks);
      const forwardedToRealtime = freshTracks.reduce(
        (count, track) =>
          count +
          (forwardMeetAudioTrackToRealtime(track, {
            label: options.label || "participant-audio",
            source: "participant-audio-stream",
            streamId: stream.id || "",
          })
            ? 1
            : 0),
        0,
      );
      const addedToPeerConnection = addParticipantTracksToPeerConnection(activePeerConnection);
      recordTimeline("participant_audio_discovered", {
        forwardingEnabled: state.connection.participantAudioForwardingEnabled === true,
        meetAudioForwardingEnabled: state.connection.meetAudioForwardingEnabled === true,
        label: options.label || "participant-audio",
        streamId: stream.id || "",
        trackIds: freshTracks.map((track) => track.id),
        forwardedToRealtime,
        addedToPeerConnection,
      });
      updateFeedback();
      return { ok: true, added: freshTracks.length, addedToPeerConnection, forwardedToRealtime };
    } catch (error) {
      rememberError(error);
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  function discoverParticipantAudioStreams() {
    const mediaElements = Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video"));
    for (const element of mediaElements) {
      if (element.dataset?.meetingAvatarRealtimeAudio === "true") continue;
      const provider = element.srcObject;
      if (!provider || !(provider instanceof MediaStream)) continue;
      if (provider.getAudioTracks?.().length) {
        registerParticipantAudioStream(provider, {
          label:
            element.dataset?.meetingAvatarParticipant ||
            element.id ||
            element.tagName.toLowerCase(),
        });
      }
    }
    return state.connection.participantAudioTracksDiscovered;
  }

  interface ParticipantAudioEventDetail {
    stream?: MediaStream;
    label?: string;
  }

  function installParticipantAudioDiscovery() {
    window.addEventListener("meeting-avatar-participant-audio-stream", (event: Event) => {
      const detail = (event as CustomEvent<ParticipantAudioEventDetail>).detail || {};
      registerParticipantAudioStream(detail.stream, {
        label: detail.label || "participant-audio-event",
      });
    });
    const run = () => {
      try {
        discoverParticipantAudioStreams();
      } catch (error) {
        rememberError(error);
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
    const installObserver = () => {
      if (!document.documentElement) return;
      const observer = new MutationObserver(run);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) {
      installObserver();
    } else {
      document.addEventListener("DOMContentLoaded", installObserver, { once: true });
    }
    window.setInterval(run, 1500);
  }

  async function connectRealtime(options = {}) {
    if (
      state.connected &&
      (window.MAB_REALTIME_DATA_CHANNEL ||
        window.MAB_REALTIME_DC ||
        state.agentRuntime.sdkConnected === true)
    ) {
      return { ok: true, alreadyConnected: true, mode: state.mode };
    }
    const connectionConfig = { ...config, ...options };
    state.connecting = true;
    state.connection.mode = connectionConfig.mode || state.mode;
    state.connection.tokenUrl = connectionConfig.tokenUrl || config.tokenUrl;
    state.connection.sdpUrl = connectionConfig.sdpUrl || config.sdpUrl;
    state.connection.localAudioFallbackEnabled = connectionConfig.fallbackToLocalMic === true;
    state.connection.participantAudioForwardingEnabled =
      connectionConfig.includeParticipantAudio === true;
    state.connection.meetAudioForwardingEnabled =
      connectionConfig.forwardMeetAudioToRealtime !== false;
    try {
      if (
        activePeerConnection &&
        ["failed", "closed", "disconnected"].includes(state.connection.peerConnectionState)
      ) {
        cleanupRealtimeConnection(`preconnect_${state.connection.peerConnectionState}`);
      }
      const wantsSDK =
        shouldUseRealtimeAgentSDK(connectionConfig.agentRuntime) ||
        state.connection.mode === "agents-sdk" ||
        state.connection.mode === "agents-sdk-mock";
      if (wantsSDK && state.connection.mode !== "mock" && state.connection.mode !== "webrtc-mock") {
        try {
          return await connectRealtimeAgentSDK(connectionConfig);
        } catch (error) {
          state.agentRuntime.fallbackReason = String((error && error.message) || error).slice(
            0,
            500,
          );
          scheduleConnectFailureRetry(error);
          if (state.connection.mode === "agents-sdk-mock") throw error;
          recordTimeline("realtime_agent_sdk_fallback_raw", {
            error: state.agentRuntime.fallbackReason,
          });
        }
      }
      if (state.connection.mode === "mock" || state.connection.mode === "webrtc-mock") {
        const channel = createMockDataChannel();
        window.MAB_REALTIME_DATA_CHANNEL = channel as unknown as RTCDataChannel;
        window.MAB_REALTIME_DC = channel as unknown as RTCDataChannel;
        state.connected = true;
        state.agentRuntime.active = "raw";
        state.connection.dataChannelOpen = true;
        state.connection.peerConnectionState = "mock-connected";
        configureRealtimeSession();
        if (
          state.connection.mode === "webrtc-mock" &&
          connectionConfig.simulateRemoteAudio !== false
        ) {
          injectMockRemoteAudio().catch(rememberError);
        }
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-realtime-connected", {
            detail: { mode: state.connection.mode },
          }),
        );
        return { ok: true, mode: state.connection.mode, mock: true };
      }
      state.agentRuntime.active = "raw";

      let tokenResponse;
      try {
        tokenResponse = await fetch(state.connection.tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...connectionConfig.session,
            instructions: connectionConfig.instructions,
            tools: connectionConfig.tools,
            toolChoice: connectionConfig.toolChoice,
          }),
        });
      } catch (tokenFetchError) {
        const detail = {
          status: 0,
          ok: false,
          retryable: true,
          retryAfter: "",
          retryAfterMs: 0,
          requestId: "",
          error: String((tokenFetchError && tokenFetchError.message) || tokenFetchError).slice(
            0,
            500,
          ),
          reason: "realtime_token_fetch_failed",
        };
        state.connection.lastTokenError = {
          ts: new Date().toISOString(),
          ...detail,
        };
        recordTimeline("realtime_token_error", state.connection.lastTokenError);
        const error = new Error(`Realtime client secret fetch failed: ${detail.error}`);
        const typedError = error as Error & { realtimeTokenError?: Record<string, unknown> };
        typedError.realtimeTokenError = detail;
        throw error;
      }
      const tokenText = await readResponseText(tokenResponse);
      const tokenBody = parseJsonObject(tokenText);
      const ephemeralKey =
        tokenBody.value || tokenBody.client_secret?.value || tokenBody.secret?.value;
      if (!tokenResponse.ok || !ephemeralKey) {
        const retry = retryAfterDetail(tokenResponse);
        const retryable = shouldRetryRealtimeConnectStatus(tokenResponse.status);
        const requestId = responseRequestId(tokenResponse);
        state.connection.lastTokenError = {
          ts: new Date().toISOString(),
          status: tokenResponse.status,
          ok: tokenResponse.ok,
          retryable,
          ...retry,
          requestId,
          error: tokenBody.error || "",
          detail: tokenBody.detail || null,
          body: tokenText.slice(0, 1000),
          reason:
            tokenResponse.status === 429
              ? "realtime_token_rate_limited"
              : "realtime_token_request_failed",
        };
        recordTimeline("realtime_token_error", state.connection.lastTokenError);
        const error = new Error(
          [
            tokenResponse.ok
              ? "Realtime client secret response did not include a value"
              : "Realtime client secret request failed:",
            formatRealtimeErrorValue(tokenBody.error) || (!tokenResponse.ok ? "" : "missing value"),
            `status=${tokenResponse.status}`,
            retry.retryAfter ? `retry_after=${retry.retryAfter}` : "",
            requestId ? `request_id=${requestId}` : "",
            tokenBody.detail ? `detail=${JSON.stringify(tokenBody.detail)}` : "",
            tokenText && !tokenBody.error ? `body=${tokenText.slice(0, 240)}` : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
        const typedError = error as Error & { realtimeTokenError?: Record<string, unknown> };
        typedError.realtimeTokenError = state.connection.lastTokenError;
        throw error;
      }

      if (!state.connection.sdpUrl) {
        throw new Error("Realtime SDP URL is required for webrtc mode");
      }
      const pc = new RTCPeerConnection(connectionConfig.rtcConfiguration || {});
      const pcGeneration = reconnectGeneration;
      activePeerConnection = pc;
      state.connection.peerConnectionState = pc.connectionState || "new";
      recordTimeline("peer_connection_state", { state: state.connection.peerConnectionState });
      pc.onconnectionstatechange = () => {
        if (pcGeneration !== reconnectGeneration) return;
        state.connection.peerConnectionState = pc.connectionState;
        state.connected =
          pc.connectionState === "connected" || (pc.connectionState as string) === "completed";
        recordTimeline("peer_connection_state", { state: pc.connectionState });
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          state.connection.dataChannelOpen = false;
          scheduleRealtimeReconnect(`peer_${pc.connectionState}`, 0);
        } else if (pc.connectionState === "disconnected") {
          scheduleRealtimeReconnect("peer_disconnected", 5000);
        }
        updateFeedback();
      };
      pc.ontrack = (event) => {
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.dataset.meetingAvatarRealtimeAudio = "true";
        audio.srcObject = event.streams[0];
        document.body.appendChild(audio);
        state.connection.remoteAudioAttached = true;
        recordTimeline("remote_audio_track", {
          streamId: event.streams[0]?.id || "",
          trackIds: (event.streams[0]?.getAudioTracks?.() || []).map((track) => track.id),
        });
        updateFeedback();
        routeRemoteAudioStream(event.streams[0]).catch(rememberError);
      };

      discoverParticipantAudioStreams();
      addedParticipantTrackIds.clear();
      const directParticipantTracksAdded = addParticipantTracksToPeerConnection(pc);
      const preferDirectParticipantAudio =
        state.connection.participantAudioForwardingEnabled === true &&
        directParticipantTracksAdded > 0;
      let localMicTrackAdded = false;
      if (preferDirectParticipantAudio) {
        realtimeAudioSender = pc.getSenders?.().find((sender) => sender.track?.kind === "audio");
        recordTimeline("realtime_input_direct_participant_audio", {
          participantAudioTracksAdded: directParticipantTracksAdded,
          trackId: realtimeAudioSender?.track?.id || "",
        });
        updateFeedback();
      } else if (connectionConfig.fallbackToLocalMic === true) {
        localMicTrackAdded = await addLocalMicTrackToPeerConnection(pc);
      }
      if (!preferDirectParticipantAudio && !localMicTrackAdded) {
        ensureMeetAudioRoutingContext();
        const [placeholderTrack] = routingDestination.stream.getAudioTracks();
        if (placeholderTrack) {
          realtimeAudioSender = pc.addTrack(placeholderTrack);
          state.connection.realtimeInputPlaceholderAdded = true;
          silentMeetAudioTrack = placeholderTrack.clone();
          recordTimeline("realtime_input_placeholder_added", { trackId: placeholderTrack.id });
          const hadPendingMeetAudioTracks = pendingMeetAudioTracks.length > 0;
          flushPendingMeetAudioTracks();
          if (!hadPendingMeetAudioTracks && state.connection.meetAudioTracksForwarded > 0) {
            replaceRealtimeInputWithRoutingMix("reconnect-meet-audio-mix");
          }
          updateFeedback();
        }
      }
      if (
        state.connection.participantAudioTracksAdded === 0 &&
        state.connection.realtimeInputPlaceholderAdded !== true &&
        state.connection.localAudioTrackAdded !== true
      ) {
        pc.addTransceiver("audio", { direction: "recvonly" });
        state.connection.recvOnlyAudioTransceiverAdded = true;
        recordTimeline("local_audio_track_skipped", {
          reason: "fallback_to_local_mic_disabled",
          recvOnlyAudioTransceiverAdded: true,
        });
        updateFeedback();
      } else {
        recordTimeline("local_audio_track_skipped", {
          reason:
            state.connection.realtimeInputPlaceholderAdded === true
              ? "meet_audio_placeholder_present"
              : state.connection.localAudioTrackAdded === true
                ? "local_mic_present"
                : "participant_audio_tracks_present",
          participantAudioTracksAdded: state.connection.participantAudioTracksAdded,
        });
        updateFeedback();
      }

      const dataChannel = pc.createDataChannel("oai-events");
      window.MAB_REALTIME_DATA_CHANNEL = dataChannel;
      window.MAB_REALTIME_DC = dataChannel;
      dataChannel.addEventListener("open", () => {
        state.connected = true;
        state.connection.dataChannelOpen = true;
        state.connection.reconnectAttempts = 0;
        clearRecoveredConnectionErrors();
        recordTimeline("data_channel_open", { label: dataChannel.label || "" });
        configureRealtimeSession();
        installMeetChatObserver().catch((error) => {
          state.meetChat.errors.push({
            ts: new Date().toISOString(),
            message: String((error && error.message) || error).slice(0, 300),
          });
          state.meetChat.errors = state.meetChat.errors.slice(-20);
        });
        updateFeedback();
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-realtime-connected", {
            detail: { mode: state.connection.mode },
          }),
        );
      });
      dataChannel.addEventListener("close", () => {
        state.connected = false;
        state.connection.dataChannelOpen = false;
        recordTimeline("data_channel_close", { label: dataChannel.label || "" });
        if (
          pcGeneration === reconnectGeneration &&
          !["closed", "failed"].includes(pc.connectionState)
        ) {
          scheduleRealtimeReconnect("data_channel_close", 500);
        }
        updateFeedback();
      });
      dataChannel.addEventListener("message", (event) => {
        let detail = event.data;
        try {
          detail = JSON.parse(event.data);
        } catch {
          // Some providers/tools may send plain text diagnostic frames.
        }
        if (detail && typeof detail === "object") detail.__meetingAvatarInboundRecorded = true;
        rememberInboundEvent(detail, "data-channel");
        window.dispatchEvent(new CustomEvent("meeting-avatar-realtime-server-event", { detail }));
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpResponse = await fetch(state.connection.sdpUrl, {
        method: "POST",
        body: offer.sdp,
        headers: {
          authorization: `Bearer ${ephemeralKey}`,
          "content-type": "application/sdp",
        },
      });
      if (!sdpResponse.ok) {
        const responseText = await readResponseText(sdpResponse);
        const retry = retryAfterDetail(sdpResponse);
        const requestId = responseRequestId(sdpResponse);
        const retryable = shouldRetryRealtimeConnectStatus(sdpResponse.status);
        const detail = {
          status: sdpResponse.status,
          ok: sdpResponse.ok,
          retryable,
          ...retry,
          requestId,
          body: responseText.slice(0, 1000),
          reason:
            sdpResponse.status === 429
              ? "realtime_sdp_rate_limited"
              : "realtime_sdp_exchange_failed",
        };
        rememberSdpError(detail);
        const error = new Error(
          [
            `Realtime SDP exchange failed: ${sdpResponse.status}`,
            retry.retryAfter ? `retry_after=${retry.retryAfter}` : "",
            requestId ? `request_id=${requestId}` : "",
            responseText ? `body=${responseText.slice(0, 240)}` : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
        const typedError = error as Error & { realtimeSdpError?: Record<string, unknown> };
        typedError.realtimeSdpError = detail;
        throw error;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
      window.MAB_REALTIME_PEER_CONNECTION = pc;
      return { ok: true, mode: state.connection.mode };
    } catch (error) {
      rememberError(error);
      scheduleConnectFailureRetry(error);
      return { ok: false, error: String((error && error.message) || error) };
    } finally {
      state.connecting = false;
    }
  }

  async function injectWorkerResult(job) {
    const scope = shouldDeliverWorkerResult(job);
    if (!scope.ok) {
      const suppressed = rememberSuppressedWorkerResult(job, scope.reason, scope);
      state.workerResults.push(suppressed);
      state.workerResults = state.workerResults.slice(-50);
      return suppressed;
    }
    if (rememberInjectedWorkerJob(job.id)) {
      const duplicate = {
        ts: new Date().toISOString(),
        jobId: job.id,
        status: job.status,
        duplicate: true,
      };
      state.workerResults.push(duplicate);
      state.workerResults = state.workerResults.slice(-50);
      return duplicate;
    }
    if (isNoActionWorkerJob(job)) {
      const suppressed = rememberSuppressedWorkerResult(job, "no_action_result", scope);
      state.workerResults.push(suppressed);
      state.workerResults = state.workerResults.slice(-50);
      return suppressed;
    }
    const interrupt = cancelActiveResponse("worker_result_ready");
    const delivery = await deliverWorkerResult(job, { interrupt });
    state.workerResults.push(delivery);
    state.workerResults = state.workerResults.slice(-50);
    return delivery;
  }

  async function simulateRealtimeAgentToolCall(name, args = {}) {
    if (!isLocalToolName(name)) {
      throw new Error(`unsupported local tool for SDK smoke: ${name}`);
    }
    const callId = `mock_call_${randomEventId()}`;
    const execution = await runLocalToolForSDK(name, args, callId);
    recordTimeline("realtime_agent_sdk_mock_tool_call", { name, callId });
    return { ok: true, name, callId, result: execution.result, delivery: execution.delivery };
  }

  window.MAB_REALTIME_CLIENT = {
    state,
    connect: connectRealtime,
    disconnect: cleanupRealtimeConnection,
    reconnect: (reason = "manual") => {
      cleanupRealtimeConnection(reason);
      return connectRealtime();
    },
    cancelActiveResponse,
    sendSessionUpdate,
    runLocalAvatarTool,
    runLocalWorkerTool,
    runLocalMeetTool,
    runRealtimeAgentSDKTool: simulateRealtimeAgentToolCall,
    simulateRealtimeAgentToolCall,
    sendRealtimeEvent,
    pushSessionContext,
    rememberSessionContext,
    contextHealth: () => updateContextHealthFromHistory(currentHistorySnapshot()),
    buildCompactedHistory,
    compactRealtimeHistory,
    resetHistory: compactRealtimeHistory,
    discoverParticipantAudioStreams,
    registerParticipantAudioStream,
    stopMeetAudioCapture,
    injectWorkerResult,
    sendWorkerResult: injectWorkerResult,
  };

  window.MAB_REALTIME_BRIDGE = state as unknown as Record<string, unknown>;

  window.addEventListener("meeting-avatar-worker-result", (event: Event) => {
    try {
      const detail = (event as CustomEvent).detail || {};
      if (detail?.status === "failed") {
        updateAvatarHudStatus("blocked", "Blocked", { mood: "sad", action: "shrug" });
      } else if (detail?.status === "completed" || detail?.status === "done") {
        updateAvatarHudStatus("done", "Done", { mood: "happy", action: "emphasize" });
      }
      injectWorkerResult(detail);
    } catch (error) {
      rememberError(error);
    }
  });

  window.addEventListener("meeting-avatar-realtime-server-event", (event: Event) => {
    const detail = (event as CustomEvent).detail as { __meetingAvatarInboundRecorded?: boolean };
    if (detail?.__meetingAvatarInboundRecorded !== true) {
      rememberInboundEvent(detail, "custom-event");
    }
    handleRealtimeServerEvent(detail);
  });

  window.addEventListener("meeting-avatar-user-speech-started", () => {
    const result = cancelActiveResponse("user_speech_started");
    if (!result.skipped) state.protection.userSpeechCancels += 1;
  });

  installParticipantAudioDiscovery();

  if (config.autoConnect && shouldAutoConnectInCurrentDocument()) {
    window.setTimeout(() => connectRealtime(), 0);
  }
})();
