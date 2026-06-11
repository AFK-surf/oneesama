import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  INITIAL_WORK_VIEW,
  foldWorkEvent,
  resetWorkForRun,
  workEventFromPayload,
} from "../packages/core/src/operator/web/workState.ts";

test("operator work state folds intent, step, and done result events", () => {
  const running = foldWorkEvent(INITIAL_WORK_VIEW, {
    type: "intent",
    detail: { intent: "extract browser state", backend: "accessibility" },
  });
  assert.equal(running.phase, "running");
  assert.equal(running.intent, "extract browser state");
  assert.equal(running.backend, "accessibility");

  const stepped = foldWorkEvent(running, {
    type: "step",
    detail: {
      step: 2,
      operation: {
        type: "read",
        target: { ref: "chrome" },
        rationale: "inspect active tab",
      },
    },
  });
  assert.deepEqual(stepped.steps, [
    {
      step: 2,
      type: "read",
      ref: "chrome",
      rationale: "inspect active tab",
      failed: false,
      error: undefined,
    },
  ]);

  const done = foldWorkEvent(stepped, {
    type: "result",
    detail: { status: "done", steps: 1, summary: "ready" },
  });
  assert.equal(done.phase, "done");
  assert.deepEqual(done.result, { status: "done", steps: 1, summary: "ready" });
});

test("operator work state folds non-command and runtime error events", () => {
  const notCommand = foldWorkEvent(INITIAL_WORK_VIEW, {
    type: "not_a_command",
    detail: { reason: "needs operator intent" },
  });
  assert.equal(notCommand.phase, "not_a_command");
  assert.equal(notCommand.error, "needs operator intent");

  const failed = foldWorkEvent(notCommand, {
    type: "error",
    detail: { error: "ax unavailable" },
  });
  assert.equal(failed.phase, "error");
  assert.equal(failed.error, "ax unavailable");

  const blocked = foldWorkEvent(failed, {
    type: "result",
    detail: { status: "blocked", blocker: "permission" },
  });
  assert.equal(blocked.phase, "error");
  assert.deepEqual(blocked.result, { status: "blocked", blocker: "permission" });
});

test("operator work state parses only valid work_event envelopes", () => {
  assert.equal(workEventFromPayload({ type: "canonical_conversation_event" }), null);
  assert.equal(workEventFromPayload({ type: "work_event" }), null);
  assert.equal(workEventFromPayload({ type: "work_event", event: { type: "unknown" } }), null);
  assert.deepEqual(
    workEventFromPayload({
      type: "work_event",
      event: { type: "step", detail: { failed: true, error: "boom" } },
    }),
    { type: "step", detail: { failed: true, error: "boom" } },
  );
});

test("operator work state resets view state before sending a new run", () => {
  const reset = resetWorkForRun();
  assert.deepEqual(reset, {
    phase: "running",
    intent: "",
    backend: "",
    steps: [],
    result: null,
    error: "",
  });
  assert.notEqual(reset.steps, INITIAL_WORK_VIEW.steps);
});
