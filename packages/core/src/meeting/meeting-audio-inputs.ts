import { createRecappiAudioTap } from "../audio/recappi-audio-tap.ts";
import { createMeetingRecorder } from "./meeting-recorder.ts";
import { createRecappiRealtimeAudioInput } from "./recappi-realtime-audio-input.ts";
import { createWebRTCAudioCaptureSink } from "./webrtc-audio-capture.ts";

export function createMeetingAudioInputs({
  input,
  config,
  sessionId,
  artifactsDir,
  allowNonGoogleMeet,
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
  const realtimeRecappiAudioInput =
    realtimeWantsMeetAudio && recorder.backend === "recappi" && !allowNonGoogleMeet && recappiTap
      ? createRecappiRealtimeAudioInput({ sessionId, recappiTap })
      : null;
  const realtimeAudioCapture =
    recordMeeting &&
    installRealtimeBridge &&
    input.forwardMeetAudioToRealtime !== false &&
    !realtimeRecappiAudioInput
      ? createWebRTCAudioCaptureSink({ sessionId, artifactsDir })
      : null;
  return { recorder, realtimeRecappiAudioInput, realtimeAudioCapture };
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
