/* eslint-disable no-unused-vars */
let realtimeSessionRenewalTimer = 0;
const {
  clearRealtimeRemoteAudioTrackStats,
  createRealtimeAgentSDKDecodeElement,
  monitorRealtimeRemoteAudioTrack,
} = (window as any).__MAB_REALTIME_AGENT_AUDIO_HELPERS.create({
  state,
  updateFeedback,
});
const { createMockRealtimeAgentTransport } = (
  window as any
).__MAB_REALTIME_AGENT_TRANSPORT_HELPERS.create({
  state,
  recordTimeline,
});

function realtimeSessionRenewalMs() {
  const value = Number((config as Record<string, unknown>).realtimeSessionRenewalMs);
  if (value === 0) return 0;
  return Math.max(1000, Number.isFinite(value) && value > 0 ? value : 28 * 60 * 1000);
}

function clearRealtimeSessionRenewalTimer() {
  if (!realtimeSessionRenewalTimer) return;
  window.clearTimeout(realtimeSessionRenewalTimer);
  realtimeSessionRenewalTimer = 0;
}

function scheduleRealtimeSessionRenewal(reason = "connected") {
  clearRealtimeSessionRenewalTimer();
  const delayMs = realtimeSessionRenewalMs();
  if (delayMs <= 0 || state.connection.mode === "mock" || state.connection.mode === "webrtc-mock") {
    return { ok: false, skipped: true, reason: "session_renewal_disabled" };
  }
  const renewalAt = new Date(Date.now() + delayMs).toISOString();
  Object.assign(state.connection as Record<string, unknown>, {
    sessionRenewalAt: renewalAt,
    sessionRenewalReason: reason,
  });
  recordTimeline("realtime_session_renewal_scheduled", { reason, delayMs, renewalAt });
  realtimeSessionRenewalTimer = window.setTimeout(() => {
    realtimeSessionRenewalTimer = 0;
    scheduleRealtimeReconnect("session_renewal", 0);
  }, delayMs);
  updateFeedback();
  return { ok: true, scheduled: true, reason, delayMs, renewalAt };
}

function realtimeAgentSDKSessionConfig(session: Record<string, any> = {}) {
  const audio = (session.audio || {}) as Record<string, any>;
  const input = (audio.input || {}) as Record<string, any>;
  const output = (audio.output || {}) as Record<string, any>;
  const outputModalities =
    session.outputModalities || session.output_modalities || session.modalities || undefined;
  return {
    ...session,
    outputModalities,
    audio: {
      ...audio,
      input: {
        ...input,
        noiseReduction:
          input.noiseReduction !== undefined ? input.noiseReduction : input.noise_reduction,
        turnDetection:
          input.turnDetection !== undefined ? input.turnDetection : input.turn_detection,
      },
      output: {
        ...output,
        voice: output.voice || session.voice,
      },
    },
  };
}

function attachRealtimeAgentSDKInputSender(pc, reason = "agents-sdk-peer-connection") {
  const senders = typeof pc?.getSenders === "function" ? pc.getSenders() || [] : [];
  const audioSenders = senders.filter((sender) => sender?.track?.kind === "audio");
  const sender =
    audioSenders.find((entry) => entry.track?.readyState !== "ended") || audioSenders[0] || null;
  if (!sender?.track) {
    recordTimeline("realtime_agent_sdk_input_sender_missing", {
      reason,
      senderCount: senders.length,
      audioSenderCount: audioSenders.length,
    });
    return false;
  }
  const alreadyAttached = mutableRealtimeBridgeState.realtimeAudioSender === sender;
  mutableRealtimeBridgeState.realtimeAudioSender = sender;
  state.connection.realtimeAgentSDKInputSenderTrackId = sender.track.id || "";
  rememberRealtimeInputTrack("meet_audio_mix", sender.track, {
    lastRealtimeInputReplaceReason: "agents-sdk-media-stream",
    lastRealtimeInputReplaceAt: new Date().toISOString(),
    currentRealtimeInputIsRoutingMix: true,
  });
  if (pendingMeetAudioTracks.length) {
    pendingMeetAudioTracks.splice(0);
    state.connection.pendingMeetAudioTrackCount = 0;
  }
  recordTimeline("realtime_agent_sdk_input_sender_attached", {
    reason,
    trackId: sender.track.id || "",
    trackReadyState: sender.track.readyState || "",
    trackEnabled: sender.track.enabled !== false,
    senderCount: senders.length,
    audioSenderCount: audioSenders.length,
    alreadyAttached,
  });
  ensureRealtimeAudioSenderStatsMonitor("agents-sdk-media-stream");
  if (alreadyAttached) sampleRealtimeAudioSenderStats("agents-sdk-input-sender-refresh");
  updateFeedback();
  return true;
}

