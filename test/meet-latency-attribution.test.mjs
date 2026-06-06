import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { buildMeetLatencyAttributionReport } from "../scripts/meet-latency-attribution.mjs";

function entry(id, value, unit = "ms") {
  return {
    id,
    unit,
    required: true,
    ok: true,
    p50: value,
    p95: value,
    max: value,
  };
}

function lanSuiteReport() {
  return {
    schema: "oneesama.lan_slo_suite.v1",
    ok: true,
    generatedAt: "2026-06-06T00:00:00.000Z",
    reports: [
      {
        gate: "lan_voice_loop",
        perceivedUx: { ok: true, firstFeedbackMs: 40 },
      },
    ],
    gates: {
      lan_voice_loop: {
        entries: [entry("turn_heard_to_assistant_output_ms", 180)],
      },
      lan_kwwk_action: {
        entries: [
          entry("kwwk_visible_feedback_after_tool_ms", 30),
          entry("warm_simple_app_action_verified_ms", 220),
          entry("cold_simple_app_action_verified_ms", 700),
        ],
      },
    },
  };
}

function meetCompatReport(input = {}) {
  return {
    gate: "meet_compat",
    acceptanceLane: "meet_compat_secondary",
    ok: true,
    acceptanceSatisfied: true,
    gates: {
      syntheticSpeaker: { acceptanceSatisfied: true },
      appControl: {
        acceptanceSatisfied: true,
        liveModelFirstLatency: {
          warmP95Ms: 1120,
          warmSloMs: 2500,
          measuredSampleCount: 2,
          sampleCount: 2,
        },
      },
    },
    ...input,
  };
}

test("Meet latency attribution compares Meet app-control latency against LAN warm baseline", () => {
  const report = buildMeetLatencyAttributionReport({
    lanReport: lanSuiteReport(),
    meetReport: meetCompatReport(),
  });

  assert.equal(report.ok, true);
  assert.equal(report.acceptanceSatisfied, true);
  assert.equal(report.lanBaseline.kwwk.warmActionVerifiedP95Ms, 220);
  assert.equal(report.meetEvidence.appControlWarmP95Ms, 1120);
  assert.equal(report.comparisons.appControl.overheadMs, 900);
  assert.equal(report.comparisons.appControl.attribution, "meet_adapter_overhead_within_budget");
});

test("Meet latency attribution fails strict evidence when Meet report is missing", () => {
  const report = buildMeetLatencyAttributionReport({
    lanReport: lanSuiteReport(),
    meetReport: null,
    meetReportPresent: false,
  });

  assert.equal(report.ok, false);
  assert.equal(report.acceptanceSatisfied, false);
  assert.equal(report.blocker, "missing_meet_report");
  assert.equal(report.meetEvidence.present, false);
});

test("Meet latency attribution carries Meet blocker source into the comparison artifact", () => {
  const report = buildMeetLatencyAttributionReport({
    lanReport: lanSuiteReport(),
    meetReport: meetCompatReport({
      ok: false,
      acceptanceSatisfied: false,
      blocker: "real_meet_room_admission_required",
      blockerSource: "real_meet_admission",
      gates: {
        syntheticSpeaker: { acceptanceSatisfied: false },
        appControl: { acceptanceSatisfied: false },
      },
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.blocker, "real_meet_admission");
  assert.equal(report.meetEvidence.blocker, "real_meet_room_admission_required");
  assert.equal(report.comparisons.appControl.measured, false);
});
