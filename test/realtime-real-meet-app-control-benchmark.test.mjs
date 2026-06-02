import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import {
  compactAppControlResult,
  compactSyntheticResult,
  extractRealMeetUrlFromJoinStatus as extractSidecarRealMeetUrlFromJoinStatus,
  gateRunErrorResult,
  normalizeRealMeetUrl as normalizeSidecarRealMeetUrl,
  parseGateJsonResult,
  waitForChildExit,
} from "../scripts/real-meet-sidecar-acceptance.mjs";
import {
  argValue,
  extractRealMeetUrlFromActiveBrowserRecord,
  resolveRealMeetUrl,
} from "../scripts/real-meet-url-resolver.mjs";
import {
  appControlActionSemanticsPass,
  appControlActionsHaveNonObserveAction,
  appControlInstructionNeedsNonObserveAction,
  appControlStatusHasCompactBlocker,
  appControlStatusIsFailure,
  appControlStatusIsSuccess,
  compactRealMeetAppControlJoinStatus,
  extractRealMeetUrlFromJoinStatus,
  gateStatus,
  normalizeRealMeetUrl,
  realMeetAppControlEvidencePasses,
  realMeetAppControlRealtimeEvidencePasses,
  realMeetAppControlSuiteCasePasses,
} from "../scripts/real-meet-synthetic-speaker-smoke.mjs";
import { buildKWWKAppControlBenchmarkReport } from "../scripts/realtime-kwwk-app-control-benchmark.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function benchmarkEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.MAB_REAL_MEET_URL;
  delete env.MAB_REQUIRE_REAL_MEET_URL;
  delete env.MAB_REAL_MEET_REQUIRED;
  env.MAB_REAL_MEET_URL_DISCOVERY = "0";
  return env;
}

function runRealMeetAppControlBenchmark(args = [], env = benchmarkEnv()) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/real-meet-synthetic-speaker-smoke.mjs",
      "--real-meet-app-control-smoke",
      ...args,
    ],
    {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    },
  );
}

function runRealMeetSidecarAcceptance(args = [], env = benchmarkEnv()) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/real-meet-sidecar-acceptance.mjs", ...args],
    {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    },
  );
}

function passingRealtimeJoinStatus(overrides = {}) {
  const delivery = overrides.delivery || {
    outputChannel: "agents_sdk_execute_return",
  };
  const decisions = overrides.decisions || [];
  return {
    ok: true,
    active: {
      sessionId: "session_real_app_control",
      realtimeRuntimePlacement: "sidecar",
      realtimeSdkOwner: "sidecar",
      realtimeSidecar: {
        active: true,
        pageCount: 1,
        sdkOwnerPageCount: 1,
      },
      meetPage: {
        realtimeSurface: {
          runtimePlacement: "sidecar",
          pageRole: "meet-surface",
          sdkOwner: "sidecar",
          sdkSuppressedOnMeetSurface: true,
          hasSDKGlobal: false,
          bundleGlobal: "",
        },
        avatarHud: overrides.avatarHud || {
          available: true,
          cells: [{ key: "done", label: "完成", value: "", level: "ok" }],
          signals: [],
        },
        kwwkCursor: overrides.kwwkCursor || {
          available: true,
          artifact: {
            schema: "oneesama.kwwk-cursor-artifact.v1",
            events: [],
            styles: {
              persistentCursor: true,
              clickPulse: true,
            },
          },
        },
      },
      realtimeBridge: {
        connected: true,
        agentRuntime: { sdkConnected: true },
        connection: {
          openaiSessionId: "sess_real_app_control",
        },
        feedback: {
          checks: {
            latestFunctionalTurnFakeExecution: false,
          },
        },
        contextHealth: {
          latestFunctionalTurn: {
            fakeExecution: false,
          },
        },
        workspaceTools: {
          calls: [
            {
              name: "control_shared_app_window",
              callId: "call_real_app_control",
              result: {
                jobId: "job_real_app_control",
                status: "queued",
              },
              delivery,
            },
          ],
        },
        turnPolicy: {
          decisions,
        },
      },
    },
  };
}

function passingRealtimeEvidence(overrides = {}) {
  return compactRealMeetAppControlJoinStatus(passingRealtimeJoinStatus(overrides));
}

