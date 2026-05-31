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

test("Recappi realtime input coalesces bursty chunks before browser push", async () => {
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
      return { ok: true };
    },
  };

  const input = createRecappiRealtimeAudioInput({ sessionId: "session_test", recappiTap });
  await input.start({ context: {}, page, diagnostics: null });
  assert.equal(typeof consumer, "function");

  for (let chunk = 0; chunk < 20; chunk += 1) {
    consumer(null, Float32Array.from([chunk, -chunk]));
  }

  await waitFor(() => input.status().pushedChunks === 20);
  assert.equal(input.status().droppedChunks, 0);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].samples.length, 40);
  assert.deepEqual(pushed[0].samples.slice(0, 6), [0, 0, 1, -1, 2, -2]);
  assert.deepEqual(pushed[0].samples.slice(-4), [18, -18, 19, -19]);
});

test("Recappi realtime input rejects global Recappi fallback source", async () => {
  let startOptions = null;
  let consumer = null;
  const recappiTap = {
    start: async (options) => {
      startOptions = options;
      return {
        source: "recappi_global_audio",
        sampleRate: 48000,
        channels: 2,
        processId: 0,
      };
    },
    addConsumer: (callback) => {
      consumer = callback;
      return () => {
        consumer = null;
      };
    },
    status: () => ({
      ok: true,
      running: true,
      source: "recappi_global_audio",
      sampleRate: 48000,
      channels: 2,
      processId: 0,
    }),
  };
  const page = {
    isClosed: () => false,
    evaluate: async () => ({ ok: true }),
  };

  const input = createRecappiRealtimeAudioInput({ sessionId: "session_test", recappiTap });
  await assert.rejects(
    () => input.start({ context: {}, page, diagnostics: null }),
    /unexpected_recappi_tap_source:recappi_global_audio/,
  );
  assert.equal(consumer, null);
  assert.equal(input.status().source, "recappi_process_audio");
  assert.deepEqual(startOptions, { context: {} });
});

test("Recappi realtime input probe starts only process-level tap", async () => {
  let startOptions = null;
  const recappiTap = {
    start: async (options) => {
      startOptions = options;
      return {
        source: "recappi_process_audio",
        sampleRate: 48000,
        channels: 2,
        processId: 4321,
      };
    },
    addConsumer: () => () => {},
    status: () => ({
      ok: true,
      running: true,
      source: "recappi_process_audio",
      sampleRate: 48000,
      channels: 2,
      processId: 4321,
    }),
  };

  const input = createRecappiRealtimeAudioInput({ sessionId: "session_test", recappiTap });
  const result = await input.probe({ context: {} });

  assert.deepEqual(startOptions, { context: {} });
  assert.equal(result.ok, true);
  assert.equal(result.source, "recappi_process_audio");
  assert.equal(result.processId, 4321);
});

test("Recappi realtime input probe reports process-tap blocker before runtime init", async () => {
  let startOptions = null;
  const recappiTap = {
    start: async (options) => {
      startOptions = options;
      throw new Error("chromium_audio_process_not_found");
    },
    addConsumer: () => () => {},
    status: () => ({
      ok: false,
      running: false,
      source: "",
      sampleRate: 0,
      channels: 0,
      processId: 0,
    }),
  };

  const input = createRecappiRealtimeAudioInput({ sessionId: "session_test", recappiTap });
  const result = await input.probe({ context: {} });

  assert.deepEqual(startOptions, { context: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, "chromium_audio_process_not_found");
  assert.equal(result.source, "");
});
