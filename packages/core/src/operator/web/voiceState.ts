import type { VoiceDevice } from "./voiceDevices.ts";

export interface VoiceViewState {
  micOn: boolean;
  muted: boolean;
  pushToTalkActive: boolean;
  localVadEnabled: boolean;
  localVadActive: boolean;
  energy: number;
  devices: VoiceDevice[];
  selectedDeviceId: string;
  chunksSent: number;
}

export type VoiceViewAction =
  | { type: "set_muted"; muted: boolean }
  | { type: "set_push_to_talk_active"; active: boolean }
  | { type: "set_local_vad_enabled"; enabled: boolean }
  | { type: "set_local_vad_active"; active: boolean }
  | { type: "set_energy"; energy: number }
  | { type: "set_devices"; devices: VoiceDevice[]; selectedDeviceId: string }
  | { type: "set_selected_device"; deviceId: string }
  | { type: "set_chunks_sent"; chunksSent: number }
  | { type: "mic_started" }
  | { type: "mic_stopped" };

export const INITIAL_VOICE_VIEW: VoiceViewState = {
  micOn: false,
  muted: false,
  pushToTalkActive: false,
  localVadEnabled: false,
  localVadActive: false,
  energy: 0,
  devices: [],
  selectedDeviceId: "",
  chunksSent: 0,
};

export function voiceViewReducer(state: VoiceViewState, action: VoiceViewAction): VoiceViewState {
  if (action.type === "set_muted") return { ...state, muted: action.muted };
  if (action.type === "set_push_to_talk_active") {
    return { ...state, pushToTalkActive: action.active };
  }
  if (action.type === "set_local_vad_enabled") {
    return {
      ...state,
      localVadEnabled: action.enabled,
      localVadActive: action.enabled ? state.localVadActive : false,
    };
  }
  if (action.type === "set_local_vad_active") {
    return { ...state, localVadActive: action.active };
  }
  if (action.type === "set_energy") return { ...state, energy: action.energy };
  if (action.type === "set_devices") {
    return {
      ...state,
      devices: action.devices,
      selectedDeviceId: action.selectedDeviceId,
    };
  }
  if (action.type === "set_selected_device") {
    return { ...state, selectedDeviceId: action.deviceId };
  }
  if (action.type === "set_chunks_sent") {
    return { ...state, chunksSent: action.chunksSent };
  }
  if (action.type === "mic_started") return { ...state, micOn: true };
  return {
    ...state,
    micOn: false,
    energy: 0,
    localVadActive: false,
  };
}
