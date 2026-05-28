import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMeetingArtifactPipeline } from "../packages/core/src/meeting/post-meeting-artifacts.ts";

function createFakeAsrCommand(dir, text) {
  const scriptPath = join(dir, "fake-asr.mjs");
  writeFileSync(
    scriptPath,
    `let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  console.log(JSON.stringify({ ok: true, provider: "fake", text: ${JSON.stringify(text)} }));
});
`,
  );
  return `node ${JSON.stringify(scriptPath)}`;
}

test("post-meeting artifacts keep captions as transcript when audio ASR succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oneesama-post-meeting-"));
  const audioPath = join(dir, "audio.wav");
  writeFileSync(audioPath, "fake audio");
  const pipeline = createMeetingArtifactPipeline({
    rootDir: join(dir, "artifacts"),
    asrProvider: "command",
    env: {
      ...process.env,
      MAB_ASR_COMMAND: createFakeAsrCommand(dir, "Unknown: ASR corrected content"),
    },
  });

  const result = await pipeline.postProcessMeeting({
    id: "caption-asr-review",
    title: "Caption ASR review",
    audioPath,
    captions: [
      {
        speaker: "Peng",
        text: "Caption keeps the speaker label.",
        source: "google-meet-caption-dom",
      },
    ],
  });

  assert.equal(result.asr.provider, "fake");
  assert.equal(result.asr.text, "Unknown: ASR corrected content");
  assert.equal(result.transcript.provider, "caption");
  assert.equal(result.transcript.segments[0].speaker, "Peng");
  assert.equal(result.transcript.segments[0].text, "Caption keeps the speaker label.");
});

test("post-meeting artifacts use audio ASR when no caption transcript exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oneesama-post-meeting-"));
  const audioPath = join(dir, "audio.wav");
  writeFileSync(audioPath, "fake audio");
  const pipeline = createMeetingArtifactPipeline({
    rootDir: join(dir, "artifacts"),
    asrProvider: "command",
    env: {
      ...process.env,
      MAB_ASR_COMMAND: createFakeAsrCommand(dir, "Peng: ASR-only transcript"),
    },
  });

  const result = await pipeline.postProcessMeeting({
    id: "asr-without-captions",
    title: "ASR without captions",
    audioPath,
  });

  assert.equal(result.transcript.provider, "asr:fake");
  assert.equal(result.transcript.segments[0].text, "Peng: ASR-only transcript");
});
