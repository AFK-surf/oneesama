import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  isVirtualOrNonMicInput,
  summarizeAudioInputs,
} from "../scripts/lan-operator-real-mic-preflight.mjs";

test("real-mic preflight treats Steam virtual input as non-real mic", () => {
  const summary = summarizeAudioInputs(
    [
      {
        _name: "Steam Streaming Microphone",
        coreaudio_default_audio_input_device: "spaudio_yes",
        coreaudio_device_manufacturer: "Valve Corporation",
        coreaudio_device_input: 2,
        coreaudio_device_transport: "coreaudio_device_type_virtual",
      },
    ],
    [
      {
        deviceId: "default",
        label: "Default - Steam Streaming Microphone (Virtual)",
      },
    ],
  );

  assert.equal(summary.ok, false);
  assert.equal(summary.blocker, "macos_no_real_microphone_input");
  assert.equal(summary.system.defaultInput.name, "Steam Streaming Microphone");
  assert.equal(
    summary.browser.selectedInput.label,
    "Default - Steam Streaming Microphone (Virtual)",
  );
  assert.equal(summary.system.realInputCount, 0);
  assert.equal(summary.browser.realInputCount, 0);
});

test("real-mic preflight accepts built-in microphone input", () => {
  const summary = summarizeAudioInputs(
    [
      {
        _name: "MacBook Pro Microphone",
        coreaudio_default_audio_input_device: "spaudio_yes",
        coreaudio_device_manufacturer: "Apple Inc.",
        coreaudio_device_input: 1,
        coreaudio_device_transport: "coreaudio_device_type_builtin",
      },
    ],
    [
      {
        deviceId: "default",
        label: "Default - MacBook Pro Microphone",
      },
      {
        deviceId: "built-in",
        label: "MacBook Pro Microphone",
      },
    ],
  );

  assert.equal(summary.ok, true);
  assert.equal(summary.blocker, null);
  assert.equal(summary.system.realInputCount, 1);
  assert.equal(summary.browser.realInputCount, 2);
});

test("real-mic classifier rejects speakers and virtual devices", () => {
  assert.equal(isVirtualOrNonMicInput({ label: "Steam Streaming Speakers" }), true);
  assert.equal(isVirtualOrNonMicInput({ label: "Studio Display Microphone" }), false);
});
