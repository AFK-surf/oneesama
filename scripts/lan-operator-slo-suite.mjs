#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { aggregateLanAcceptanceSloReports } from "./lan-operator-acceptance-slo.mjs";
import { LOCAL_OPERATOR_GATES } from "./local-operator-gates.mjs";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-slo-suite-latest.json";

const GATES = Object.freeze([
  {
    gate: LOCAL_OPERATOR_GATES.voice,
    script: "scripts/lan-operator-voice-acceptance.mjs",
  },
  {
    gate: LOCAL_OPERATOR_GATES.hostVisual,
    script: "scripts/lan-operator-host-visual-acceptance.mjs",
  },
  {
    gate: LOCAL_OPERATOR_GATES.toolRouting,
    script: "scripts/lan-operator-tool-routing-benchmark.mjs",
  },
  {
    gate: LOCAL_OPERATOR_GATES.kwwkAction,
    script: "scripts/lan-operator-kwwk-action-benchmark.mjs",
  },
  {
    gate: LOCAL_OPERATOR_GATES.debugPanel,
    script: "scripts/lan-operator-debug-panel-benchmark.mjs",
  },
]);

function parseArgs(argv) {
  const args = {
    samples: 1,
    timeoutMs: 30_000,
    jsonOut: DEFAULT_JSON_OUT,
    headed: false,
    reports: [],
    runGates: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--samples") args.samples = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--report") {
      args.reports.push(argv[++index]);
      args.runGates = false;
    } else if (arg === "--reports") {
      args.reports.push(
        ...String(argv[++index] || "")
          .split(",")
          .filter(Boolean),
      );
      args.runGates = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.samples) || args.samples < 1) {
    throw new Error("--samples must be >= 1");
  }
  args.sampleDir = join(
    dirname(args.jsonOut),
    `oneesama-local-slo-suite-${Date.now().toString(36)}`,
  );
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/lan-operator-slo-suite.mjs [options]

Options:
  --samples <n>       Number of sequential samples per local gate (default: 1)
  --timeout-ms <n>    Timeout passed to each gate script (default: 30000)
  --json-out <path>   Write suite report (default: ${DEFAULT_JSON_OUT})
  --report <path>     Aggregate an existing report instead of running gates; can repeat
  --reports <csv>     Aggregate comma-separated existing reports instead of running gates
  --headed            Run Chromium headed when running gates
`);
}

function samplePath(args, sampleIndex, gate) {
  return join(args.sampleDir, `sample-${sampleIndex + 1}-${gate}.json`);
}

async function runCommand(command, commandArgs) {
  return await new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: "inherit" });
    child.once("exit", (code, signal) => {
      resolve({ code: code ?? 1, signal: signal || "" });
    });
    child.once("error", (error) => {
      resolve({ code: 1, signal: "", error: String(error?.message || error) });
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function runGateSample(args, sampleIndex, gateConfig) {
  const jsonOut = samplePath(args, sampleIndex, gateConfig.gate);
  await mkdir(dirname(jsonOut), { recursive: true });
  const commandArgs = [
    "exec",
    "tsx",
    gateConfig.script,
    "--json-out",
    jsonOut,
    "--timeout-ms",
    String(args.timeoutMs),
  ];
  if (args.headed) commandArgs.push("--headed");
  const result = await runCommand("vp", commandArgs);
  let report = null;
  try {
    report = await readJson(jsonOut);
  } catch (error) {
    report = {
      schema: "oneesama.local_voice_acceptance.v1",
      gate: gateConfig.gate,
      ok: false,
      functionalOk: false,
      generatedAt: new Date().toISOString(),
      error: `missing_gate_report:${String(error?.message || error)}`,
    };
  }
  return {
    gate: gateConfig.gate,
    sampleIndex: sampleIndex + 1,
    path: jsonOut,
    exitCode: result.code,
    signal: result.signal,
    error: result.error || "",
    report,
  };
}

async function collectReports(args) {
  if (!args.runGates) {
    const existing = [];
    for (const reportPath of args.reports) {
      existing.push({
        gate: "",
        sampleIndex: 0,
        path: reportPath,
        exitCode: 0,
        signal: "",
        error: "",
        report: await readJson(reportPath),
      });
    }
    return existing;
  }

  const samples = [];
  for (let sampleIndex = 0; sampleIndex < args.samples; sampleIndex += 1) {
    for (const gateConfig of GATES) {
      samples.push(await runGateSample(args, sampleIndex, gateConfig));
    }
  }
  return samples;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const samples = await collectReports(args);
  const reports = samples.map((sample) => sample.report);
  const aggregate = aggregateLanAcceptanceSloReports(reports);
  const commandFailures = samples.filter(
    (sample) => sample.exitCode !== 0 || sample.report?.ok !== true,
  );
  const report = {
    ...aggregate,
    ok: aggregate.ok === true && commandFailures.length === 0,
    suite: {
      runGates: args.runGates,
      samplesPerGate: args.runGates ? args.samples : 0,
      timeoutMs: args.timeoutMs,
      headed: args.headed,
      sampleDir: args.runGates ? args.sampleDir : "",
    },
    sampleReports: samples.map((sample) => ({
      gate: sample.report?.gate || sample.gate,
      sampleIndex: sample.sampleIndex,
      path: sample.path,
      ok: sample.report?.ok === true,
      functionalOk: sample.report?.functionalOk === true,
      sloOk: sample.report?.slo?.ok === true,
      exitCode: sample.exitCode,
      signal: sample.signal,
      error: sample.error || sample.report?.error || "",
    })),
    commandFailures: commandFailures.map((sample) => ({
      gate: sample.report?.gate || sample.gate,
      sampleIndex: sample.sampleIndex,
      path: sample.path,
      exitCode: sample.exitCode,
      signal: sample.signal,
      error: sample.error || sample.report?.error || "",
    })),
  };
  await writeJson(args.jsonOut, report);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        sampleCount: report.sampleCount,
        commandFailures: report.commandFailures.length,
        failedGates: report.failedGates.map((failure) => failure.gate),
        jsonOut: args.jsonOut,
      },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
}

await run();
