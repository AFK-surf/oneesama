export interface VoiceDevice {
  index: number;
  deviceId: string;
  label: string;
  groupId: string;
}

export interface VoiceMediaDeviceInfo {
  kind: string;
  deviceId: string;
  label: string;
  groupId: string;
}

export interface VoiceMediaDevices {
  enumerateDevices?: () => Promise<VoiceMediaDeviceInfo[]>;
}

export function voiceInputDevicesFromMediaDevices(devices: VoiceMediaDeviceInfo[]): VoiceDevice[] {
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => ({
      index,
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
      groupId: device.groupId,
    }));
}

export async function listVoiceInputDevices(
  mediaDevices: VoiceMediaDevices | undefined,
): Promise<VoiceDevice[]> {
  if (!mediaDevices?.enumerateDevices) return [];
  return voiceInputDevicesFromMediaDevices(await mediaDevices.enumerateDevices());
}

export function selectedVoiceDeviceMissing(
  devices: VoiceDevice[],
  selectedDeviceId: string,
): boolean {
  return Boolean(
    selectedDeviceId && !devices.some((device) => device.deviceId === selectedDeviceId),
  );
}
