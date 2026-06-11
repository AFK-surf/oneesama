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

export type OperatorVoiceStatusMessage = Record<string, unknown> & {
  type:
    | "operator_local_vad_configured"
    | "operator_mic_armed"
    | "operator_mic_blocked"
    | "operator_mic_disarmed"
    | "operator_mic_muted"
    | "operator_voice_devices_refreshed";
};

export interface VoiceCaptureStatusInput {
  micOn: boolean;
  deviceId?: string;
}

export interface VoiceVadStatusInput {
  enabled: boolean;
  active: boolean;
  lastEnergy: number;
}

export interface VoiceDevicesRefreshedMessageInput
  extends VoiceCaptureStatusInput, VoiceVadStatusInput {
  availableDeviceCount: number;
}

export interface VoiceMicBlockedMessageInput {
  error: unknown;
  muted: boolean;
  deviceId?: string;
  availableDeviceCount: number;
}

export interface VoiceMicMutedMessageInput extends VoiceCaptureStatusInput {
  muted: boolean;
  availableDeviceCount: number;
}

export interface VoiceMicCaptureMessageInput {
  muted: boolean;
  deviceId?: string;
  deviceLabel?: string;
  availableDeviceCount: number;
}

export interface VoiceMutedMessagesInput extends VoiceMicMutedMessageInput {
  sessionId: string;
  reason?: string;
}

export interface VoiceCaptureDisarmedMessagesInput extends VoiceMicCaptureMessageInput {
  sessionId: string;
  reason?: string;
}

export interface VoiceCaptureOpenedMessagesInput extends VoiceMicCaptureMessageInput {
  sessionId: string;
  voiceStreamId: string;
  openedAt?: string;
}

export interface VoiceMutedMessages {
  operatorEvents: [ReturnType<typeof voiceEngineControl>, OperatorVoiceStatusMessage];
}

export interface VoiceCaptureDisarmedMessages {
  operatorEvents: [OperatorVoiceStatusMessage, ReturnType<typeof voiceEngineControl>];
}

export interface VoiceCaptureOpenedMessages {
  voiceMessage: ReturnType<typeof voiceStreamOpenedMessage>;
  operatorEvents: [ReturnType<typeof voiceEngineControl>, OperatorVoiceStatusMessage];
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

export function micBlockedMessage(input: VoiceMicBlockedMessageInput): OperatorVoiceStatusMessage {
  const message = String((input.error as Error)?.message || input.error || "microphone_blocked");
  return {
    type: "operator_mic_blocked",
    error: message,
    capture: voiceCaptureSnapshot({
      armed: false,
      muted: input.muted,
      status: "blocked",
      error: message,
      permissionState: permissionStateForError(input.error),
      deviceId: input.deviceId || null,
      availableDeviceCount: input.availableDeviceCount,
    }),
  };
}

export function localVadConfiguredMessage(
  input: VoiceCaptureStatusInput & VoiceVadStatusInput,
): OperatorVoiceStatusMessage {
  return {
    type: "operator_local_vad_configured",
    localVad: localVadSnapshot({
      enabled: input.enabled,
      active: input.enabled ? input.active : false,
      lastEnergy: input.lastEnergy,
    }),
    capture: captureStatus(input),
  };
}

export function voiceDevicesRefreshedMessage(
  input: VoiceDevicesRefreshedMessageInput,
): OperatorVoiceStatusMessage {
  return {
    type: "operator_voice_devices_refreshed",
    availableDeviceCount: input.availableDeviceCount,
    capture: captureStatus(input),
    localVad: localVadSnapshot({
      enabled: input.enabled,
      active: input.enabled && input.active,
      lastEnergy: input.lastEnergy,
    }),
  };
}

export function micMutedMessage(input: VoiceMicMutedMessageInput): OperatorVoiceStatusMessage {
  return {
    type: "operator_mic_muted",
    capture: voiceCaptureSnapshot({
      armed: input.micOn,
      muted: input.muted,
      status: input.micOn ? "capturing" : "idle",
      deviceId: input.deviceId || null,
      availableDeviceCount: input.availableDeviceCount,
    }),
  };
}

export function voiceMutedMessages(input: VoiceMutedMessagesInput): VoiceMutedMessages {
  return {
    operatorEvents: [
      voiceEngineControl(
        input.sessionId,
        "set_voice_muted",
        input.reason || "operator_web_set_mute",
        {
          muted: input.muted,
        },
      ),
      micMutedMessage({
        muted: input.muted,
        micOn: input.micOn,
        deviceId: input.deviceId,
        availableDeviceCount: input.availableDeviceCount,
      }),
    ],
  };
}

export function micDisarmedMessage(input: VoiceMicCaptureMessageInput): OperatorVoiceStatusMessage {
  return {
    type: "operator_mic_disarmed",
    capture: voiceCaptureSnapshot({
      armed: false,
      muted: input.muted,
      status: "idle",
      deviceId: input.deviceId || null,
      availableDeviceCount: input.availableDeviceCount,
    }),
  };
}

export function voiceCaptureDisarmedMessages(
  input: VoiceCaptureDisarmedMessagesInput,
): VoiceCaptureDisarmedMessages {
  return {
    operatorEvents: [
      micDisarmedMessage({
        muted: input.muted,
        deviceId: input.deviceId,
        availableDeviceCount: input.availableDeviceCount,
      }),
      voiceEngineControl(
        input.sessionId,
        "set_voice_armed",
        input.reason || "operator_web_stop_mic",
        {
          armed: false,
        },
      ),
    ],
  };
}

export function micArmedMessage(input: VoiceMicCaptureMessageInput): OperatorVoiceStatusMessage {
  return {
    type: "operator_mic_armed",
    capture: voiceCaptureSnapshot({
      armed: true,
      muted: input.muted,
      status: "capturing",
      permissionState: "granted",
      deviceId: input.deviceId || null,
      deviceLabel: input.deviceLabel || "",
      availableDeviceCount: input.availableDeviceCount,
    }),
  };
}

export function voiceCaptureOpenedMessages(
  input: VoiceCaptureOpenedMessagesInput,
): VoiceCaptureOpenedMessages {
  return {
    voiceMessage: voiceStreamOpenedMessage(input.sessionId, input.voiceStreamId, input.openedAt),
    operatorEvents: [
      voiceEngineControl(input.sessionId, "set_voice_armed", "operator_web_start_mic", {
        armed: true,
      }),
      micArmedMessage({
        muted: input.muted,
        deviceId: input.deviceId,
        deviceLabel: input.deviceLabel,
        availableDeviceCount: input.availableDeviceCount,
      }),
    ],
  };
}

function captureStatus(input: VoiceCaptureStatusInput) {
  return {
    status: input.micOn ? "capturing" : "idle",
    deviceId: input.deviceId || null,
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
