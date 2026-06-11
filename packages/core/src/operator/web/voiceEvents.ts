import type { EngineControlType } from "./useOperatorRuntime.ts";
import { pcm16Base64 } from "./protocol.ts";

export const LOCAL_VAD_THRESHOLD = 0.02;

export interface VoiceCaptureSnapshotInput {
  armed: boolean;
  muted: boolean;
  status: "idle" | "capturing" | "blocked";
  availableDeviceCount: number;
  deviceId?: string;
  deviceLabel?: string;
  error?: string;
  permissionState?: string;
}

export interface LocalVadSnapshotInput {
  enabled: boolean;
  active: boolean;
  lastEnergy: number;
  nowIso?: string;
}

export interface VoiceChunkMessageInput {
  sessionId: string;
  sequence: number;
  voiceStreamId: string;
  monotonicMs: number;
  sentAt: string;
  sampleRate: number;
  energy: number;
  samples: Float32Array;
}

export function permissionStateForError(error: unknown) {
  const name = String((error as { name?: string })?.name || "");
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "unavailable";
  return "unknown";
}

export function voiceCaptureSnapshot(input: VoiceCaptureSnapshotInput) {
  return {
    armed: input.armed,
    muted: input.muted,
    mode: "microphone_pcm16",
    status: input.status,
    ...(input.error ? { error: input.error } : {}),
    ...(input.permissionState ? { permissionState: input.permissionState } : {}),
    deviceId: input.deviceId || null,
    ...(input.deviceLabel != null ? { deviceLabel: input.deviceLabel } : {}),
    availableDeviceCount: input.availableDeviceCount,
  };
}

export function localVadSnapshot(input: LocalVadSnapshotInput) {
  return {
    enabled: input.enabled,
    role: input.enabled ? "telemetry" : "disabled",
    active: input.enabled ? input.active : false,
    threshold: LOCAL_VAD_THRESHOLD,
    lastEnergy: input.lastEnergy,
    lastUpdatedAt: input.nowIso || new Date().toISOString(),
  };
}

export function voiceEngineControl(
  sessionId: string,
  type: EngineControlType,
  reason: string,
  detail: Record<string, unknown>,
) {
  return {
    type: "engine_control",
    sessionId,
    control: {
      type,
      reason,
      detail: { source: "operator_web", ...detail },
    },
  };
}

export function voiceStreamOpenedMessage(
  sessionId: string,
  voiceStreamId: string,
  openedAt = new Date().toISOString(),
) {
  return {
    type: "operator_voice_stream_opened",
    sessionId,
    voiceStreamId,
    voiceStreamGeneration: 1,
    openedAt,
  };
}

export function createVoiceStreamId(nowMs = Date.now()): string {
  return "web_voice_" + nowMs.toString(36);
}

export function voiceChunkMessage(input: VoiceChunkMessageInput) {
  return {
    type: "voice_chunk",
    source: "operator_web_pcm16",
    sessionId: input.sessionId,
    sequence: input.sequence,
    voiceStreamId: input.voiceStreamId,
    voiceStreamGeneration: 1,
    monotonicMs: input.monotonicMs,
    sentAt: input.sentAt,
    sampleRate: input.sampleRate,
    channels: 1,
    durationMs: (input.samples.length / input.sampleRate) * 1000,
    energy: input.energy,
    dataBase64: pcm16Base64(input.samples),
  };
}
