import assert from "node:assert/strict";
import test from "node:test";

import { createRecappiRealtimeAudioInput } from "../packages/core/src/meeting/recappi-realtime-audio-input.ts";

function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timeout"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("Recappi realtime input serializes typed-array chunks for browser push", async () => {
  let consumer = null;
  const pushed = [];
  const recappiTap = {
    start: async () => ({
      source: "recappi_process_audio",
      sampleRate: 44100,
      channels: 2,
      processId: 1234,
    }),
    addConsumer: (callback) => {
      consumer = callback;
      return () => {
        consumer = null;
      };
    },
    status: () => ({
      ok: true,
      running: true,
      source: "recappi_process_audio",
      sampleRate: 44100,
      channels: 2,
      processId: 1234,
    }),
  };
  const page = {
    isClosed: () => false,
    evaluate: async (_fn, payload) => {
      pushed.push(payload);
      assert.equal(Array.isArray(payload.samples), true);
      return { ok: true };
    },
  };

  const input = createRecappiRealtimeAudioInput({ sessionId: "session_test", recappiTap });
  await input.start({ context: {}, page, diagnostics: null });
  assert.equal(typeof consumer, "function");

  consumer(null, Float32Array.from([0.25, -0.25, 0.5, -0.5]));

  await waitFor(() => pushed.length > 0);
  assert.deepEqual(pushed[0].samples, [0.25, -0.25, 0.5, -0.5]);
  assert.equal(input.status().pushedChunks, 1);
});
