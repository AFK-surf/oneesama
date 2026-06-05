#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { ensureAppControlHelperBinary } from "../packages/core/src/meeting/app-control-helper.ts";

const WARM_RUNS = 8;
const WARM_P95_SLO_MS = 2500;
const PLANNER_MODEL_P95_SLO_MS = 1200;
const NONVISUAL_EXECUTE_OBSERVE_SLO_MS = 500;
const NONVISUAL_EXECUTE_VERIFY_SLO_MS = 500;

function parseArgs(argv) {
  const args = { jsonOut: "", warmRuns: WARM_RUNS, timeoutMs: 30_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json-out") args.jsonOut = argv[++i];
    else if (arg === "--warm-runs") args.warmRuns = Number(argv[++i]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.warmRuns = Number.isFinite(args.warmRuns) && args.warmRuns > 0 ? args.warmRuns : WARM_RUNS;
  args.timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 30_000;
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/realtime-kwwk-latency-benchmark.mjs [options]

Options:
  --warm-runs <n>       Warm deterministic plan samples (default: ${WARM_RUNS})
  --timeout-ms <n>      Overall helper timeout (default: 30000)
  --json-out <path>     Write structured report
`);
}

function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function callPlanOnce(child, id) {
  return callHelperOnce(child, {
    id,
    caseId: "deterministic-plan",
    method: "kwwk.cu.plan",
    params: {
      instruction: "输入 hello",
      modelPlan: modelPlan([{ kind: "type_text", text: "hello" }]),
    },
    expectedOk: true,
  });
}

function modelPlan(operations, summary = "Local fixture planner produced a model-first CU plan.") {
  return {
    status: "planned",
    summary,
    blocker: "",
    operations,
  };
}

async function callHelperOnce(child, testCase) {
  const started = performance.now();
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: testCase.id,
      method: testCase.method,
      params: testCase.params,
    })}\n`,
  );
  const response = await child.nextResponse();
  const result = response.result || {};
  const planner = result?.planner || result?.metadata?.planner || {};
  const timings = result?.metadata?.timings || {};
  return {
    caseId: testCase.caseId,
    roundTripMs: Math.round(performance.now() - started),
    normalizeMs: Number(planner?.normalizeMs || 0),
    modelUsed: planner?.modelUsed === true,
    modelName: String(planner?.modelName || planner?.optionalModel?.model || ""),
    modelLatencyMs: Number(planner?.modelLatencyMs || 0),
    observationMode: String(result?.metadata?.observationMode || ""),
    observeMs: Number(timings?.observeMs || 0),
    planMs: Number(timings?.planMs ?? planner?.latencyMs ?? planner?.normalizeMs ?? 0),
    executeMs: Number(timings?.executeMs || 0),
    verifyMs: Number(timings?.verifyMs || 0),
    actions: Array.isArray(result?.actions) ? result.actions : [],
    ok: testCase.expectedOk === false ? result?.ok === false : result?.ok === true,
  };
}

function warmLatencyCases(iteration) {
  return [
    {
      id: `warm-plan-${iteration}`,
      caseId: "deterministic-plan",
      method: "kwwk.cu.plan",
      params: {
        instruction: "输入 hello",
        modelPlan: modelPlan([{ kind: "type_text", text: "hello" }]),
      },
      expectedOk: true,
    },
    {
      id: `warm-observe-${iteration}`,
      caseId: "observe-state-intent",
      method: "kwwk.cu.plan",
      params: {
        instruction: "看一下当前状态",
        modelPlan: modelPlan([{ kind: "state" }], "Local fixture planner chose observe/state."),
      },
      expectedOk: true,
    },
    {
      id: `warm-visual-${iteration}`,
      caseId: "visual-screenshot-fallback-plan",
      method: "kwwk.cu.plan",
      params: {
        instruction: "点击发送按钮",
        modelPlan: modelPlan([
          { kind: "click", x: 260, y: 120, targetRole: "button", targetLabel: "发送" },
        ]),
        observation: {
          screenshot: {
            elements: [
              { role: "button", label: "发送", frame: { x: 200, y: 100, width: 120, height: 40 } },
            ],
          },
        },
      },
      expectedOk: true,
    },
    {
      id: `warm-nonvisual-execute-${iteration}`,
      caseId: "nonvisual-execute-light",
      method: "kwwk.cu.execute",
      params: {
        instruction: "Press Escape once.",
        modelPlan: modelPlan(
          [{ kind: "press_key", key: "escape" }],
          "Local fixture planner chose a non-visual key action.",
        ),
      },
      expectedOk: true,
    },
  ];
}

function optionalModelLatencyCase() {
  return {
    id: "optional-local-model",
    caseId: "optional-local-model-plan",
    method: "kwwk.cu.plan",
    params: {
      instruction: "用小模型规划这个可见操作",
      modelPlan: modelPlan([{ kind: "press_key", key: "return" }]),
    },
    expectedOk: true,
  };
}

function spawnHelper(binary, timeoutMs, env = {}) {
  const child = spawn(binary, ["--stdio"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  const pending = [];
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/u);
    stdout = lines.pop() || "";
    for (const line of lines.filter(Boolean)) {
      pending.shift()?.(JSON.parse(line));
    }
  });
  child.nextResponse = () =>
    new Promise((resolve) => {
      pending.push(resolve);
    });
  child.closeHelper = async () => {
    clearTimeout(timer);
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  };
  return child;
}

