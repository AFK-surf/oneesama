/* eslint-disable max-lines */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import {
  buildSidecarAcceptancePreflight,
  buildAdmissionRecipes,
  compactAppControlResult,
  compactSyntheticResult,
  extractRealMeetUrlFromJoinStatus as extractSidecarRealMeetUrlFromJoinStatus,
  gateRunErrorResult,
  normalizeRealMeetUrl as normalizeSidecarRealMeetUrl,
  parseGateJsonResult,
  prepareSyntheticSpeakerProfileClone,
  summarizeSidecarBlocker,
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
  buildRealMeetAppControlLiveLatencySummary,
  compactAppControlEvidence,
  compactRealMeetAppControlJoinStatus,
  extractRealMeetUrlFromJoinStatus,
  gateStatus,
  normalizeRealMeetUrl,
  realMeetAppControlEvidencePasses,
  realMeetAppControlManagedTargetConfig,
  realMeetAppControlRealtimeEvidencePasses,
  realMeetAppControlSuiteCasePasses,
  validateSyntheticSpeakerProfileIsolation,
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
              name: "kwwk_computer_use",
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
    packageJson.scripts["acceptance:realtime-meet-compat"],
    /real-meet-sidecar-acceptance\.mjs/,
  );
  assert.match(packageJson.scripts["acceptance:realtime-meet-compat"], /--meet-compat/);
  assert.match(packageJson.scripts["acceptance:realtime-meet-compat"], /--require-real-meet-url/);
  assert.match(
    packageJson.scripts["acceptance:realtime-meet-compat"],
    /--json-out \/tmp\/oneesama-realtime-meet-compat-latest\.json/,
  );
  assert.match(
    packageJson.scripts["acceptance:realtime-meet-compat:preflight"],
    /--preflight-only/,
  );
  assert.match(
    packageJson.scripts["acceptance:realtime-meet-compat:auto-room"],
    /--create-calendar-meet/,
  );
  assert.doesNotMatch(
    packageJson.scripts["acceptance:realtime-meet-compat:optional"],
    /--require-real-meet-url/,
  );
  assert.match(
    packageJson.scripts["acceptance:realtime-live-sidecar"],
    /real-meet-sidecar-acceptance\.mjs/,
  );
  assert.match(packageJson.scripts["acceptance:realtime-live-sidecar"], /--require-real-meet-url/);
  assert.match(
    packageJson.scripts["acceptance:realtime-live-sidecar:prepare-speaker-profile"],
    /--prepare-speaker-profile/,
  );
  assert.match(
    packageJson.scripts["acceptance:realtime-live-sidecar:preflight"],
    /--preflight-only/,
  );
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

