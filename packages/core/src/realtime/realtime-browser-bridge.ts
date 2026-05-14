(() => {
  if (window.__meetingAvatarRealtimeBridge) return;
  if (window.top !== window) return;
  window.__meetingAvatarRealtimeBridge = true;

  interface RealtimeEventSummary {
    type: string;
    responseId?: string;
    itemType?: string;
    name?: string;
    callId?: string;
    error?: string;
    delta?: string;
    transcript?: string;
    text?: string;
  }

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
    fallbackToLocalMic: boolean;
    instructions: string;
    tools: RealtimeToolLike[];
    toolChoice?: string;
    session: RealtimeSessionShape;
    sendSessionUpdateOnConnect: boolean;
    autoRespondToWorkerToolCalls: boolean;
    autoRespondToMeetToolCalls: boolean;
    observeMeetChat: boolean;
    botName: string;
    simulateRemoteAudio?: boolean;
    rtcConfiguration?: RTCConfiguration;
    [key: string]: unknown;
  }

  const config: RealtimeBridgeConfig = {
    mode: "mock",
    autoRespondToWorkerResults: true,
    autoRespondToAvatarToolCalls: true,
    autoConnect: false,
    tokenUrl: "/realtime/client-secret",
    sdpUrl: "",
    workerDelegateUrl: "/worker/delegate",
    workerStatusUrl: "/worker/status",
    includeParticipantAudio: false,
    forwardMeetAudioToRealtime: true,
    fallbackToLocalMic: false,
    instructions: "",
    tools: [],
    session: {},
    sendSessionUpdateOnConnect: true,
    autoRespondToWorkerToolCalls: true,
    autoRespondToMeetToolCalls: true,
    observeMeetChat: true,
    botName: "Meeting Avatar Bot",
    ...(window.MAB_REALTIME_BRIDGE_CONFIG || {}),
  };

  const state = {
    ok: true,
    mode: config.mode,
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
      recvOnlyAudioTransceiverAdded: false,
      realtimeInputPlaceholderAdded: false,
      realtimeInputGateOpen: true,
      meetAudioForwardingEnabled: config.forwardMeetAudioToRealtime !== false,
      meetAudioTracksForwarded: 0,
      lastMeetAudioTrackId: "",
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
  };
  const participantStreams = [];
  const participantTrackIds = new Set();
  const addedParticipantTrackIds = new Set();
  const injectedWorkerJobIds = new Set();
  const handledLocalToolCallIds = new Set();
  let activePeerConnection = null;
  let realtimeAudioSender = null;
  let routingAudioContext = null;
  let routingInputGate = null;
  let routingDestination = null;
  let routingSilenceSource = null;
  let silentMeetAudioTrack = null;
  let primaryMeetAudioSender = null;
  let peerConnectionHookInstalled = false;
  let reconnectTimer = null;
  let reconnectGeneration = 0;
  const observedMeetChatKeys = new Set();
  let meetChatObserver = null;
  let meetChatPollTimer = null;
  const pendingMeetAudioTracks = [];
  const routedMeetAudioTrackIds = new Set();
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
    "read_meet_chat",
  ]);
  const LOCAL_WORKSPACE_TOOLS = new Set([
    "current_user_identity",
    "search_team_members",
    "linear_query",
    "linear_user_issues",
    "google_calendar",
    "calendar_attendees",
    "slack_search",
    "notion_search",
    "github_search",
    "fetch_url",
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

  function recordTimeline(type, detail = {}) {
    state.timeline.push({
      ts: new Date().toISOString(),
      type,
      detail,
    });
    state.timeline = state.timeline.slice(-120);
  }

  function summarizeRealtimeEvent(event: unknown): RealtimeEventSummary {
    const eventObj = (typeof event === "object" && event !== null ? event : {}) as Record<
      string,
      unknown
    >;
    const summary: RealtimeEventSummary = {
      type: (eventObj.type as string | undefined) || typeof event,
    };
    const response = eventObj.response as { id?: string } | undefined;
    if (response?.id) summary.responseId = response.id;
    const item = eventObj.item as { type?: string } | undefined;
    if (item?.type) summary.itemType = item.type;
    if (eventObj.name) summary.name = String(eventObj.name);
    const callId = (eventObj.call_id || eventObj.callId) as string | undefined;
    if (callId) summary.callId = callId;
    const errorObj = eventObj.error as { message?: string } | undefined;
    if (errorObj?.message) summary.error = String(errorObj.message).slice(0, 300);
    if (typeof eventObj.delta === "string") summary.delta = eventObj.delta.slice(0, 300);
    if (typeof eventObj.transcript === "string")
      summary.transcript = eventObj.transcript.slice(0, 500);
    if (typeof eventObj.text === "string") summary.text = eventObj.text.slice(0, 500);
    if (typeof event === "string") summary.text = event.slice(0, 300);
    return summary;
  }

  function rememberTranscriptEvent(event) {
    const type = String(event?.type || "");
    if (type === "response.output_audio_transcript.delta" && typeof event.delta === "string") {
      state.transcripts.currentOutput += event.delta;
      state.transcripts.currentOutput = state.transcripts.currentOutput.slice(-4000);
      return;
    }
    if (type === "response.output_audio_transcript.done") {
      const text = String(event.transcript || state.transcripts.currentOutput || "").trim();
      if (text) {
        state.transcripts.output.push({
          ts: new Date().toISOString(),
          text: text.slice(0, 2000),
        });
        state.transcripts.output = state.transcripts.output.slice(-10);
      }
      state.transcripts.currentOutput = "";
      return;
    }
    if (
      type === "conversation.item.input_audio_transcription.delta" &&
      typeof event.delta === "string"
    ) {
      state.transcripts.currentInput += event.delta;
      state.transcripts.currentInput = state.transcripts.currentInput.slice(-4000);
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const text = String(event.transcript || state.transcripts.currentInput || "").trim();
      if (text) {
        state.transcripts.input.push({
          ts: new Date().toISOString(),
          text: text.slice(0, 2000),
        });
        state.transcripts.input = state.transcripts.input.slice(-10);
      }
      state.transcripts.currentInput = "";
    }
  }

  function classifyRealtimeFeedback() {
    const checks = {
      peerConnected:
        state.connected === true ||
        ["connected", "completed"].includes(state.connection.peerConnectionState),
      dataChannelOpen: state.connection.dataChannelOpen === true,
      sessionConfigured: state.session.configured === true,
      participantAudioForwardingEnabled:
        state.connection.participantAudioForwardingEnabled === true,
      meetAudioForwardingEnabled: state.connection.meetAudioForwardingEnabled === true,
      localAudioFallbackEnabled: state.connection.localAudioFallbackEnabled === true,
      realtimeInputPlaceholderAdded: state.connection.realtimeInputPlaceholderAdded === true,
      inputAudioAdded:
        state.connection.participantAudioTracksAdded > 0 ||
        state.connection.meetAudioTracksForwarded > 0 ||
        state.connection.localAudioTrackAdded === true,
      participantAudioAdded: state.connection.participantAudioTracksAdded > 0,
      meetAudioTracksForwarded: state.connection.meetAudioTracksForwarded,
      localAudioTrackAdded: state.connection.localAudioTrackAdded === true,
      recvOnlyAudioTransceiverAdded: state.connection.recvOnlyAudioTransceiverAdded === true,
      inboundEvents: state.inbound.length,
      responseEvents: state.inbound.filter((entry) =>
        String(entry.event?.type || "").startsWith("response."),
      ).length,
      remoteAudioAttached: state.connection.remoteAudioAttached === true,
      remoteAudioRoutedToAvatarBus: state.connection.remoteAudioRoutedToAvatarBus === true,
      avatarToolCalls: state.avatarTools.calls.length,
      workerToolCalls: state.workerTools.calls.length,
      meetToolCalls: state.meetTools.calls.length,
      workspaceToolCalls: state.workspaceTools.calls.length,
      inputTranscriptChars: state.transcripts.input.reduce(
        (sum, entry) => sum + String(entry.text || "").length,
        0,
      ),
      outputTranscriptChars: state.transcripts.output.reduce(
        (sum, entry) => sum + String(entry.text || "").length,
        0,
      ),
      errors: state.errors.length,
    };
    const blockers = [];
    let status = "ready";
    let summary;

    if (checks.errors) {
      status = "error";
      summary = "Realtime bridge reported errors.";
      blockers.push("bridge_errors_present");
    } else if (!checks.peerConnected) {
      status = "blocked";
      summary = "Realtime peer connection is not connected.";
      blockers.push("peer_not_connected");
    } else if (!checks.dataChannelOpen) {
      status = "blocked";
      summary = "Realtime data channel is not open.";
      blockers.push("data_channel_not_open");
    } else if (!checks.sessionConfigured) {
      status = "blocked";
      summary = "Realtime session.update has not been sent.";
      blockers.push("session_not_configured");
    } else if (!checks.inboundEvents) {
      if (!checks.inputAudioAdded) {
        status = "waiting_for_turn";
        summary = checks.realtimeInputPlaceholderAdded
          ? "Realtime is connected with a silent input placeholder; waiting for Meet participant audio."
          : "Realtime is connected in output-only mode; send a text/tool turn or enable Meet audio forwarding.";
        blockers.push(
          checks.realtimeInputPlaceholderAdded
            ? "waiting_for_meet_audio"
            : "input_audio_not_configured",
        );
      } else {
        status = "waiting_for_model";
        summary = "Realtime is connected, but no server events have been received yet.";
        blockers.push("no_realtime_server_events");
      }
    } else if (!checks.responseEvents) {
      status = "waiting_for_response";
      summary = "Realtime server events are arriving, but no response events have been observed.";
      blockers.push("no_response_events");
    } else if (!checks.remoteAudioAttached) {
      status = "output_blocked";
      summary = "Realtime response events exist, but no remote audio track is attached.";
      blockers.push("remote_audio_not_attached");
    } else if (!checks.remoteAudioRoutedToAvatarBus) {
      status = "output_blocked";
      summary = "Realtime remote audio is attached but not routed into the avatar audio bus.";
      blockers.push("remote_audio_not_routed");
    } else {
      summary = checks.inputAudioAdded
        ? "Realtime E2E transport is healthy: input track, model events, output audio, and avatar audio route are present."
        : "Realtime output path is healthy for text/tool turns; audio input is intentionally disabled to avoid avatar self-echo.";
    }

    return {
      status,
      summary,
      blockers,
      checks,
      updatedAt: new Date().toISOString(),
    };
  }

  function updateFeedback() {
    state.feedback = classifyRealtimeFeedback();
    return state.feedback;
  }

  function rememberInboundEvent(event, source = "data-channel") {
    const summary = summarizeRealtimeEvent(event);
    state.inbound.push({
      ts: new Date().toISOString(),
      source,
      event: summary,
    });
    state.inbound = state.inbound.slice(-100);
    state.connection.dataChannelMessagesReceived += 1;
    state.connection.lastInboundEventAt = new Date().toISOString();
    state.connection.lastInboundEventType = summary.type || "";
    rememberTranscriptEvent(event);
    recordTimeline("realtime_inbound", { source, ...summary });
    updateFeedback();
  }

  function ensureMeetAudioRoutingContext() {
    if (routingDestination) return routingDestination;
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    routingAudioContext = routingAudioContext || new AudioContextImpl({ sampleRate: 48000 });
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
    });
    return routingDestination;
  }

  function setRealtimeInputGate(open, reason = "") {
    if (!routingInputGate || !routingAudioContext) return;
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
        updateFeedback();
      })
      .catch((error) => rememberError(error));
    return true;
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
      state.connection.meetAudioTracksForwarded += 1;
      state.connection.lastMeetAudioTrackId = track.id;
      recordTimeline("meet_audio_track_forwarded", {
        trackId: track.id,
        label: track.label || "",
        ...detail,
      });
      if (!realtimeAudioSender) {
        pendingMeetAudioTracks.push(track);
        recordTimeline("meet_audio_track_pending", { trackId: track.id });
        updateFeedback();
        return true;
      }
      replaceRealtimeInputWithRoutingMix("meet-audio-forwarded");
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

  function silenceDuplicateMeetAudioSender(sender, pcId, source) {
    if (!sender || !silentMeetAudioTrack || sender === primaryMeetAudioSender) return;
    sender
      .replaceTrack(silentMeetAudioTrack.clone())
      .then(() => {
        state.connection.duplicateMeetAudioSendersMuted += 1;
        recordTimeline("duplicate_meet_audio_sender_muted", { pcId, source });
        updateFeedback();
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

  function instrumentMeetSender(pc, pcId, sender, source) {
    if (!sender || sender.__meetingAvatarRealtimeInstrumented) return sender;
    sender.__meetingAvatarRealtimeInstrumented = true;
    const originalReplaceTrack = sender.replaceTrack?.bind(sender);
    if (originalReplaceTrack) {
      sender.replaceTrack = async function (track) {
        const result = await originalReplaceTrack(track);
        handleMeetOutboundAudioSender(pc, pcId, sender, track, `${source}.replaceTrack`);
        return result;
      };
    }
    if (sender.track?.kind === "audio") {
      handleMeetOutboundAudioSender(pc, pcId, sender, sender.track, source);
    }
    return sender;
  }

  function scanMeetOutboundSenders(pc, pcId) {
    if (pc === activePeerConnection || typeof pc.getSenders !== "function") return;
    pc.getSenders().forEach((sender, index) => {
      instrumentMeetSender(pc, pcId, sender, `scan[${index}]`);
      if (sender?.track?.kind === "audio") {
        handleMeetOutboundAudioSender(pc, pcId, sender, sender.track, `scan[${index}]`);
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
          handleMeetOutboundAudioSender(pc, pcId, sender, track, "addTrack");
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

  interface RealtimeToolLike {
    name?: string;
    server_label?: string;
    type?: string;
    [key: string]: unknown;
  }

  function normalizeToolNames(tools: RealtimeToolLike[] = []): string[] {
    return tools
      .map((tool) => tool?.name || tool?.server_label || tool?.type || "")
      .filter(Boolean);
  }

  function isLegacyRealtimeSessionSchema(value: unknown): boolean {
    return ["legacy", "v1", "1", "1.5", "realtime-1.5"].includes(String(value || "").toLowerCase());
  }

  function defaultRealtime2Session(session: RealtimeSessionShape = {}): RealtimeSessionShape {
    const merged: RealtimeSessionShape & {
      reasoning?: { effort?: string };
      voice?: string;
    } = { ...session };
    merged.type = merged.type || "realtime";
    merged.model = merged.model || "gpt-realtime-2";
    merged.output_modalities = merged.output_modalities ||
      merged.outputModalities ||
      merged.modalities || ["audio"];
    delete merged.outputModalities;
    delete merged.modalities;
    const inputTurnDetection = merged.audio?.input?.turn_detection ?? merged.turn_detection;
    merged.audio = {
      ...(merged.audio || {}),
      input: {
        ...(merged.audio?.input || {}),
        format: {
          type: "audio/pcm",
          rate: 24000,
          ...(merged.audio?.input?.format || {}),
        },
        turn_detection:
          inputTurnDetection === null
            ? null
            : {
                type: "semantic_vad",
                ...((inputTurnDetection as Record<string, unknown> | undefined) || {}),
              },
      },
      output: {
        ...(merged.audio?.output || {}),
        format: {
          type: "audio/pcm",
          rate: 24000,
          ...(merged.audio?.output?.format || {}),
        },
        voice: merged.audio?.output?.voice || merged.voice || "marin",
      },
    };
    delete merged.voice;
    delete merged.turn_detection;
    if (!merged.reasoning && String(merged.model || "").includes("gpt-realtime-2")) {
      merged.reasoning = { effort: "high" };
    }
    return merged;
  }

  interface BuildSessionUpdateOptions {
    session?: RealtimeSessionShape & { schema?: string; session_schema?: string };
    instructions?: string;
    tools?: RealtimeToolLike[];
    toolChoice?: string;
    sessionSchema?: string;
  }

  function buildSessionUpdateEvent(options: BuildSessionUpdateOptions = {}) {
    const schema = String(
      options.session?.schema ||
        options.session?.session_schema ||
        options.sessionSchema ||
        "realtime-2",
    ).toLowerCase();
    const session: RealtimeSessionShape & {
      schema?: string;
      session_schema?: string;
      tool_choice?: string;
    } = isLegacyRealtimeSessionSchema(schema)
      ? { ...(options.session || {}) }
      : defaultRealtime2Session(options.session || {});
    delete session.schema;
    delete session.session_schema;
    const instructions = options.instructions ?? session.instructions;
    const tools = Array.isArray(options.tools) ? options.tools : session.tools;
    if (instructions) session.instructions = instructions;
    if (Array.isArray(tools) && tools.length) session.tools = tools;
    if (options.toolChoice) session.tool_choice = options.toolChoice;
    return {
      type: "session.update" as const,
      session,
    };
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
    state.session.toolNames = normalizeToolNames(
      (event.session?.tools as RealtimeToolLike[] | undefined) || [],
    );
    updateFeedback();
    return { ok: true, channel, event };
  }

  function injectCurrentUserContext() {
    const instructions = String(config.instructions || "");
    const identityLines = instructions
      .split("\n")
      .filter((line) => /^Current (speaker\/user|user identity):/.test(line))
      .join("\n");
    if (!identityLines) return { ok: true, skipped: true, reason: "no_identity_context" };
    const channel = sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `Persistent meeting context:\n${identityLines}\nIf the user asks who they are, answer from this context or call current_user_identity.`,
          },
        ],
      },
    });
    return { ok: true, channel };
  }

  function configureRealtimeSession() {
    if (config.sendSessionUpdateOnConnect === false) return { ok: true, skipped: true };
    const sessionUpdate = sendSessionUpdate();
    const identityContext = injectCurrentUserContext();
    return { ok: true, sessionUpdate, identityContext };
  }

  function cleanupRealtimeConnection(reason = "cleanup") {
    reconnectGeneration += 1;
    const channel = window.MAB_REALTIME_DATA_CHANNEL || window.MAB_REALTIME_DC;
    try {
      if (channel && channel.readyState !== "closed") channel.close();
    } catch {
      // Best-effort close before reconnecting.
    }
    try {
      activePeerConnection?.getSenders?.().forEach((sender) => {
        if (sender.track && sender.track !== silentMeetAudioTrack) sender.track.stop?.();
      });
    } catch {
      // Best-effort cleanup.
    }
    try {
      activePeerConnection?.close?.();
    } catch {
      // Best-effort cleanup.
    }
    activePeerConnection = null;
    realtimeAudioSender = null;
    window.MAB_REALTIME_DATA_CHANNEL = null;
    window.MAB_REALTIME_DC = null;
    window.MAB_REALTIME_PEER_CONNECTION = null;
    state.connected = false;
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

  function cancelActiveResponse(reason = "interrupt") {
    if (!state.protection.activeResponseId)
      return { ok: true, skipped: true, reason: "no_active_response" };
    const channel = sendRealtimeEvent({
      type: "response.cancel",
      response_id: state.protection.activeResponseId,
    });
    state.protection.cancelledResponses += 1;
    const cancelledResponseId = state.protection.activeResponseId;
    state.protection.activeResponseId = "";
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
      setRealtimeInputGate(false, event.type);
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
      setRealtimeInputGate(true, event.type);
    }
    handleLocalToolCallEvent(event);
  }

  function parseToolArguments(rawArguments) {
    if (!rawArguments) return {};
    if (typeof rawArguments === "object") return rawArguments;
    try {
      return JSON.parse(String(rawArguments));
    } catch {
      return {};
    }
  }

  function extractLocalToolCall(event) {
    if (event.type === "response.function_call_arguments.done" && isLocalToolName(event.name)) {
      return {
        name: event.name,
        callId: event.call_id || event.callId || "",
        arguments: parseToolArguments(event.arguments),
      };
    }
    const item = event.item || event.output_item || {};
    if (
      event.type === "response.output_item.done" &&
      item.type === "function_call" &&
      isLocalToolName(item.name)
    ) {
      return {
        name: item.name,
        callId: item.call_id || item.callId || event.call_id || "",
        arguments: parseToolArguments(item.arguments),
      };
    }
    if (event.type === "response.done") {
      const output = event.response?.output || [];
      const functionCall = output.find(
        (entry) => entry?.type === "function_call" && isLocalToolName(entry.name),
      );
      if (functionCall) {
        return {
          name: functionCall.name,
          callId: functionCall.call_id || functionCall.callId || "",
          arguments: parseToolArguments(functionCall.arguments),
        };
      }
    }
    return null;
  }

  interface AvatarToolArgs {
    mood?: string;
    holdMs?: number;
    action?: string;
    intensity?: number;
    durationMs?: number;
    [key: string]: unknown;
  }

  function runLocalAvatarTool(name: string, args: AvatarToolArgs = {}) {
    const controller = window.MAB_AVATAR_CONTROLLER;
    if (!controller) throw new Error("avatar controller is not available");
    if (name === "set_avatar_expression") {
      if (!controller.setExpression) throw new Error("controller.setExpression not available");
      return controller.setExpression(args.mood || "neutral", { holdMs: args.holdMs });
    }
    if (name === "set_avatar_action") {
      if (!controller.setAction) throw new Error("controller.setAction not available");
      return controller.setAction(args.action || "idle", args.intensity ?? 0.8, {
        holdMs: args.holdMs,
        durationMs: args.durationMs,
      });
    }
    if (name === "update_avatar_state") return controller.updateState(args);
    throw new Error(`unsupported local avatar tool: ${name}`);
  }

  async function postJson(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = { ok: false, error: "invalid_json_response" };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, body: payload };
    }
    return payload as { ok?: boolean; [key: string]: unknown };
  }

  function localServiceUrl(path: string): string {
    try {
      return new URL(path, new URL(config.tokenUrl, window.location.href).origin).toString();
    } catch {
      return path;
    }
  }

  interface WorkerToolArgs {
    task?: string;
    context?: Record<string, unknown>;
    mode?: string;
    allowCodeChanges?: boolean;
    allow_code_changes?: boolean;
    jobId?: string;
    job_id?: string;
    id?: string;
    [key: string]: unknown;
  }

  async function runLocalWorkerTool(name: string, args: WorkerToolArgs = {}) {
    if (name === "delegate_to_worker" || name === "delegate_to_codex") {
      if (!args.task) throw new Error("delegate_to_worker requires task");
      return postJson(config.workerDelegateUrl, {
        task: args.task,
        context: args.context || {},
        mode: args.mode || "analysis",
        allowCodeChanges: Boolean(args.allowCodeChanges || args.allow_code_changes),
      });
    }
    if (name === "worker_status" || name === "delegate_status") {
      return postJson(config.workerStatusUrl, {
        jobId: args.jobId || args.job_id || args.id || "",
      });
    }
    throw new Error(`unsupported local worker tool: ${name}`);
  }

  function getElementLabel(element) {
    if (!element) return "";
    return [
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-tooltip"),
      element.getAttribute?.("data-tooltip-id"),
      element.getAttribute?.("placeholder"),
      element.innerText,
      element.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function isVisibleElement(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)
      return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findMeetChatInput(): HTMLElement | null {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        [
          "textarea",
          "input[type='text']",
          "input:not([type])",
          "[contenteditable='true']",
          "[role='textbox']",
        ].join(","),
      ),
    );
    return (
      candidates.find((element) => {
        if (!isVisibleElement(element)) return false;
        const label = getElementLabel(element);
        if (label.includes("search")) return false;
        if (label.includes("your name")) return false;
        return (
          label.includes("message") ||
          label.includes("chat") ||
          label.includes("send") ||
          label.includes("everyone") ||
          label.includes("输入") ||
          label.includes("消息") ||
          element.isContentEditable
        );
      }) || null
    );
  }

  function findVisibleButtonByLabels(labels: string[] = []): HTMLButtonElement | null {
    const lowerLabels = labels.map((label) => String(label).toLowerCase());
    const candidates = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button,[role='button']"),
    );
    return (
      candidates.find((element) => {
        if (!isVisibleElement(element)) return false;
        if (element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
        const label = getElementLabel(element);
        return lowerLabels.some((needle) => label.includes(needle));
      }) || null
    );
  }

  async function waitForMeetChatInput(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const input = findMeetChatInput();
      if (input) return input;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return null;
  }

  function setMeetChatInputText(input, text) {
    input.focus?.();
    if (input.isContentEditable || input.getAttribute?.("contenteditable") === "true") {
      try {
        document.getSelection()?.selectAllChildren(input);
        document.execCommand?.("insertText", false, text);
      } catch {
        input.textContent = text;
      }
      if (!String(input.innerText || input.textContent || "").includes(text)) {
        input.textContent = text;
      }
    } else {
      const prototype =
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) descriptor.set.call(input, text);
      else input.value = text;
    }
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
    );
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getInputText(input) {
    return String(
      input?.isContentEditable || input?.getAttribute?.("contenteditable") === "true"
        ? input.innerText || input.textContent || ""
        : input?.value || "",
    ).trim();
  }

  function findMeetChatSendButton(input) {
    const inputRect = input?.getBoundingClientRect?.() || null;
    const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>("button,[role='button']"))
      .filter((element) => {
        if (!isVisibleElement(element)) return false;
        if (element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
        const label = getElementLabel(element);
        if (label.includes("reaction") || label.includes("mood") || label.includes("emoji"))
          return false;
        return /\b(send|send message|send a message)\b|发送|傳送/.test(label);
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const distance = inputRect
          ? Math.abs((rect.top + rect.bottom) / 2 - (inputRect.top + inputRect.bottom) / 2) +
            Math.max(0, inputRect.left - rect.right)
          : 0;
        return { element, distance, label: getElementLabel(element) };
      })
      .sort((a, b) => a.distance - b.distance);
    return candidates[0]?.element || null;
  }

  async function waitForMeetChatSendButton(input, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const button = findMeetChatSendButton(input);
      if (button) return button;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return null;
  }

  async function waitForMeetChatSent(input, text, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const currentText = getInputText(input);
      if (!currentText || !currentText.includes(text)) return "input-cleared";
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    return "";
  }

  async function triggerMeetChatSubmit(input, text) {
    const sendButton = await waitForMeetChatSendButton(input);
    if (sendButton) {
      sendButton.click();
      return "send-button";
    }
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
      }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }),
    );
    return "enter-key";
  }

  interface SendMeetChatArgs {
    text?: string;
    message?: string;
    [key: string]: unknown;
  }

  interface MeetFixtureChatMessage {
    ts?: string;
    sender?: string;
    source?: string;
    text?: string;
    [key: string]: unknown;
  }

  type MeetFixture =
    | (Record<string, unknown> & {
        chatMessages?: MeetFixtureChatMessage[];
      })
    | null
    | undefined;

  async function sendMeetChat(args: SendMeetChatArgs = {}) {
    const text = String(args.text || args.message || "").trim();
    if (!text) throw new Error("send_meet_chat requires text");

    const fixture = window.__MAB_MEET_FIXTURE as MeetFixture;
    if (fixture) {
      const beforeCount = fixture.chatMessages?.length || 0;
      window.dispatchEvent(new CustomEvent("meeting-avatar-meet-chat-send", { detail: { text } }));
      const afterCount = fixture.chatMessages?.length || 0;
      if (afterCount > beforeCount) {
        return {
          ok: true,
          path: "fixture-event",
          text,
          count: afterCount,
          sentAt: new Date().toISOString(),
        };
      }
    }

    let input = await waitForMeetChatInput(400);
    if (!input) {
      const chatButton = findVisibleButtonByLabels([
        "chat",
        "chat with everyone",
        "open chat",
        "show everyone",
        "messages",
        "聊天",
        "訊息",
        "消息",
      ]);
      if (!chatButton) throw new Error("meet chat button not found");
      chatButton.click();
      input = await waitForMeetChatInput(3000);
    }
    if (!input) throw new Error("meet chat input not found");
    setMeetChatInputText(input, text);
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    const submitPath = await triggerMeetChatSubmit(input, text);
    const sentConfirmation = await waitForMeetChatSent(input, text);
    if (!sentConfirmation) {
      return {
        ok: false,
        error: "meet_chat_submit_unconfirmed",
        path: "meet-dom",
        submitPath,
        inputText: getInputText(input),
        text,
      };
    }
    return {
      ok: true,
      path: "meet-dom",
      submitPath,
      sentConfirmation,
      text,
      sentAt: new Date().toISOString(),
    };
  }

  function extractUrls(text: unknown): string[] {
    return Array.from(String(text || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)).map((match) =>
      match[0].replace(/[.,，。!?！？;；:：]+$/g, ""),
    );
  }

  function readFixtureMeetChat(limit: number, onlyLinks: boolean) {
    const fixture = window.__MAB_MEET_FIXTURE as MeetFixture;
    const messages = (fixture?.chatMessages || []).slice(-limit).map((entry) => ({
      ts: entry.ts || "",
      sender: entry.source || "",
      text: String(entry.text || ""),
      links: extractUrls(entry.text || ""),
    }));
    return onlyLinks ? messages.filter((entry) => entry.links.length) : messages;
  }

  function findMeetChatMessageElements(): HTMLElement[] {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        [
          "[data-message-id]",
          "[data-message-text]",
          "[data-message-text-content]",
          "[role='listitem']",
          "[role='article']",
          "a[href^='http']",
        ].join(","),
      ),
    );
    return candidates.filter((element) => {
      if (!isVisibleElement(element)) return false;
      const text = String(element.innerText || element.textContent || "").trim();
      const href = (element as HTMLAnchorElement).href || "";
      if (!text && !href) return false;
      if (/^(chat|messages|send a message|发送消息|訊息|聊天)$/i.test(text)) return false;
      return (
        /^https?:\/\//.test(href) ||
        /https?:\/\//.test(text) ||
        Boolean(
          element.closest(
            "[aria-label*='Chat'],[aria-label*='chat'],[aria-label*='messages'],[aria-label*='Messages']",
          ),
        ) ||
        text.length < 500
      );
    });
  }

  async function ensureMeetChatOpen() {
    if (findMeetChatInput()) return true;
    const chatButton = findVisibleButtonByLabels([
      "chat",
      "chat with everyone",
      "open chat",
      "show everyone",
      "messages",
      "聊天",
      "訊息",
      "消息",
    ]);
    if (!chatButton) return false;
    chatButton.click();
    await waitForMeetChatInput(2500);
    return true;
  }

  interface ReadMeetChatArgs {
    limit?: number;
    onlyLinks?: boolean;
    only_links?: boolean;
    [key: string]: unknown;
  }

  async function readMeetChat(args: ReadMeetChatArgs = {}) {
    const limit = Math.max(1, Math.min(Number(args.limit || 10), 50));
    const onlyLinks = Boolean(args.onlyLinks || args.only_links);
    if (window.__MAB_MEET_FIXTURE) {
      const messages = readFixtureMeetChat(limit, onlyLinks);
      return {
        ok: true,
        path: "fixture-state",
        messages,
        links: messages.flatMap((entry) => entry.links),
        count: messages.length,
        readAt: new Date().toISOString(),
      };
    }
    await ensureMeetChatOpen();
    const seen = new Set();
    const messages = [];
    for (const element of findMeetChatMessageElements()) {
      const rawText = String(element.innerText || element.textContent || "").trim();
      const text = rawText.replace(/\s+/g, " ").slice(0, 1000);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const links = Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .map((anchor) => anchor.href)
        .filter((href) => /^https?:\/\//.test(href));
      for (const url of extractUrls(text)) {
        if (!links.includes(url)) links.push(url);
      }
      if (onlyLinks && links.length === 0) continue;
      messages.push({
        text,
        links,
      });
    }
    const recent = messages.slice(-limit);
    return {
      ok: true,
      path: "meet-dom",
      messages: recent,
      links: Array.from(new Set(recent.flatMap((entry) => entry.links))),
      count: recent.length,
      readAt: new Date().toISOString(),
    };
  }

  interface MeetChatMessageEntry {
    text: string;
    links: string[];
  }

  function normalizeMeetChatElement(element: HTMLElement): MeetChatMessageEntry | null {
    const rawText = String(element.innerText || element.textContent || "").trim();
    const href = (element as HTMLAnchorElement).href || "";
    const text = (rawText || href).replace(/\s+/g, " ").slice(0, 1000);
    if (!text) return null;
    const anchors = element.querySelectorAll
      ? Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]"))
      : [];
    const links = anchors
      .map((anchor) => anchor.href)
      .filter((url) => /^https?:\/\//.test(url));
    if (/^https?:\/\//.test(href) && !links.includes(href)) links.push(href);
    for (const url of extractUrls(text)) {
      if (!links.includes(url)) links.push(url);
    }
    if (
      !links.length &&
      /^(more_vert|call_end|info|chat_bubble|apps|mood|closed_caption|back_hand|keep|pin message|send message)$/i.test(
        text,
      )
    )
      return null;
    if (!links.length && text.length < 8) return null;
    return {
      text,
      links: Array.from(new Set(links)),
    };
  }

  interface RememberMeetChatMessageOptions {
    inject?: boolean;
    [key: string]: unknown;
  }

  function rememberMeetChatMessage(
    message: MeetChatMessageEntry | null,
    source: string = "observer",
    options: RememberMeetChatMessageOptions = {},
  ) {
    if (!message?.text) return { ok: false, skipped: true, reason: "empty_message" };
    const botName = String(config.botName || "").trim();
    if (botName && message.text.includes(botName)) {
      return { ok: false, skipped: true, reason: "own_message" };
    }
    const key = `${message.text}|${message.links.join(",")}`;
    if (observedMeetChatKeys.has(key)) return { ok: false, skipped: true, reason: "duplicate" };
    observedMeetChatKeys.add(key);
    if (options.inject === false) return { ok: true, seeded: true };
    const entry = {
      ts: new Date().toISOString(),
      source,
      text: message.text,
      links: message.links || [],
    };
    state.meetChat.messages.push(entry);
    state.meetChat.messages = state.meetChat.messages.slice(-30);
    state.meetChat.links = Array.from(
      new Set(state.meetChat.messages.flatMap((item) => item.links)),
    ).slice(-50);
    state.meetChat.lastObservedAt = entry.ts;
    recordTimeline("meet_chat_observed", {
      source,
      text: entry.text.slice(0, 200),
      links: entry.links,
    });
    const channel = sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Meet chat message from the operator: ${entry.text}${entry.links.length ? `\nLinks: ${entry.links.join(" ")}` : ""}`,
          },
        ],
      },
    });
    state.meetChat.injected += 1;
    updateFeedback();
    return { ok: true, channel, entry };
  }

  function scanMeetChatMessages(source = "scan", options = {}) {
    const results = [];
    for (const element of findMeetChatMessageElements()) {
      const message = normalizeMeetChatElement(element);
      if (!message) continue;
      const result = rememberMeetChatMessage(message, source, options);
      if (result.ok) results.push(result.entry);
    }
    return results;
  }

  async function installMeetChatObserver() {
    if (config.observeMeetChat === false || state.meetChat.observerInstalled)
      return { ok: true, skipped: true };
    await ensureMeetChatOpen();
    scanMeetChatMessages("initial-scan", { inject: false });
    meetChatObserver = new MutationObserver(() => {
      try {
        scanMeetChatMessages("mutation");
      } catch (error) {
        state.meetChat.errors.push({
          ts: new Date().toISOString(),
          message: String((error && error.message) || error).slice(0, 300),
        });
        state.meetChat.errors = state.meetChat.errors.slice(-20);
      }
    });
    meetChatObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    meetChatPollTimer = window.setInterval(() => {
      try {
        scanMeetChatMessages("poll");
      } catch (error) {
        state.meetChat.errors.push({
          ts: new Date().toISOString(),
          message: String((error && error.message) || error).slice(0, 300),
        });
        state.meetChat.errors = state.meetChat.errors.slice(-20);
      }
    }, 1500);
    state.meetChat.observerInstalled = true;
    recordTimeline("meet_chat_observer_installed", {});
    updateFeedback();
    return { ok: true };
  }

  async function runLocalMeetTool(name, args = {}) {
    if (name === "send_meet_chat") return sendMeetChat(args);
    if (name === "present_video_stage")
      return postJson(localServiceUrl("/screen-share/video"), args);
    if (name === "stop_video_stage") return postJson(localServiceUrl("/screen-share/stop"), args);
    if (name === "read_meet_chat") return readMeetChat(args);
    throw new Error(`unsupported local meet tool: ${name}`);
  }

  async function runLocalWorkspaceTool(name, args = {}) {
    if (!LOCAL_WORKSPACE_TOOLS.has(name))
      throw new Error(`unsupported local workspace tool: ${name}`);
    return postJson(localServiceUrl(`/tools/${encodeURIComponent(name)}`), args);
  }

  interface FunctionCallOutputOptions {
    autoRespond?: boolean;
    responseInstructions?: string;
  }

  function sendFunctionCallOutput(
    callId: string,
    result: unknown,
    options: FunctionCallOutputOptions = {},
  ) {
    if (!callId) return { ok: true, skipped: true, reason: "missing_call_id" };
    const outputChannel = sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    let responseChannel = "";
    if (options.autoRespond !== false) {
      responseChannel = sendRealtimeEvent({
        type: "response.create",
        response: {
          instructions: options.responseInstructions || "Continue after applying the tool result.",
        },
      });
      state.responsesRequested += 1;
    }
    return { ok: true, outputChannel, responseChannel };
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
          const delivery = sendFunctionCallOutput(toolCall.callId, result, {
            autoRespond: config.autoRespondToWorkerToolCalls,
            responseInstructions:
              toolCall.name === "delegate_to_worker"
                ? "Tell the user the task was delegated; if the worker result is already complete, summarize it now."
                : "Summarize the worker status in concise Chinese.",
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
          const delivery = sendFunctionCallOutput(toolCall.callId, result, {
            autoRespond: config.autoRespondToMeetToolCalls,
            responseInstructions:
              toolCall.name === "send_meet_chat"
                ? "Confirm briefly in Chinese that the Meet chat message was sent."
                : "Answer from the returned Meet chat messages/links in concise Chinese.",
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
          const delivery = sendFunctionCallOutput(toolCall.callId, result, {
            autoRespond: true,
            responseInstructions:
              "Summarize the workspace tool result in concise Chinese. If the tool failed, state the exact blocker.",
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
      const delivery = sendFunctionCallOutput(toolCall.callId, result, {
        autoRespond: config.autoRespondToAvatarToolCalls,
        responseInstructions: "Continue after applying the avatar visual state.",
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

  interface MockDataChannel {
    readyState: RTCDataChannelState;
    send(payload: unknown): void;
    close(): void;
  }

  function createMockDataChannel(): MockDataChannel {
    const channel: MockDataChannel = {
      readyState: "open",
      send(payload: unknown) {
        state.connection.sentDataChannelMessages.push({
          ts: new Date().toISOString(),
          payload,
        });
        state.connection.sentDataChannelMessages =
          state.connection.sentDataChannelMessages.slice(-100);
      },
      close() {
        channel.readyState = "closed";
        state.connected = false;
        state.connection.dataChannelOpen = false;
      },
    };
    return channel;
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

  async function waitForAvatarAudioBus(timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (window.MAB_AVATAR_AUDIO_BUS) return window.MAB_AVATAR_AUDIO_BUS;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return window.MAB_AVATAR_AUDIO_BUS || null;
  }

  interface RouteRemoteAudioOptions {
    label?: string;
    gain?: number;
    timeoutMs?: number;
  }

  async function routeRemoteAudioStream(
    stream: MediaStream | null | undefined,
    options: RouteRemoteAudioOptions = {},
  ) {
    const bus = await waitForAvatarAudioBus(options.timeoutMs);
    if (!bus?.addStream) {
      rememberError(new Error("avatar audio bus is not available for remote audio routing"));
      return { ok: false, error: "avatar_audio_bus_missing" };
    }
    const result = bus.addStream(stream, {
      label: options.label || "openai-realtime-remote-audio",
      gain: options.gain,
    });
    state.connection.remoteAudioRoutedToAvatarBus = result.ok === true;
    recordTimeline("remote_audio_route", {
      ok: result.ok === true,
      label: options.label || "openai-realtime-remote-audio",
      trackIds: stream?.getAudioTracks?.().map((track) => track.id) || [],
    });
    updateFeedback();
    return result;
  }

  interface MockRemoteAudioOptions extends RouteRemoteAudioOptions {
    durationMs?: number;
  }

  async function injectMockRemoteAudio(options: MockRemoteAudioOptions = {}) {
    const bus = await waitForAvatarAudioBus(options.timeoutMs);
    if (!bus?.injectTone) {
      rememberError(new Error("avatar audio bus is not available for mock remote audio injection"));
      return { ok: false, error: "avatar_audio_bus_missing" };
    }
    const result = bus.injectTone({
      label: options.label || "webrtc-mock-remote-audio",
      gain: options.gain ?? 0.0001,
      durationMs: options.durationMs ?? 120,
    });
    state.connection.remoteAudioRoutedToAvatarBus = result.ok === true;
    state.connection.mockRemoteAudioInjected = result.ok === true;
    recordTimeline("mock_remote_audio_route", { ok: result.ok === true });
    updateFeedback();
    return result;
  }

  async function connectRealtime(options = {}) {
    if (state.connected && (window.MAB_REALTIME_DATA_CHANNEL || window.MAB_REALTIME_DC)) {
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
      if (state.connection.mode === "mock" || state.connection.mode === "webrtc-mock") {
        const channel = createMockDataChannel();
        window.MAB_REALTIME_DATA_CHANNEL = channel as unknown as RTCDataChannel;
        window.MAB_REALTIME_DC = channel as unknown as RTCDataChannel;
        state.connected = true;
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

      const tokenResponse = await fetch(state.connection.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(connectionConfig.session || {}),
          instructions: connectionConfig.instructions,
          tools: connectionConfig.tools,
          toolChoice: connectionConfig.toolChoice,
        }),
      });
      const tokenBody = await tokenResponse.json();
      const ephemeralKey =
        tokenBody.value || tokenBody.client_secret?.value || tokenBody.secret?.value;
      if (!tokenResponse.ok || !ephemeralKey) {
        throw new Error(
          tokenBody.error || "Realtime client secret response did not include a value",
        );
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
        state.connected = pc.connectionState === "connected" || (pc.connectionState as string) === "completed";
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

      ensureMeetAudioRoutingContext();
      const [placeholderTrack] = routingDestination.stream.getAudioTracks();
      if (placeholderTrack) {
        realtimeAudioSender = pc.addTrack(placeholderTrack);
        state.connection.realtimeInputPlaceholderAdded = true;
        silentMeetAudioTrack = placeholderTrack.clone();
        recordTimeline("realtime_input_placeholder_added", { trackId: placeholderTrack.id });
        flushPendingMeetAudioTracks();
        updateFeedback();
      }

      discoverParticipantAudioStreams();
      addParticipantTracksToPeerConnection(pc);
      if (
        state.connection.participantAudioTracksAdded === 0 &&
        state.connection.realtimeInputPlaceholderAdded !== true &&
        connectionConfig.fallbackToLocalMic === true
      ) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const [track] = stream.getAudioTracks();
        if (track) {
          pc.addTrack(track, stream);
          state.connection.localAudioTrackAdded = true;
          recordTimeline("local_audio_track_added", { trackId: track.id });
          updateFeedback();
        }
      } else if (
        state.connection.participantAudioTracksAdded === 0 &&
        state.connection.realtimeInputPlaceholderAdded !== true
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
              : "participant_audio_tracks_present",
          participantAudioTracksAdded: state.connection.participantAudioTracksAdded,
        });
        updateFeedback();
      }

      const dataChannel = pc.createDataChannel("oai-events");
      window.MAB_REALTIME_DATA_CHANNEL = dataChannel;
      window.MAB_REALTIME_DC = dataChannel;
      dataChannel.onopen = () => {
        state.connected = true;
        state.connection.dataChannelOpen = true;
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
      };
      dataChannel.onclose = () => {
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
      };
      dataChannel.onmessage = (event) => {
        let detail = event.data;
        try {
          detail = JSON.parse(event.data);
        } catch {
          // Some providers/tools may send plain text diagnostic frames.
        }
        if (detail && typeof detail === "object") detail.__meetingAvatarInboundRecorded = true;
        rememberInboundEvent(detail, "data-channel");
        window.dispatchEvent(new CustomEvent("meeting-avatar-realtime-server-event", { detail }));
      };

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
        throw new Error(`Realtime SDP exchange failed: ${sdpResponse.status}`);
      }
      await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
      window.MAB_REALTIME_PEER_CONNECTION = pc;
      return { ok: true, mode: state.connection.mode };
    } catch (error) {
      rememberError(error);
      return { ok: false, error: String((error && error.message) || error) };
    } finally {
      state.connecting = false;
    }
  }

  function buildWorkerResultText(job) {
    const status = job.status === "failed" ? "失败" : "完成";
    const result = job.result || job.error || "没有返回详细结果。";
    return [
      `后台任务 ${status}。`,
      `任务：${job.task || job.id}`,
      `结果：${result}`,
      "请用 1-2 句中文主动汇报给会议里的用户。",
    ].join("\n");
  }

  function injectWorkerResult(job) {
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
    const itemEvent = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: buildWorkerResultText(job),
          },
        ],
      },
    };
    const itemChannel = sendRealtimeEvent(itemEvent);
    let responseChannel = "";
    if (config.autoRespondToWorkerResults) {
      responseChannel = sendRealtimeEvent({
        type: "response.create",
        response: {
          instructions: "Summarize the injected worker result proactively in concise Chinese.",
        },
      });
      state.responsesRequested += 1;
    }
    const delivery = {
      ts: new Date().toISOString(),
      jobId: job.id,
      status: job.status,
      itemChannel,
      responseChannel,
    };
    state.workerResults.push(delivery);
    state.workerResults = state.workerResults.slice(-50);
    return delivery;
  }

  window.MAB_REALTIME_CLIENT = {
    state,
    connect: connectRealtime,
    reconnect: (reason = "manual") => {
      cleanupRealtimeConnection(reason);
      return connectRealtime();
    },
    cancelActiveResponse,
    sendSessionUpdate,
    runLocalAvatarTool,
    runLocalWorkerTool,
    runLocalMeetTool,
    sendRealtimeEvent,
    discoverParticipantAudioStreams,
    registerParticipantAudioStream,
    injectWorkerResult,
    sendWorkerResult: injectWorkerResult,
  };

  window.MAB_REALTIME_BRIDGE = state as unknown as Record<string, unknown>;

  window.addEventListener("meeting-avatar-worker-result", (event: Event) => {
    try {
      const detail = (event as CustomEvent).detail || {};
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

  if (config.autoConnect) {
    window.setTimeout(() => connectRealtime(), 0);
  }
})();
