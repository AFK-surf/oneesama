import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { canStopKwwk, workPanelView } from "../packages/core/src/operator/web/workPanelView.ts";

function baseWork(overrides = {}) {
  return {
    phase: "idle",
    intent: "",
    backend: "",
    steps: [],
    result: null,
    error: "",
    ...overrides,
  };
}

test("operator work panel view derives idle defaults from work state", () => {
  const view = workPanelView(baseWork(), { debug: {} });

  assert.equal(view.headerStatus, "idle");
  assert.equal(view.headerBackend, "manual");
  assert.equal(view.runButtonDisabled, false);
  assert.equal(view.stopActionDisabled, true);
  assert.equal(view.kwwkStatus, "idle");
  assert.equal(view.kwwkPhaseClass, "phase-idle");
  assert.equal(view.jobLabel, "-");
  assert.equal(view.cursorLabel, "0");
  assert.equal(view.actionCountLabel, "0");
  assert.equal(view.verificationLabel, "-");
  assert.equal(view.empty, true);
  assert.equal(view.phaseLabel, "idle");
  assert.equal(view.workPhaseClass, "phase-idle");
});

test("operator work panel view derives running kwwk controls and recent actions", () => {
  const view = workPanelView(
    baseWork({
      phase: "running",
      intent: "inspect browser",
      backend: "kwwk-cu",
      steps: [{ step: 1, type: "observe", ref: "screen" }],
    }),
    {
      debug: {
        kwwk: {
          status: "executing",
          latestActionKind: "click",
          currentJobId: "job_1",
          cursorEventCount: 7,
          actionCount: 6,
          verification: { ok: null, status: "pending" },
          blocker: null,
          actions: Array.from({ length: 6 }, (_, index) => ({
            ts: `t${index}`,
            kind: `kind_${index}`,
            label: `label_${index}`,
            status: index === 5 ? "running" : "done",
          })),
        },
      },
    },
  );

  assert.equal(view.headerStatus, "executing");
  assert.equal(view.headerBackend, "click");
  assert.equal(view.runButtonDisabled, true);
  assert.equal(view.stopActionDisabled, false);
  assert.equal(view.kwwkStatus, "executing");
  assert.equal(view.jobLabel, "job_1");
  assert.equal(view.cursorLabel, "7");
  assert.equal(view.actionCountLabel, "6");
  assert.equal(view.verificationLabel, "pending");
  assert.equal(view.empty, false);
  assert.equal(view.phaseLabel, "running…");
  assert.equal(view.backendLabel, "kwwk-cu");
  assert.equal(view.intentText, "inspect browser");
  assert.deepEqual(view.steps, [{ step: 1, type: "observe", ref: "screen" }]);
  assert.equal(view.recentActions.length, 5);
  assert.deepEqual(view.recentActions[0], {
    key: "t1-0",
    kind: "kind_1",
    label: "label_1",
    status: "done",
  });
  assert.deepEqual(view.recentActions.at(-1), {
    key: "t5-4",
    kind: "kind_5",
    label: "label_5",
    status: "running",
  });
});

test("operator work panel view derives blocker, verification, result, and errors", () => {
  const result = {
    status: "blocked",
    blocker: "needs permission",
    extracted: "partial data",
    postConditions: [{ ok: false, condition: { kind: "visible", value: "dialog" } }],
  };
  const view = workPanelView(
    baseWork({
      phase: "error",
      result,
      error: "work failed",
    }),
    {
      debug: {
        kwwk: {
          status: "blocked",
          latestActionKind: null,
          currentJobId: null,
          cursorEventCount: 0,
          actionCount: 0,
          verification: { ok: false, status: "failed" },
          blocker: "permission",
          actions: [],
        },
      },
    },
  );

  assert.equal(view.headerStatus, "blocked");
  assert.equal(view.headerBackend, "manual");
  assert.equal(view.stopActionDisabled, true);
  assert.equal(view.verificationLabel, "failed");
  assert.equal(view.blockerText, "blocked: permission");
  assert.equal(view.phaseLabel, "error");
  assert.equal(view.result, result);
  assert.equal(view.errorText, "work failed");
});

test("operator work panel view recognises stoppable kwwk phases", () => {
  assert.equal(canStopKwwk("queued"), true);
  assert.equal(canStopKwwk("started"), true);
  assert.equal(canStopKwwk("streaming"), true);
  assert.equal(canStopKwwk("running"), true);
  assert.equal(canStopKwwk("observing"), true);
  assert.equal(canStopKwwk("planning"), true);
  assert.equal(canStopKwwk("executing"), true);
  assert.equal(canStopKwwk("verifying"), true);
  assert.equal(canStopKwwk("completed"), false);
  assert.equal(canStopKwwk("idle"), false);
  assert.equal(canStopKwwk(null), false);
});