test("Meet compatibility acceptance emits secondary-lane skipped evidence", () => {
  const result = runRealMeetSidecarAcceptance(["--meet-compat"]);

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.gate, "meet_compat");
  assert.equal(summary.acceptanceLane, "meet_compat_secondary");
  assert.equal(summary.primaryAcceptanceLane, "lan_operator");
  assert.equal(summary.ok, false);
  assert.equal(summary.skipped, true);
  assert.equal(summary.diagnosticOnly, true);
  assert.equal(summary.acceptanceSatisfied, false);
  assert.match(summary.command, /acceptance:realtime-meet-compat/);
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
    liveModelFirstLatency: { ok: true, warmP95Ms: 900 },
    suite: [
      {
        id: "keyboard-escape",
        kind: "keyboard",
        ok: true,
        acceptanceSatisfied: true,
        final: {
          appControl: {
            status: "completed",
            actions: ["press_key"],
            jobId: "job_keyboard",
            timing: { toolReceiveToVerifiedActionMs: 500, withinWarmSlo: true },
          },
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
  assert.equal(summary.suite[0].timing.toolReceiveToVerifiedActionMs, 500);
  assert.deepEqual(summary.suite[1].actions, ["click"]);
  assert.equal(summary.liveModelFirstLatency.warmP95Ms, 900);
});

test("real Meet app-control evidence preserves model-first timing", () => {
  const evidence = compactAppControlEvidence({
    ok: true,
    status: "completed",
    provider: "kwwk",
    backendResult: {
      metadata: {
        planner: {
          modelUsed: true,
          provider: "model_first_openrouter",
          modelName: "google/gemini-3.5-flash-20260519",
          modelLatencyMs: 380,
        },
        timings: {
          observeMs: 90,
          planMs: 420,
          executeMs: 70,
          cursorMs: 20,
          verifyMs: 40,
        },
      },
    },
  });

  assert.equal(evidence.timing.available, true);
  assert.equal(evidence.timing.modelUsed, true);
  assert.equal(evidence.timing.modelPlannerMs, 380);
  assert.equal(evidence.timing.toolReceiveToVerifiedActionMs, 640);
  assert.equal(evidence.timing.withinWarmSlo, true);
  assert.equal(evidence.timing.modelName, "google/gemini-3.5-flash-20260519");
});

test("real Meet app-control suite summarizes live latency evidence", () => {
  const passing = buildRealMeetAppControlLiveLatencySummary([
    {
      id: "keyboard-escape",
      kind: "keyboard",
      acceptanceSatisfied: true,
      final: {
        appControl: {
          timing: {
            modelUsed: true,
            toolReceiveToVerifiedActionMs: 600,
            modelPlannerMs: 300,
            withinWarmSlo: true,
          },
        },
      },
    },
    {
      id: "pointer-visible-click",
      kind: "pointer",
      acceptanceSatisfied: true,
      final: {
        appControl: {
          timing: {
            modelUsed: true,
            toolReceiveToVerifiedActionMs: 900,
            modelPlannerMs: 450,
            withinWarmSlo: true,
          },
        },
      },
    },
  ]);
  const missing = buildRealMeetAppControlLiveLatencySummary([
    {
      id: "keyboard-escape",
      kind: "keyboard",
      acceptanceSatisfied: true,
      final: {
        appControl: {},
      },
    },
  ]);

  assert.equal(passing.ok, true);
  assert.equal(passing.warmP95Ms, 900);
  assert.equal(passing.measuredSampleCount, 2);
  assert.equal(missing.ok, false);
  assert.equal(missing.missingTimingCount, 1);
  assert.equal(missing.samples[0].modelPlannerMs, null);
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

test("real Meet live sidecar acceptance preserves synthetic speaker failure diagnostics", () => {
  const summary = compactSyntheticResult({
    ok: false,
    acceptanceSatisfied: false,
    sessionId: "synthetic_session",
    childExit: { code: 1, signal: null },
    failure: {
      reason: "speaker_room_admission_required",
      hostAdmissionRequired: true,
      requiredFix: "Use a Meet room/profile that can admit the synthetic speaker.",
    },
    mainBotProfile: {
      profileMode: "persistent",
      browserUserDataDirConfigured: true,
    },
    syntheticSpeakerProfile: {
      profileMode: "guest",
      browserUserDataDirConfigured: false,
    },
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.acceptanceSatisfied, false);
  assert.equal(summary.failure.reason, "speaker_room_admission_required");
  assert.equal(summary.mainBotProfile.profileMode, "persistent");
  assert.equal(summary.syntheticSpeakerProfile.profileMode, "guest");
});

test("real Meet live sidecar acceptance lifts synthetic speaker admission blocker", () => {
  const summary = compactSyntheticResult({
    ok: false,
    acceptanceSatisfied: false,
    childExit: { code: 1, signal: null },
    failure: {
      reason: "speaker_room_admission_required",
      requiredFix: "Use a Meet room/profile that can admit the synthetic speaker.",
    },
  });
  const blocker = summarizeSidecarBlocker({
    syntheticSpeaker: summary,
    appControl: {
      acceptanceSatisfied: true,
    },
  });

  assert.equal(blocker.blockerSource, "synthetic_speaker");
  assert.equal(blocker.blocker, "speaker_room_admission_required");
  assert.match(blocker.requiredFix, /admit the synthetic speaker/);
});

test("real Meet live sidecar compact app-control records waiting-room admission", () => {
  const summary = compactAppControlResult({
    ok: false,
    acceptanceSatisfied: false,
    childExit: { code: 1, signal: null },
    error: "HTTP 400 /screen-share/app: not_in_meeting",
    errorBody: {
      postcheck: {
        meetPage: {
          waitingForAdmit: true,
          inMeeting: false,
          participantCount: 1,
          textHead: "Please wait until a meeting host brings you into the call",
        },
      },
    },
  });

  assert.equal(summary.acceptanceSatisfied, false);
  assert.equal(summary.blocker, "room_admission_required");
  assert.equal(summary.meetingAdmission.waitingForAdmit, true);
  assert.equal(summary.meetingAdmission.inMeeting, false);
  assert.match(summary.meetingAdmission.textHead, /meeting host/);
});

test("real Meet live sidecar summarizes shared room admission failure", () => {
  const blocker = summarizeSidecarBlocker({
    syntheticSpeaker: {
      acceptanceSatisfied: false,
      failure: { reason: "speaker_room_admission_required" },
    },
    appControl: {
      acceptanceSatisfied: false,
      meetingAdmission: { waitingForAdmit: true },
    },
  });

  assert.equal(blocker.blockerSource, "real_meet_admission");
  assert.equal(blocker.blocker, "real_meet_room_admission_required");
  assert.match(blocker.requiredFix, /authenticated profiles/);
});

test("real Meet live sidecar preflight rejects shared persistent speaker profile", () => {
  const preflight = buildSidecarAcceptancePreflight({
    meetUrl: "https://meet.google.com/abc-defg-hij",
    meetUrlSource: "test",
    env: {
      MAB_MEET_PROFILE_MODE: "persistent",
      MAB_BROWSER_USER_DATA_DIR: "/tmp/oneesama-profile",
      MAB_SYNTHETIC_SPEAKER_PROFILE_MODE: "persistent",
      MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR: "/tmp/oneesama-profile",
    },
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.preflightSatisfied, false);
  assert.equal(preflight.acceptanceSatisfied, false);
  assert.equal(preflight.blockerSource, "synthetic_speaker");
  assert.equal(preflight.blocker, "synthetic_speaker_profile_conflicts_with_main_bot");
  assert.match(preflight.requiredFix, /separate authenticated Chrome profile/);
});

test("real Meet live sidecar preflight warns for guest speaker profile", () => {
  const preflight = buildSidecarAcceptancePreflight({
    meetUrl: "https://meet.google.com/abc-defg-hij",
    meetUrlSource: "test",
    env: {},
  });

  assert.equal(preflight.ok, true);
  assert.equal(preflight.preflightSatisfied, true);
  assert.equal(preflight.syntheticSpeakerProfile.profileMode, "guest");
  assert.equal(preflight.warnings[0].reason, "synthetic_speaker_guest_profile");
});

test("real Meet live sidecar preflight records room admission as unverified", () => {
  const preflight = buildSidecarAcceptancePreflight({
    meetUrl: "https://meet.google.com/abc-defg-hij",
    meetUrlSource: "test",
    env: {
      MAB_MEET_PROFILE_MODE: "persistent",
      MAB_BROWSER_USER_DATA_DIR: "/tmp/oneesama-main-profile",
      MAB_SYNTHETIC_SPEAKER_PROFILE_MODE: "persistent",
      MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR: "/tmp/oneesama-speaker-profile",
    },
  });

  assert.equal(preflight.ok, true);
  assert.equal(preflight.admissionPreconditions.roomAdmissionVerified, false);
  assert.equal(preflight.admissionPreconditions.profilesConfiguredOnly, true);
  assert.equal(preflight.admissionPreconditions.syntheticSpeakerMustBeAdmitted, true);
  assert.match(preflight.admissionPreconditions.message, /admits the synthetic speaker/);
});

test("real Meet live sidecar auto-room preflight requires an admission path", () => {
  const preflight = buildSidecarAcceptancePreflight({
    meetUrl: "",
    meetUrlSource: "",
    env: {},
    calendarMeetCreation: {
      requested: true,
      preflightOnly: true,
      config: {
        ok: true,
        attendeeCount: 0,
      },
    },
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.blockerSource, "calendar_meet");
  assert.equal(preflight.blocker, "calendar_auto_room_admission_path_missing");
  assert.equal(preflight.admissionPreconditions.calendarAutoRoomRequested, true);
  assert.equal(preflight.admissionPreconditions.calendarAutoRoomAdmissionPathConfigured, false);
  assert.ok(preflight.admissionRecipes.some((recipe) => recipe.id === "main_bot_host_profile"));
  assert.ok(
    preflight.admissionRecipes.some((recipe) => recipe.id === "invited_synthetic_speaker_profile"),
  );
  assert.ok(preflight.admissionRecipes.some((recipe) => recipe.id === "host_admission_actor"));
});

test("real Meet live sidecar auto-room preflight accepts configured admission paths", () => {
  const mainHost = buildSidecarAcceptancePreflight({
    meetUrl: "",
    meetUrlSource: "",
    env: {
      MAB_MEET_PROFILE_MODE: "persistent",
      MAB_BROWSER_USER_DATA_DIR: "/tmp/main-host-profile",
    },
    calendarMeetCreation: {
      requested: true,
      preflightOnly: true,
      config: {
        ok: true,
        attendeeCount: 0,
      },
    },
  });
  const invitedSpeaker = buildSidecarAcceptancePreflight({
    meetUrl: "",
    meetUrlSource: "",
    env: {
      MAB_SYNTHETIC_SPEAKER_PROFILE_MODE: "persistent",
      MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR: "/tmp/speaker-profile",
    },
    calendarMeetCreation: {
      requested: true,
      preflightOnly: true,
      config: {
        ok: true,
        attendeeCount: 1,
      },
    },
  });

  assert.equal(mainHost.ok, true);
  assert.equal(mainHost.admissionPreconditions.calendarAutoRoomAdmissionPathConfigured, true);
  assert.equal(invitedSpeaker.ok, true);
  assert.equal(invitedSpeaker.admissionPreconditions.calendarAutoRoomAdmissionPathConfigured, true);
});

test("real Meet live sidecar admission recipes are explicit env templates only", () => {
  const recipes = buildAdmissionRecipes({
    calendarMeetCreation: { requested: true },
  });
  const rendered = JSON.stringify(recipes);

  assert.equal(recipes.length, 3);
  assert.match(rendered, /MAB_BROWSER_USER_DATA_DIR=\/path\/to\/authenticated-main-bot-profile/);
  assert.match(rendered, /MAB_REAL_MEET_CALENDAR_ATTENDEES=speaker@example.com/);
  assert.doesNotMatch(rendered, /Users\/pengx17/);
  assert.doesNotMatch(rendered, /@gmail\.com/);
  assert.doesNotMatch(rendered, /@cue\.surf/);
});

test("real Meet live sidecar can prepare an isolated speaker profile clone", async () => {
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), "oneesama-speaker-profile-test-"));
  const source = pathJoin(tmpDir, "main-profile");
  const target = pathJoin(tmpDir, "speaker-profile");
  mkdirSync(pathJoin(source, "Default", "Cache"), { recursive: true });
  mkdirSync(pathJoin(source, "Default"), { recursive: true });
  writeFileSync(pathJoin(source, "Local State"), "{}");
  writeFileSync(pathJoin(source, "Default", "Preferences"), "{}");
  writeFileSync(pathJoin(source, "Default", "Cache", "ignored"), "cache");
  writeFileSync(pathJoin(source, "SingletonLock"), "locked");
  try {
    rmSync(pathJoin(source, "SingletonLock"), { force: true });
    const result = await prepareSyntheticSpeakerProfileClone({
      env: {
        MAB_MEET_PROFILE_MODE: "persistent",
        MAB_BROWSER_USER_DATA_DIR: source,
        MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR: target,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.env.MAB_SYNTHETIC_SPEAKER_PROFILE_MODE, "persistent");
    assert.equal(result.env.MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR, target);
    assert.equal(existsSync(pathJoin(target, "Local State")), true);
    assert.equal(existsSync(pathJoin(target, "Default", "Preferences")), true);
    assert.equal(existsSync(pathJoin(target, "Default", "Cache", "ignored")), false);
    assert.equal(existsSync(pathJoin(target, "SingletonLock")), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("real Meet live sidecar speaker profile clone requires main persistent profile", async () => {
  const result = await prepareSyntheticSpeakerProfileClone({
    env: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "main_bot_persistent_profile_required");
});

test("real Meet synthetic speaker preflight rejects shared persistent profile", () => {
  const failure = validateSyntheticSpeakerProfileIsolation(
    {
      profileMode: "persistent",
      browserUserDataDir: "/tmp/oneesama-profile",
    },
    {
      profileMode: "persistent",
      browserUserDataDir: "/tmp/oneesama-profile",
    },
  );

  assert.equal(failure.reason, "synthetic_speaker_profile_conflicts_with_main_bot");
  assert.match(failure.requiredFix, /separate authenticated Chrome profile/);
});

test("real Meet synthetic speaker preflight allows distinct persistent profiles", () => {
  const failure = validateSyntheticSpeakerProfileIsolation(
    {
      profileMode: "persistent",
      browserUserDataDir: "/tmp/oneesama-main-profile",
    },
    {
      profileMode: "persistent",
      browserUserDataDir: "/tmp/oneesama-speaker-profile",
    },
  );

  assert.equal(failure, null);
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
  assert.deepEqual(await exitPromise, { code: 0, signal: null, timedOut: false, timeoutMs: 0 });

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

test("real Meet app-control suite defaults to a managed stable target window", () => {
  const defaults = realMeetAppControlManagedTargetConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.applicationName, "Google Chrome for Testing");
  assert.equal(defaults.windowTitle, "Oneesama KWWK App Control Target");
  assert.equal(defaults.targetLabel, "Chromium");

  const external = realMeetAppControlManagedTargetConfig({
    MAB_REAL_MEET_APP_CONTROL_APPLICATION: "Chrome",
  });
  assert.equal(external.enabled, false);
  assert.equal(external.applicationName, "Chrome");

  const forced = realMeetAppControlManagedTargetConfig({
    MAB_REAL_MEET_APP_CONTROL_APPLICATION: "Chrome",
    MAB_REAL_MEET_APP_CONTROL_MANAGED_TARGET: "1",
    MAB_REAL_MEET_APP_CONTROL_WINDOW_TITLE: "Custom CU Target",
    MAB_REAL_MEET_APP_CONTROL_TARGET_LABEL: "Click Me",
  });
  assert.equal(forced.enabled, true);
  assert.equal(forced.applicationName, "Chrome");
  assert.equal(forced.windowTitle, "Custom CU Target");
  assert.equal(forced.targetLabel, "Click Me");
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
