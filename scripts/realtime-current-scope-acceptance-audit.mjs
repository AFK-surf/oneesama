#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const DEFAULT_MAX_AGE_HOURS = 72;

export const CURRENT_SCOPE_ARTIFACTS = [
  {
    id: "kwwk_app_control",
    path: "/tmp/oneesama-realtime-kwwk-app-control-latest.json",
    gate: "kwwk_backend_execution",
    check: (data) => {
      expect(data.ok === true, "ok must be true");
      expect(data.gate === "kwwk_backend_execution", "gate must be kwwk_backend_execution");
      expect(data.error === "", "error must be empty when present");
    },
  },
  {
    id: "kwwk_planner_action",
    path: "/tmp/oneesama-realtime-kwwk-planner-action-latest.json",
    gate: "kwwk_planner_action",
    check: (data) => {
      expect(data.ok === true, "ok must be true");
      expect(data.gate === "kwwk_planner_action", "gate must be kwwk_planner_action");
      const cases = Array.isArray(data.cases) ? data.cases : [];
      expect(cases.length > 0, "cases must be present");
      expect(
        cases.every((entry) => entry.ok === true),
        "every case must pass",
      );
      expect(
        cases.every((entry) => plannerModelUsed(entry)),
        "every natural-language action case must use a model plan",
      );
    },
  },
  {
    id: "kwwk_planner_live",
    path: "/tmp/oneesama-realtime-kwwk-planner-live-latest.json",
    gate: "kwwk_live_planner",
    check: (data) => {
      expect(data.ok === true, "ok must be true");
      expect(data.gate === "kwwk_live_planner", "gate must be kwwk_live_planner");
      expect(
        data.requestedProvider === "gemini",
        "current product planner provider must be native Gemini",
      );
      expect(
        data.requestedModel === "gemini-3.5-flash",
        "current product planner model must be gemini-3.5-flash",
      );
      expect(
        data.providerRuntime?.openAICompatibility === false,
        "native Gemini path must not be OpenAI-compatible wrapper mode",
      );
      expect(data.latencyGate?.ok === true, "planner latency gate must pass");
      expect(
        Number(data.latencyGate?.p95ModelMs || 0) <= Number(data.plannerSloMs || 1200),
        "planner model p95 must be within SLO",
      );
      const cases = Array.isArray(data.cases) ? data.cases : [];
      expect(cases.length > 0, "live planner cases must be present");
      expect(
        cases.every((entry) => entry.modelUsed === true),
        "all live planner cases must use the provider model",
      );
      expect(
        cases.every((entry) => entry.schemaValid === true),
        "all live planner cases must be schema valid",
      );
      expect(
        cases.every((entry) => entry.withinPlannerSlo === true),
        "all live planner cases must be within planner SLO",
      );
    },
  },
  {
    id: "kwwk_cursor_visible",
    path: "/tmp/oneesama-realtime-kwwk-cursor-visible-latest.json",
    gate: "cursor_visible",
    check: (data) => {
      expect(data.ok === true, "ok must be true");
      expect(data.gate === "cursor_visible", "gate must be cursor_visible");
    },
  },
  {
    id: "kwwk_native_cursor",
    path: "/tmp/oneesama-realtime-kwwk-native-cursor-latest.json",
    gate: "native_foreground_cursor",
    check: (data) => {
      expect(data.ok === true, "ok must be true");
      expect(data.gate === "native_foreground_cursor", "gate must be native_foreground_cursor");
    },
  },
  {
    id: "kwwk_latency",
    path: "/tmp/oneesama-realtime-kwwk-latency-latest.json",
    gate: "cold_warm_latency",
    check: (data) => {
      expect(data.ok === true, "ok must be true");
      expect(data.gate === "cold_warm_latency", "gate must be cold_warm_latency");
      expect(
        Number(data.timings?.warmP95Ms || Infinity) <= 2500,
        "warm helper p95 must be <= 2500ms",
      );
      expect(data.nonVisualExecuteLight?.ok === true, "nonvisual light execution gate must pass");
      const cases = Array.isArray(data.cases) ? data.cases : [];
      expect(cases.length > 0, "latency cases must be present");
      expect(
        cases.every((entry) => entry.ok === true),
        "every latency case must pass",
      );
      expect(
        cases.every((entry) => plannerModelUsed(entry)),
        "latency cases must stay model-first",
      );
    },
  },
  {
    id: "realtime_tool_recall",
    path: "/tmp/oneesama-realtime-tool-recall-full-kwwk-latest.json",
    gate: "realtime_tool_recall",
    check: (data) => {
      expect(data.ok === true, "ok must be true");
      expect(data.gate === "realtime_tool_recall", "gate must be realtime_tool_recall");
      expect(data.acceptanceGate === true, "tool recall must be an acceptance gate");
      expect(data.notAcceptanceGate !== true, "tool recall must not be diagnostic-only");
      expect(data.runtime === "sidecar-control", "tool recall must use sidecar-control runtime");
      expect(data.staleServiceSuspected !== true, "stale service must not be suspected");
      const exposed = Array.isArray(data.exposedToolNames) ? data.exposedToolNames : [];
      expect(exposed.includes("kwwk_computer_use"), "tool surface must expose kwwk_computer_use");
      expect(
        !exposed.includes("control_shared_app_window"),
        "tool surface must not expose control_shared_app_window",
      );
      const full = (Array.isArray(data.variants) ? data.variants : []).find(
        (entry) => entry.name === "full",
      );
      expect(Boolean(full), "full variant must be present");
      expect(full.summary?.ok === true, "full variant summary must pass");
      expect(Number(full.summary?.recall || 0) >= 1, "full variant recall must be 1");
      expect(
        Number(full.summary?.disallowedRate ?? Infinity) === 0,
        "full variant disallowed rate must be 0",
      );
      expect(
        (full.toolNames || []).includes("kwwk_computer_use"),
        "full variant must include kwwk_computer_use",
      );
      expect(
        !(full.toolNames || []).includes("control_shared_app_window"),
        "full variant must not include control_shared_app_window",
      );
      const cases = Array.isArray(full.cases) ? full.cases : [];
      expect(cases.length > 0, "full variant cases must be present");
      expect(
        cases.every((entry) => entry.ok === true),
        "all full variant cases must pass",
      );
      expect(
        cases.every((entry) => entry.fakeExecution !== true),
        "tool recall must not pass through fake execution",
      );
      expect(
        caseCallsTool(cases, "control_switch_tab_zh", "kwwk_computer_use"),
        "tab-switch case must route to kwwk_computer_use",
      );
      expect(
        caseCallsTool(cases, "complex_shared_doc_redesign_zh", "delegate_to_worker"),
        "complex work case must route to delegate_to_worker",
      );
      expect(
        caseAvoidsTool(cases, "complex_shared_doc_redesign_zh", "kwwk_computer_use"),
        "complex work case must not route to kwwk_computer_use",
      );
      expect(
        caseAvoidsTool(cases, "negative_stop_share_zh", "kwwk_computer_use"),
        "stop-share negative must not route to kwwk_computer_use",
      );
      expect(
        caseAvoidsTool(cases, "negative_meeting_control_mute_zh", "kwwk_computer_use"),
        "meeting-control negative must not route to kwwk_computer_use",
      );
    },
  },
  {
    id: "native_interruption",
    path: "/tmp/oneesama-realtime-native-interruption-latest.json",
    gate: "realtime_native_audio_interruption",
    check: (data) => {
      expect(data.ok === true, "ok must be true");
      expect(
        data.gate === "realtime_native_audio_interruption",
        "gate must be realtime_native_audio_interruption",
      );
      const cases = Array.isArray(data.cases) ? data.cases : [];
      expect(cases.length >= 4, "native interruption must cover all core cases");
      expect(
        cases.every((entry) => entry.ok === true),
        "every interruption case must pass",
      );
    },
  },
  {
    id: "real_app_control_suite",
    path: "/tmp/oneesama-realtime-real-app-control-suite-latest.json",
    gate: "real_meet_app_control_suite",
    check: (data) => {
      expect(data.ok === true, "ok must be true");
      expect(data.acceptanceSatisfied === true, "acceptanceSatisfied must be true");
      expect(data.actionAcceptanceSatisfied === true, "actionAcceptanceSatisfied must be true");
      expect(
        data.liveModelFirstLatency?.ok === true,
        "live model-first latency sub-gate must pass",
      );
      expect(
        Number(data.liveModelFirstLatency?.warmP95Ms || Infinity) <=
          Number(data.liveModelFirstLatency?.warmSloMs || 2500),
        "real app-control warm p95 must be within SLO",
      );
      const samples = Array.isArray(data.liveModelFirstLatency?.samples)
        ? data.liveModelFirstLatency.samples
        : [];
      expect(samples.length > 0, "real app-control latency samples must be present");
      expect(
        samples.every((entry) => entry.modelUsed === true),
        "real app-control samples must be model-first",
      );
      expect(
        samples.every((entry) => entry.acceptanceSatisfied === true),
        "real app-control samples must pass acceptance",
      );
    },
  },
  {
    id: "meet_free_gomoku",
    path: "/tmp/oneesama-realtime-synthetic-audio-suite-latest.json",
    gate: "meet_free_synthetic_audio_suite",
    check: (data) => {
      expect(data.ok === true, "ok must be true");
      expect(Number(data.caseCount || 0) >= 1, "caseCount must be present");
      expect(Number(data.failed || 0) === 0, "failed must be 0");
      const result = (Array.isArray(data.results) ? data.results : []).find(
        (entry) => entry.id === "gomoku_sync_build_and_play_en",
      );
      expect(Boolean(result), "gomoku_sync_build_and_play_en result must exist");
      expect(result.ok === true, "Gomoku primary case must pass");
      const evaluation = result.evaluation || {};
      expect(
        evaluation.requiredToolsSatisfied === true,
        "delegate_to_worker must be required and satisfied",
      );
      expect(evaluation.forbiddenToolsAbsent === true, "forbidden tools must be absent");
      expect(
        Array.isArray(evaluation.forbiddenToolNamesCalled) &&
          evaluation.forbiddenToolNamesCalled.length === 0,
        "forbiddenToolNamesCalled must be empty",
      );
      expect(
        Array.isArray(evaluation.forbiddenOutputTextPatternsHit) &&
          evaluation.forbiddenOutputTextPatternsHit.length === 0,
        "startup chatter must be absent",
      );
      expect(evaluation.englishOutputOnly === true, "English output contract must hold");
      expect(evaluation.twoClientSyncPass === true, "two-client sync must pass");
      expect(evaluation.botMoveSourceObserved === true, "bot move must come from app/bot engine");
      const compact = result.result || {};
      expect(
        (compact.toolCalls?.all || []).join(",") === "delegate_to_worker",
        "Gomoku case must call only delegate_to_worker",
      );
      expect(compact.workerArtifact?.reachable === true, "worker artifact URL must be reachable");
      expect(compact.syncProbe?.twoClientSyncPass === true, "sync probe must pass");
      expect(
        compact.syncProbe?.botMoveSource === "app_bot_engine",
        "bot move source must be app_bot_engine",
      );
      expect(
        Array.isArray(compact.outputTranscriptTail) && compact.outputTranscriptTail.length === 0,
        "output transcript tail must be empty for no startup chatter",
      );
      expect(
        Array.isArray(compact.syncProbe?.screenshots) && compact.syncProbe.screenshots.length >= 2,
        "screenshot evidence must be present",
      );
    },
  },
];

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function plannerModelUsed(entry) {
  return (
    entry?.modelUsed === true ||
    entry?.planner?.modelUsed === true ||
    entry?.verifier?.modelUsed === true ||
    entry?.verifier?.modelFirst === true
  );
}

