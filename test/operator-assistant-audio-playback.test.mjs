import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  assistantAudioBase64,
  assistantAudioSampleRate,
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
});
