import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  LEGACY_LOCAL_VAD_THRESHOLD,
  legacyLocalVadView,
  legacySurfaceStateProxy,
  legacySurfaceStateView,
  legacyVoiceCaptureView,
} from "../packages/core/src/operator/web/legacySurfaceBridgeView.ts";

function voice(overrides = {}) {
  return {
    chunksSent: 0,
    devices: [],
    energy: 0,
    localVadActive: false,
    localVadEnabled: false,
    micOn: false,
    muted: false,
    selectedDeviceId: "",
    ...overrides,
  };
}

test("operator legacy surface state view maps voice and debug state", () => {
  const devices = [{ index: 0, deviceId: "desk", label: "Desk mic", groupId: "g1" }];
  const providerConfig = { selectedTransport: "openai_realtime", providers: [] };
  const state = legacySurfaceStateView(
    {
      providerConfig,
      debug: {
        voice: { chunksReceived: 2 },
        visual: {
          sources: [{ id: "screen", label: "Screen", kind: "desktop_app", state: "live" }],
          composition: { layoutRevision: 3 },
        },
        kwwk: { status: "executing", actionCount: 4 },
        conversation: { status: "connected" },
      },
    },
    voice({
      chunksSent: 7,
      devices,
      energy: 0.42,
      localVadActive: true,
      localVadEnabled: true,
      micOn: true,
      muted: true,
      selectedDeviceId: "desk",
    }),
  );

  assert.equal(state.ready, true);
  assert.deepEqual(state.voiceCapture, {
    status: "capturing",
    lastEnergy: 0.42,
    availableDeviceCount: 1,
    deviceId: "desk",
  });
  assert.deepEqual(state.voiceLocalVad, {
    enabled: true,
    role: "telemetry",
    active: true,
    threshold: LEGACY_LOCAL_VAD_THRESHOLD,
    lastEnergy: 0.42,
  });
  assert.equal(state.voiceDeviceId, "desk");
  assert.equal(state.voiceDevices, devices);
  assert.equal(state.voiceChunksSent, 7);
  assert.equal(state.voiceMuted, true);
  assert.equal(state.voice.chunksReceived, 2);
  assert.equal(state.visual.composition.layoutRevision, 3);
  assert.equal(state.sources.length, 1);
  assert.equal(state.kwwk.status, "executing");
  assert.equal(state.conversation.status, "connected");
  assert.equal(state.liveProviderConfig, providerConfig);
});

test("operator legacy surface state view falls back to empty debug objects", () => {
  const state = legacySurfaceStateView({ providerConfig: null, debug: {} }, voice());

  assert.deepEqual(state.voice, {});
  assert.deepEqual(state.visual, {});
  assert.deepEqual(state.sources, []);
  assert.deepEqual(state.kwwk, {});
  assert.deepEqual(state.conversation, {});
  assert.equal(state.liveProviderConfig, null);
});

test("operator legacy surface state proxy forwards voice device assignments", () => {
  const calls = [];
  const state = legacySurfaceStateProxy(
    legacySurfaceStateView({ providerConfig: null, debug: {} }, voice({ selectedDeviceId: "old" })),
    (deviceId) => calls.push(deviceId),
  );

  state.voiceDeviceId = "new-device";
  assert.deepEqual(calls, ["new-device"]);
  assert.equal(state.voiceDeviceId, "new-device");

  state.voiceDeviceId = null;
  assert.deepEqual(calls, ["new-device", ""]);
  assert.equal(state.voiceDeviceId, null);
});

test("operator legacy local vad and capture helpers preserve compatibility labels", () => {
  assert.deepEqual(legacyLocalVadView({ enabled: false, active: true, lastEnergy: 0.12 }), {
    enabled: false,
    role: "disabled",
    active: true,
    threshold: LEGACY_LOCAL_VAD_THRESHOLD,
    lastEnergy: 0.12,
  });
  assert.deepEqual(
    legacyVoiceCaptureView({
      devices: [{ index: 0, deviceId: "mic", label: "Mic", groupId: "g" }],
      energy: 0.2,
      micOn: false,
      selectedDeviceId: "mic",
    }),
    {
      status: "idle",
      lastEnergy: 0.2,
      availableDeviceCount: 1,
      deviceId: "mic",
    },
  );
});
