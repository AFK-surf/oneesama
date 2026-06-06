import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { attachLanAcceptanceSlo } from "../scripts/lan-operator-acceptance-slo.mjs";

const layoutUpdate = {
  schema: "oneesama.operator_visual_layout_update.v1",
  sourceId: "avatar",
  action: "move_resize",
  beforeRect: { x: 0.72, y: 0.54, width: 0.22, height: 0.34 },
  afterRect: { x: 0.58, y: 0.42, width: 0.28, height: 0.38 },
  moved: true,
  resized: true,
  composedTrack: {
    liveBefore: true,
    liveAfter: true,
    trackKindBefore: "video",
    trackKindAfter: "video",
    trackIdStable: true,
  },
  sourceTracks: { hostAppStable: true, avatarStable: true },
};

function visualReport(update = layoutUpdate, visualPatch = {}) {
  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_host_visual_stream",
    ok: true,
    timings: { connectedMs: 700 },
    visual: {
      frameAgeMs: 12,
      frameRate: 30,
      sources: [
        {
          id: "host-app",
          state: "live",
          trackReadyState: "live",
          width: 1280,
          height: 720,
          frameRate: 30,
          frameAgeMs: 12,
        },
        {
          id: "avatar",
          state: "live",
          trackReadyState: "live",
          width: 640,
          height: 360,
          frameRate: 30,
          frameAgeMs: 12,
        },
      ],
      composition: {
        mode: "operator_side",
        localComposedTrack: true,
        trackKind: "video",
        trackReadyState: "live",
        width: 1280,
        height: 720,
        targetFps: 30,
        lastRenderedFrameAgeMs: 9,
        layoutRevision: 1,
        sourceRects: {
          "host-app": { x: 0.04, y: 0.08, width: 0.64, height: 0.78 },
          avatar: { x: 0.58, y: 0.42, width: 0.28, height: 0.38 },
        },
        focusedSourceId: "avatar",
        overlayCount: 1,
      },
      hostSourceMode: "diagnostic_canvas",
      hostCaptureStatus: "live",
      hostDisplayCaptureRequired: false,
      avatarSourceMode: "avatar_renderer",
      avatarRenderer: "fallback",
      overlayVisible: true,
      operatorScreenBackflow: false,
      layoutUpdate: update,
      ...visualPatch,
    },
  };
}

test("LAN host visual SLO rejects layout revision without real move/resize evidence", () => {
  const report = attachLanAcceptanceSlo(
    visualReport({ ...layoutUpdate, moved: false, resized: false }),
  );
  const entry = report.slo.entries.find(
    (item) => item.id === "operator_visual_layout_update_observed",
  );

  assert.equal(report.ok, false);
  assert.equal(entry.actual, 0);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "operator_visual_layout_update_observed"),
    JSON.stringify(report.slo),
  );
});

test("LAN host visual display SLO requires live display-capture status", () => {
  const report = attachLanAcceptanceSlo(
    visualReport(layoutUpdate, {
      hostSourceMode: "display_capture",
      hostDisplayCaptureRequired: true,
      hostCaptureStatus: "failed",
      hostCaptureError: "NotAllowedError: Permission denied",
    }),
  );
  const entry = report.slo.entries.find(
    (item) => item.id === "host_visual_display_capture_source_observed",
  );

  assert.equal(report.ok, false);
  assert.equal(entry.actual, 0);
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "host_visual_display_capture_source_observed",
    ),
    JSON.stringify(report.slo),
  );
});
