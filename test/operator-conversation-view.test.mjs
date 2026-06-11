import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  conversationView,
  turnsFromEvents,
} from "../packages/core/src/operator/web/conversationView.ts";

test("operator conversation view folds transcript and assistant text turns", () => {
  const turns = turnsFromEvents([
    { type: "transcript_completed", text: "hello" },
    { type: "assistant_text_delta", responseId: "r1", text: "hi " },
    { type: "assistant_text_delta", responseId: "r1", text: "there" },
    { type: "assistant_text_completed", responseId: "r1", text: "hi there" },
    { type: "assistant_text_delta", responseId: "r2", text: "next" },
  ]);

  assert.deepEqual(turns, [
    { role: "you", text: "hello", status: "heard" },
    { role: "bot", text: "hi there", status: "final" },
    { role: "bot", text: "next", status: "speaking" },
  ]);
});

test("operator conversation view derives header labels and metrics from runtime debug", () => {
  const view = conversationView(
    {
      debug: {
        conversation: {
          status: "connected",
          eventCounts: { speech_started: 2 },
          control: { lastResult: "cancelled" },
        },
        output: {
          assistantText: { currentText: "still talking" },
        },
        timeline: {
          currentTurnId: "turn_2",
          turns: [
            {
              turnId: "turn_2",
              startedAt: "2026-06-11T00:00:00.000Z",
              lastEventAt: "2026-06-11T00:00:01.000Z",
              durationMs: 1000,
              status: "active",
              responseIds: ["r1"],
              latestEvent: "assistant_text_delta",
              blocker: null,
              milestones: {
                heard: true,
                speechStarted: true,
                transcript: true,
                tool: false,
                kwwk: false,
                verification: false,
                output: true,
              },
              events: ["transcript_completed", "assistant_text_delta"],
            },
          ],
          rows: [],
        },
      },
      runtimeError: "",
    },
    {
      error: "",
      status: "connecting",
      events: [{ type: "transcript_completed", text: "hello" }],
    },
  );

  assert.equal(view.latestEventLabel, "assistant_text_delta");
  assert.equal(view.currentTurnLabel, "turn_2");
  assert.equal(view.eventCountLabel, "1");
  assert.equal(view.speechStartedCountLabel, "2");
  assert.equal(view.controlLabel, "cancelled");
  assert.equal(view.connected, true);
  assert.equal(view.liveAssistantText, "still talking");
  assert.equal(view.empty, false);
  assert.equal(view.errorText, "");
  assert.equal(view.latestTurn?.turnId, "turn_2");
});

test("operator conversation view falls back to realtime state and errors", () => {
  const view = conversationView(
    {
      debug: {},
      runtimeError: "runtime_down",
    },
    {
      error: "ws_down",
      status: "connected",
      events: [{ type: "audio_started" }],
    },
  );

  assert.equal(view.latestEventLabel, "audio_started");
  assert.equal(view.currentTurnLabel, "no turn");
  assert.equal(view.eventCountLabel, "1");
  assert.equal(view.speechStartedCountLabel, "0");
  assert.equal(view.controlLabel, "idle");
  assert.equal(view.connected, true);
  assert.equal(view.liveAssistantText, "");
  assert.equal(view.empty, true);
  assert.equal(view.errorText, "ws_down");
  assert.equal(view.latestTurn, null);
});