test("npm real Meet app-control benchmark is a strict live gate with optional skip mode", () => {
  assert.match(
    packageJson.scripts["benchmark:realtime-real-app-control"],
    /--require-real-meet-url/,
  );
  assert.match(
    packageJson.scripts["benchmark:realtime-real-app-control"],
    /--json-out \/tmp\/oneesama-realtime-real-app-control-latest\.json/,
  );
  assert.ok(packageJson.scripts["benchmark:realtime-real-app-control:optional"]);
  assert.ok(packageJson.scripts["benchmark:realtime-real-app-control:suite"]);
  assert.match(
    packageJson.scripts["benchmark:realtime-real-app-control:suite"],
    /--real-meet-app-control-suite/,
  );
  assert.match(
    packageJson.scripts["benchmark:realtime-real-app-control:suite"],
    /--json-out \/tmp\/oneesama-realtime-real-app-control-suite-latest\.json/,
  );
  assert.doesNotMatch(
    packageJson.scripts["benchmark:realtime-real-app-control:optional"],
    /--require-real-meet-url/,
  );
  assert.match(
    packageJson.scripts["benchmark:realtime-real-app-control:optional"],
    /--json-out \/tmp\/oneesama-realtime-real-app-control-optional-latest\.json/,
  );
  assert.match(
    packageJson.scripts["benchmark:realtime-kwwk-app-control"],
    /realtime-kwwk-app-control-benchmark\.mjs/,
  );
  assert.match(
    packageJson.scripts["benchmark:realtime-kwwk-app-control"],
    /--json-out \/tmp\/oneesama-realtime-kwwk-app-control-latest\.json/,
  );
  assert.match(
    packageJson.scripts["acceptance:realtime-real-app-control"],
    /--require-real-meet-url/,
  );
  assert.match(
    packageJson.scripts["acceptance:realtime-real-app-control"],
    /--real-meet-app-control-suite/,
  );
  assert.match(
    packageJson.scripts["acceptance:realtime-live-sidecar"],
    /real-meet-sidecar-acceptance\.mjs/,
  );
  assert.match(packageJson.scripts["acceptance:realtime-live-sidecar"], /--require-real-meet-url/);
  assert.match(
    packageJson.scripts["acceptance:realtime-live-sidecar:optional"],
    /real-meet-sidecar-acceptance\.mjs/,
  );
  assert.match(
    packageJson.scripts["acceptance:realtime-live-sidecar:optional"],
    /--json-out \/tmp\/oneesama-realtime-live-sidecar-optional-latest\.json/,
  );
});

test("KWWK app-control backend benchmark report uses backend gate envelope", () => {
  const report = buildKWWKAppControlBenchmarkReport(
    { app: "Chrome", timeoutMs: 45_000 },
    {
      ok: true,
      stdout: "--- PASS: TestLiveKWWKStdioAppControlBackendControlsHostApp (0.01s)\n",
      code: 0,
      signal: "",
      timedOut: false,
      error: "",
      durationMs: 12,
    },
  );

  assert.equal(report.gate, "kwwk_backend_execution");
  assert.equal(report.acceptanceGateScope, "kwwk_backend_execution");
  assert.equal(report.backendProvider, "host_kwwk_app_control_live_smoke");
  assert.equal(report.environment.app, "Chrome");
  assert.equal(report.meetingAgent.runtimePlacement, "host_kwwk_helper");
  assert.deepEqual(report.cases, [
    {
      id: "TestLiveKWWKStdioAppControlBackendControlsHostApp",
      ok: true,
      status: "pass",
      blocker: "",
      gate: "kwwk_backend_execution",
      category: "backend_state_observe",
      proves: ["state_observe_request", "screenshot_or_state_capture", "stdio_helper_backend"],
    },
  ]);
});

test("real Meet URL extraction accepts explicit args and active join status shapes", () => {
  assert.equal(
    normalizeRealMeetUrl("join https://meet.google.com/abc-defg-hij?authuser=0."),
    "https://meet.google.com/abc-defg-hij?authuser=0",
  );
  assert.equal(
    normalizeSidecarRealMeetUrl("https://meet.google.com/qwe-rtyu-iop"),
    "https://meet.google.com/qwe-rtyu-iop",
  );
  const status = {
    ok: true,
    active: {
      status: "joined",
      meeting_url: "https://meet.google.com/nth-tkfo-hqi",
    },
  };
  assert.equal(extractRealMeetUrlFromJoinStatus(status), "https://meet.google.com/nth-tkfo-hqi");
  assert.equal(
    extractSidecarRealMeetUrlFromJoinStatus({
      ok: true,
      runtime: {
        active: {
          meetUrl: "https://meet.google.com/wbq-ahjq-xhi",
        },
      },
    }),
    "https://meet.google.com/wbq-ahjq-xhi",
  );
});

