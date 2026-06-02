#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { ensureAppControlHelperBinary } from "../packages/core/src/meeting/app-control-helper.ts";

const WARM_RUNS = 8;

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
    method: "app_control.plan_instruction",
    params: { instruction: "输入 hello" },
    expectedOk: true,
  });
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
  return {
    caseId: testCase.caseId,
    roundTripMs: Math.round(performance.now() - started),
    normalizeMs: Number(result?.planner?.normalizeMs || 0),
    modelUsed: result?.planner?.modelUsed === true,
    modelName: String(result?.planner?.modelName || result?.planner?.optionalModel?.model || ""),
    modelLatencyMs: Number(result?.planner?.modelLatencyMs || 0),
    observeMs: Number(result?.metadata?.timings?.observeMs || 0),
    planMs: Number(
      result?.metadata?.timings?.planMs ??
        result?.planner?.latencyMs ??
        result?.planner?.normalizeMs ??
        0,
    ),
    executeMs: Number(result?.metadata?.timings?.executeMs || 0),
    verifyMs: Number(result?.metadata?.timings?.verifyMs || 0),
    ok: testCase.expectedOk === false ? result?.ok === false : result?.ok === true,
  };
}

function warmLatencyCases(iteration) {
  return [
    {
      id: `warm-plan-${iteration}`,
      caseId: "deterministic-plan",
      method: "app_control.plan_instruction",
      params: { instruction: "输入 hello" },
      expectedOk: true,
    },
    {
      id: `warm-observe-${iteration}`,
      caseId: "observe-state-intent",
      method: "app_control.plan_instruction",
      params: { instruction: "看一下当前状态" },
      expectedOk: true,
    },
    {
      id: `warm-visual-${iteration}`,
      caseId: "visual-screenshot-fallback-plan",
      method: "app_control.plan_instruction",
      params: {
        instruction: "点击发送按钮",
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
  ];
}

function optionalModelLatencyCase() {
  return {
    id: "optional-local-model",
    caseId: "optional-local-model-plan",
    method: "app_control.plan_instruction",
    params: { instruction: "用小模型规划这个可见操作" },
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
  const optionalModelSamples = Array.isArray(result.optionalModelSamples)
    ? result.optionalModelSamples
    : [];
  const samplesByCase = {};
  for (const sample of result.warmSamples) {
    const caseId = sample.caseId || "unknown";
    samplesByCase[caseId] ||= [];
    samplesByCase[caseId].push(sample);
  }
  const ok =
    result.ok === true &&
    result.compileMs >= 0 &&
    result.coldFirstPlanMs >= 0 &&
    result.warmSamples.length === args.warmRuns * 3 &&
    result.warmSamples.every((sample) => sample.ok) &&
    optionalModelSamples.length === 1 &&
    optionalModelSamples.every((sample) => sample.ok && sample.modelUsed && sample.modelName);
  return {
    schema: "oneesama.kwwk-latency-report.v1",
    gate: "cold_warm_latency",
    ok,
    generatedAt: new Date().toISOString(),
    evidenceMode: "host_kwwk_helper_deterministic_plan_latency",
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
      warmP95Ms: percentile(warmRoundTrips, 95),
      normalizeMs: result.warmSamples.map((sample) => sample.normalizeMs),
      observeMs: result.warmSamples.map((sample) => sample.observeMs || 0),
      planMs: result.warmSamples.map((sample) => sample.planMs || 0),
      modelMs: optionalModelSamples.map((sample) => sample.modelLatencyMs || 0),
      executeMs: result.warmSamples.map((sample) => sample.executeMs || 0),
      verifyMs: result.warmSamples.map((sample) => sample.verifyMs || 0),
      wrapperMs: 0,
      realtimeMs: 0,
    },
    proofBoundary: {
      proves: [
        "helper compile/startup and deterministic warm latency are measurable",
        "observe/state-intent and visual screenshot-fallback planner calls are sampled",
        "local optional model planner fixture reports model name and model latency",
      ],
      doesNotProve: [
        "Realtime wrapper latency",
        "live app execution latency",
        "remote OpenAI planner latency",
      ],
    },
    cases: ["deterministic-plan", "observe-state-intent", "visual-screenshot-fallback-plan"].map(
      (caseId) => {
        const samples = samplesByCase[caseId] || [];
        return {
          id: caseId,
          ok: samples.length === args.warmRuns && samples.every((sample) => sample.ok),
          warmRuns: samples.length,
          modelUsed: false,
          warmRoundTripMs: samples.map((sample) => sample.roundTripMs),
          blocker:
            samples.length === args.warmRuns && samples.every((sample) => sample.ok)
              ? ""
              : result.error || "latency_benchmark_failed",
        };
      },
    ),
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
    const helper = spawnHelper(binary, args.timeoutMs);
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
      ONEESAMA_KWWK_PLANNER_MODEL: "tiny-planner-latency-fixture",
      ONEESAMA_KWWK_PLANNER_LOCAL_PLAN_JSON: JSON.stringify({
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
