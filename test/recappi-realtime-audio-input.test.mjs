import assert from "node:assert/strict";
import { test } from "vite-plus/test";

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
      if (payload === undefined) return { ok: true };
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
      if (payload === undefined) return { ok: true };
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

test("Recappi realtime input suppresses prime pulse audio before browser push", async () => {
  let consumer = null;
  let primeEvaluations = 0;
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
      if (payload !== undefined) {
        pushed.push(payload);
        return { ok: true };
      }
      primeEvaluations += 1;
      return primeEvaluations > 1 ? { ok: true, durationMs: 5 } : { ok: true };
    },
  };

  const input = createRecappiRealtimeAudioInput({ sessionId: "session_test", recappiTap });
  await input.start({ context: {}, page, diagnostics: null });
  assert.equal(typeof consumer, "function");

  consumer(null, Float32Array.from([0.75, -0.75]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pushed.length, 0);
  assert.equal(input.status().droppedChunks, 1);

  await new Promise((resolve) => setTimeout(resolve, 420));
  consumer(null, Float32Array.from([0.5, -0.5]));
  await waitFor(() => pushed.length === 1);
  assert.deepEqual(pushed[0].samples, [0.5, -0.5]);
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

test("Recappi realtime input probe inspects process-level tap without starting capture", async () => {
  let probeOptions = null;
  let startCalled = false;
  const recappiTap = {
    probe: async (options) => {
      probeOptions = options;
      return {
        source: "recappi_process_audio",
        sampleRate: 48000,
        channels: 2,
        processId: 4321,
      };
    },
    start: async () => {
      startCalled = true;
      throw new Error("tapAudio should not be started during probe");
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

  assert.deepEqual(probeOptions, { context: {} });
  assert.equal(startCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.source, "recappi_process_audio");
  assert.equal(result.processId, 4321);
});

test("Recappi realtime input probe reports process-tap blocker before runtime init", async () => {
  let probeOptions = null;
  let startCalled = false;
  const recappiTap = {
    probe: async (options) => {
      probeOptions = options;
      throw new Error("chromium_audio_process_not_found");
    },
    start: async () => {
      startCalled = true;
      throw new Error("tapAudio should not be started during probe");
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

  assert.deepEqual(probeOptions, { context: {} });
  assert.equal(startCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, "chromium_audio_process_not_found");
  assert.equal(result.source, "");
});

test("Recappi realtime input primes browser audio and retries tap startup", async () => {
  let consumer = null;
  let attempts = 0;
  const evaluations = [];
  const recappiTap = {
    start: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Application not found or not available for audio tapping");
      }
      return {
        source: "recappi_process_audio",
        sampleRate: 44100,
        channels: 2,
        processId: 2468,
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
      source: "recappi_process_audio",
      sampleRate: 44100,
      channels: 2,
      processId: 2468,
    }),
  };
  const diagnostics = {
    events: [],
    record(type, detail) {
      this.events.push({ type, detail });
    },
  };
  const page = {
    isClosed: () => false,
    evaluate: async () => {
      evaluations.push("evaluate");
      return { ok: true };
    },
  };

  const input = createRecappiRealtimeAudioInput({
    sessionId: "session_test",
    recappiTap,
    startTimeoutMs: 500,
    startRetryDelayMs: 10,
  });
  const result = await input.start({ context: {}, page, diagnostics });

  assert.equal(result.ok, true);
  assert.equal(result.state.processId, 2468);
  assert.equal(attempts, 2);
  assert.equal(typeof consumer, "function");
  assert.ok(evaluations.length >= 2);
  assert.ok(
    diagnostics.events.some(
      (event) => event.type === "recappi_realtime_audio_start_attempt_failed",
    ),
  );
  assert.ok(
    diagnostics.events.some(
      (event) => event.type === "recappi_realtime_audio_start_retry_succeeded",
    ),
  );
});

test("Recappi realtime input keeps retrying in background after early app audio unavailable", async () => {
  let consumer = null;
  let attempts = 0;
  const recappiTap = {
    start: async () => {
      attempts += 1;
      if (attempts < 4) {
        throw new Error("Application not found or not available for audio tapping");
      }
      return {
        source: "recappi_process_audio",
        sampleRate: 44100,
        channels: 2,
        processId: 8642,
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
      running: Boolean(consumer),
      source: consumer ? "recappi_process_audio" : "",
      sampleRate: consumer ? 44100 : 0,
      channels: consumer ? 2 : 0,
      processId: consumer ? 8642 : 0,
    }),
  };
  const diagnostics = {
    events: [],
    record(type, detail) {
      this.events.push({ type, detail });
    },
  };
  const page = {
    isClosed: () => false,
    evaluate: async () => ({ ok: true }),
  };

  const input = createRecappiRealtimeAudioInput({
    sessionId: "session_test",
    recappiTap,
    startTimeoutMs: 1,
    startRetryDelayMs: 50,
    backgroundRetryTimeoutMs: 1000,
    backgroundRetryDelayMs: 10,
  });
  const result = await input.start({ context: {}, page, diagnostics });

  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.equal(input.status().retrying, true);
  assert.equal(consumer, null);

  await waitFor(() => input.status().recording === true, 1000);
  assert.equal(input.status().ok, true);
  assert.equal(input.status().processId, 8642);
  assert.equal(typeof consumer, "function");
  assert.ok(
    diagnostics.events.some(
      (event) => event.type === "recappi_realtime_audio_background_retry_succeeded",
    ),
  );
});
