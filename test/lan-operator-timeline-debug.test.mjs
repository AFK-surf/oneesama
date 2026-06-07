import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { defaultDebugState } from "../packages/core/src/operator/lan-operator-debug-state.ts";
import { appendTimelineRow } from "../packages/core/src/operator/lan-operator-timeline-debug.ts";

const baseTime = Date.parse("2026-06-06T00:00:00.000Z");

function at(ms) {
  return new Date(baseTime + ms).toISOString();
}

function append(debug, event, atMs) {
  appendTimelineRow(debug, {
    at: at(atMs),
    layer: event.startsWith("assistant") ? "output_audio" : "audio_input",
    event,
    ok: true,
    turnId: "turn_real_mic",
    responseId: event.startsWith("assistant") ? "response_real_mic" : null,
    blocker: null,
    detail: {},
  });
}

test("turn summaries preserve voice milestones after rolling timeline rows drop early events", () => {
  const debug = defaultDebugState();

  append(debug, "operator_voice_chunk_received", 0);
  append(debug, "speech_started", 120);
  append(debug, "transcript_delta", 180);
  append(debug, "assistant_text_delta", 310);

  for (let index = 0; index < 140; index += 1) {
    append(debug, "transcript_delta", 400 + index);
  }

  assert.equal(
    debug.timeline.rows.some((row) => row.event === "operator_voice_chunk_received"),
    false,
  );
  assert.equal(
    debug.timeline.rows.some((row) => row.event === "speech_started"),
    false,
  );

  const turn = debug.timeline.turns.find((entry) => entry.turnId === "turn_real_mic");
  assert.equal(turn?.milestones.heard, true);
  assert.equal(turn?.milestones.speechStarted, true);
  assert.equal(turn?.milestones.transcript, true);
  assert.equal(turn?.milestones.output, true);
  assert.equal(turn?.milestoneAts?.heard, at(0));
  assert.equal(turn?.milestoneAts?.speechStarted, at(120));
  assert.equal(turn?.milestoneDurationsMs?.speechStarted, 120);
});
