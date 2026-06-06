import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { defaultDebugState } from "../packages/core/src/operator/lan-operator-debug-state.ts";
import { buildLanOperatorMeetHudTelemetry } from "../packages/core/src/operator/lan-operator-hud-telemetry.ts";
import { buildLanOperatorRuntimeSessionConfig } from "../packages/core/src/operator/lan-operator-runtime-config.ts";
import { buildLanOperatorDebugReport } from "../packages/core/src/operator/lan-operator-runtime-status.ts";
import { appendTimelineRow } from "../packages/core/src/operator/lan-operator-timeline-debug.ts";

test("LAN operator debug state builds compact Meet HUD telemetry", () => {
  const debug = defaultDebugState();
  debug.conversation.status = "connected";
  debug.transport.events.state = "open";
  debug.voice.chunksReceived = 2;
  debug.kwwk.status = "blocked";
  debug.kwwk.blocker = "verification_target_missing";
  appendTimelineRow(debug, {
    at: new Date("2026-06-05T00:00:00.000Z").toISOString(),
    layer: "kwwk",
    event: "kwwk_blocked",
    ok: false,
    turnId: "turn_hud",
    responseId: "response_hud",
    blocker: "verification_target_missing",
    detail: { jobId: "job_hud" },
  });

  const telemetry = buildLanOperatorMeetHudTelemetry(debug);

  assert.equal(telemetry.schema, "oneesama.lan_operator_hud_telemetry.v1");
  assert.equal(telemetry.source, "lan_operator_debug_state");
  assert.deepEqual(telemetry.primaryBlocker, {
    layer: "kwwk",
    event: "kwwk_blocked",
    blocker: "verification_target_missing",
    turnId: "turn_hud",
    responseId: "response_hud",
  });
  assert.equal(telemetry.signals.find((signal) => signal.key === "rt")?.level, "ok");
  assert.equal(telemetry.signals.find((signal) => signal.key === "audio")?.value, "有输入");
  assert.equal(telemetry.signals.find((signal) => signal.key === "tool")?.level, "blocked");
  assert.equal(telemetry.signals.find((signal) => signal.key === "err")?.level, "blocked");
});

test("LAN debug report exposes compact Meet HUD telemetry without Meet dependency", () => {
  const debug = defaultDebugState();
  debug.transport.events.state = "open";
  debug.conversation.status = "connected";
  const report = buildLanOperatorDebugReport(
    buildLanOperatorRuntimeSessionConfig({ sessionId: "lan-hud-report" }),
    [],
    debug,
    "ready",
  );

  assert.equal(report.summaries.meetHudTelemetry.schema, "oneesama.lan_operator_hud_telemetry.v1");
  assert.equal(report.summaries.meetHudTelemetry.source, "lan_operator_debug_state");
  assert.ok(report.summaries.meetHudTelemetry.signals.some((signal) => signal.key === "rt"));
  assert.equal(report.debug.conversation.status, "connected");
});
