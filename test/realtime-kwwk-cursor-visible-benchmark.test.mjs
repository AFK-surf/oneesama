import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { buildKWWKCursorVisibleReport } from "../scripts/realtime-kwwk-cursor-visible-benchmark.mjs";

test("KWWK cursor-visible report proves native foreground cursor and shared-surface mirror", () => {
  const report = buildKWWKCursorVisibleReport({
    ok: true,
    nativeForegroundCursorRequired: true,
    nativeForegroundCursor: nativeCursorEvidence(),
    nativeForegroundCursorDrag: nativeCursorDragEvidence(),
    cursorVisible: true,
    cursorEventsPresent: true,
    coordinateSpacePresent: true,
    dragTrailVisible: true,
    targetRingVisible: true,
    cursorNonBackgroundRatio: 0.08,
    dragTrailNonBackgroundRatio: 0.09,
    targetRingNonBackgroundRatio: 0.07,
    cursorSnapshot: { visible: true, kind: "click", x: 0.18, y: 0.22 },
    cursorArtifact: cursorArtifact(),
    lowValueHudHidden: true,
    lowValueCells: [{ key: "tool", label: "工具", value: "控制" }],
    lowValueText: "工具 控制",
    hiddenKeys: ["rt", "audio", "speak"],
  });

  assert.equal(report.ok, true);
  assert.equal(report.gate, "cursor_visible");
  assert.equal(report.acceptanceGateScope, "cursor_visible");
  assert.equal(report.realAppExecution, false);
  assert.equal(report.meetRoomRequired, false);
  assert.equal(report.evidenceMode, "native_foreground_cursor_and_shared_surface_mirror");
  assert.equal(report.cursor.nativeForeground.evidenceMode, "native_ns_panel");
  assert.equal(
    report.cursor.sharedSurfaceMirror.artifact.events[0].coordinateSpaceId,
    "avatar_shared_surface_normalized",
  );
  const cases = new Map(report.cases.map((testCase) => [testCase.id, testCase]));
  assert.equal(cases.get("native-foreground-cursor-materialized").ok, true);
  assert.equal(cases.get("native-foreground-cursor-drag-materialized").ok, true);
  assert.equal(cases.get("native-foreground-cursor-animation").ok, true);
  assert.equal(cases.get("native-foreground-cursor-animation").dragFrames, 4);
  assert.equal(
    cases.get("native-foreground-cursor-animation").clickPathPlanner,
    "cueboard_action_overlay_bezier",
  );
  assert.equal(
    cases.get("native-foreground-cursor-animation").dragPathPlanner,
    "cueboard_action_overlay_bezier",
  );
  assert.equal(cases.get("cursor-evidence-layer-split").ok, true);
  assert.equal(cases.get("cursor-rendered-marker").markerDetected, true);
  assert.equal(cases.get("cursor-event-coordinate-space").ok, true);
  assert.equal(cases.get("cursor-drag-trail-rendered").ok, true);
  assert.equal(cases.get("cursor-target-ring-rendered").ok, true);
  assert.equal(cases.get("hud-low-value-negative").ok, true);
  assert.equal(
    report.cursor.artifact.events[0].coordinateSpaceId,
    "avatar_shared_surface_normalized",
  );
  assert.equal(report.cursor.artifact.styles.dragTrail, true);
  assert.equal(report.cursor.artifact.styles.targetRing, true);
});

test("KWWK cursor-visible report fails telemetry-only cursor evidence", () => {
  const report = buildKWWKCursorVisibleReport({
    ok: true,
    nativeForegroundCursorRequired: true,
    nativeForegroundCursor: nativeCursorEvidence(),
    nativeForegroundCursorDrag: nativeCursorDragEvidence(),
    cursorVisible: false,
    cursorEventsPresent: true,
    coordinateSpacePresent: true,
    dragTrailVisible: true,
    targetRingVisible: true,
    cursorNonBackgroundRatio: 0,
    dragTrailNonBackgroundRatio: 0.08,
    targetRingNonBackgroundRatio: 0.08,
    cursorSnapshot: { visible: true, kind: "click", x: 0.18, y: 0.22 },
    cursorArtifact: cursorArtifact(),
    lowValueHudHidden: true,
    lowValueCells: [],
    lowValueText: "",
  });

  assert.equal(report.ok, false);
  const cases = new Map(report.cases.map((testCase) => [testCase.id, testCase]));
  assert.equal(cases.get("cursor-rendered-marker").blocker, "cursor_marker_not_rendered");
});

