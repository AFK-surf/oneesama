import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  assistantAudioBase64,
  assistantAudioChannels,
  assistantAudioSampleRate,
  assistantOutputStateMessage,
  createAssistantOutputState,
  foldAssistantOutputEvent,
  markAssistantAudioPlayed,
} from "../packages/core/src/operator/web/useAssistantAudioPlayback.ts";

test("assistant audio playback helpers read canonical audio fields", () => {
  assert.equal(
    assistantAudioBase64({
      type: "assistant_audio_chunk",
      audioBase64: "direct",
      detail: { audioBase64: "fallback" },
    }),
    "direct",
  );
  assert.equal(
    assistantAudioBase64({
      type: "assistant_audio_chunk",
      detail: { audioBase64: "fallback" },
    }),
    "fallback",
  );
  assert.equal(
    assistantAudioSampleRate({
      type: "assistant_audio_chunk",
      detail: { sampleRate: 16000 },
    }),
    16000,
  );
  assert.equal(assistantAudioSampleRate({ type: "assistant_audio_chunk" }), 24000);
  assert.equal(
    assistantAudioChannels({
      type: "assistant_audio_chunk",
      detail: { channels: 2 },
    }),
    2,
  );
});

test("assistant output helpers fold text and audio telemetry", () => {
  let output = createAssistantOutputState();
  output = foldAssistantOutputEvent(
    output,
    { type: "assistant_text_delta", text: "hel", responseId: "resp-1" },
    "2026-06-11T00:00:00.000Z",
  ).output;
  output = foldAssistantOutputEvent(
    output,
    { type: "assistant_text_completed", text: "hello", responseId: "resp-1" },
    "2026-06-11T00:00:01.000Z",
  ).output;

  assert.equal(output.assistantText.deltaCount, 1);
  assert.equal(output.assistantText.completedCount, 1);
  assert.equal(output.assistantText.completedText, "hello");
  assert.equal(output.assistantText.lastResponseId, "resp-1");

  const folded = foldAssistantOutputEvent(
    output,
    {
      type: "assistant_audio_chunk",
      audioBase64: "AAD/Pw==",
      detail: { sampleRate: 24000, channels: 1 },
    },
    "2026-06-11T00:00:02.000Z",
  );

  assert.equal(folded.changed, true);
  assert.equal(folded.audioChunk.sampleRate, 24000);
  assert.equal(folded.output.assistantAudio.chunksReceived, 1);
  assert.equal(folded.output.assistantAudio.bytesReceived, 4);
  assert.equal(folded.output.assistantAudio.lastChunkAt, "2026-06-11T00:00:02.000Z");

  const played = markAssistantAudioPlayed(folded.output, {
    queuedMs: 40,
    nowIso: "2026-06-11T00:00:02.010Z",
  });
  assert.equal(played.assistantAudio.status, "playing");
  assert.equal(played.assistantAudio.chunksPlayed, 1);
  assert.equal(played.assistantAudio.queuedMs, 40);
  assert.deepEqual(assistantOutputStateMessage(played), {
    type: "assistant_output_state",
    output: played,
  });
});