function caseById(cases, id) {
  return cases.find((entry) => entry.id === id) || null;
}

function caseCallsTool(cases, id, toolName) {
  const entry = caseById(cases, id);
  return Array.isArray(entry?.calls) && entry.calls.includes(toolName);
}

function caseAvoidsTool(cases, id, toolName) {
  const entry = caseById(cases, id);
  return Boolean(entry) && (!Array.isArray(entry.calls) || !entry.calls.includes(toolName));
}

function parseArgs(argv) {
  const args = {
    jsonOut: "",
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json-out") args.jsonOut = argv[++index] || "";
    else if (arg === "--max-age-hours") args.maxAgeHours = Number(argv[++index]);
    else if (arg === "--no-max-age") args.maxAgeHours = 0;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.maxAgeHours) || args.maxAgeHours < 0) {
    throw new Error("--max-age-hours must be a non-negative number");
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/realtime-current-scope-acceptance-audit.mjs [options]

Options:
  --json-out <path>       Write audit report JSON
  --max-age-hours <n>     Fail artifacts older than n hours (default: ${DEFAULT_MAX_AGE_HOURS})
  --no-max-age            Disable artifact freshness checks
`);
}

export function auditCurrentScopeArtifacts({
  artifacts = CURRENT_SCOPE_ARTIFACTS,
  now = Date.now(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
} = {}) {
  const results = [];
  for (const artifact of artifacts) {
    const result = {
      id: artifact.id,
      path: artifact.path,
      gate: artifact.gate,
      ok: false,
      exists: false,
      mtime: "",
      ageHours: null,
      error: "",
    };
    try {
      expect(existsSync(artifact.path), "artifact file missing");
      result.exists = true;
      const stat = statSync(artifact.path);
      result.mtime = stat.mtime.toISOString();
      result.ageHours = Math.round(((now - stat.mtimeMs) / 3_600_000) * 100) / 100;
      if (maxAgeHours > 0) {
        expect(
          result.ageHours <= maxAgeHours,
          `artifact is stale: ${result.ageHours}h > ${maxAgeHours}h`,
        );
      }
      const data = JSON.parse(readFileSync(artifact.path, "utf8"));
      artifact.check(data, { artifact, result, now, maxAgeHours });
      result.ok = true;
    } catch (error) {
      result.error = String(error?.message || error);
    }
    results.push(result);
  }
  const failed = results.filter((entry) => !entry.ok);
  return {
    schema: "oneesama.realtime-current-scope-acceptance-audit.v1",
    ok: failed.length === 0,
    generatedAt: new Date(now).toISOString(),
    maxAgeHours,
    currentScope: true,
    realRoomSidecarFollowUp: true,
    artifactCount: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = auditCurrentScopeArtifacts({ maxAgeHours: args.maxAgeHours });
  const json = JSON.stringify(report, null, 2);
  if (args.jsonOut) {
    writeFileSync(args.jsonOut, `${json}\n`);
  }
  console.log(json);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
    process.exitCode = 1;
  });
}
