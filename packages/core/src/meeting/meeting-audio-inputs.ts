import { createRecappiAudioTap } from "../audio/recappi-audio-tap.ts";
import { createMeetingRecorder } from "./meeting-recorder.ts";
import { createRecappiRealtimeAudioInput } from "./recappi-realtime-audio-input.ts";
import { createWebRTCAudioCaptureSink } from "./webrtc-audio-capture.ts";

export function createMeetingAudioInputs({
  input,
  config,
  sessionId,
  artifactsDir,
  meetUrl,
  installRealtimeBridge,
  recordMeeting,
}) {
  const realtimeWantsMeetAudio =
    installRealtimeBridge &&
    input.forwardMeetAudioToRealtime !== false &&
    Boolean(input.includeParticipantAudio);
  const recappiTap =
    process.platform === "darwin" && (recordMeeting || realtimeWantsMeetAudio)
      ? createRecappiAudioTap({ log: (message) => console.error(`[meeting-recorder] ${message}`) })
      : null;
  const recorder = createMeetingRecorder({
    backend: input.meetAudioBackend || config.meetAudioBackend,
    recappiTap: recappiTap || undefined,
  });
  const realtimeRecappiAudioInput = shouldUseRecappiRealtimeAudioInput({
    meetUrl,
    realtimeWantsMeetAudio,
    recorderBackend: recorder.backend,
    recappiTapAvailable: Boolean(recappiTap),
  })
    ? createRecappiRealtimeAudioInput({ sessionId, recappiTap })
    : null;
  const realtimeAudioCapture =
    recordMeeting &&
    installRealtimeBridge &&
    input.forwardMeetAudioToRealtime !== false &&
    !realtimeRecappiAudioInput &&
    !isGoogleMeetUrlForRealtimeAudio(meetUrl)
      ? createWebRTCAudioCaptureSink({ sessionId, artifactsDir })
      : null;
  return { recorder, realtimeRecappiAudioInput, realtimeAudioCapture };
}

export function isGoogleMeetUrlForRealtimeAudio(meetUrl = "") {
  return /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#].*)?$/i.test(
    String(meetUrl || "").trim(),
  );
}

export function shouldUseRecappiRealtimeAudioInput({
  platform = process.platform,
  meetUrl,
  realtimeWantsMeetAudio,
  recorderBackend,
  recappiTapAvailable,
}) {
  return (
    platform === "darwin" &&
    Boolean(realtimeWantsMeetAudio) &&
    recorderBackend === "recappi" &&
    Boolean(recappiTapAvailable) &&
    isGoogleMeetUrlForRealtimeAudio(meetUrl)
  );
}

export async function startRealtimeRecappiAudioInput({
  realtimeRecappiAudioInput,
  context,
  page,
  diagnostics,
}) {
  if (!realtimeRecappiAudioInput) return null;
  const started = await realtimeRecappiAudioInput.start({ context, page, diagnostics });
  diagnostics.record("recappi_realtime_audio_ready", started);
  return started;
}

export async function probeRealtimeRecappiAudioInput({
  realtimeRecappiAudioInput,
  context,
  diagnostics,
}) {
  if (!realtimeRecappiAudioInput) {
    return { ok: false, skipped: true, reason: "recappi_realtime_input_disabled" };
  }
  const probe =
    typeof realtimeRecappiAudioInput?.probe === "function"
      ? await realtimeRecappiAudioInput.probe({ context })
      : { ok: true, source: "recappi_process_audio", processId: 0 };
  diagnostics?.record?.("recappi_realtime_audio_probe", probe);
  return probe;
}

export async function stopRealtimeRecappiAudioInput(active) {
  try {
    return await active?.realtimeRecappiAudioInput?.stop();
  } catch (error) {
    active?.diagnostics?.record("recappi_realtime_audio_stop_error", {
      error: String(error?.message || error),
    });
    return null;
  }
}
