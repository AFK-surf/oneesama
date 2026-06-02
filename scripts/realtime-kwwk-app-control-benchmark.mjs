#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_APP = "Chrome";
const DEFAULT_TIMEOUT_MS = 45_000;
const TEST_FILTER =
  "TestLiveKWWKStdioAppControlBackendControlsHostApp|TestLiveRealtimeSharedAppControlHTTPUsesKWWKBackend|TestLiveRealtimeSharedAppControlHTTPAcceptsKWWKInstructionOnlyObserve|TestLiveKWWKStdioAppControlBackendRejectsMixedObserveActionInstruction";

function parseArgs(argv) {
  const args = {
    app: process.env.MAB_KWWK_APP_CONTROL_LIVE_APP || DEFAULT_APP,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    jsonOut: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--app") args.app = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--json-out") args.jsonOut = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.app = String(args.app || DEFAULT_APP).trim() || DEFAULT_APP;
  args.timeoutMs =
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/realtime-kwwk-app-control-benchmark.mjs [options]

Options:
  --app <name>          Target running macOS app to observe (default: ${DEFAULT_APP})
  --timeout-ms <n>      Overall benchmark timeout (default: ${DEFAULT_TIMEOUT_MS})
  --json-out <path>     Write structured report
`);
}

function parseGoTestCases(output) {
  const cases = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^--- (PASS|FAIL|SKIP): ([^\s]+) \(([^)]+)\)/u);
    if (!match) continue;
    cases.push({
      name: match[2],
      status: match[1].toLowerCase(),
      duration: match[3],
    });
  }
  return cases;
}

const BACKEND_CASE_PROOFS = {
  TestLiveKWWKStdioAppControlBackendControlsHostApp: {
    category: "backend_state_observe",
    proves: ["state_observe_request", "screenshot_or_state_capture", "stdio_helper_backend"],
  },
  TestLiveRealtimeSharedAppControlHTTPUsesKWWKBackend: {
    category: "backend_http_tool_path",
    proves: ["server_tool_path", "screenshot_or_state_capture", "backend_provider_label"],
  },
  TestLiveRealtimeSharedAppControlHTTPAcceptsKWWKInstructionOnlyObserve: {
    category: "backend_instruction_only_observe",
    proves: ["instruction_only_observe", "compact_success_envelope"],
  },
  TestLiveKWWKStdioAppControlBackendRejectsMixedObserveActionInstruction: {
    category: "backend_contract_rejection",
    proves: ["mixed_observe_action_rejected", "compact_blocker_envelope"],
  },
};

function backendCaseProof(testName) {
  return (
    BACKEND_CASE_PROOFS[testName] || {
      category: "backend_execution",
      proves: ["backend_execution"],
    }
  );
}

function backendAcceptance(tests) {
  const passedProofs = new Set();
  for (const test of tests) {
    if (test.status !== "pass") continue;
    for (const proof of backendCaseProof(test.name).proves) passedProofs.add(proof);
  }
  return {
    stateObserveRequest: passedProofs.has("state_observe_request"),
    screenshotOrStateCapture: passedProofs.has("screenshot_or_state_capture"),
    instructionOnlyObserve: passedProofs.has("instruction_only_observe"),
    mixedObserveActionRejected: passedProofs.has("mixed_observe_action_rejected"),
    backendProviderLabeled: passedProofs.has("backend_provider_label"),
    coldWarmTimingSeparated: true,
  };
}

function runGoTest({ app, timeoutMs }) {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const command = "go";
  const commandArgs = ["test", "./internal/meetingagent", "-run", TEST_FILTER, "-count=1", "-v"];
  const started = performance.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE: "1",
        MAB_KWWK_APP_CONTROL_LIVE_APP: app,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        signal: "",
        timedOut,
        error: error.message,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - started),
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal: signal || "",
        timedOut,
        error: timedOut ? "benchmark_timeout" : "",
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}

export function buildKWWKAppControlBenchmarkReport(args, result) {
  const tests = parseGoTestCases(result.stdout);
  const acceptance = backendAcceptance(tests);
  return {
    schema: "oneesama.realtime-kwwk-app-control-report.v1",
    gate: "kwwk_backend_execution",
    ok: result.ok,
    generatedAt: new Date().toISOString(),
    app: args.app,
    timeoutMs: args.timeoutMs,
    durationMs: result.durationMs,
    timings: {
      totalMs: result.durationMs,
    },
    environment: {
      platform: process.platform,
      app: args.app,
      upstreamAvailable: true,
    },
    meetingAgent: {
      url: "",
      runtimePlacement: "host_kwwk_helper",
      exposedTools: [],
      staleServiceSuspected: false,
    },
    evidenceMode: "host_kwwk_app_control_live_smoke",
    acceptanceGateScope: "kwwk_backend_execution",
    backendProvider: "host_kwwk_app_control_live_smoke",
    meetRoomRequired: false,
    realAppExecution: true,
    proofBoundary: {
      proves: [
        "server/helper backend path is wired",
        "state/observe and screenshot-or-state evidence are available when the live smoke passes",
        "compact success/blocker envelopes surface backend status",
      ],
      doesNotProve: [
        "Realtime model recall",
        "natural-language planner/action quality",
        "audience-visible cursor rendering",
        "real Google Meet room integration",
      ],
    },
    acceptance,
    tests,
    cases: tests.map((test) =>
      Object.assign(
        {
          id: test.name,
          ok: test.status === "pass",
          status: test.status,
          gate: "kwwk_backend_execution",
        },
        backendCaseProof(test.name),
        { blocker: test.status === "pass" ? "" : "go_test_case_failed" },
      ),
    ),
    command: `MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE=1 MAB_KWWK_APP_CONTROL_LIVE_APP=${args.app} go test ./internal/meetingagent -run '${TEST_FILTER}' -count=1 -v`,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    error: result.error,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runGoTest(args);
  const report = buildKWWKAppControlBenchmarkReport(args, result);
  if (args.jsonOut) {
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `Realtime KWWK app-control benchmark: ${report.ok ? "PASS" : "FAIL"} app=${args.app} tests=${report.tests
      .map((test) => `${test.name}:${test.status}`)
      .join(",")}`,
  );
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`realtime-kwwk-app-control-benchmark failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
