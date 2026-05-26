/* eslint-disable no-unused-vars */
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
