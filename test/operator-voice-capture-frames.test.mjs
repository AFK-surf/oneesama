import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  VOICE_WS_BACKPRESSURE_BYTES,
  VOICE_WS_OPEN_STATE,
} from "../packages/core/src/operator/web/voiceCaptureResources.ts";
import { voiceCaptureFrameDecision } from "../packages/core/src/operator/web/voiceCaptureFrames.ts";
import { LOCAL_VAD_THRESHOLD } from "../packages/core/src/operator/web/voiceEvents.ts";

const BASE_FRAME = {
  sampleRate: 4,
  localVadEnabled: true,
  muted: false,
  readyState: VOICE_WS_OPEN_STATE,
  bufferedAmount: 0,
  sequence: 0,
  voiceStreamId: "web_voice_1",
  sessionId: "session-1",
  monotonicMs: 123.4,
  sentAt: "2026-06-11T00:00:00.000Z",
};

test("operator voice capture frames emit PCM chunks and publish first chunk count", () => {
  const decision = voiceCaptureFrameDecision({
    ...BASE_FRAME,
    samples: new Float32Array([0, 1, -1, 0]),
  });

  assert.equal(decision.energy, Math.sqrt(0.5));
  assert.equal(decision.vadActive, true);
  assert.equal(decision.updateLocalVad, true);
  assert.equal(decision.nextSequence, 1);
  assert.equal(decision.chunksSent, 1);
  assert.equal(decision.chunkMessage?.type, "voice_chunk");
  assert.equal(decision.chunkMessage?.sessionId, "session-1");
  assert.equal(decision.chunkMessage?.sequence, 0);
  assert.equal(decision.chunkMessage?.voiceStreamId, "web_voice_1");
  assert.equal(decision.chunkMessage?.sampleRate, 4);
  assert.equal(decision.chunkMessage?.durationMs, 1000);
  assert.equal(decision.chunkMessage?.energy, Math.sqrt(0.5));
  assert.equal(typeof decision.chunkMessage?.dataBase64, "string");
});

test("operator voice capture frames keep local VAD inactive when disabled", () => {
  const decision = voiceCaptureFrameDecision({
    ...BASE_FRAME,
    samples: new Float32Array([LOCAL_VAD_THRESHOLD * 2]),
    localVadEnabled: false,
  });

  assert.equal(decision.vadActive, true);
  assert.equal(decision.updateLocalVad, false);
  assert.equal(decision.nextSequence, 1);
  assert.equal(decision.chunkMessage?.sequence, 0);
});

test("operator voice capture frames do not send or increment sequence while muted", () => {
  const decision = voiceCaptureFrameDecision({
    ...BASE_FRAME,
    samples: new Float32Array([1]),
    muted: true,
    sequence: 7,
  });

  assert.equal(decision.nextSequence, 7);
  assert.equal(decision.chunkMessage, undefined);
  assert.equal(decision.chunksSent, undefined);
});

test("operator voice capture frames do not send when websocket is closed or backpressured", () => {
  const closed = voiceCaptureFrameDecision({
    ...BASE_FRAME,
    samples: new Float32Array([1]),
    readyState: 0,
    sequence: 3,
  });
  assert.equal(closed.nextSequence, 3);
  assert.equal(closed.chunkMessage, undefined);

  const backpressured = voiceCaptureFrameDecision({
    ...BASE_FRAME,
    samples: new Float32Array([1]),
    bufferedAmount: VOICE_WS_BACKPRESSURE_BYTES + 1,
    sequence: 4,
  });
  assert.equal(backpressured.nextSequence, 4);
  assert.equal(backpressured.chunkMessage, undefined);
});

test("operator voice capture frames publish chunk count every eight sent chunks", () => {
  const sequenceSeven = voiceCaptureFrameDecision({
    ...BASE_FRAME,
    samples: new Float32Array([1]),
    sequence: 7,
  });
  assert.equal(sequenceSeven.nextSequence, 8);
  assert.equal(sequenceSeven.chunksSent, undefined);

  const sequenceEight = voiceCaptureFrameDecision({
    ...BASE_FRAME,
    samples: new Float32Array([1]),
    sequence: 8,
  });
  assert.equal(sequenceEight.nextSequence, 9);
  assert.equal(sequenceEight.chunksSent, 9);
  assert.equal(sequenceEight.chunkMessage?.sequence, 8);
});
