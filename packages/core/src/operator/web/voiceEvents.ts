import type { EngineControlType } from "./useOperatorRuntime.ts";

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