export function buildKWWKLatencyReport(args, result) {
  const warmRoundTrips = result.warmSamples.map((sample) => sample.roundTripMs);
  const warmP95Ms = percentile(warmRoundTrips, 95);
  const optionalModelSamples = Array.isArray(result.optionalModelSamples)
    ? result.optionalModelSamples
    : [];
  const modelSamples = [...result.warmSamples, ...optionalModelSamples];
  const modelLatencies = modelSamples.map((sample) => sample.modelLatencyMs || 0);
  const plannerModelP95Ms = percentile(modelLatencies, 95);
  const samplesByCase = {};
  for (const sample of result.warmSamples) {
    const caseId = sample.caseId || "unknown";
    samplesByCase[caseId] ||= [];
    samplesByCase[caseId].push(sample);
  }
  const nonVisualExecuteSamples = samplesByCase["nonvisual-execute-light"] || [];
  const nonVisualExecuteLight =
    nonVisualExecuteSamples.length === args.warmRuns &&
    nonVisualExecuteSamples.every(
      (sample) =>
        sample.ok &&
        sample.modelUsed &&
        sample.modelName &&
        sample.observationMode === "light" &&
        sample.observeMs <= NONVISUAL_EXECUTE_OBSERVE_SLO_MS &&
        sample.verifyMs <= NONVISUAL_EXECUTE_VERIFY_SLO_MS &&
        sample.actions.includes("press_key"),
    );
  const ok =
    result.ok === true &&
    result.compileMs >= 0 &&
    result.coldFirstPlanMs >= 0 &&
    warmP95Ms <= WARM_P95_SLO_MS &&
    plannerModelP95Ms <= PLANNER_MODEL_P95_SLO_MS &&
    result.warmSamples.length === args.warmRuns * 4 &&
    result.warmSamples.every((sample) => sample.ok && sample.modelUsed && sample.modelName) &&
    nonVisualExecuteLight &&
    optionalModelSamples.length === 1 &&
    optionalModelSamples.every((sample) => sample.ok && sample.modelUsed && sample.modelName);
  return {
    schema: "oneesama.kwwk-latency-report.v1",
    gate: "cold_warm_latency",
    ok,
    generatedAt: new Date().toISOString(),
    evidenceMode: "host_kwwk_helper_model_first_fixture_latency",
    acceptanceGateScope: "cold_warm_latency",
    meetRoomRequired: false,
    realAppExecution: false,
    timeoutMs: args.timeoutMs,
    environment: {
      platform: process.platform,
      upstreamAvailable: true,
    },
    timings: {
      compileMs: result.compileMs,
      startupMs: result.startupMs || 0,
      coldFirstPlanMs: result.coldFirstPlanMs,
      warmRoundTripMs: warmRoundTrips,
      warmP50Ms: percentile(warmRoundTrips, 50),
      warmP95Ms,
      normalizeMs: result.warmSamples.map((sample) => sample.normalizeMs),
      observeMs: result.warmSamples.map((sample) => sample.observeMs || 0),
      planMs: result.warmSamples.map((sample) => sample.planMs || 0),
      modelMs: modelLatencies,
      plannerModelP95Ms,
      executeMs: result.warmSamples.map((sample) => sample.executeMs || 0),
      verifyMs: result.warmSamples.map((sample) => sample.verifyMs || 0),
      wrapperMs: 0,
      realtimeMs: 0,
    },
    nonVisualExecuteLight: {
      ok: nonVisualExecuteLight,
      observeSloMs: NONVISUAL_EXECUTE_OBSERVE_SLO_MS,
      verifySloMs: NONVISUAL_EXECUTE_VERIFY_SLO_MS,
      samples: nonVisualExecuteSamples.map((sample) => ({
        roundTripMs: sample.roundTripMs,
        observationMode: sample.observationMode,
        observeMs: sample.observeMs,
        executeMs: sample.executeMs,
        verifyMs: sample.verifyMs,
        actions: sample.actions,
        modelUsed: sample.modelUsed,
        modelName: sample.modelName,
      })),
      blocker: nonVisualExecuteLight
        ? ""
        : result.error || "nonvisual_execute_light_latency_failed",
    },
    proofBoundary: {
      proves: [
        "helper compile/startup and model-first warm latency are measurable",
        "observe/state-intent and visual screenshot-fallback planner calls are sampled through kwwk.cu.plan",
        "non-visual model-first execute calls use light observation without AX/window/screenshot slow path",
        "local fixture planner reports modelUsed, model name, and model latency for every warm case",
      ],
      doesNotProve: [
        "Realtime wrapper latency",
        "live app execution latency",
        "remote OpenAI planner latency",
      ],
    },
    cases: [
      "deterministic-plan",
      "observe-state-intent",
      "visual-screenshot-fallback-plan",
      "nonvisual-execute-light",
    ].map((caseId) => {
      const samples = samplesByCase[caseId] || [];
      const modelUsed = samples.length > 0 && samples.every((sample) => sample.modelUsed === true);
      return {
        id: caseId,
        ok:
          samples.length === args.warmRuns &&
          samples.every((sample) => sample.ok && sample.modelUsed === true && sample.modelName) &&
          (caseId !== "nonvisual-execute-light" || nonVisualExecuteLight),
        warmRuns: samples.length,
        modelUsed,
        modelName: samples[0]?.modelName || "",
        warmRoundTripMs: samples.map((sample) => sample.roundTripMs),
        observeMs: samples.map((sample) => sample.observeMs || 0),
        verifyMs: samples.map((sample) => sample.verifyMs || 0),
        observationModes: [
          ...new Set(samples.map((sample) => sample.observationMode).filter(Boolean)),
        ],
        blocker:
          samples.length === args.warmRuns &&
          samples.every((sample) => sample.ok && sample.modelUsed === true && sample.modelName) &&
          (caseId !== "nonvisual-execute-light" || nonVisualExecuteLight)
            ? ""
            : result.error ||
              (caseId === "nonvisual-execute-light"
                ? "nonvisual_execute_light_latency_failed"
                : "latency_benchmark_failed"),
      };
    }),
    optionalModelCases: optionalModelSamples.map((sample) => ({
      id: sample.caseId || "optional-local-model-plan",
      ok: sample.ok === true && sample.modelUsed === true && Boolean(sample.modelName),
      modelUsed: sample.modelUsed === true,
      modelName: sample.modelName || "",
      modelLatencyMs: sample.modelLatencyMs || 0,
      roundTripMs: sample.roundTripMs || 0,
      blocker:
        sample.ok === true && sample.modelUsed === true && Boolean(sample.modelName)
          ? ""
          : result.error || "optional_model_latency_missing",
    })),
    error: result.error || "",
  };
}

