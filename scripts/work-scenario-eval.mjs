// Work-pipeline scenario eval (RFC P0.2 execution layer / D9 gates).
//
//   vp run eval:work-scenarios                     # fixture planner, 1 run each
//   vp exec tsx scripts/work-scenario-eval.mjs --mode replay --runs 1
//   vp exec tsx scripts/work-scenario-eval.mjs --mode live --runs 10
//
// Flags: --mode fixture|replay|live   planner source (default fixture)
//        --runs N                     runs per scenario (default 1)
//        --scenario id                only this scenario
//        --json-out path              artifact (default /tmp/oneesama-work-scenario-eval-latest.json)
//        --record-out dir             write planner recordings per scenario
//        --append-history             append a summary line to test/evals/work-scenario-history.jsonl
//        --check-baseline path        exit 1 when a rate drops below the baseline
import { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { createWorkBrowserSurface } from "../packages/core/src/work/work-browser-surface.ts";
import { createWorkExecutor } from "../packages/core/src/work/work-executor.ts";
import { startWorkFixtureServer } from "../packages/core/src/work/work-fixture-server.ts";
import {
  createRecordingWorkPlanner,
  createReplayWorkPlanner,
} from "../packages/core/src/work/work-planner.ts";
import {
  createFixturePlanPlanner,
  parseWorkPlannerRecords,
  serializeWorkPlannerRecords,
  validateWorkScenario,
} from "../packages/core/src/work/work-scenario.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS_DIR = join(ROOT, "test/fixtures/work/scenarios");
const RECORDINGS_DIR = join(ROOT, "test/fixtures/work/recordings");
const FIXTURES_DIR = join(ROOT, "test/fixtures/work");
const HISTORY_PATH = join(ROOT, "test/evals/work-scenario-history.jsonl");

function parseArgs(argv) {
  const args = {
    mode: "fixture",
    runs: 1,
    scenario: "",
    jsonOut: "/tmp/oneesama-work-scenario-eval-latest.json",
    recordOut: "",
    appendHistory: false,
    checkBaseline: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") args.mode = String(argv[++i] || "fixture");
    else if (arg === "--runs") args.runs = Math.max(1, Number(argv[++i] || 1));
    else if (arg === "--scenario") args.scenario = String(argv[++i] || "");
    else if (arg === "--json-out") args.jsonOut = String(argv[++i] || args.jsonOut);
    else if (arg === "--record-out") args.recordOut = String(argv[++i] || RECORDINGS_DIR);
    else if (arg === "--append-history") args.appendHistory = true;
    else if (arg === "--check-baseline") args.checkBaseline = String(argv[++i] || "");
  }
  return args;
}

function loadScenarios(filterId) {
  const scenarios = [];
  for (const file of readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const validation = validateWorkScenario(
      JSON.parse(readFileSync(join(SCENARIOS_DIR, file), "utf8")),
    );
    if (!validation.ok || !validation.scenario) {
      throw new Error(`scenario_invalid:${file}:${validation.errors.join(",")}`);
    }
    if (!filterId || validation.scenario.id === filterId) scenarios.push(validation.scenario);
  }
  if (scenarios.length === 0) throw new Error("no_scenarios_loaded");
  return scenarios;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function plannerFor(mode, scenario, baseUrl) {
  if (mode === "fixture") return createFixturePlanPlanner(scenario, baseUrl);
  if (mode === "replay") {
    const records = parseWorkPlannerRecords(
      readFileSync(join(RECORDINGS_DIR, `${scenario.id}.json`), "utf8"),
      baseUrl,
    );
    return createReplayWorkPlanner(records);
  }
  if (mode === "live") {
    const { createOpenAIWorkPlanner } =
      await import("../packages/core/src/work/work-openai-planner.ts");
    return createOpenAIWorkPlanner({ baseUrl });
  }
  throw new Error(`unknown_mode:${mode}`);
}

const args = parseArgs(process.argv.slice(2));
const scenarios = loadScenarios(args.scenario);
const fixture = await startWorkFixtureServer(FIXTURES_DIR);
const browser = await chromium.launch({ headless: true });

const report = {
  schema: "oneesama.work_scenario_eval.v1",
  mode: args.mode,
  runsPerScenario: args.runs,
  generatedAt: new Date().toISOString(),
  scenarios: [],
  overall: { runs: 0, successes: 0, successRate: 0, stepMsP50: null, stepMsP95: null },
};
const allStepMs = [];

for (const scenario of scenarios) {
  const entry = {
    id: scenario.id,
    runs: 0,
    successes: 0,
    successRate: 0,
    failures: [],
    stepMsP50: null,
    totalMsP50: null,
  };
  const stepMs = [];
  const totalMs = [];
  let lastRecords = null;

  for (let run = 0; run < args.runs; run++) {
    const page = await browser.newPage();
    const surface = createWorkBrowserSurface({
      page,
      surfaceId: scenario.job.surfaceId,
      allowedHosts: ["127.0.0.1", "localhost"],
    });
    try {
      const inner = await plannerFor(args.mode, scenario, fixture.url);
      const records = [];
      const decideDurations = [];
      const timedPlanner = {
        id: inner.id,
        async decide(input) {
          const startedAt = Date.now();
          const operation = await inner.decide(input);
          decideDurations.push(Date.now() - startedAt);
          return operation;
        },
      };
      const planner = createRecordingWorkPlanner(timedPlanner, (record) => records.push(record));
      const executor = createWorkExecutor({ surface, planner, maxSteps: 10 });
      const result = await executor.run(scenario.job);
      entry.runs += 1;
      report.overall.runs += 1;
      const performMs = result.steps.map((step) => step.durationMs);
      for (let i = 0; i < Math.max(performMs.length, decideDurations.length); i++) {
        const total = (performMs[i] || 0) + (decideDurations[i] || 0);
        stepMs.push(total);
        allStepMs.push(total);
      }
      totalMs.push(result.totalMs);
      if (result.status === "done") {
        entry.successes += 1;
        report.overall.successes += 1;
        lastRecords = records;
      } else {
        entry.failures.push({
          run,
          status: result.status,
          blocker: result.blocker,
          steps: result.steps.length,
        });
      }
    } finally {
      await surface.close().catch(() => {});
      await page.close().catch(() => {});
    }
  }

  entry.successRate = entry.runs > 0 ? entry.successes / entry.runs : 0;
  entry.stepMsP50 = percentile(stepMs, 50);
  entry.totalMsP50 = percentile(totalMs, 50);
  report.scenarios.push(entry);

  if (args.recordOut && lastRecords) {
    const outDir = args.recordOut === "" ? RECORDINGS_DIR : args.recordOut;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, `${scenario.id}.json`),
      serializeWorkPlannerRecords(lastRecords, fixture.url),
    );
  }
}