test("real Meet CLI argValue lets appended npm args override defaults", () => {
  assert.equal(
    argValue(
      ["node", "script.mjs", "--json-out", "/tmp/default.json", "--json-out", "/tmp/override.json"],
      "--json-out",
    ),
    "/tmp/override.json",
  );
  assert.equal(
    argValue(
      [
        "node",
        "script.mjs",
        "--real-meet-url=https://meet.google.com/old-room-id",
        "--real-meet-url=https://meet.google.com/new-room-id",
      ],
      "--real-meet-url",
    ),
    "https://meet.google.com/new-room-id",
  );
});

test("real Meet URL resolution falls back to active browser record", async () => {
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), "oneesama-real-meet-url-resolver-"));
  try {
    const recordPath = pathJoin(tmpDir, "active-meet-browser.json");
    writeFileSync(
      recordPath,
      JSON.stringify(
        {
          pid: process.pid,
          sessionId: "session_active_browser",
          meetUrl: "https://meet.google.com/abc-defg-hij?authuser=0",
        },
        null,
        2,
      ),
    );
    const result = await resolveRealMeetUrl({
      args: ["node", "script.mjs"],
      env: {
        ...benchmarkEnv(),
        MAB_REAL_MEET_URL_DISCOVERY: "1",
        MAB_DATA_DIR: tmpDir,
      },
      fetchJson: async () => ({ ok: true, sessions: { total: 1 } }),
    });

    assert.equal(result.meetUrl, "https://meet.google.com/abc-defg-hij?authuser=0");
    assert.equal(result.source, "active-browser-record");
    assert.deepEqual(result.checkedSources, ["http://127.0.0.1:8781/join/status", recordPath]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("real Meet URL resolution ignores stale active browser records", () => {
  assert.equal(
    extractRealMeetUrlFromActiveBrowserRecord({
      pid: 0,
      meetUrl: "https://meet.google.com/abc-defg-hij",
    }),
    "",
  );
});

test("real Meet URL resolution reports stale active browser record reasons", async () => {
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), "oneesama-real-meet-url-stale-record-"));
  try {
    const recordPath = pathJoin(tmpDir, "active-meet-browser.json");
    writeFileSync(
      recordPath,
      JSON.stringify(
        {
          pid: 0,
          sessionId: "session_stale_browser",
          meetUrl: "https://meet.google.com/abc-defg-hij",
        },
        null,
        2,
      ),
    );
    const result = await resolveRealMeetUrl({
      args: ["node", "script.mjs"],
      env: {
        ...benchmarkEnv(),
        MAB_REAL_MEET_URL_DISCOVERY: "1",
        MAB_DATA_DIR: tmpDir,
      },
      fetchJson: async () => ({ ok: true }),
    });

    assert.equal(result.meetUrl, "");
    assert.equal(result.activeBrowserRecordError, "active_browser_record_process_absent");
    assert.deepEqual(result.checkedSources, ["http://127.0.0.1:8781/join/status", recordPath]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("real Meet app-control script can produce diagnostic skipped evidence", () => {
  const result = runRealMeetAppControlBenchmark();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.equal(summary.skipped, true);
  assert.equal(summary.diagnosticOnly, true);
  assert.equal(summary.acceptanceSatisfied, false);
  assert.deepEqual(summary.missingEnv, ["MAB_REAL_MEET_URL"]);
});

test("real Meet app-control optional script writes skipped json-out evidence", () => {
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), "oneesama-real-meet-app-control-test-"));
  const jsonOut = pathJoin(tmpDir, "skip.json");
  try {
    const result = runRealMeetAppControlBenchmark(["--json-out", jsonOut]);

    assert.equal(result.status, 0, result.stderr);
    const stdoutSummary = JSON.parse(result.stdout);
    const fileSummary = JSON.parse(readFileSync(jsonOut, "utf8"));
    assert.deepEqual(fileSummary, stdoutSummary);
    assert.equal(fileSummary.ok, false);
    assert.equal(fileSummary.skipped, true);
    assert.equal(fileSummary.diagnosticOnly, true);
    assert.equal(fileSummary.acceptanceSatisfied, false);
    assert.deepEqual(fileSummary.missingEnv, ["MAB_REAL_MEET_URL"]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("real Meet app-control acceptance mode can require MAB_REAL_MEET_URL", () => {
  const result = runRealMeetAppControlBenchmark(["--require-real-meet-url"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const summary = JSON.parse(result.stderr);
  assert.equal(summary.ok, false);
  assert.equal(summary.skipped, false);
  assert.equal(summary.diagnosticOnly, false);
  assert.equal(summary.acceptanceSatisfied, false);
  assert.deepEqual(summary.missingEnv, ["MAB_REAL_MEET_URL"]);
});

test("real Meet live sidecar acceptance can produce diagnostic skipped evidence", () => {
  const result = runRealMeetSidecarAcceptance();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.equal(summary.skipped, true);
  assert.equal(summary.diagnosticOnly, true);
  assert.equal(summary.acceptanceSatisfied, false);
  assert.deepEqual(summary.missingEnv, ["MAB_REAL_MEET_URL"]);
});

test("real Meet live sidecar acceptance writes diagnostic skipped json-out evidence", () => {
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), "oneesama-live-sidecar-acceptance-test-"));
  const jsonOut = pathJoin(tmpDir, "skip.json");
  try {
    const result = runRealMeetSidecarAcceptance(["--json-out", jsonOut]);

    assert.equal(result.status, 0, result.stderr);
    const stdoutSummary = JSON.parse(result.stdout);
    const fileSummary = JSON.parse(readFileSync(jsonOut, "utf8"));
    assert.deepEqual(fileSummary, stdoutSummary);
    assert.equal(fileSummary.ok, false);
    assert.equal(fileSummary.skipped, true);
    assert.equal(fileSummary.diagnosticOnly, true);
    assert.equal(fileSummary.acceptanceSatisfied, false);
    assert.deepEqual(fileSummary.missingEnv, ["MAB_REAL_MEET_URL"]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("real Meet live sidecar acceptance requires MAB_REAL_MEET_URL in strict mode", () => {
  const result = runRealMeetSidecarAcceptance(["--require-real-meet-url"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const summary = JSON.parse(result.stderr);
  assert.equal(summary.ok, false);
  assert.equal(summary.skipped, false);
  assert.equal(summary.diagnosticOnly, false);
  assert.equal(summary.acceptanceSatisfied, false);
  assert.deepEqual(summary.missingEnv, ["MAB_REAL_MEET_URL"]);
});

test("real Meet live sidecar acceptance rejects successful-looking child JSON from failed gates", () => {
  const failedExit = { code: 1, signal: null };

  assert.equal(
    compactSyntheticResult({
      ok: true,
      acceptanceSatisfied: true,
      childExit: failedExit,
    }).acceptanceSatisfied,
    false,
  );
  assert.equal(
    compactAppControlResult({
      ok: true,
      acceptanceSatisfied: true,
      childExit: failedExit,
      final: {
        appControl: { status: "completed" },
        joinStatus: passingRealtimeEvidence(),
      },
    }).acceptanceSatisfied,
    false,
  );
});

test("real Meet live sidecar acceptance compacts app-control suite evidence", () => {
  const summary = compactAppControlResult({
    ok: true,
    acceptanceSatisfied: true,
    sessionId: "suite_session",
    applicationName: "Chrome",
    childExit: { code: 0, signal: null },
    suite: [
      {
        id: "keyboard-escape",
        kind: "keyboard",
        ok: true,
        acceptanceSatisfied: true,
        final: {
          appControl: { status: "completed", actions: ["press_key"], jobId: "job_keyboard" },
          joinStatus: { avatarHud: { noisySpeechOrConnectionVisible: false } },
        },
      },
      {
        id: "pointer-visible-click",
        kind: "pointer",
        ok: true,
        acceptanceSatisfied: true,
        final: {
          appControl: {
            status: "completed",
            actions: ["click"],
            cursor: { hasPointerAction: true },
            jobId: "job_pointer",
          },
          joinStatus: {
            kwwkCursor: { hasPointerAction: true },
            avatarHud: { noisySpeechOrConnectionVisible: false },
          },
        },
      },
    ],
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.acceptanceSatisfied, true);
  assert.equal(summary.suite.length, 2);
  assert.equal(summary.suite[0].kind, "keyboard");
  assert.deepEqual(summary.suite[1].actions, ["click"]);
});

test("real Meet live sidecar acceptance requires explicit child acceptance", () => {
  assert.equal(
    compactSyntheticResult({
      ok: true,
      childExit: { code: 0, signal: null },
    }).acceptanceSatisfied,
    false,
  );
  assert.equal(
    compactSyntheticResult({
      ok: true,
      acceptanceSatisfied: true,
      childExit: { code: 0, signal: null },
    }).acceptanceSatisfied,
    true,
  );
});

test("real Meet synthetic fixture text-turn fallback cannot satisfy acceptance", () => {
  const summary = compactSyntheticResult({
    ok: true,
    acceptanceSatisfied: true,
    childExit: { code: 0, signal: null },
    expectedToolNames: ["share_existing_app_window"],
    textTurnFallback: {
      ok: true,
      status: "queued",
    },
    final: {
      gates: {
        meetEnergyOk: true,
        speechStarted: true,
        responseSeen: true,
        expectedToolCalled: true,
      },
      compact: {
        toolCalls: {
          all: ["share_existing_app_window"],
        },
      },
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.acceptanceSatisfied, false);
  assert.equal(summary.textTurnFallback.ok, true);
});

test("real Meet live sidecar acceptance reports malformed child JSON as structured failure", () => {
  const exit = { code: 0, signal: null };
  const malformed = parseGateJsonResult("synthetic-speaker", "{nope", exit);
  const nonObject = parseGateJsonResult("app-control", "true", exit);

  assert.equal(malformed.ok, false);
  assert.equal(malformed.acceptanceSatisfied, false);
  assert.equal(malformed.reason, "invalid_json");
  assert.match(malformed.error, /synthetic-speaker wrote invalid JSON evidence/);
  assert.equal(malformed.raw, "{nope");
  assert.deepEqual(malformed.childExit, exit);
  assert.equal(compactSyntheticResult(malformed).acceptanceSatisfied, false);

  assert.equal(nonObject.ok, false);
  assert.equal(nonObject.acceptanceSatisfied, false);
  assert.equal(nonObject.reason, "invalid_json");
  assert.match(nonObject.error, /app-control wrote invalid JSON evidence/);
  assert.deepEqual(nonObject.childExit, exit);
  assert.equal(compactAppControlResult(nonObject).acceptanceSatisfied, false);
});

test("real Meet live sidecar acceptance reports child gate runtime errors as structured failure", () => {
  const failure = gateRunErrorResult("app-control", new Error("spawn failed"));

  assert.equal(failure.ok, false);
  assert.equal(failure.acceptanceSatisfied, false);
  assert.equal(failure.reason, "gate_error");
  assert.match(failure.error, /app-control gate failed: spawn failed/);
  assert.equal(failure.childExit, null);
  assert.equal(compactSyntheticResult(failure).acceptanceSatisfied, false);
  assert.equal(compactAppControlResult(failure).acceptanceSatisfied, false);
});

test("real Meet live sidecar acceptance child wait handles exit and error events", async () => {
  const exited = new EventEmitter();
  const exitPromise = waitForChildExit(exited);
  exited.emit("exit", 0, null);
  assert.deepEqual(await exitPromise, { code: 0, signal: null });

  const errored = new EventEmitter();
  const errorPromise = waitForChildExit(errored);
  errored.emit("error", new Error("spawn exploded"));
  await assert.rejects(errorPromise, /spawn exploded/);
});

test("real Meet app-control acceptance passes success or compact explicit blocker", () => {
  const realtimeEvidence = passingRealtimeEvidence();
  assert.equal(
    realMeetAppControlEvidencePasses({
      appControl: { status: "completed", ok: true },
      joinStatus: realtimeEvidence,
    }),
    true,
  );
  assert.equal(
    realMeetAppControlEvidencePasses({
      appControl: { status: "done", ok: true },
      joinStatus: realtimeEvidence,
    }),
    true,
  );
  assert.equal(
    realMeetAppControlEvidencePasses({ status: "completed", ok: true }),
    false,
    "terminal app-control status alone must not satisfy Realtime acceptance",
  );

  const compactBlockers = [
    { status: "blocked", ok: false, blocker: "permission_required" },
    { status: "failed", ok: false, blocker: "computer_use_unavailable" },
  ];
  for (const evidence of compactBlockers) {
    assert.equal(appControlStatusHasCompactBlocker(evidence), true, evidence.status);
    assert.equal(
      realMeetAppControlEvidencePasses({ appControl: evidence, joinStatus: realtimeEvidence }),
      true,
      evidence.status,
    );
  }

  const failedTerminals = [
    { status: "failed", ok: false, error: "backend_failed" },
    { status: "failed", ok: true, blocker: "computer_use_unavailable" },
    { status: "blocked", ok: false },
    { status: "blocked", ok: true, blocker: "permission_required" },
    { status: "blocked", ok: false, blocker: "app_control_timeout" },
    { status: "blocked", ok: false, blocker: "x".repeat(241) },
    { status: "error", ok: false, error: "unexpected_error" },
    { status: "timeout", ok: false, error: "app_control_timeout" },
    { status: "stale", ok: false },
    { status: "canceled", ok: false },
    { status: "cancelled", ok: false },
  ];
  for (const evidence of failedTerminals) {
    assert.equal(appControlStatusIsFailure(evidence.status), true, evidence.status);
    assert.equal(appControlStatusHasCompactBlocker(evidence), false, evidence.status);
    assert.equal(
      realMeetAppControlEvidencePasses({ appControl: evidence, joinStatus: realtimeEvidence }),
      false,
      evidence.status,
    );
  }

  assert.equal(appControlStatusIsSuccess("completed"), true);
  assert.equal(
    realMeetAppControlEvidencePasses({
      appControl: { status: "completed", ok: false },
      joinStatus: realtimeEvidence,
    }),
    false,
  );
  assert.equal(
    realMeetAppControlEvidencePasses({
      appControl: { status: "failed", ok: true },
      joinStatus: realtimeEvidence,
    }),
    false,
  );
  assert.equal(
    realMeetAppControlEvidencePasses({
      appControl: { status: "", ok: true },
      joinStatus: realtimeEvidence,
    }),
    false,
  );
});

test("real Meet app-control acceptance rejects observe-only success for action-bearing instructions", () => {
  const realtimeEvidence = passingRealtimeEvidence();
  const actionInstruction =
    "Look at the shared Chrome window, then press Escape if applicable; otherwise return blocker.";
  const observeInstruction =
    "Observe the currently shared browser window and report the visible page title or blocker. Do not type, click, navigate, or change the page.";

  assert.equal(appControlInstructionNeedsNonObserveAction(actionInstruction), true);
  assert.equal(appControlInstructionNeedsNonObserveAction(observeInstruction), false);
  assert.equal(appControlActionsHaveNonObserveAction(["observe"]), false);
  assert.equal(appControlActionsHaveNonObserveAction(["observe", "press_key"]), true);
  assert.equal(
    appControlActionSemanticsPass(
      { status: "completed", ok: true, actions: ["observe"] },
      { instruction: actionInstruction },
    ),
    false,
  );
  assert.equal(
    realMeetAppControlEvidencePasses({
      appControl: { status: "completed", ok: true, actions: ["observe"] },
      joinStatus: realtimeEvidence,
      instruction: actionInstruction,
    }),
    false,
  );
  assert.equal(
    realMeetAppControlEvidencePasses({
      appControl: { status: "completed", ok: true, actions: ["press_key"] },
      joinStatus: realtimeEvidence,
      instruction: actionInstruction,
    }),
    true,
  );
  assert.equal(
    realMeetAppControlEvidencePasses({
      appControl: { status: "blocked", ok: false, blocker: "instruction_not_directly_executable" },
      joinStatus: realtimeEvidence,
      instruction: actionInstruction,
    }),
    true,
  );
  assert.equal(
    realMeetAppControlEvidencePasses({
      appControl: { status: "completed", ok: true, actions: ["observe"] },
      joinStatus: realtimeEvidence,
      instruction: observeInstruction,
    }),
    true,
  );
});

test("real Meet app-control suite distinguishes keyboard-only and pointer cursor evidence", () => {
  const keyboardJoinStatus = passingRealtimeEvidence();
  assert.equal(
    realMeetAppControlSuiteCasePasses({
      kind: "keyboard",
      sessionId: "session_real_app_control",
      instruction: "Press Escape",
      appControl: {
        status: "completed",
        ok: true,
        actions: ["press_key"],
        cursor: { eventCount: 0, hasPointerAction: false },
      },
      joinStatus: keyboardJoinStatus,
    }),
    true,
  );
  assert.equal(
    realMeetAppControlSuiteCasePasses({
      kind: "keyboard",
      sessionId: "session_real_app_control",
      instruction: "Press Escape",
      appControl: {
        status: "completed",
        ok: true,
        actions: ["press_key"],
        cursor: { eventCount: 1, hasPointerAction: true },
      },
      joinStatus: passingRealtimeEvidence({
        kwwkCursor: {
          available: true,
          artifact: {
            schema: "oneesama.kwwk-cursor-artifact.v1",
            events: [{ kind: "cursor.click" }],
            styles: { persistentCursor: true },
          },
        },
      }),
    }),
    false,
  );

  const pointerCursor = {
    available: true,
    artifact: {
      schema: "oneesama.kwwk-cursor-artifact.v1",
      events: [{ kind: "cursor.click", coordinateSpaceId: "avatar_shared_surface_normalized" }],
      styles: { persistentCursor: true, clickPulse: true },
    },
  };
  assert.equal(
    realMeetAppControlSuiteCasePasses({
      kind: "pointer",
      sessionId: "session_real_app_control",
      instruction: "Click Chromium",
      appControl: {
        status: "completed",
        ok: true,
        actions: ["click"],
        cursor: { eventCount: 1, hasPointerAction: true },
      },
      joinStatus: passingRealtimeEvidence({ kwwkCursor: pointerCursor }),
    }),
    true,
  );
  assert.equal(
    realMeetAppControlSuiteCasePasses({
      kind: "pointer",
      sessionId: "session_real_app_control",
      instruction: "Click Chromium",
      appControl: {
        status: "completed",
        ok: true,
        actions: ["click"],
        cursor: { eventCount: 1, hasPointerAction: true },
      },
      joinStatus: passingRealtimeEvidence(),
    }),
    false,
    "backend cursor metadata alone must not satisfy the audience-visible cursor gate",
  );
  assert.equal(
    realMeetAppControlSuiteCasePasses({
      kind: "keyboard",
      sessionId: "session_real_app_control",
      instruction: "Press Escape",
      appControl: {
        status: "completed",
        ok: true,
        actions: ["press_key"],
        cursor: { eventCount: 0, hasPointerAction: false },
      },
      joinStatus: passingRealtimeEvidence({
        avatarHud: {
          available: true,
          cells: [{ key: "audio", label: "听语音", value: "", level: "active" }],
          signals: [],
        },
      }),
    }),
    false,
    "noisy speech/listening HUD labels must fail the real-room suite gate",
  );
});

test("real Meet app-control acceptance requires sidecar tool telemetry and Meet SDK negative probe", () => {
  const evidence = passingRealtimeEvidence();

  assert.equal(realMeetAppControlRealtimeEvidencePasses(evidence), true);
  assert.equal(
    realMeetAppControlRealtimeEvidencePasses(evidence, {
      expectedSessionId: "session_real_app_control",
    }),
    true,
  );
  assert.equal(evidence.toolTelemetry.appControlCalled, true);
  assert.equal(evidence.toolTelemetry.appControlJobId, "job_real_app_control");
  assert.equal(evidence.toolTelemetry.functionOutputDelivered, true);
  assert.equal(evidence.meetSurface.hasSDKGlobal, false);
  assert.equal(evidence.sidecarActive, true);
  assert.equal(evidence.sidecarPageCount, 1);
  assert.equal(evidence.sdkOwnerPageCount, 1);

  assert.equal(
    realMeetAppControlRealtimeEvidencePasses(
      {
        ...evidence,
        activeSessionId: "old_session",
      },
      {
        expectedSessionId: "session_real_app_control",
      },
    ),
    false,
  );
  assert.equal(
    realMeetAppControlEvidencePasses({
      appControl: { status: "completed", ok: true },
      joinStatus: {
        ...evidence,
        activeSessionId: "old_session",
      },
      expectedSessionId: "session_real_app_control",
    }),
    false,
  );
  assert.equal(
    passingRealtimeEvidence({
      delivery: {
        outputChannel: "agents_sdk_execute_return",
        suppressed: true,
      },
    }).toolTelemetry.functionOutputDelivered,
    false,
  );
  assert.equal(
    passingRealtimeEvidence({
      delivery: {},
      decisions: [
        {
          callId: "call_real_app_control",
          outputChannel: "agents_sdk_execute_return",
          suppressed: true,
        },
      ],
    }).toolTelemetry.functionOutputDelivered,
    false,
  );
  assert.equal(
    realMeetAppControlRealtimeEvidencePasses({
      ...evidence,
      toolTelemetry: {
        ...evidence.toolTelemetry,
        appControlCalled: false,
        appControlJobId: "",
      },
    }),
    false,
  );
  assert.equal(
    realMeetAppControlRealtimeEvidencePasses({
      ...evidence,
      meetSurface: { ...evidence.meetSurface, hasSDKGlobal: true },
    }),
    false,
  );
  assert.equal(
    realMeetAppControlRealtimeEvidencePasses({
      ...evidence,
      sidecarActive: false,
    }),
    false,
  );
  assert.equal(
    realMeetAppControlRealtimeEvidencePasses({
      ...evidence,
      sidecarPageCount: 0,
    }),
    false,
  );
  assert.equal(
    realMeetAppControlRealtimeEvidencePasses({
      ...evidence,
      sidecarPageCount: 2,
    }),
    false,
  );
  assert.equal(
    realMeetAppControlRealtimeEvidencePasses({
      ...evidence,
      sdkOwnerPageCount: 0,
    }),
    false,
  );
  assert.equal(
    realMeetAppControlRealtimeEvidencePasses({
      ...evidence,
      sdkOwnerPageCount: 2,
    }),
    false,
  );
});

test("real Meet app-control compact evidence reads Go runtime active joiner status", () => {
  const status = passingRealtimeJoinStatus();
  const evidence = compactRealMeetAppControlJoinStatus({
    ok: true,
    active: {
      session_id: "go_session_record",
      status: "joined",
    },
    runtime: {
      ok: true,
      active: status.active,
    },
  });

  assert.equal(evidence.activeSessionId, "session_real_app_control");
  assert.equal(evidence.realtimeRuntimePlacement, "sidecar");
  assert.equal(evidence.toolTelemetry.appControlCalled, true);
  assert.equal(realMeetAppControlRealtimeEvidencePasses(evidence), true);
});

test("real Meet gate requires Recappi input for live Realtime sender", () => {
  const gates = gateStatus({
    participantCount: 2,
    currentRealtimeInputSource: "host_meet_audio_pcm",
    senderTrackReadyState: "live",
    senderBytesSent: 4096,
    primaryMeetAudioSenderUsingAvatarBus: true,
    primaryMeetAudioSenderStats: {
      trackReadyState: "live",
      bytesSent: 4096,
      bytesDelta: 2048,
      packetsSent: 12,
      packetsDelta: 6,
    },
    meetAudioEnergy: {
      observed: true,
      rms: 0.02,
      peak: 0.08,
    },
    responsesRequested: 1,
    outputTranscriptCount: 1,
    inboundTypes: [],
    timelineTypes: [],
    avatarAudio: {
      outputEnergyObserved: true,
    },
    toolCalls: {
      all: ["share_existing_app_window"],
    },
  });

  assert.equal(gates.realtimeInputSenderLive, false);
  assert.equal(gates.senderLive, false);
  assert.deepEqual(gates.acceptedRealtimeInputSources, ["recappi_process_audio_tap"]);
});

test("real Meet gate rejects stale fake mic sender stats without fresh bytes", () => {
  const gates = gateStatus({
    participantCount: 2,
    currentRealtimeInputSource: "recappi_process_audio_tap",
    senderTrackReadyState: "live",
    senderBytesSent: 4096,
    primaryMeetAudioSenderUsingAvatarBus: true,
    primaryMeetAudioSenderStats: {
      trackReadyState: "live",
      bytesSent: 4096,
      bytesDelta: 0,
      packetsSent: 12,
      packetsDelta: 0,
    },
    meetAudioEnergy: {
      observed: true,
      rms: 0.02,
      peak: 0.08,
    },
    responsesRequested: 1,
    outputTranscriptCount: 1,
    inboundTypes: [],
    timelineTypes: [],
    avatarAudio: {
      outputEnergyObserved: true,
    },
    toolCalls: {
      all: ["share_existing_app_window"],
    },
  });

  assert.equal(gates.realtimeInputSenderLive, true);
  assert.equal(gates.meetPublishSenderLive, false);
  assert.equal(gates.senderLive, false);
});

test("fixture gate can accept host-forwarded Meet PCM as diagnostic Realtime sender", () => {
  const gates = gateStatus(
    {
      participantCount: 2,
      currentRealtimeInputSource: "host_meet_audio_pcm",
      senderTrackReadyState: "live",
      senderBytesSent: 4096,
      primaryMeetAudioSenderUsingAvatarBus: true,
      primaryMeetAudioSenderStats: {
        trackReadyState: "live",
        bytesSent: 4096,
        bytesDelta: 2048,
        packetsSent: 12,
        packetsDelta: 6,
      },
      meetAudioEnergy: {
        observed: true,
        rms: 0.02,
        peak: 0.08,
      },
      responsesRequested: 1,
      outputTranscriptCount: 1,
      inboundTypes: [],
      timelineTypes: [],
      avatarAudio: {
        outputEnergyObserved: true,
      },
      toolCalls: {
        all: ["share_existing_app_window"],
      },
    },
    { allowDiagnosticInputSources: true },
  );

  assert.equal(gates.realtimeInputSenderLive, true);
  assert.equal(gates.senderLive, true);
  assert.equal(gates.meetEnergyOk, true);
  assert.deepEqual(gates.acceptedRealtimeInputSources, [
    "meet_audio_mix",
    "recappi_process_audio_tap",
    "host_meet_audio_pcm",
  ]);
});
