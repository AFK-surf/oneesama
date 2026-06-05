import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";

import {
  CURRENT_SCOPE_ARTIFACTS,
  auditCurrentScopeArtifacts,
} from "../scripts/realtime-current-scope-acceptance-audit.mjs";

function writeJson(dir, name, payload) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

function passingArtifactPayload(id) {
  switch (id) {
    case "kwwk_app_control":
      return { ok: true, gate: "kwwk_backend_execution", error: "" };
    case "kwwk_planner_action":
      return {
        ok: true,
        gate: "kwwk_planner_action",
        cases: [{ ok: true, modelUsed: true }],
      };
    case "kwwk_planner_live":
      return {
        ok: true,
        gate: "kwwk_live_planner",
        requestedProvider: "gemini",
        requestedModel: "gemini-3.5-flash",
        providerRuntime: { openAICompatibility: false },
        plannerSloMs: 1200,
        latencyGate: { ok: true, p95ModelMs: 1000 },
        cases: [{ ok: true, modelUsed: true, schemaValid: true, withinPlannerSlo: true }],
      };
    case "kwwk_cursor_visible":
      return { ok: true, gate: "cursor_visible" };
    case "kwwk_native_cursor":
      return { ok: true, gate: "native_foreground_cursor" };
    case "kwwk_latency":
      return {
        ok: true,
        gate: "cold_warm_latency",
        timings: { warmP95Ms: 1000 },
        nonVisualExecuteLight: { ok: true },
        cases: [{ ok: true, modelUsed: true }],
      };
    case "native_interruption":
      return {
        ok: true,
        gate: "realtime_native_audio_interruption",
        cases: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      };
    case "real_app_control_suite":
      return {
        ok: true,
        acceptanceSatisfied: true,
        actionAcceptanceSatisfied: true,
        liveModelFirstLatency: {
          ok: true,
          warmP95Ms: 1200,
          warmSloMs: 2500,
          samples: [{ modelUsed: true, acceptanceSatisfied: true }],
        },
      };
    case "realtime_tool_recall":
      return {
        ok: true,
        gate: "realtime_tool_recall",
        acceptanceGate: true,
        notAcceptanceGate: false,
        runtime: "sidecar-control",
        exposedToolNames: ["delegate_to_worker", "kwwk_computer_use", "share_existing_app_window"],
        staleServiceSuspected: false,
        variants: [
          {
            name: "full",
            toolNames: ["delegate_to_worker", "kwwk_computer_use", "share_existing_app_window"],
            summary: {
              ok: true,
              recall: 1,
              disallowedRate: 0,
              positivePassed: 2,
              positiveTotal: 2,
              negativePassed: 2,
              negativeTotal: 2,
            },
            cases: [
              {
                id: "control_switch_tab_zh",
                ok: true,
                calls: ["kwwk_computer_use"],
                fakeExecution: false,
              },
              {
                id: "complex_shared_doc_redesign_zh",
                ok: true,
                calls: ["delegate_to_worker"],
                fakeExecution: false,
              },
              {
                id: "negative_stop_share_zh",
                ok: true,
                calls: ["stop_video_stage"],
                fakeExecution: false,
              },
              {
                id: "negative_meeting_control_mute_zh",
                ok: true,
                calls: [],
                fakeExecution: false,
              },
            ],
          },
        ],
      };
    case "meet_free_gomoku":
      return {
        ok: true,
        caseCount: 1,
        failed: 0,
        results: [
          {
            id: "gomoku_sync_build_and_play_en",
            ok: true,
            evaluation: {
              requiredToolsSatisfied: true,
              forbiddenToolsAbsent: true,
              forbiddenToolNamesCalled: [],
              forbiddenOutputTextPatternsHit: [],
              englishOutputOnly: true,
              twoClientSyncPass: true,
              botMoveSourceObserved: true,
            },
            result: {
              toolCalls: { all: ["delegate_to_worker"] },
              workerArtifact: { reachable: true },
              syncProbe: {
                twoClientSyncPass: true,
                botMoveSource: "app_bot_engine",
                screenshots: ["/tmp/a.png", "/tmp/b.png"],
              },
              outputTranscriptTail: [],
            },
          },
        ],
      };
    default:
      throw new Error(`unknown fixture id: ${id}`);
  }
}

function fixtureArtifacts(dir, mutate = () => {}) {
  mkdirSync(dir, { recursive: true });
  return CURRENT_SCOPE_ARTIFACTS.map((artifact) => {
    const payload = passingArtifactPayload(artifact.id);
    mutate(artifact.id, payload);
    return {
      ...artifact,
      path: writeJson(dir, `${artifact.id}.json`, payload),
    };
  });
}

test("current-scope acceptance audit passes complete current-scope evidence", () => {
  const dir = join(process.env.TEST_TMPDIR || "/tmp", `oneesama-audit-${Date.now()}`);
  const artifacts = fixtureArtifacts(dir);

  const report = auditCurrentScopeArtifacts({
    artifacts,
    now: Date.now(),
    maxAgeHours: 0,
  });

  assert.equal(report.ok, true);
  assert.equal(report.artifactCount, CURRENT_SCOPE_ARTIFACTS.length);
  assert.equal(report.failed, 0);
  assert.equal(report.realRoomSidecarFollowUp, true);
  assert.equal(
    report.results.some((entry) => entry.id === "realtime_live_sidecar"),
    false,
  );
});

test("current-scope acceptance audit fails missing or weakened evidence", () => {
  const dir = join(process.env.TEST_TMPDIR || "/tmp", `oneesama-audit-fail-${Date.now()}`);
  const artifacts = fixtureArtifacts(dir, (id, payload) => {
    if (id === "meet_free_gomoku") {
      payload.results[0].result.outputTranscriptTail = [
        { text: "Hi there! Nice to hear you. What's on your mind today?" },
      ];
    }
  });

  const report = auditCurrentScopeArtifacts({
    artifacts,
    now: Date.now(),
    maxAgeHours: 0,
  });

  assert.equal(report.ok, false);
  const gomoku = report.results.find((entry) => entry.id === "meet_free_gomoku");
  assert.equal(gomoku.ok, false);
  assert.match(gomoku.error, /output transcript tail must be empty/);
});