report.overall.successRate =
  report.overall.runs > 0 ? report.overall.successes / report.overall.runs : 0;
report.overall.stepMsP50 = percentile(allStepMs, 50);
report.overall.stepMsP95 = percentile(allStepMs, 95);

writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `work-scenario-eval mode=${report.mode} scenarios=${report.scenarios.length} runs=${report.overall.runs} ` +
    `successRate=${(report.overall.successRate * 100).toFixed(1)}% stepP50=${report.overall.stepMsP50}ms`,
);
for (const entry of report.scenarios) {
  console.log(
    `  ${entry.id}: ${entry.successes}/${entry.runs}` +
      (entry.failures.length > 0
        ? ` failures=${JSON.stringify(entry.failures).slice(0, 200)}`
        : ""),
  );
}
console.log(`artifact: ${args.jsonOut}`);

if (args.appendHistory) {
  mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  appendFileSync(
    HISTORY_PATH,
    `${JSON.stringify({
      ts: report.generatedAt,
      mode: report.mode,
      runs: report.overall.runs,
      successRate: report.overall.successRate,
      stepMsP50: report.overall.stepMsP50,
      scenarios: Object.fromEntries(report.scenarios.map((s) => [s.id, s.successRate])),
    })}\n`,
  );
  console.log(`history: ${HISTORY_PATH}`);
}

let failed = false;
if (args.checkBaseline) {
  const baseline = JSON.parse(readFileSync(args.checkBaseline, "utf8"));
  if (
    typeof baseline.overallSuccessRate === "number" &&
    report.overall.successRate < baseline.overallSuccessRate
  ) {
    console.error(
      `BASELINE REGRESSION: overall ${report.overall.successRate} < ${baseline.overallSuccessRate}`,
    );
    failed = true;
  }
  for (const [id, minimum] of Object.entries(baseline.scenarios || {})) {
    const entry = report.scenarios.find((s) => s.id === id);
    if (entry && entry.successRate < minimum) {
      console.error(`BASELINE REGRESSION: ${id} ${entry.successRate} < ${minimum}`);
      failed = true;
    }
  }
}

await browser.close();
await fixture.close();
process.exit(failed ? 1 : 0);
