import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  voiceBarView,
  voiceEnergyLabel,
  voiceEnergyPercent,
} from "../packages/core/src/operator/web/voiceBarView.ts";

function voice(overrides = {}) {
  return {
    devices: [],
    energy: 0,
    localVadActive: false,
    localVadEnabled: false,
    micOn: false,
    muted: false,
    pushToTalkActive: false,
    ...overrides,
  };
}

test("operator voice bar view derives idle disconnected state", () => {
  const view = voiceBarView(voice(), false);

  assert.equal(view.energyPercent, 0);
  assert.equal(view.energyWidth, "0%");
  assert.equal(view.micStateLabel, "idle / open");
  assert.deepEqual(view.deviceOptions, []);
  assert.equal(view.showStopMic, false);
  assert.equal(view.startMicDisabled, true);
  assert.equal(view.muteDisabled, true);
  assert.equal(view.mutePressed, false);
  assert.equal(view.muteLabel, "Mute");
  assert.equal(view.pushToTalkDisabled, true);
  assert.equal(view.pushToTalkPressed, false);
  assert.equal(view.localVadChecked, false);
  assert.equal(view.localVadStateLabel, "disabled 0");
});

test("operator voice bar view derives armed muted push-to-talk state", () => {
  const view = voiceBarView(
    voice({
      energy: 0.24,
      localVadActive: true,
      localVadEnabled: true,
      micOn: true,
      muted: true,
      pushToTalkActive: true,
      devices: [
        { index: 0, deviceId: "", label: "", groupId: "g0" },
        { index: 1, deviceId: "desk", label: "Desk mic", groupId: "g1" },
      ],
    }),
    true,
  );

  assert.equal(view.energyPercent, 100);
  assert.equal(view.energyWidth, "100%");
  assert.equal(view.micStateLabel, "armed / muted");
  assert.deepEqual(view.deviceOptions, [
    { key: "0", value: "", label: "Microphone 1" },
    { key: "desk", value: "desk", label: "Desk mic" },
  ]);
  assert.equal(view.showStopMic, true);
  assert.equal(view.startMicDisabled, false);
  assert.equal(view.muteDisabled, false);
  assert.equal(view.mutePressed, true);
  assert.equal(view.muteLabel, "Unmute");
  assert.equal(view.pushToTalkDisabled, false);
  assert.equal(view.pushToTalkPressed, true);
  assert.equal(view.localVadChecked, true);
  assert.equal(view.localVadStateLabel, "active 0.24");
});

test("operator voice bar view derives local vad quiet state", () => {
  const view = voiceBarView(voice({ energy: 0.123, localVadEnabled: true }), true);

  assert.equal(view.localVadStateLabel, "quiet 0.12");
});

test("operator voice energy helpers clamp and round values", () => {
  assert.equal(voiceEnergyPercent(0), 0);
  assert.equal(voiceEnergyPercent(0.1), 42);
  assert.equal(voiceEnergyPercent(0.5), 100);
  assert.equal(voiceEnergyLabel(0.126), 0.13);
  assert.equal(voiceEnergyLabel(0.124), 0.12);
});
