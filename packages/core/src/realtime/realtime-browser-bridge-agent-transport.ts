/* eslint-disable no-unused-vars */
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
  ensureMeetAudioRoutingContext();
  const sourceTracks = routingDestination?.stream?.getAudioTracks?.() || [];
  const clonedTracks = sourceTracks
    .filter((track) => track.readyState !== "ended")
    .map((track) => track.clone());
  state.connection.realtimeAgentSDKInputTrackIds = clonedTracks.map((track) => track.id);
  recordTimeline("realtime_agent_sdk_input_stream_cloned", {
    sourceTrackIds: sourceTracks.map((track) => track.id),
    sourceTrackStates: sourceTracks.map((track) => track.readyState || ""),
    clonedTrackIds: clonedTracks.map((track) => track.id),
  });
  const baseUrl =
    String(connectionConfig.openaiRealtimeBaseUrl || "").trim() ||
    String(connectionConfig.sdpUrl || "https://api.openai.com/v1/realtime/calls").replace(
      /\/realtime\/calls\/?$/,
      "",
    );
  const transport = new namespace.OpenAIRealtimeWebRTC({
    mediaStream: new MediaStream(clonedTracks),
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
        state.connected = pc.connectionState === "connected" || pc.connectionState === "completed";
        recordTimeline("realtime_agent_sdk_peer_connection", { state: pc.connectionState });
        updateFeedback();
      });
      pc.ontrack = (event) => {
        routeRemoteAudioStream(event.streams?.[0]).catch(rememberError);
        updateFeedback();
      };
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
      connectionConfig.session?.audio?.output?.voice || connectionConfig.session?.voice || "marin",
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
  clearRealtimeOutputAudioActivity(`realtime_connection_${reason}`);
  if (realtimeInputGateReopenTimer) {
    window.clearTimeout(realtimeInputGateReopenTimer);
    realtimeInputGateReopenTimer = 0;
  }
  if (realtimeAudioSenderStatsTimer) {
    window.clearInterval(realtimeAudioSenderStatsTimer);
    realtimeAudioSenderStatsTimer = 0;
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
  activePeerConnection = null;
  activeRealtimeAgentSession = null;
  activeRealtimeAgentTransport = null;
  realtimeAudioSender = null;
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
  clearRealtimeOutputAudioActivity(`response_cancel_${reason}`);
  return { ok: true, channel, responseId: cancelledResponseId, reason };
}
