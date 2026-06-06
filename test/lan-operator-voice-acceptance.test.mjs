import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  lanOperatorVoiceBrowserLaunchArgs,
  lanOperatorVoiceNormalizeTimelineDurations,
  lanOperatorVoiceOperatorPageUrl,
  lanOperatorVoiceSelectDevice,
  lanOperatorVoiceTimelineSinceBaseline,
} from "../scripts/lan-operator-voice-acceptance.mjs";

test("LAN voice external browser launch treats non-loopback HTTP origin as secure", () => {
  const args = lanOperatorVoiceBrowserLaunchArgs("http://192.168.1.100:18913/");

  assert.ok(args.includes("--use-fake-device-for-media-stream"));
  assert.ok(args.includes("--use-fake-ui-for-media-stream"));
  assert.ok(args.includes("--unsafely-treat-insecure-origin-as-secure=http://192.168.1.100:18913"));
});

test("LAN voice local browser launch does not mark loopback origin as insecure LAN", () => {
  const args = lanOperatorVoiceBrowserLaunchArgs("http://127.0.0.1:18913/");

  assert.equal(
    args.some((arg) => arg.startsWith("--unsafely-treat-insecure-origin-as-secure=")),
    false,
  );
});

test("LAN voice real-mic launch never enables Chromium fake media input", () => {
  const args = lanOperatorVoiceBrowserLaunchArgs("http://127.0.0.1:18913/operator", {
    inputMode: "real_mic",
  });

  assert.equal(args.includes("--use-fake-device-for-media-stream"), false);
  assert.equal(args.includes("--use-fake-ui-for-media-stream"), false);
});

test("LAN voice device selection can target a microphone by label", () => {
  const selection = lanOperatorVoiceSelectDevice(
    [
      { deviceId: "default", label: "Default - Steam Streaming Microphone (Virtual)" },
      { deviceId: "built-in", label: "MacBook Pro Microphone" },
    ],
    { micLabel: "macbook" },
  );

  assert.equal(selection.requested, true);
  assert.equal(selection.selected.deviceId, "built-in");
});

test("LAN voice device selection reports missing requested microphone", () => {
  const selection = lanOperatorVoiceSelectDevice(
    [{ deviceId: "default", label: "Default - Steam Streaming Microphone (Virtual)" }],
    { micLabel: "studio display" },
  );

  assert.equal(selection.requested, true);
  assert.equal(selection.selected, null);
  assert.deepEqual(
    selection.availableDevices.map((device) => device.label),
    ["Default - Steam Streaming Microphone (Virtual)"],
  );
});

test("LAN voice gate opens the formal /operator app entrypoint", () => {
  assert.equal(
    lanOperatorVoiceOperatorPageUrl("http://127.0.0.1:18913/"),
    "http://127.0.0.1:18913/operator",
  );
  assert.equal(
    lanOperatorVoiceOperatorPageUrl("http://127.0.0.1:18913/operator?debug=1"),
    "http://127.0.0.1:18913/operator?debug=1",
  );
});

test("LAN voice report ignores timeline rows that existed before the run baseline", () => {
  const rows = [
    { event: "old_transport_error", ok: false },
    { event: "operator_voice_chunk_received", ok: true },
    { event: "speech_started", ok: true },
  ];
  const sliced = lanOperatorVoiceTimelineSinceBaseline(rows, {
    debug: { timeline: { rows: [rows[0]] } },
  });

  assert.deepEqual(sliced, [rows[1], rows[2]]);
});

test("LAN voice report normalizes timeline durations for long-running surfaces", () => {
  const rows = [
    { event: "operator_voice_chunk_received", ok: true, durationMs: 163900 },
    { event: "assistant_text_delta", ok: true, durationMs: 164005 },
    { event: "assistant_audio_stopped", ok: true, durationMs: 164006 },
  ];
  const normalized = lanOperatorVoiceNormalizeTimelineDurations(rows);

  assert.equal(normalized[0].durationMs, 0);
  assert.equal(normalized[1].durationMs, 105);
  assert.equal(normalized[1].originalDurationMs, 164005);
});
