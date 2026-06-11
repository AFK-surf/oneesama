import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  listVoiceInputDevices,
  selectedVoiceDeviceMissing,
  voiceInputDevicesFromMediaDevices,
} from "../packages/core/src/operator/web/voiceDevices.ts";

test("operator voice devices normalize audio inputs and labels", () => {
  assert.deepEqual(
    voiceInputDevicesFromMediaDevices([
      { kind: "videoinput", deviceId: "cam", label: "Camera", groupId: "video" },
      { kind: "audioinput", deviceId: "mic-1", label: "", groupId: "group-a" },
      { kind: "audioinput", deviceId: "mic-2", label: "Desk Mic", groupId: "group-b" },
    ]),
    [
      { index: 0, deviceId: "mic-1", label: "Microphone 1", groupId: "group-a" },
      { index: 1, deviceId: "mic-2", label: "Desk Mic", groupId: "group-b" },
    ],
  );
});

test("operator voice devices list browser audio inputs defensively", async () => {
  assert.deepEqual(await listVoiceInputDevices(undefined), []);
  assert.deepEqual(await listVoiceInputDevices({}), []);
  assert.deepEqual(
    await listVoiceInputDevices({
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "default", label: "Default", groupId: "group-default" },
      ],
    }),
    [{ index: 0, deviceId: "default", label: "Default", groupId: "group-default" }],
  );
});

test("operator voice devices report stale selected device ids", () => {
  const devices = [{ index: 0, deviceId: "default", label: "Default", groupId: "group-default" }];

  assert.equal(selectedVoiceDeviceMissing(devices, ""), false);
  assert.equal(selectedVoiceDeviceMissing(devices, "default"), false);
  assert.equal(selectedVoiceDeviceMissing(devices, "missing"), true);
});
