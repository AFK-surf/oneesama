import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { buildLivePlannerReport } from "../scripts/realtime-kwwk-live-planner-benchmark.mjs";

const OPENROUTER_ENV = [
  "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_PROVIDER_SORT",
  "MAB_KWWK_CU_PLANNER_OPENROUTER_PROVIDER_SORT",
  "ONEESAMA_OPENROUTER_PROVIDER_SORT",
  "MAB_OPENROUTER_PROVIDER_SORT",
  "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_REQUIRE_PARAMETERS",
  "MAB_KWWK_CU_PLANNER_OPENROUTER_REQUIRE_PARAMETERS",
  "ONEESAMA_OPENROUTER_REQUIRE_PARAMETERS",
  "MAB_OPENROUTER_REQUIRE_PARAMETERS",
  "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_ALLOW_FALLBACKS",
  "MAB_KWWK_CU_PLANNER_OPENROUTER_ALLOW_FALLBACKS",
  "ONEESAMA_OPENROUTER_ALLOW_FALLBACKS",
  "MAB_OPENROUTER_ALLOW_FALLBACKS",
  "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_STREAM",
  "MAB_KWWK_CU_PLANNER_OPENROUTER_STREAM",
  "ONEESAMA_OPENROUTER_STREAM",
  "MAB_OPENROUTER_STREAM",
];

function withOpenRouterEnv(values, fn) {
  const previous = new Map(OPENROUTER_ENV.map((name) => [name, process.env[name]]));
  for (const name of OPENROUTER_ENV) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const name of OPENROUTER_ENV) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("KWWK live planner report records OpenRouter routing and latency blockers", () => {
  const report = withOpenRouterEnv(
    {
      ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_PROVIDER_SORT: "latency",
      ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_REQUIRE_PARAMETERS: "1",
      ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_STREAM: "0",
    },
    () =>
      buildLivePlannerReport(
        {
          provider: "openrouter",
          model: "google/gemini-3.5-flash",
          timeoutMs: 30_000,
          plannerTimeoutMs: 3000,
          plannerSloMs: 1200,
          warmupRuns: 1,
          plannerRuns: 2,
          reasoningEffort: "minimal",
          serviceTier: "",
        },
        {
          ok: false,
          apiKeyPresent: true,
          cases: [
            {
              id: "planner-1",
              ok: false,
              schemaValid: true,
              withinPlannerSlo: false,
              modelLatencyMs: 1600,
              roundTripMs: 1602,
              blocker: "planner_model_latency_slo_exceeded",
            },
            {
              id: "planner-2",
              ok: false,
              schemaValid: false,
              modelLatencyMs: 3000,
              roundTripMs: 3001,
              blocker: "blocked_planner_model_timeout",
            },
          ],
          warmupCases: [],
          durationMs: 42,
        },
      ),
  );

  assert.equal(report.ok, false);
  assert.deepEqual(report.providerRuntime, {
    sort: "latency",
    requireParameters: true,
    allowFallbacks: null,
    stream: false,
  });
  assert.deepEqual(report.latencyGate, {
    ok: false,
    plannerSloMs: 1200,
    p50ModelMs: 1600,
    p90ModelMs: 3000,
    p95ModelMs: 3000,
    maxModelMs: 3000,
    p95RoundTripMs: 3001,
    measuredCount: 2,
    exceededCount: 1,
  });
  assert.deepEqual(report.summaryCounts, {
    schemaValid: 1,
    plannerLatencySloExceeded: 1,
    invalidResponse: 0,
    timeout: 1,
  });
});

test("KWWK live planner report records native Gemini runtime", () => {
  const report = buildLivePlannerReport(
    {
      provider: "gemini",
      model: "gemini-3.5-flash",
      timeoutMs: 30_000,
      plannerTimeoutMs: 3000,
      plannerSloMs: 1200,
      warmupRuns: 0,
      plannerRuns: 1,
      reasoningEffort: "minimal",
      serviceTier: "",
    },
    {
      ok: true,
      apiKeyPresent: true,
      cases: [
        {
          id: "planner-1",
          ok: true,
          schemaValid: true,
          modelLatencyMs: 900,
          roundTripMs: 905,
          blocker: "",
        },
      ],
      warmupCases: [],
      durationMs: 42,
    },
  );

  assert.equal(
    report.docsEvidence.endpoint,
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
  );
  assert.deepEqual(report.providerRuntime, {
    endpoint: "generateContent",
    responseSchema: "responseMimeType+responseSchema",
    thinkingLevel: "",
    thinkingBudget: 0,
    deterministicPlannerShape: "operation_id_selection",
    deterministicHedgeWidth: 24,
    openAICompatibility: false,
  });
  assert.deepEqual(report.latencyGate, {
    ok: true,
    plannerSloMs: 1200,
    p50ModelMs: 900,
    p90ModelMs: 900,
    p95ModelMs: 900,
    maxModelMs: 900,
    p95RoundTripMs: 905,
    measuredCount: 1,
    exceededCount: 0,
  });
});
