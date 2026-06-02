import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vite-plus/test";

import { buildKWWKNativeCursorReport } from "../scripts/realtime-kwwk-native-cursor-benchmark.mjs";

test("KWWK native cursor report distinguishes foreground panel evidence from shared-surface mirror evidence", () => {
  const report = buildKWWKNativeCursorReport(
    { timeoutMs: 15_000 },
    {
      ok: true,
      exitCode: 0,
      durationMs: 12,
      result: {
        ok: true,
        nativeForegroundCursor: nativeEvidence(),
      },
      renderResult: {
        ok: true,
        nativeCursorRender: renderEvidence(),
      },
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.gate, "native_foreground_cursor");
  assert.equal(report.acceptanceGateScope, "cursor_visible");
  assert.equal(report.evidenceMode, "native_ns_panel_probe_and_native_view_rendered_png_pixels");
  assert.equal(report.sharedSurfaceMirrorEvidence, false);
  assert.equal(report.realAppExecution, false);
  const cases = new Map(report.cases.map((testCase) => [testCase.id, testCase]));
  assert.equal(cases.get("native-foreground-cursor-materialized").materialized, true);
  assert.equal(cases.get("native-foreground-cursor-panel-contract").nonActivating, true);
  assert.equal(cases.get("native-foreground-cursor-panel-contract").ignoresMouseEvents, true);
  assert.equal(cases.get("native-foreground-cursor-panel-contract").transparent, true);
  assert.equal(cases.get("native-foreground-cursor-cueboard-geometry").renderSize, 28);
  assert.equal(cases.get("native-foreground-cursor-cueboard-bezier-planner").ok, true);
  assert.equal(
    cases.get("native-foreground-cursor-cueboard-bezier-planner").pathPlanner,
    "cueboard_action_overlay_bezier",
  );
  assert.equal(cases.get("native-foreground-cursor-light-dark-rendered").ok, true);
  assert.equal(cases.get("native-foreground-cursor-light-dark-rendered").lightRatio > 0.02, true);
  assert.equal(cases.get("native-foreground-drag-trail-rendered").ok, true);
  assert.equal(cases.get("native-foreground-drag-trail-rendered").trailPointCount, 4);
  assert.equal(report.nativeForegroundCursor.source, "cueboard_bridge_computer_use_port");
  assert.equal(report.nativeCursorRender.evidenceMode, "native_view_rendered_png_pixels");
});

test("KWWK native cursor report fails mirror-only evidence", () => {
  const report = buildKWWKNativeCursorReport(
    { timeoutMs: 15_000 },
    {
      ok: true,
      exitCode: 0,
      durationMs: 12,
      result: {
        ok: true,
        nativeForegroundCursor: {
          schema: "oneesama.kwwk-cursor-artifact.v1",
          materialized: false,
        },
      },
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.cases[0].blocker, "native_foreground_cursor_not_materialized");
});

test("KWWK native cursor report fails without light/dark render evidence", () => {
  const report = buildKWWKNativeCursorReport(
    { timeoutMs: 15_000 },
    {
      ok: true,
      exitCode: 0,
      durationMs: 12,
      result: {
        ok: true,
        nativeForegroundCursor: nativeEvidence(),
      },
      renderResult: {
        ok: true,
        nativeCursorRender: {},
      },
    },
  );

  assert.equal(report.ok, false);
  const cases = new Map(report.cases.map((testCase) => [testCase.id, testCase]));
  assert.equal(
    cases.get("native-foreground-cursor-light-dark-rendered").blocker,
    "native_cursor_light_dark_render_missing",
  );
  assert.equal(
    cases.get("native-foreground-drag-trail-rendered").blocker,
    "native_cursor_drag_trail_render_missing",
  );
});

test(
  "KWWK native cursor benchmark probes the helper foreground panel on macOS",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneesama-kwwk-native-cursor-test-"));
    const jsonOut = join(dir, "report.json");
    try {
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/realtime-kwwk-native-cursor-benchmark.mjs",
          "--json-out",
          jsonOut,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, ONEESAMA_APP_CONTROL_HELPER: join(dir, "helper") },
        },
      );
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const report = JSON.parse(await readFile(jsonOut, "utf8"));
      assert.equal(report.ok, true);
      assert.equal(report.gate, "native_foreground_cursor");
      assert.equal(report.nativeForegroundCursor.materialized, true);
      assert.equal(report.nativeForegroundCursor.visible, true);
      assert.equal(report.nativeForegroundCursor.nonActivating, true);
      assert.equal(report.nativeForegroundCursor.ignoresMouseEvents, true);
      assert.equal(report.nativeForegroundCursor.transparent, true);
      assert.equal(report.nativeCursorRender.schema, "oneesama.kwwk-native-cursor-render.v1");
      assert.equal(
        report.cases.find(
          (testCase) => testCase.id === "native-foreground-cursor-light-dark-rendered",
        ).ok,
        true,
      );
      assert.equal(
        report.cases.find((testCase) => testCase.id === "native-foreground-drag-trail-rendered").ok,
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

function nativeEvidence() {
  return {
    schema: "oneesama.kwwk-native-foreground-cursor.v1",
    source: "cueboard_bridge_computer_use_port",
    evidenceMode: "native_ns_panel",
    materialized: true,
    visible: true,
    windowNumber: 9001,
    level: 2147483631,
    nonActivating: true,
    ignoresMouseEvents: true,
    transparent: true,
    displayAnchor: "foreground",
    displayID: 1,
    screenPoint: { x: 640, y: 360 },
    appKitPoint: { x: 640, y: 540 },
    hotspot: { x: 17 / 101, y: 13 / 101 },
    renderSize: 28,
    kind: "click",
    label: "native cursor probe",
    animation: {
      style: "cueboard_style_ease_in_out",
      approach: {
        enabled: true,
        mode: "approach",
        durationMs: 230,
        stepMs: 12,
        frameCount: 21,
        pathLength: 150,
        startAppKitPoint: { x: 520, y: 450 },
        endAppKitPoint: { x: 640, y: 540 },
        easing: "arc_length_smoothstep",
        pathPlanner: "cueboard_action_overlay_bezier",
        pathPlannerSource: "bridge/cueboard/ActionOverlayBezierPath.swift",
        bezier: bezierPlan(),
      },
      drag: { enabled: false },
    },
    at: 1780380000000,
  };
}

function bezierPlan() {
  return {
    schema: "oneesama.kwwk-cueboard-bezier-plan.v1",
    planner: "cueboard_action_overlay_bezier",
    mode: { kind: "quartic", handleScale: 0.4 },
    controlPointCount: 5,
    controlPoints: [
      { x: 520, y: 450 },
      { x: 570, y: 470 },
      { x: 600, y: 500 },
      { x: 620, y: 530 },
      { x: 640, y: 540 },
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

function renderEvidence() {
  return {
    schema: "oneesama.kwwk-native-cursor-render.v1",
    evidenceMode: "native_view_rendered_png_pixels",
    outputDir: "/tmp/native-cursor-render",
    light: {
      kind: "click",
      outputPath: "/tmp/native-cursor-render/native-cursor-light.png",
      width: 240,
      height: 240,
      nonBackgroundRatio: 0.034,
      trailPointCount: 0,
    },
    dark: {
      kind: "click",
      outputPath: "/tmp/native-cursor-render/native-cursor-dark.png",
      width: 240,
      height: 240,
      nonBackgroundRatio: 0.037,
      trailPointCount: 0,
    },
    dragTrail: {
      kind: "drag",
      outputPath: "/tmp/native-cursor-render/native-cursor-drag-trail.png",
      width: 240,
      height: 240,
      nonBackgroundRatio: 0.055,
      trailPointCount: 4,
    },
  };
}