export async function runKWWKLatencyBenchmark(args) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "app_control_helper_requires_darwin", warmSamples: [] };
  }
  const dir = await mkdtemp(join(tmpdir(), "oneesama-kwwk-latency-"));
  const previousHelper = process.env.ONEESAMA_APP_CONTROL_HELPER;
  process.env.ONEESAMA_APP_CONTROL_HELPER = join(dir, "helper");
  try {
    const compileStarted = performance.now();
    const binary = await ensureAppControlHelperBinary();
    const compileMs = Math.round(performance.now() - compileStarted);
    const startupStarted = performance.now();
    const helper = spawnHelper(binary, args.timeoutMs, {
      ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
      ONEESAMA_KWWK_CU_PLANNER_MODEL: "tiny-planner-latency-fixture",
    });
    const startupMs = Math.round(performance.now() - startupStarted);
    const cold = await callPlanOnce(helper, "cold");
    const warmSamples = [];
    for (let i = 0; i < args.warmRuns; i += 1) {
      for (const testCase of warmLatencyCases(i)) {
        warmSamples.push(await callHelperOnce(helper, testCase));
      }
    }
    await helper.closeHelper();
    const modelHelper = spawnHelper(binary, args.timeoutMs, {
      ONEESAMA_KWWK_PLANNER_PROVIDER: "local",
      ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
      ONEESAMA_KWWK_PLANNER_MODEL: "tiny-planner-latency-fixture",
      ONEESAMA_KWWK_CU_PLANNER_MODEL: "tiny-planner-latency-fixture",
      ONEESAMA_KWWK_PLANNER_LOCAL_PLAN_JSON: JSON.stringify({
        operations: [{ kind: "press_key", key: "return" }],
      }),
      ONEESAMA_KWWK_CU_PLANNER_LOCAL_PLAN_JSON: JSON.stringify({
        operations: [{ kind: "press_key", key: "return" }],
      }),
    });
    const optionalModelSamples = [await callHelperOnce(modelHelper, optionalModelLatencyCase())];
    await modelHelper.closeHelper();
    return {
      ok:
        cold.ok &&
        warmSamples.every((sample) => sample.ok) &&
        optionalModelSamples.every((sample) => sample.ok),
      compileMs,
      startupMs,
      coldFirstPlanMs: cold.roundTripMs,
      warmSamples,
      optionalModelSamples,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), warmSamples: [] };
  } finally {
    if (previousHelper === undefined) delete process.env.ONEESAMA_APP_CONTROL_HELPER;
    else process.env.ONEESAMA_APP_CONTROL_HELPER = previousHelper;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runKWWKLatencyBenchmark(args);
  const report = buildKWWKLatencyReport(args, result);
  if (args.jsonOut) {
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `KWWK cold/warm latency benchmark: ${report.ok ? "PASS" : "FAIL"} compileMs=${report.timings.compileMs} warmP50Ms=${report.timings.warmP50Ms} warmP95Ms=${report.timings.warmP95Ms}`,
  );
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`realtime-kwwk-latency-benchmark failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
