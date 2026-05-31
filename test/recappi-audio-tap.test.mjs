import assert from "node:assert/strict";
import test from "node:test";

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

test("Recappi audio tap never uses the CDP audio-service PID as an app PID", async () => {
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
    tapGlobalAudio: () => {
      tapped.push({ type: "global" });
      return { sampleRate: 44100, channels: 2, stop: () => {} };
    },
  };
  const tap = createRecappiAudioTap({ shareableContent, log: () => {} });

  const status = await tap.start({
    context: fakeContext([
      { type: "browser", id: 999 },
      { type: "audio.mojom.AudioService", id: 333 },
    ]),
    allowGlobalFallback: true,
  });

  assert.deepEqual(tapped, [{ type: "global" }]);
  assert.equal(status.source, "recappi_global_audio");
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
    tapGlobalAudio: () => {
      tapped.push({ type: "global" });
      return { sampleRate: 44100, channels: 2, stop: () => {} };
    },
  };
  const tap = createRecappiAudioTap({ shareableContent, log: () => {} });

  const status = await tap.start({
    context: fakeContext([
      { type: "browser", id: 999 },
      { type: "audio.mojom.AudioService", id: 333 },
    ]),
    allowGlobalFallback: true,
  });

  assert.deepEqual(tapped, [{ type: "app", pid: 999 }]);
  assert.equal(status.source, "recappi_process_audio");
  assert.equal(status.processId, 999);
});