test("KWWK cursor-visible report fails when native drag cursor evidence is missing", () => {
  const report = buildKWWKCursorVisibleReport({
    ok: true,
    nativeForegroundCursorRequired: true,
    nativeForegroundCursor: nativeCursorEvidence(),
    cursorVisible: true,
    cursorEventsPresent: true,
    coordinateSpacePresent: true,
    dragTrailVisible: true,
    targetRingVisible: true,
    cursorNonBackgroundRatio: 0.08,
    dragTrailNonBackgroundRatio: 0.09,
    targetRingNonBackgroundRatio: 0.07,
    cursorSnapshot: { visible: true, kind: "click", x: 0.18, y: 0.22 },
    cursorArtifact: cursorArtifact(),
    lowValueHudHidden: true,
    lowValueCells: [],
    lowValueText: "",
  });

  assert.equal(report.ok, false);
  const cases = new Map(report.cases.map((testCase) => [testCase.id, testCase]));
  assert.equal(
    cases.get("native-foreground-cursor-drag-materialized").blocker,
    "native_foreground_cursor_drag_missing",
  );
  assert.equal(
    cases.get("cursor-evidence-layer-split").blocker,
    "native_foreground_cursor_drag_missing",
  );
});

test("KWWK cursor-visible report fails when native cursor animation evidence is missing", () => {
  const evidence = nativeCursorEvidence();
  delete evidence.animation;
  const report = buildKWWKCursorVisibleReport({
    ok: true,
    nativeForegroundCursorRequired: true,
    nativeForegroundCursor: evidence,
    nativeForegroundCursorDrag: nativeCursorDragEvidence(),
    cursorVisible: true,
    cursorEventsPresent: true,
    coordinateSpacePresent: true,
    dragTrailVisible: true,
    targetRingVisible: true,
    cursorNonBackgroundRatio: 0.08,
    dragTrailNonBackgroundRatio: 0.09,
    targetRingNonBackgroundRatio: 0.07,
    cursorSnapshot: { visible: true, kind: "click", x: 0.18, y: 0.22 },
    cursorArtifact: cursorArtifact(),
    lowValueHudHidden: true,
    lowValueCells: [],
    lowValueText: "",
  });

  assert.equal(report.ok, false);
  const cases = new Map(report.cases.map((testCase) => [testCase.id, testCase]));
  assert.equal(
    cases.get("native-foreground-cursor-animation").blocker,
    "native_foreground_cursor_animation_missing",
  );
  assert.equal(
    cases.get("cursor-evidence-layer-split").blocker,
    "native_foreground_cursor_animation_missing",
  );
});

test("KWWK cursor-visible report fails when native foreground cursor evidence is missing", () => {
  const report = buildKWWKCursorVisibleReport({
    ok: true,
    nativeForegroundCursorRequired: true,
    cursorVisible: true,
    cursorEventsPresent: true,
    coordinateSpacePresent: true,
    dragTrailVisible: true,
    targetRingVisible: true,
    cursorNonBackgroundRatio: 0.08,
    dragTrailNonBackgroundRatio: 0.09,
    targetRingNonBackgroundRatio: 0.07,
    cursorSnapshot: { visible: true, kind: "click", x: 0.18, y: 0.22 },
    cursorArtifact: cursorArtifact(),
    lowValueHudHidden: true,
    lowValueCells: [],
    lowValueText: "",
  });

  assert.equal(report.ok, false);
  const cases = new Map(report.cases.map((testCase) => [testCase.id, testCase]));
  assert.equal(
    cases.get("native-foreground-cursor-materialized").blocker,
    "native_foreground_cursor_missing",
  );
  assert.equal(
    cases.get("cursor-evidence-layer-split").blocker,
    "native_foreground_cursor_missing",
  );
});

