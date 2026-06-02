#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = { jsonOut: "", timeoutMs: 15_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json-out") args.jsonOut = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 15_000;
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/realtime-kwwk-native-cursor-benchmark.mjs [options]

Options:
  --timeout-ms <n>      Overall benchmark timeout (default: 15000)
  --json-out <path>     Write structured report
`);
}

function nativeEvidence(result) {
  return result?.nativeForegroundCursor || {};
}

function renderEvidence(result) {
  return result?.nativeCursorRender || {};
}

function nativeBezierPlanOk(animation) {
  const bezier = animation?.bezier || {};
  return (
    animation?.easing === "arc_length_smoothstep" &&
    animation?.pathPlanner === "cueboard_action_overlay_bezier" &&
    bezier.schema === "oneesama.kwwk-cueboard-bezier-plan.v1" &&
    bezier.planner === "cueboard_action_overlay_bezier" &&
    Number(bezier.controlPointCount || 0) === 5 &&
    Number(bezier.sampleCount || 0) >= 2 &&
    bezier.turnBound?.passed === true &&
    Number(bezier.candidatePool?.total || 0) > 0
  );
}

export function buildKWWKNativeCursorReport(args, runResult) {
  const evidence = nativeEvidence(runResult.result);
  const render = renderEvidence(runResult.renderResult);
  const approach = evidence.animation?.approach || {};
  const cases = [
    {
      id: "native-foreground-cursor-materialized",
      ok:
        evidence.schema === "oneesama.kwwk-native-foreground-cursor.v1" &&
        evidence.materialized === true &&
        evidence.visible === true &&
        Number(evidence.windowNumber || 0) > 0,
      materialized: evidence.materialized === true,
      visible: evidence.visible === true,
      windowNumber: Number(evidence.windowNumber || 0),
      blocker:
        evidence.materialized === true && evidence.visible === true
          ? ""
          : "native_foreground_cursor_not_materialized",
    },
    {
      id: "native-foreground-cursor-panel-contract",
      ok:
        evidence.nonActivating === true &&
        evidence.ignoresMouseEvents === true &&
        evidence.transparent === true &&
        evidence.displayAnchor === "foreground",
      nonActivating: evidence.nonActivating === true,
      ignoresMouseEvents: evidence.ignoresMouseEvents === true,
      transparent: evidence.transparent === true,
      displayAnchor: evidence.displayAnchor || "",
      blocker:
        evidence.nonActivating === true &&
        evidence.ignoresMouseEvents === true &&
        evidence.transparent === true
          ? ""
          : "native_foreground_cursor_panel_contract_failed",
    },
    {
      id: "native-foreground-cursor-cueboard-geometry",
      ok:
        Number(evidence.renderSize || 0) === 28 &&
        Number(evidence.hotspot?.x || 0) > 0 &&
        Number(evidence.hotspot?.y || 0) > 0 &&
        evidence.source === "cueboard_bridge_computer_use_port",
      renderSize: Number(evidence.renderSize || 0),
      hotspot: evidence.hotspot || {},
      source: evidence.source || "",
      blocker:
        Number(evidence.renderSize || 0) === 28 ? "" : "native_foreground_cursor_geometry_mismatch",
    },
    {
      id: "native-foreground-cursor-cueboard-bezier-planner",
      ok: nativeBezierPlanOk(approach),
      pathPlanner: approach.pathPlanner || "",
      easing: approach.easing || "",
      bezierMode: approach.bezier?.mode?.kind || "",
      controlPointCount: Number(approach.bezier?.controlPointCount || 0),
      sampleCount: Number(approach.bezier?.sampleCount || 0),
      turnBoundPassed: approach.bezier?.turnBound?.passed === true,
      candidatePoolTotal: Number(approach.bezier?.candidatePool?.total || 0),
      blocker: nativeBezierPlanOk(approach)
        ? ""
        : "native_foreground_cursor_bezier_planner_missing",
    },
    {
      id: "native-foreground-cursor-light-dark-rendered",
      ok:
        render.schema === "oneesama.kwwk-native-cursor-render.v1" &&
        Number(render.light?.nonBackgroundRatio || 0) > 0.02 &&
        Number(render.dark?.nonBackgroundRatio || 0) > 0.02,
      lightRatio: Number(render.light?.nonBackgroundRatio || 0),
      darkRatio: Number(render.dark?.nonBackgroundRatio || 0),
      lightOutputPath: render.light?.outputPath || "",
      darkOutputPath: render.dark?.outputPath || "",
      blocker:
        Number(render.light?.nonBackgroundRatio || 0) > 0.02 &&
        Number(render.dark?.nonBackgroundRatio || 0) > 0.02
          ? ""
          : "native_cursor_light_dark_render_missing",
    },
    {
      id: "native-foreground-drag-trail-rendered",
      ok:
        render.schema === "oneesama.kwwk-native-cursor-render.v1" &&
        Number(render.dragTrail?.nonBackgroundRatio || 0) > 0.035 &&
        Number(render.dragTrail?.trailPointCount || 0) >= 2,
      dragTrailRatio: Number(render.dragTrail?.nonBackgroundRatio || 0),
      trailPointCount: Number(render.dragTrail?.trailPointCount || 0),
      outputPath: render.dragTrail?.outputPath || "",
      blocker:
        Number(render.dragTrail?.nonBackgroundRatio || 0) > 0.035 &&
        Number(render.dragTrail?.trailPointCount || 0) >= 2
          ? ""
          : "native_cursor_drag_trail_render_missing",
    },
  ];
  return {
    schema: "oneesama.kwwk-native-cursor-report.v1",
    gate: "native_foreground_cursor",
    ok: runResult.ok === true && cases.every((testCase) => testCase.ok),
    generatedAt: new Date().toISOString(),
    evidenceMode: "native_ns_panel_probe_and_native_view_rendered_png_pixels",
    acceptanceGateScope: "cursor_visible",
    meetRoomRequired: false,
    realAppExecution: false,
    sharedSurfaceMirrorEvidence: false,
    timeoutMs: args.timeoutMs,
    durationMs: runResult.durationMs,
    environment: {
      platform: process.platform,
      helper: "oneesama_app_control_helper",
    },
    nativeForegroundCursor: evidence,
    nativeCursorRender: render,
    cases,
    exitCode: runResult.exitCode,
    timedOut: runResult.timedOut === true,
    error: runResult.error || "",
  };
}

export async function runKWWKNativeCursorBenchmark(args) {
  const started = performance.now();
  if (process.platform !== "darwin") {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      error: "native_cursor_requires_darwin",
      durationMs: Math.round(performance.now() - started),
      result: {},
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "oneesama-kwwk-native-cursor-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "packages/core/src/meeting/app-control-helper.ts", "--stdio"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ONEESAMA_APP_CONTROL_HELPER: join(dir, "helper") },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), args.timeoutMs);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "native-cursor",
      method: "app_control.native_cursor_overlay_probe",
      params: { kind: "click", label: "native cursor probe" },
    })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "native-cursor-render",
      method: "app_control.native_cursor_render_probe",
      params: {},
    })}\n`,
  );
  child.stdin.end();
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const responses = stdout
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const byId = new Map(responses.map((response) => [response.id, response]));
  const response = byId.get("native-cursor") || {};
  const renderResponse = byId.get("native-cursor-render") || {};
  return {
    ok: exit.code === 0 && response?.result?.ok === true && renderResponse?.result?.ok === true,
    exitCode: exit.code,
    signal: exit.signal || "",
    timedOut: exit.signal === "SIGTERM",
    error: exit.code === 0 ? "" : stderr.trim() || "helper_failed",
    durationMs: Math.round(performance.now() - started),
    result: response.result || {},
    renderResult: renderResponse.result || {},
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runResult = await runKWWKNativeCursorBenchmark(args);
  const report = buildKWWKNativeCursorReport(args, runResult);
  if (args.jsonOut) {
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `KWWK native cursor benchmark: ${report.ok ? "PASS" : "FAIL"} cases=${report.cases
      .map((testCase) => `${testCase.id}:${testCase.ok ? "pass" : "fail"}`)
      .join(",")}`,
  );
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`realtime-kwwk-native-cursor-benchmark failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