function captureRealtimeAgentSDKInputSender(pc, reason = "agents-sdk-peer-connection") {
  if (attachRealtimeAgentSDKInputSender(pc, reason)) return;
  const retry = (retryReason) => {
    if (mutableRealtimeBridgeState.realtimeAudioSender) return;
    attachRealtimeAgentSDKInputSender(pc, retryReason);
  };
  if (typeof window.queueMicrotask === "function") {
    window.queueMicrotask(() => retry(`${reason}:microtask`));
  }
  window.setTimeout(() => retry(`${reason}:timeout-0`), 0);
  window.setTimeout(() => retry(`${reason}:timeout-250`), 250);
}

function markRealtimeAgentSDKTransportDisconnected(reason, detail: Record<string, any> = {}) {
  const peerConnectionState = String(
    detail.peerConnectionState || state.connection.peerConnectionState || "",
  );
  state.connected = false;
  state.agentRuntime.sdkConnected = false;
  state.connection.dataChannelOpen = false;
  if (peerConnectionState) state.connection.peerConnectionState = peerConnectionState;
  Object.assign(state.connection as Record<string, unknown>, {
    lastRealtimeAgentSDKDisconnectAt: new Date().toISOString(),
    lastRealtimeAgentSDKDisconnectReason: reason,
  });
  recordTimeline("realtime_agent_sdk_disconnected", {
    reason,
    peerConnectionState,
    ...detail,
  });
  const delayMs = Number(detail.delayMs || 0);
  scheduleRealtimeReconnect(reason, Number.isFinite(delayMs) ? delayMs : 0);
  updateFeedback();
}

function createRealtimeAgentSDKTransport(namespace, connectionConfig) {
  if (connectionConfig.mode === "agents-sdk-mock") return createMockRealtimeAgentTransport();
  const inputDestination = ensureRealtimeInputDestination("agents-sdk-connect");
  const inputTracks = inputDestination?.stream?.getAudioTracks?.() || [];
  const inputTrack = inputTracks.find((track) => track.readyState !== "ended");
  state.connection.realtimeAgentSDKInputTrackIds = inputTracks.map((track) => track.id);
  if (inputTrack) {
    rememberRealtimeInputTrack("meet_audio_mix", inputTrack, {
      lastRealtimeInputReplaceReason: "agents-sdk-media-stream",
      lastRealtimeInputReplaceAt: new Date().toISOString(),
      currentRealtimeInputIsRoutingMix: true,
    });
  }
  recordTimeline("realtime_agent_sdk_input_stream_attached", {
    inputTrackIds: inputTracks.map((track) => track.id),
    inputTrackStates: inputTracks.map((track) => track.readyState || ""),
  });
  const endpointUrl = (() => {
    const sdpUrl = String(connectionConfig.sdpUrl || "").trim();
    if (sdpUrl) return sdpUrl;
    const baseUrl = String(connectionConfig.openaiRealtimeBaseUrl || "").trim();
    if (!baseUrl) return "https://api.openai.com/v1/realtime/calls";
    if (/\/realtime\/calls\/?$/i.test(baseUrl)) return baseUrl;
    if (/\/realtime\/?$/i.test(baseUrl)) return `${baseUrl.replace(/\/+$/, "")}/calls`;
    return `${baseUrl.replace(/\/+$/, "")}/realtime/calls`;
  })();
  const transport = new namespace.OpenAIRealtimeWebRTC({
    mediaStream: inputDestination?.stream || new MediaStream(),
    audioElement: createRealtimeAgentSDKDecodeElement(),
    baseUrl: endpointUrl,
    changePeerConnection: async (pc) => {
      mutableRealtimeBridgeState.activePeerConnection = pc;
      window.MAB_REALTIME_PEER_CONNECTION = pc;
      state.connection.peerConnectionState = pc.connectionState || "new";
      captureRealtimeAgentSDKInputSender(pc, "change-peer-connection");
      recordTimeline("realtime_agent_sdk_peer_connection", {
        state: state.connection.peerConnectionState,
      });
      pc.addEventListener("connectionstatechange", () => {
        state.connection.peerConnectionState = pc.connectionState;
        state.connected = pc.connectionState === "connected" || pc.connectionState === "completed";
        if (!mutableRealtimeBridgeState.realtimeAudioSender) {
          captureRealtimeAgentSDKInputSender(pc, "connectionstatechange");
        }
        recordTimeline("realtime_agent_sdk_peer_connection", { state: pc.connectionState });
        if (
          pc === mutableRealtimeBridgeState.activePeerConnection &&
          ["failed", "closed", "disconnected"].includes(String(pc.connectionState || ""))
        ) {
          markRealtimeAgentSDKTransportDisconnected(`agents_sdk_peer_${pc.connectionState}`, {
            peerConnectionState: pc.connectionState,
            delayMs: pc.connectionState === "disconnected" ? 750 : 0,
          });
          return;
        }
        updateFeedback();
      });
      const sdkOnTrack = pc.ontrack;
      pc.ontrack = (event) => {
        sdkOnTrack?.call(pc, event);
        monitorRealtimeRemoteAudioTrack(pc, event.track, "agents-sdk-ontrack");
        routeRemoteAudioStream(event.streams?.[0]).catch(rememberError);
        updateFeedback();
      };
      return pc;
    },
  });
  return transport;
}

