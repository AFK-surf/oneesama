/* eslint-disable no-unused-vars */
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
        const failure = classifyRealtimeConnectFailure(
          tokenResponse.status,
          tokenText,
          "realtime_token",
        );
        const requestId = responseRequestId(tokenResponse);
        state.connection.lastTokenError = {
          ts: new Date().toISOString(),
          status: tokenResponse.status,
          ok: tokenResponse.ok,
          retryable: failure.retryable,
          terminal: failure.terminal,
          ...retry,
          requestId,
          error: tokenBody.error || "",
          detail: tokenBody.detail || null,
          body: tokenText.slice(0, 1000),
          reason: failure.reason,
        };
        recordTimeline("realtime_token_error", state.connection.lastTokenError);
        if (failure.terminal) {
          updateAvatarHudStatus("blocked", "Realtime blocked", { mood: "sad", action: "shrug" });
        }
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
        const failure = classifyRealtimeConnectFailure(
          sdpResponse.status,
          responseText,
          "realtime_sdp",
        );
        const detail = {
          status: sdpResponse.status,
          ok: sdpResponse.ok,
          retryable: failure.retryable,
          terminal: failure.terminal,
          ...retry,
          requestId,
          body: responseText.slice(0, 1000),
          reason: failure.reason,
        };
        rememberSdpError(detail);
        if (failure.terminal) {
          updateAvatarHudStatus("blocked", "Realtime blocked", { mood: "sad", action: "shrug" });
        }
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
