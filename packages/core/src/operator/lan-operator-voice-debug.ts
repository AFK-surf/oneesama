import type { DebugState } from "./lan-operator-debug-state.ts";

export function mergeOperatorVoiceTelemetry(debug: DebugState, payload: Record<string, unknown>) {
  const capture = (payload.capture || payload) as Record<string, unknown>;
  if ("armed" in capture) debug.voice.armed = Boolean(capture.armed);
  if ("muted" in capture) debug.voice.muted = Boolean(capture.muted);
  if (capture.mode) debug.voice.captureMode = String(capture.mode);
  if (capture.status) debug.voice.captureStatus = String(capture.status);
  if (capture.error !== undefined) debug.voice.captureError = String(capture.error || "");
  if (capture.permissionState) debug.voice.permissionState = String(capture.permissionState);
  if (capture.deviceId !== undefined) debug.voice.deviceId = String(capture.deviceId || "");
  if (capture.deviceLabel !== undefined)
    debug.voice.deviceLabel = String(capture.deviceLabel || "");
  if (capture.availableDeviceCount !== undefined) {
    debug.voice.availableDeviceCount = Math.max(0, Number(capture.availableDeviceCount) || 0);
  }
  const localVad = (payload.localVad || capture.localVad) as Record<string, unknown> | undefined;
  if (localVad && typeof localVad === "object") {
    const enabled = localVad.enabled !== false;
    debug.voice.localVad = {
      enabled,
      role: enabled ? "telemetry" : "disabled",
      active: Boolean(localVad.active),
      threshold: Number(localVad.threshold) || debug.voice.localVad.threshold,
      lastEnergy:
        localVad.lastEnergy == null
          ? debug.voice.localVad.lastEnergy
          : Number(localVad.lastEnergy) || 0,
      lastUpdatedAt: String(localVad.lastUpdatedAt || new Date().toISOString()),
    };
  }
}

export function mergeOperatorVoiceAckTelemetry(
  debug: DebugState,
  payload: Record<string, unknown>,
) {
  const ack = (payload.ack || payload) as Record<string, unknown>;
  const ackRttMs = Number(ack.ackRttMs);
  debug.voice.ackCount += 1;
  debug.voice.lastAckSequence = Number.isFinite(Number(ack.sequence))
    ? Number(ack.sequence)
    : debug.voice.lastAckSequence;
  debug.voice.lastAckAt = String(ack.ackAt || new Date().toISOString());
  debug.voice.lastAckRttMs = Number.isFinite(ackRttMs)
    ? Math.max(0, ackRttMs)
    : debug.voice.lastAckRttMs;
  if (debug.voice.lastAckRttMs != null) {
    debug.voice.maxAckRttMs = Math.max(debug.voice.maxAckRttMs ?? 0, debug.voice.lastAckRttMs);
  }
}

export function mergeOperatorVoiceStreamOpened(
  debug: DebugState,
  payload: Record<string, unknown>,
) {
  debug.voice.activeStreamId = String(payload.voiceStreamId || payload.streamId || "") || null;
  debug.voice.activeStreamGeneration = Math.max(
    debug.voice.activeStreamGeneration,
    Number(payload.voiceStreamGeneration) || 0,
  );
  debug.voice.streamOpenCount += 1;
  debug.voice.lastStreamOpenedAt = String(payload.openedAt || new Date().toISOString());
  return {
    voiceStreamId: debug.voice.activeStreamId,
    voiceStreamGeneration: debug.voice.activeStreamGeneration,
    streamOpenCount: debug.voice.streamOpenCount,
  };
}

export function rejectStaleVoiceChunk(debug: DebugState, voiceStreamId: string) {
  debug.voice.staleChunksRejected += 1;
  debug.voice.lastRejectedStreamId = voiceStreamId;
  return {
    reason: "stale_voice_stream",
    voiceStreamId,
    activeStreamId: debug.voice.activeStreamId,
    staleChunksRejected: debug.voice.staleChunksRejected,
  };
}
