import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createRecappiAudioTap } from "../packages/core/src/audio/recappi-audio-tap.ts";

function fakeContext(processInfo) {
  return {
    browser: () => ({
      newBrowserCDPSession: async () => ({
        send: async () => ({ processInfo }),
      }),
    }),
  };
}

test("Recappi audio tap never falls back to global audio when CDP only exposes audio-service PID", async () => {
  const tapped = [];
  const shareableContent = {
    applications: () => [
      { processId: 111, name: "Google Chrome", bundleIdentifier: "com.google.Chrome" },
    ],
    applicationWithProcessId: () => null,
    tapAudio: (pid) => {
      tapped.push({ type: "app", pid });
      return { sampleRate: 44100, channels: 2, stop: () => {} };
    },
  };
  const tap = createRecappiAudioTap({ shareableContent, log: () => {} });

  await assert.rejects(
    () =>
      tap.start({
        context: fakeContext([
          { type: "browser", id: 999 },
          { type: "audio.mojom.AudioService", id: 333 },
        ]),
      }),
    /chromium_audio_process_not_found/,
  );

  assert.deepEqual(tapped, []);
  assert.equal(tap.status().source, "");
});

test("Recappi audio tap rejects helper apps instead of falling back to global audio", async () => {
  const tapped = [];
  const shareableContent = {
    applications: () => [
      {
        processId: 333,
        name: "Google Chrome for Testing Helper",
        bundleIdentifier: "com.google.ChromeForTesting.helper",
      },
    ],
    applicationWithProcessId: () => null,
    tapAudio: (pid) => {
      tapped.push({ type: "app", pid });
      return { sampleRate: 44100, channels: 2, stop: () => {} };
    },
  };
  const tap = createRecappiAudioTap({ shareableContent, log: () => {} });

  await assert.rejects(
    () =>
      tap.start({
        context: fakeContext([
          { type: "browser", id: 999 },
          { type: "audio.mojom.AudioService", id: 333 },
        ]),
      }),
    /chromium_audio_process_not_found/,
  );

  assert.deepEqual(tapped, []);
  assert.equal(tap.status().processId, 0);
});

test("Recappi audio tap probe refuses global fallback when process audio is required", async () => {
  const shareableContent = {
    applications: () => [
      {
        processId: 333,
        name: "Google Chrome for Testing Helper",
        bundleIdentifier: "com.google.ChromeForTesting.helper",
      },
    ],
    applicationWithProcessId: () => null,
    tapAudio: () => {
      throw new Error("tapAudio should not be called by probe");
    },
  };
  const tap = createRecappiAudioTap({ shareableContent, log: () => {} });

  const status = await tap.probe({
    context: fakeContext([
      { type: "browser", id: 999 },
      { type: "audio.mojom.AudioService", id: 333 },
    ]),
  });

  assert.equal(status.ok, false);
  assert.equal(status.error, "chromium_audio_process_not_found");
  assert.equal(status.source, "");
});

test("Recappi audio tap probe reports process audio when a browser app PID matches", async () => {
  const shareableContent = {
    applications: () => [
      { processId: 999, name: "Chromium", bundleIdentifier: "org.chromium.Chromium" },
    ],
    tapAudio: () => {
      throw new Error("tapAudio should not be called by probe");
    },
  };
  const tap = createRecappiAudioTap({ shareableContent, log: () => {} });

  const status = await tap.probe({
    context: fakeContext([
      { type: "browser", id: 999 },
      { type: "audio.mojom.AudioService", id: 333 },
    ]),
  });

  assert.equal(status.ok, true);
  assert.equal(status.source, "recappi_process_audio");
  assert.equal(status.processId, 999);
});

test("Recappi audio tap uses a Recappi app PID when it matches the browser process", async () => {
  const tapped = [];
  const shareableContent = {
    applications: () => [
      { processId: 999, name: "Chromium", bundleIdentifier: "org.chromium.Chromium" },
    ],
    tapAudio: (pid) => {
      tapped.push({ type: "app", pid });
      return { sampleRate: 44100, channels: 2, stop: () => {} };
    },
  };
  const tap = createRecappiAudioTap({ shareableContent, log: () => {} });

  const status = await tap.start({
    context: fakeContext([
      { type: "browser", id: 999 },
      { type: "audio.mojom.AudioService", id: 333 },
    ]),
  });

  assert.deepEqual(tapped, [{ type: "app", pid: 999 }]);
  assert.equal(status.source, "recappi_process_audio");
  assert.equal(status.processId, 999);
});

test(
  "Recappi SDK exposes Google Chrome as a process-tappable application on this machine",
  {
    skip: process.platform !== "darwin" || process.env.ONEESAMA_RUN_LOCAL_RECAPPI_PROBE !== "1",
  },
  async () => {
    const tap = createRecappiAudioTap({ log: () => {} });

    const status = await tap.probe({ context: null });

    assert.equal(status.ok, true, `expected Recappi process tap to be available: ${status.error}`);
    assert.equal(status.source, "recappi_process_audio");
    assert.ok(status.processId > 0, "expected a positive Chrome process id");
  },
);
