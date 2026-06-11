import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  INITIAL_VOICE_VIEW,
  voiceViewReducer,
} from "../packages/core/src/operator/web/voiceState.ts";

test("operator voice state starts from idle view defaults", () => {
  assert.deepEqual(INITIAL_VOICE_VIEW, {
    micOn: false,
    muted: false,
    pushToTalkActive: false,
    localVadEnabled: false,
    localVadActive: false,
    energy: 0,
    devices: [],
    selectedDeviceId: "",
    chunksSent: 0,
  });
});

test("operator voice state tracks devices and selected device", () => {
  const devices = [
    { deviceId: "default", label: "Default microphone" },
    { deviceId: "mic-1", label: "Desk mic" },
  ];
  const withDevices = voiceViewReducer(INITIAL_VOICE_VIEW, {
    type: "set_devices",
    devices,
    selectedDeviceId: "mic-1",
  });
  assert.deepEqual(withDevices.devices, devices);
  assert.equal(withDevices.selectedDeviceId, "mic-1");

  const selected = voiceViewReducer(withDevices, {
    type: "set_selected_device",
    deviceId: "default",
  });
  assert.equal(selected.selectedDeviceId, "default");
});

test("operator voice state disables local VAD by clearing active state", () => {
  const active = voiceViewReducer(
    voiceViewReducer(INITIAL_VOICE_VIEW, {
      type: "set_local_vad_enabled",
      enabled: true,
    }),
    { type: "set_local_vad_active", active: true },
  );
  assert.equal(active.localVadEnabled, true);
  assert.equal(active.localVadActive, true);

  const disabled = voiceViewReducer(active, {
    type: "set_local_vad_enabled",
    enabled: false,
  });
  assert.equal(disabled.localVadEnabled, false);
  assert.equal(disabled.localVadActive, false);
});

test("operator voice state tracks mic, energy, chunks, mute, and push-to-talk", () => {
  let state = voiceViewReducer(INITIAL_VOICE_VIEW, { type: "mic_started" });
  state = voiceViewReducer(state, { type: "set_energy", energy: 0.12 });
  state = voiceViewReducer(state, { type: "set_chunks_sent", chunksSent: 9 });
  state = voiceViewReducer(state, { type: "set_muted", muted: true });
  state = voiceViewReducer(state, { type: "set_push_to_talk_active", active: true });

  assert.equal(state.micOn, true);
  assert.equal(state.energy, 0.12);
  assert.equal(state.chunksSent, 9);
  assert.equal(state.muted, true);
  assert.equal(state.pushToTalkActive, true);

  const stopped = voiceViewReducer(state, { type: "mic_stopped" });
  assert.equal(stopped.micOn, false);
  assert.equal(stopped.energy, 0);
  assert.equal(stopped.localVadActive, false);
  assert.equal(stopped.muted, true);
  assert.equal(stopped.chunksSent, 9);
});
