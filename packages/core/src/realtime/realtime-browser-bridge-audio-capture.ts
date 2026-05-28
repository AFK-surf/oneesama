/* eslint-disable no-unused-vars */
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
    reader.addEventListener(
      "loadend",
      () => {
        const result = String(reader.result || "");
        resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
      },
      { once: true },
    );
    reader.addEventListener(
      "error",
      () => reject(reader.error || new Error("audio_chunk_read_failed")),
      { once: true },
    );
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
  if (!config.captureMeetAudioForTranscript) return { ok: true, skipped: true, reason: "disabled" };
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