function installRealtimeAgentSDKEventHandlers(session, transport) {
  const nameOf = (value) =>
    typeof value === "string" ? value : value?.name || value?.config?.name || "";
  const textOf = (value) => (typeof value === "string" ? value.slice(0, 500) : "");
  const record =
    (type) =>
    (...args) => {
      const event = args.length === 1 ? args[0] : {};
      const agent = nameOf(args.length > 1 ? args[1] : event?.agent);
      const tool = nameOf(
        type === "agent_tool_start" || type === "agent_tool_end"
          ? args[2]
          : event?.tool || event?.name,
      );
      const handoff = nameOf(
        type === "agent_handoff" ? args[2] : event?.handoff?.targetAgent || event?.handoff,
      );
      const toolDetailsIndex = type === "agent_tool_end" ? 4 : 3;
      const toolCall =
        type === "agent_tool_start" || type === "agent_tool_end"
          ? args[toolDetailsIndex]?.toolCall || args[toolDetailsIndex]?.tool_call || {}
          : {};
      const eventType = event?.type || type;
      const detail = {
        eventType,
        agent,
        tool,
        handoff,
        callId: toolCall?.callId || toolCall?.call_id || "",
        text: type === "agent_end" ? textOf(args[2]) : textOf(event?.text),
      };
      recordTimeline(`realtime_agent_sdk_${type}`, detail);
      rememberInboundEvent({ type: `agents_sdk.${eventType}`, ...detail }, "agents-sdk");
      if (type === "history_updated") {
        const history = Array.isArray(args[0]) ? args[0] : currentHistorySnapshot();
        updateContextHealthFromHistory(history);
        maybeCompactRealtimeHistory("history_updated");
      }
      if (type === "agent_end") {
        updateContextHealthFromHistory(currentHistorySnapshot());
      }
      updateFeedback();
    };
  for (const eventName of [
    "agent_start",
    "agent_end",
    "agent_handoff",
    "agent_tool_start",
    "agent_tool_end",
    "error",
    "audio_start",
    "audio_stopped",
    "audio_interrupted",
    "history_updated",
    "history_added",
  ]) {
    session?.on?.(eventName, record(eventName));
  }
  const recordedTransportEvents = new WeakSet();
  const recordTransportEvent = (event) => {
    if (event && typeof event === "object") {
      if (recordedTransportEvents.has(event)) return;
      recordedTransportEvents.add(event);
    }
    recordTimeline("realtime_agent_sdk_transport_event", summarizeRealtimeEvent(event));
    if (event && typeof event === "object") {
      rememberInboundEvent({ ...event, __meetingAvatarInboundRecorded: true }, "agents-sdk");
    }
  };
  session?.on?.("transport_event", recordTransportEvent);
  transport?.on?.("transport_event", recordTransportEvent);
}

