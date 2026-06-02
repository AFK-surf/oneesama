import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { buildKWWKAppControlBenchmarkReport } from "../scripts/realtime-kwwk-app-control-benchmark.mjs";

test("KWWK backend app-control report labels backend proof boundary", () => {
  const report = buildKWWKAppControlBenchmarkReport(
    { app: "Chrome", timeoutMs: 45_000 },
    {
      ok: true,
      code: 0,
      signal: "",
      timedOut: false,
      error: "",
      durationMs: 1234,
      stderr: "",
      stdout: [
        "--- PASS: TestLiveKWWKStdioAppControlBackendControlsHostApp (0.10s)",
        "--- PASS: TestLiveRealtimeSharedAppControlHTTPUsesKWWKBackend (0.20s)",
        "--- PASS: TestLiveRealtimeSharedAppControlHTTPAcceptsKWWKInstructionOnlyObserve (0.30s)",
        "--- PASS: TestLiveKWWKStdioAppControlBackendRejectsMixedObserveActionInstruction (0.40s)",
      ].join("\n"),
    },
  );

  assert.equal(report.gate, "kwwk_backend_execution");
  assert.equal(report.acceptanceGateScope, "kwwk_backend_execution");
  assert.equal(report.backendProvider, "host_kwwk_app_control_live_smoke");
  assert.equal(report.realAppExecution, true);
  assert.equal(report.meetRoomRequired, false);
  assert.deepEqual(report.acceptance, {
    stateObserveRequest: true,
    screenshotOrStateCapture: true,
    instructionOnlyObserve: true,
    mixedObserveActionRejected: true,
    backendProviderLabeled: true,
    coldWarmTimingSeparated: true,
  });
  assert.ok(report.proofBoundary.doesNotProve.includes("natural-language planner/action quality"));
  assert.ok(report.proofBoundary.doesNotProve.includes("audience-visible cursor rendering"));
  assert.deepEqual(
    report.cases.map((entry) => [entry.id, entry.category, entry.proves]),
    [
      [
        "TestLiveKWWKStdioAppControlBackendControlsHostApp",
        "backend_state_observe",
        ["state_observe_request", "screenshot_or_state_capture", "stdio_helper_backend"],
      ],
      [
        "TestLiveRealtimeSharedAppControlHTTPUsesKWWKBackend",
        "backend_http_tool_path",
        ["server_tool_path", "screenshot_or_state_capture", "backend_provider_label"],
      ],
      [
        "TestLiveRealtimeSharedAppControlHTTPAcceptsKWWKInstructionOnlyObserve",
        "backend_instruction_only_observe",
        ["instruction_only_observe", "compact_success_envelope"],
      ],
      [
        "TestLiveKWWKStdioAppControlBackendRejectsMixedObserveActionInstruction",
        "backend_contract_rejection",
        ["mixed_observe_action_rejected", "compact_blocker_envelope"],
      ],
    ],
  );
});
