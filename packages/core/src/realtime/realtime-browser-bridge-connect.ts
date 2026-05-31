/* eslint-disable no-unused-vars */
function installMockRealtimeInputSender(reason = "webrtc-mock") {
  if (state.connection.mode !== "webrtc-mock") return false;
  if (state.connection.meetAudioForwardingEnabled === false) return false;
  ensureMeetAudioRoutingContext();
  const [placeholderTrack] = routingDestination.stream.getAudioTracks();
  if (!placeholderTrack) return false;
  const mockSender = {
    track: placeholderTrack,
    replaceTrack(nextTrack) {
      mockSender.track = nextTrack || null;
      return Promise.resolve();
    },
  };
  realtimeAudioSender = mockSender;
  rememberRealtimeInputTrack("silent_placeholder", placeholderTrack);
  ensureRealtimeAudioSenderStatsMonitor("mock-placeholder");
  state.connection.realtimeInputPlaceholderAdded = true;
  silentMeetAudioTrack = placeholderTrack.clone();
  recordTimeline("realtime_input_mock_placeholder_added", {
    reason,
    trackId: placeholderTrack.id,
  });
  const hadPendingMeetAudioTracks = pendingMeetAudioTracks.length > 0;
  flushPendingMeetAudioTracks();
  if (!hadPendingMeetAudioTracks && state.connection.meetAudioTracksForwarded > 0) {
    replaceRealtimeInputWithRoutingMix("webrtc-mock-meet-audio-mix");
  }
  updateFeedback();
  return true;
}

function configureRealtimeConnectionOptions(connectionConfig) {
  const requestedMode = connectionConfig.mode || state.mode;
  state.connection.requestedMode = requestedMode;
  state.connection.mode =
    requestedMode === "mock" || requestedMode === "webrtc-mock" ? requestedMode : "agents-sdk";
  state.connection.tokenUrl = connectionConfig.tokenUrl || config.tokenUrl;
  state.connection.sdpUrl = connectionConfig.sdpUrl || config.sdpUrl;
  state.connection.participantAudioForwardingEnabled =
    connectionConfig.includeParticipantAudio === true;
  state.connection.meetAudioForwardingEnabled =
    connectionConfig.forwardMeetAudioToRealtime !== false;
  const nextInputGain =
    shouldUseMeetReceiverFallbackForRecappi() && state.connection.meetAudioTracksForwarded > 0
      ? configuredMeetReceiverInputGain()
      : normalizeMeetAudioInputGain(
          connectionConfig.meetAudioInputGain || config.meetAudioInputGain,
        );
  updateRoutingInputGain(nextInputGain, "connection-options");
  state.connection.meetAudioEnergyStaleMs = Math.max(
    1000,
    Number(connectionConfig.meetAudioEnergyStaleMs || config.meetAudioEnergyStaleMs || 10000),
  );
}

function connectMockRealtime(connectionConfig) {
  const channel = createMockDataChannel();
  window.MAB_REALTIME_DATA_CHANNEL = channel as unknown as RTCDataChannel;
  window.MAB_REALTIME_DC = channel as unknown as RTCDataChannel;
  state.connected = true;
  state.agentRuntime.active = "mock";
  state.connection.dataChannelOpen = true;
  state.connection.peerConnectionState = "mock-connected";
  if (state.connection.mode === "webrtc-mock") {
    installMockRealtimeInputSender("webrtc-mock-connect");
    discoverParticipantAudioStreams();
    flushPendingMeetAudioTracks();
  }
  configureRealtimeSession();
  if (state.connection.mode === "webrtc-mock" && connectionConfig.simulateRemoteAudio !== false) {
    injectMockRemoteAudio().catch(rememberError);
  }
  window.dispatchEvent(
    new CustomEvent("meeting-avatar-realtime-connected", {
      detail: { mode: state.connection.mode, agentRuntime: "mock" },
    }),
  );
  return { ok: true, mode: state.connection.mode, mock: true };
}

async function connectRealtime(options = {}) {
  if (
    state.connected &&
    (window.MAB_REALTIME_DATA_CHANNEL ||
      window.MAB_REALTIME_DC ||
      state.agentRuntime.sdkConnected === true)
  ) {
    return { ok: true, alreadyConnected: true, mode: state.connection.mode };
  }
  const connectionConfig = { ...config, ...options };
  state.connecting = true;
  configureRealtimeConnectionOptions(connectionConfig);
  try {
    if (
      activePeerConnection &&
      ["failed", "closed", "disconnected"].includes(state.connection.peerConnectionState)
    ) {
      cleanupRealtimeConnection(`preconnect_${state.connection.peerConnectionState}`);
    }
    if (state.connection.mode === "mock" || state.connection.mode === "webrtc-mock") {
      return connectMockRealtime(connectionConfig);
    }
    return await connectRealtimeAgentSDK(connectionConfig);
  } catch (error) {
    rememberError(error);
    if (error?.realtimeTokenError?.retryable === true) {
      scheduleRealtimeReconnect("realtime_token_retryable_failure", 750);
    }
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    state.connecting = false;
  }
}
