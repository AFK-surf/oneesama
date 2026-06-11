import type { VoiceState } from "./useVoice.ts";

export interface VoiceDeviceOptionView {
  key: string;
  value: string;
  label: string;
}

export interface VoiceBarView {
  energyPercent: number;
  energyWidth: string;
  micStateLabel: string;
  deviceOptions: VoiceDeviceOptionView[];
  showStopMic: boolean;
  startMicDisabled: boolean;
  muteDisabled: boolean;
  mutePressed: boolean;
  muteLabel: "Mute" | "Unmute";
  pushToTalkDisabled: boolean;
  pushToTalkPressed: boolean;
  localVadChecked: boolean;
  localVadStateLabel: string;
}

export function voiceBarView(
  voice: Pick<
    VoiceState,
    | "devices"
    | "energy"
    | "localVadActive"
    | "localVadEnabled"
    | "micOn"
    | "muted"
    | "pushToTalkActive"
  >,
  connected: boolean,
): VoiceBarView {
  const energyPercent = voiceEnergyPercent(voice.energy);
  return {
    energyPercent,
    energyWidth: `${energyPercent}%`,
    micStateLabel: `${voice.micOn ? "armed" : "idle"} / ${voice.muted ? "muted" : "open"}`,
    deviceOptions: voice.devices.map((device) => ({
      key: device.deviceId || String(device.index),
      value: device.deviceId,
      label: device.label || `Microphone ${device.index + 1}`,
    })),
    showStopMic: voice.micOn,
    startMicDisabled: !connected,
    muteDisabled: !voice.micOn,
    mutePressed: voice.muted,
    muteLabel: voice.muted ? "Unmute" : "Mute",
    pushToTalkDisabled: !connected,
    pushToTalkPressed: voice.pushToTalkActive,
    localVadChecked: voice.localVadEnabled,
    localVadStateLabel: `${voice.localVadEnabled ? (voice.localVadActive ? "active" : "quiet") : "disabled"} ${voiceEnergyLabel(
      voice.energy,
    )}`,
  };
}

export function voiceEnergyPercent(energy: number): number {
  return Math.min(100, Math.round(energy * 420));
}

export function voiceEnergyLabel(energy: number): number {
  return Math.round(energy * 100) / 100;
}