async function connectRealtimeAgentSDK(connectionConfig) {
  if (realtimeRuntimePlacement === "inline") {
    const meetSurface = realtimePageRole === "meet-surface";
    if (meetSurface || !allowInlineAgentsSDKDiagnostic) {
      state.agentRuntime.fallbackReason = meetSurface
        ? "inline_agents_sdk_on_meet_removed"
        : "inline_agents_sdk_requires_diagnostic_opt_in";
      throw new Error(
        meetSurface
          ? "Inline OpenAI Realtime Agents SDK on Meet has been removed; use realtimeRuntimePlacement=sidecar"
          : "Inline OpenAI Realtime Agents SDK requires allowInlineAgentsSDKDiagnostic=true",
      );
    }
  }
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
      connectionConfig.session?.audio?.output?.voice || connectionConfig.session?.voice || "marin",
  });
  const transport = createRealtimeAgentSDKTransport(namespace, connectionConfig);
  const session = new namespace.RealtimeSession(agent, {
    model: connectionConfig.session?.model || "gpt-realtime-2",
    transport,
    config: realtimeAgentSDKSessionConfig(defaultRealtime2Session(connectionConfig.session || {})),
    historyStoreAudio: false,
    context: {
      session_id: state.sessionId || String(config.sessionId || ""),
      botName: connectionConfig.botName || "",
    },
    groupId: state.sessionId || String(config.sessionId || ""),
    traceMetadata: { session_id: state.sessionId || String(config.sessionId || "") },
  });
  mutableRealtimeBridgeState.activeRealtimeAgentSession = session;
  mutableRealtimeBridgeState.activeRealtimeAgentTransport = transport;
  installRealtimeAgentSDKEventHandlers(session, transport);
  (window as any).__MAB_CREATING_REALTIME_AGENT_PEER_CONNECTION = true;
  try {
    await session.connect({
      apiKey: ephemeralKey,
      model: connectionConfig.session?.model || "gpt-realtime-2",
    });
  } finally {
    (window as any).__MAB_CREATING_REALTIME_AGENT_PEER_CONNECTION = false;
  }
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
  scheduleRealtimeSessionRenewal("agents_sdk_connected");
  if (
    String(config.realtimeRuntimePlacement || "") === "sidecar" &&
    String(config.realtimePageRole || "") === "sidecar"
  ) {
    recordTimeline("meet_chat_observer_skipped", {
      reason: "sidecar_page_not_meet_surface",
    });
  } else {
    installMeetChatObserver().catch((error) => {
      state.meetChat.errors.push({
        ts: new Date().toISOString(),
        message: String((error && error.message) || error).slice(0, 300),
      });
      state.meetChat.errors = state.meetChat.errors.slice(-20);
    });
  }
  window.dispatchEvent(
    new CustomEvent("meeting-avatar-realtime-connected", {
      detail: { mode: state.connection.mode, agentRuntime: "agents-sdk" },
    }),
  );
  updateFeedback();
  return { ok: true, mode: state.connection.mode, agentRuntime: "agents-sdk" };
}

function cleanupRealtimeConnection(reason = "cleanup") {
  mutableRealtimeBridgeState.reconnectGeneration += 1;
  clearRealtimeSessionRenewalTimer();
  clearRealtimeAudioSenderStatsMonitor();
  clearRealtimeRemoteAudioTrackStats();
  const peerConnection = mutableRealtimeBridgeState.activePeerConnection;
  mutableRealtimeBridgeState.activePeerConnection = null;
  try {
    mutableRealtimeBridgeState.activeRealtimeAgentSession?.close?.();
  } catch {
    // Best-effort close before reconnecting.
  }
  try {
    mutableRealtimeBridgeState.activeRealtimeAgentTransport?.close?.();
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
    peerConnection?.getSenders?.().forEach((sender) => {
      if (
        sender.track &&
        sender.track !== mutableRealtimeBridgeState.silentMeetAudioTrack &&
        !isRealtimeRoutingMixTrack(sender.track)
      ) {
        sender.track.stop?.();
      }
    });
  } catch {
    // Best-effort cleanup.
  }
  try {
    peerConnection?.close?.();
  } catch {
    // Best-effort cleanup.
  }
  mutableRealtimeBridgeState.activeRealtimeAgentSession = null;
  mutableRealtimeBridgeState.activeRealtimeAgentTransport = null;
  mutableRealtimeBridgeState.realtimeAudioSender = null;
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
  if (state.connection.mode === "mock" || state.connection.mode === "webrtc-mock") {
    return { ok: false, skipped: true, reason: "mock_mode" };
  }
  if (
    mutableRealtimeBridgeState.reconnectTimer ||
    state.connection.reconnecting ||
    state.connecting
  ) {
    return {
      ok: true,
      scheduled: Boolean(mutableRealtimeBridgeState.reconnectTimer),
      reason: "already_reconnecting",
    };
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
  mutableRealtimeBridgeState.reconnectTimer = window.setTimeout(async () => {
    mutableRealtimeBridgeState.reconnectTimer = null;
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
  if (!responseId && !options.force) {
    return { ok: true, skipped: true, reason: "no_active_response" };
  }
  const event: Record<string, unknown> = { type: "response.cancel" };
  if (responseId) event.response_id = responseId;
  const channel = sendRealtimeEvent(event);
  state.protection.cancelledResponses += 1;
  const cancelledResponseId = responseId;
  state.protection.activeResponseId = "";
  return { ok: true, channel, responseId: cancelledResponseId, reason };
}
