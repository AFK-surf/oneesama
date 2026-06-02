import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { buildKWWKLatencyReport } from "../scripts/realtime-kwwk-latency-benchmark.mjs";

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
        { caseId: "deterministic-plan", ok: true, roundTripMs: 4, normalizeMs: 0 },
        { caseId: "observe-state-intent", ok: true, roundTripMs: 5, normalizeMs: 0, observeMs: 0 },
        { caseId: "visual-screenshot-fallback-plan", ok: true, roundTripMs: 8, normalizeMs: 1 },
        { caseId: "deterministic-plan", ok: true, roundTripMs: 11, normalizeMs: 1 },
        { caseId: "observe-state-intent", ok: true, roundTripMs: 4, normalizeMs: 0, observeMs: 0 },
        { caseId: "visual-screenshot-fallback-plan", ok: true, roundTripMs: 5, normalizeMs: 0 },
        { caseId: "deterministic-plan", ok: true, roundTripMs: 8, normalizeMs: 1 },
        { caseId: "observe-state-intent", ok: true, roundTripMs: 11, normalizeMs: 1, observeMs: 0 },
        { caseId: "visual-screenshot-fallback-plan", ok: true, roundTripMs: 4, normalizeMs: 0 },
        { caseId: "deterministic-plan", ok: true, roundTripMs: 5, normalizeMs: 0 },
        { caseId: "observe-state-intent", ok: true, roundTripMs: 8, normalizeMs: 1, observeMs: 0 },
        { caseId: "visual-screenshot-fallback-plan", ok: true, roundTripMs: 11, normalizeMs: 1 },
      ],
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.gate, "cold_warm_latency");
  assert.equal(report.acceptanceGateScope, "cold_warm_latency");
  assert.equal(report.realAppExecution, false);
  assert.equal(report.meetRoomRequired, false);
  assert.equal(report.timings.warmP50Ms, 5);
  assert.equal(report.timings.warmP95Ms, 11);
  assert.equal(report.timings.startupMs, 3);
  assert.equal(report.timings.wrapperMs, 0);
  assert.equal(report.timings.realtimeMs, 0);
  assert.deepEqual(report.timings.modelMs, [2]);
  assert.equal(report.timings.warmRoundTripMs.length, 12);
  assert.deepEqual(
    report.cases.map((entry) => [entry.id, entry.warmRuns, entry.modelUsed]),
    [
      ["deterministic-plan", 4, false],
      ["observe-state-intent", 4, false],
      ["visual-screenshot-fallback-plan", 4, false],
    ],
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
      "local optional model planner fixture reports model name and model latency",
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
