import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  CAPTURE_SAMPLE_RATE,
  PROCESSOR_FRAMES,
  VOICE_WS_BACKPRESSURE_BYTES,
  VOICE_WS_OPEN_STATE,
  canSendVoiceChunk,
  connectVoiceCaptureGraph,
  createVoiceCaptureAudioContext,
  shouldPublishVoiceChunkCount,
  stopVoiceCaptureResources,
  voiceAudioConstraints,
} from "../packages/core/src/operator/web/voiceCaptureResources.ts";

test("operator voice capture resources build browser audio constraints", () => {
  assert.deepEqual(voiceAudioConstraints(""), {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  assert.deepEqual(voiceAudioConstraints("mic-1"), {
    audio: {
      deviceId: { exact: "mic-1" },
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
});

test("operator voice capture resources create audio context with sample-rate fallback", async () => {
  const calls = [];
  class FakeAudioContext {
    constructor(options) {
      calls.push(options || null);
      if (options?.sampleRate === CAPTURE_SAMPLE_RATE) {
        throw new Error("sample rate unsupported");
      }
    }

    async resume() {
      calls.push("resume");
    }
  }

  const ctx = await createVoiceCaptureAudioContext({ AudioContext: FakeAudioContext });

  assert.ok(ctx instanceof FakeAudioContext);
  assert.deepEqual(calls, [{ sampleRate: CAPTURE_SAMPLE_RATE }, null, "resume"]);
});

test("operator voice capture resources support webkit audio context fallback", async () => {
  const calls = [];
  class FakeWebkitAudioContext {
    constructor(options) {
      calls.push(options);
    }

    resume() {
      calls.push("resume");
    }
  }

  const ctx = await createVoiceCaptureAudioContext({
    webkitAudioContext: FakeWebkitAudioContext,
  });

  assert.ok(ctx instanceof FakeWebkitAudioContext);
  assert.deepEqual(calls, [{ sampleRate: CAPTURE_SAMPLE_RATE }, "resume"]);
});

test("operator voice capture resources connect browser audio graph through silent sink", () => {
  const calls = [];
  const stream = { id: "stream-1" };
  const destination = { label: "destination" };
  const source = {
    label: "source",
    connect: (target) => calls.push(["source.connect", target.label]),
  };
  const processor = {
    label: "processor",
    onaudioprocess: null,
    connect: (target) => calls.push(["processor.connect", target.label]),
  };
  const sink = {
    label: "sink",
    gain: { value: 1 },
    connect: (target) => calls.push(["sink.connect", target.label]),
  };
  const ctx = {
    destination,
    createMediaStreamSource: (nextStream) => {
      calls.push(["createMediaStreamSource", nextStream.id]);
      return source;
    },
    createScriptProcessor: (frames, inputs, outputs) => {
      calls.push(["createScriptProcessor", frames, inputs, outputs]);
      return processor;
    },
    createGain: () => {
      calls.push(["createGain"]);
      return sink;
    },
  };
  const events = [];

  const returned = connectVoiceCaptureGraph({
    audioContext: ctx,
    stream,
    onAudioProcess: (event) => events.push(event.kind),
  });

  assert.equal(returned, processor);
  assert.equal(sink.gain.value, 0);
  processor.onaudioprocess({ kind: "frame" });
  assert.deepEqual(events, ["frame"]);
  assert.deepEqual(calls, [
    ["createMediaStreamSource", "stream-1"],
    ["createScriptProcessor", PROCESSOR_FRAMES, 1, 1],
    ["createGain"],
    ["source.connect", "processor"],
    ["processor.connect", "sink"],
    ["sink.connect", "destination"],
  ]);
});

test("operator voice capture resources gate chunk sending by mute and backpressure", () => {
  assert.equal(
    canSendVoiceChunk({
      muted: false,
      readyState: VOICE_WS_OPEN_STATE,
      bufferedAmount: 0,
    }),
    true,
  );
  assert.equal(
    canSendVoiceChunk({
      muted: false,
      readyState: VOICE_WS_OPEN_STATE,
      bufferedAmount: VOICE_WS_BACKPRESSURE_BYTES,
    }),
    true,
  );
  assert.equal(
    canSendVoiceChunk({
      muted: false,
      readyState: VOICE_WS_OPEN_STATE,
      bufferedAmount: VOICE_WS_BACKPRESSURE_BYTES + 1,
    }),
    false,
  );
  assert.equal(
    canSendVoiceChunk({
      muted: true,
      readyState: VOICE_WS_OPEN_STATE,
      bufferedAmount: 0,
    }),
    false,
  );
  assert.equal(
    canSendVoiceChunk({
      muted: false,
      readyState: 0,
      bufferedAmount: 0,
    }),
    false,
  );
});

test("operator voice capture resources publish chunk count every eight chunks", () => {
  assert.equal(shouldPublishVoiceChunkCount(0), true);
  assert.equal(shouldPublishVoiceChunkCount(1), false);
  assert.equal(shouldPublishVoiceChunkCount(7), false);
  assert.equal(shouldPublishVoiceChunkCount(8), true);
  assert.equal(shouldPublishVoiceChunkCount(16), true);
});

test("operator voice capture resources release browser handles", () => {
  const calls = [];
  stopVoiceCaptureResources({
    processor: { disconnect: () => calls.push("processor") },
    stream: {
      getTracks: () => [
        { stop: () => calls.push("track-1") },
        { stop: () => calls.push("track-2") },
      ],
    },
    audioContext: { close: () => calls.push("ctx") },
    websocket: { close: () => calls.push("ws") },
  });

  assert.deepEqual(calls, ["processor", "track-1", "track-2", "ctx", "ws"]);
});