function cursorArtifact() {
  return {
    schema: "oneesama.kwwk-cursor-artifact.v1",
    coordinateSpaces: {
      avatar_shared_surface_normalized: {
        id: "avatar_shared_surface_normalized",
        kind: "shared_surface_normalized",
        width: 1,
        height: 1,
        origin: "top_left",
      },
    },
    events: [
      {
        kind: "cursor.click",
        x: 0.18,
        y: 0.22,
        label: "点击",
        at: 123,
        coordinateSpaceId: "avatar_shared_surface_normalized",
      },
      {
        kind: "cursor.highlight",
        x: 0.42,
        y: 0.34,
        label: "目标",
        at: 124,
        coordinateSpaceId: "avatar_shared_surface_normalized",
      },
      {
        kind: "cursor.drag",
        x: 0.56,
        y: 0.5,
        label: "拖拽",
        at: 125,
        coordinateSpaceId: "avatar_shared_surface_normalized",
      },
    ],
    trail: [
      { kind: "cursor.click", x: 0.18, y: 0.22, at: 123 },
      { kind: "cursor.drag", x: 0.56, y: 0.5, at: 125 },
    ],
    styles: {
      persistentCursor: true,
      clickPulse: true,
      dragTrail: true,
      targetRing: true,
      pointerAsset: "inline-bridge-equivalent",
    },
  };
}

function nativeCursorEvidence() {
  return {
    schema: "oneesama.kwwk-native-foreground-cursor.v1",
    source: "cueboard_bridge_computer_use_port",
    evidenceMode: "native_ns_panel",
    materialized: true,
    visible: true,
    windowNumber: 123,
    level: 1002,
    nonActivating: true,
    ignoresMouseEvents: true,
    transparent: true,
    displayAnchor: "foreground",
    displayID: 1,
    screenPoint: { x: 960, y: 540 },
    appKitPoint: { x: 960, y: 540 },
    hotspot: { x: 17 / 101, y: 13 / 101 },
    renderSize: 28,
    kind: "click",
    animation: {
      style: "cueboard_style_ease_in_out",
      approach: {
        enabled: true,
        mode: "approach",
        durationMs: 12,
        stepMs: 4,
        frameCount: 4,
        pathLength: 150,
        startAppKitPoint: { x: 840, y: 450 },
        endAppKitPoint: { x: 960, y: 540 },
        easing: "arc_length_smoothstep",
        pathPlanner: "cueboard_action_overlay_bezier",
        pathPlannerSource: "bridge/cueboard/ActionOverlayBezierPath.swift",
        bezier: bezierPlan(),
      },
      drag: { enabled: false },
    },
  };
}

function nativeCursorDragEvidence() {
  return {
    ...nativeCursorEvidence(),
    kind: "drag",
    screenPointStart: { x: 800, y: 540 },
    appKitPointStart: { x: 800, y: 540 },
    screenPoint: { x: 1120, y: 620 },
    appKitPoint: { x: 1120, y: 460 },
    animation: {
      style: "cueboard_style_ease_in_out",
      approach: {
        enabled: true,
        mode: "approach",
        durationMs: 12,
        stepMs: 4,
        frameCount: 4,
        pathLength: 160,
        startAppKitPoint: { x: 960, y: 540 },
        endAppKitPoint: { x: 800, y: 540 },
        easing: "arc_length_smoothstep",
        pathPlanner: "cueboard_action_overlay_bezier",
        pathPlannerSource: "bridge/cueboard/ActionOverlayBezierPath.swift",
        bezier: bezierPlan(),
      },
      drag: {
        enabled: true,
        mode: "drag",
        durationMs: 12,
        stepMs: 4,
        frameCount: 4,
        pathLength: 329,
        startAppKitPoint: { x: 800, y: 540 },
        endAppKitPoint: { x: 1120, y: 460 },
        easing: "arc_length_smoothstep",
        pathPlanner: "cueboard_action_overlay_bezier",
        pathPlannerSource: "bridge/cueboard/ActionOverlayBezierPath.swift",
        bezier: bezierPlan(),
      },
    },
  };
}

function bezierPlan() {
  return {
    schema: "oneesama.kwwk-cueboard-bezier-plan.v1",
    planner: "cueboard_action_overlay_bezier",
    mode: { kind: "quartic", handleScale: 0.4 },
    controlPointCount: 5,
    controlPoints: [
      { x: 840, y: 450 },
      { x: 900, y: 460 },
      { x: 930, y: 510 },
      { x: 940, y: 530 },
      { x: 960, y: 540 },
    ],
    sampleCount: 121,
    totalLength: 150,
    startHeading: 0.3,
    endHeading: 0.1,
    turning: 0.2,
    turnBound: {
      passed: true,
      sampleCount: 121,
      violations: 0,
      worstRatio: 0.42,
      worstWindow: 9.8,
      maxDegPerPx: 2,
      windowPx: 10,
    },
    candidatePool: {
      total: 9,
      passing: 8,
    },
  };
}
