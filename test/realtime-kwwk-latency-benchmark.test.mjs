import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { buildKWWKLatencyReport } from "../scripts/realtime-kwwk-latency-benchmark.mjs";

function warmSample(caseId, roundTripMs, extra = {}) {
  return {
    caseId,
    ok: true,
    roundTripMs,
    normalizeMs: 0,
    modelUsed: true,
    modelName: "tiny-planner-latency-fixture",
    modelLatencyMs: 0,
    ...extra,
  };
}

test("KWWK cold/warm latency report keeps latency evidence separate", () => {
  const report = buildKWWKLatencyReport(
    { timeoutMs: 30_000, warmRuns: 4 },
    {
      ok: true,
      compileMs: 1200,
      startupMs: 3,
      coldFirstPlanMs: 12,
      optionalModelSamples: [
        {
          caseId: "optional-local-model-plan",
          ok: true,
          roundTripMs: 9,
          normalizeMs: 1,
          modelUsed: true,
          modelName: "tiny-planner-latency-fixture",
          modelLatencyMs: 2,
        },
      ],
      warmSamples: [
        warmSample("deterministic-plan", 4),
        warmSample("observe-state-intent", 5, { observeMs: 0 }),
        warmSample("visual-screenshot-fallback-plan", 8, { normalizeMs: 1 }),
        warmSample("nonvisual-execute-light", 9, {
          observationMode: "light",
          observeMs: 24,
          executeMs: 87,
          verifyMs: 0,
          actions: ["press_key"],
        }),
        warmSample("deterministic-plan", 11, { normalizeMs: 1 }),
        warmSample("observe-state-intent", 4, { observeMs: 0 }),
        warmSample("visual-screenshot-fallback-plan", 5),
        warmSample("nonvisual-execute-light", 6, {
          observationMode: "light",
          observeMs: 20,
          executeMs: 80,
          verifyMs: 0,
          actions: ["press_key"],
        }),
        warmSample("deterministic-plan", 8, { normalizeMs: 1 }),
        warmSample("observe-state-intent", 11, { normalizeMs: 1, observeMs: 0 }),
        warmSample("visual-screenshot-fallback-plan", 4),
        warmSample("nonvisual-execute-light", 5, {
          observationMode: "light",
          observeMs: 18,
          executeMs: 75,
          verifyMs: 0,
          actions: ["press_key"],
        }),
        warmSample("deterministic-plan", 5),
        warmSample("observe-state-intent", 8, { normalizeMs: 1, observeMs: 0 }),
        warmSample("visual-screenshot-fallback-plan", 11, { normalizeMs: 1 }),
        warmSample("nonvisual-execute-light", 7, {
          observationMode: "light",
          observeMs: 22,
          executeMs: 78,
          verifyMs: 0,
          actions: ["press_key"],
        }),
      ],
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.gate, "cold_warm_latency");
  assert.equal(report.acceptanceGateScope, "cold_warm_latency");
  assert.equal(report.realAppExecution, false);
  assert.equal(report.meetRoomRequired, false);
  assert.equal(report.timings.warmP50Ms, 6);
  assert.equal(report.timings.warmP95Ms, 11);
  assert.equal(report.timings.startupMs, 3);
  assert.equal(report.timings.wrapperMs, 0);
  assert.equal(report.timings.realtimeMs, 0);
  assert.equal(report.timings.modelMs.length, 17);
  assert.equal(report.timings.modelMs.at(-1), 2);
  assert.equal(report.timings.warmRoundTripMs.length, 16);
  assert.equal(report.nonVisualExecuteLight.ok, true);
  assert.equal(report.nonVisualExecuteLight.observeSloMs, 500);
  assert.equal(report.nonVisualExecuteLight.verifySloMs, 500);
  assert.equal(report.nonVisualExecuteLight.samples.length, 4);
  assert.deepEqual(report.nonVisualExecuteLight.samples[0].actions, ["press_key"]);
  assert.equal(report.nonVisualExecuteLight.samples[0].observationMode, "light");
  assert.deepEqual(
    report.cases.map((entry) => [entry.id, entry.warmRuns, entry.modelUsed]),
    [
      ["deterministic-plan", 4, true],
      ["observe-state-intent", 4, true],
      ["visual-screenshot-fallback-plan", 4, true],
      ["nonvisual-execute-light", 4, true],
    ],
  );
  assert.deepEqual(
    report.cases.find((entry) => entry.id === "nonvisual-execute-light").observationModes,
    ["light"],
  );
  assert.deepEqual(report.optionalModelCases, [
    {
      id: "optional-local-model-plan",
      ok: true,
      modelUsed: true,
      modelName: "tiny-planner-latency-fixture",
      modelLatencyMs: 2,
      roundTripMs: 9,
      blocker: "",
    },
  ]);
  assert.ok(
    report.proofBoundary.proves.includes(
      "non-visual model-first execute calls use light observation without AX/window/screenshot slow path",
    ),
  );
  assert.ok(report.proofBoundary.doesNotProve.includes("Realtime wrapper latency"));
  assert.ok(report.proofBoundary.doesNotProve.includes("remote OpenAI planner latency"));
});

test("KWWK cold/warm latency report fails missing warm samples", () => {
  const report = buildKWWKLatencyReport(
    { timeoutMs: 30_000, warmRuns: 2 },
    {
      ok: true,
      compileMs: 1200,
      coldFirstPlanMs: 12,
      warmSamples: [{ caseId: "deterministic-plan", ok: true, roundTripMs: 4, normalizeMs: 0 }],
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.cases[0].blocker, "latency_benchmark_failed");
});
