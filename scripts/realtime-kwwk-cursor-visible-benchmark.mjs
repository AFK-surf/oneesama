#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createAvatarPlaygroundServer } from "../packages/core/src/avatar-runtime/avatar-playground.ts";

function parseArgs(argv) {
  const args = { jsonOut: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json-out") args.jsonOut = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/realtime-kwwk-cursor-visible-benchmark.mjs [options]

Options:
  --json-out <path>     Write structured report
`);
}

function nativeForegroundCursorMaterialized(evidence) {
  return (
    evidence?.schema === "oneesama.kwwk-native-foreground-cursor.v1" &&
    evidence?.source === "cueboard_bridge_computer_use_port" &&
    evidence?.evidenceMode === "native_ns_panel" &&
    evidence?.materialized === true &&
    evidence?.visible === true &&
    evidence?.nonActivating === true &&
    evidence?.ignoresMouseEvents === true &&
    evidence?.transparent === true &&
    Number(evidence?.windowNumber || 0) > 0
  );
}

function nativeCursorAnimated(evidence, mode) {
  const animation = evidence?.animation?.[mode] || {};
  const bezier = animation.bezier || {};
  return (
    animation.enabled === true &&
    Number(animation.frameCount || 0) >= 2 &&
    Number(animation.pathLength || 0) > 0 &&
    typeof animation.startAppKitPoint?.x === "number" &&
    typeof animation.endAppKitPoint?.x === "number" &&
    animation.easing === "arc_length_smoothstep" &&
    animation.pathPlanner === "cueboard_action_overlay_bezier" &&
    bezier.schema === "oneesama.kwwk-cueboard-bezier-plan.v1" &&
    bezier.planner === "cueboard_action_overlay_bezier" &&
    Number(bezier.controlPointCount || 0) === 5 &&
    Number(bezier.sampleCount || 0) >= 2 &&
    bezier.turnBound?.passed === true &&
    Number(bezier.candidatePool?.total || 0) > 0
  );
}

export function buildKWWKCursorVisibleReport(result) {
  const nativeRequired = result.nativeForegroundCursorRequired !== false;
  const nativeSkipped = result.nativeForegroundCursorSkipped === true || nativeRequired === false;
  const nativeEvidence = result.nativeForegroundCursor || {};
  const nativeDragEvidence = result.nativeForegroundCursorDrag || {};
  const nativeMaterialized = nativeSkipped || nativeForegroundCursorMaterialized(nativeEvidence);
  const nativeDragMaterialized =
    nativeSkipped || nativeForegroundCursorMaterialized(nativeDragEvidence);
  const nativeAnimationOk =
    nativeSkipped ||
    (nativeCursorAnimated(nativeEvidence, "approach") &&
      nativeCursorAnimated(nativeDragEvidence, "approach") &&
      nativeCursorAnimated(nativeDragEvidence, "drag"));
  const sharedSurfaceMirrorPresent =
    result.cursorVisible === true &&
    result.cursorArtifact?.schema === "oneesama.kwwk-cursor-artifact.v1";
  const cases = [
    {
      id: "native-foreground-cursor-materialized",
      ok: nativeMaterialized,
      required: nativeRequired,
      skipped: nativeSkipped,
      evidenceMode: nativeSkipped ? "skipped" : nativeEvidence.evidenceMode || "",
      source: nativeEvidence.source || "",
      windowNumber: nativeEvidence.windowNumber || 0,
      blocker: nativeMaterialized
        ? ""
        : result.nativeForegroundCursorError || "native_foreground_cursor_missing",
    },
    {
      id: "native-foreground-cursor-drag-materialized",
      ok: nativeDragMaterialized,
      required: nativeRequired,
      skipped: nativeSkipped,
      evidenceMode: nativeSkipped ? "skipped" : nativeDragEvidence.evidenceMode || "",
      source: nativeDragEvidence.source || "",
      windowNumber: nativeDragEvidence.windowNumber || 0,
      blocker: nativeDragMaterialized ? "" : "native_foreground_cursor_drag_missing",
    },
    {
      id: "native-foreground-cursor-animation",
      ok: nativeAnimationOk,
      required: nativeRequired,
      skipped: nativeSkipped,
      clickApproachFrames: nativeEvidence.animation?.approach?.frameCount || 0,
      dragApproachFrames: nativeDragEvidence.animation?.approach?.frameCount || 0,
      dragFrames: nativeDragEvidence.animation?.drag?.frameCount || 0,
      clickPathPlanner: nativeEvidence.animation?.approach?.pathPlanner || "",
      dragPathPlanner: nativeDragEvidence.animation?.drag?.pathPlanner || "",
      clickBezierMode: nativeEvidence.animation?.approach?.bezier?.mode?.kind || "",
      dragBezierMode: nativeDragEvidence.animation?.drag?.bezier?.mode?.kind || "",
      blocker: nativeAnimationOk ? "" : "native_foreground_cursor_animation_missing",
    },
    {
      id: "cursor-evidence-layer-split",
      ok:
        nativeMaterialized &&
        nativeDragMaterialized &&
        nativeAnimationOk &&
        sharedSurfaceMirrorPresent,
      evidenceModes: [
        nativeSkipped ? "native_foreground_cursor_skipped" : "native_foreground_cursor",
        "shared_surface_cursor_mirror",
      ],
      nativeEvidenceMode: nativeEvidence.evidenceMode || "",
      sharedSurfaceMirrorPresent,
      blocker:
        nativeMaterialized &&
        nativeDragMaterialized &&
        nativeAnimationOk &&
        sharedSurfaceMirrorPresent
          ? ""
          : !nativeMaterialized
            ? "native_foreground_cursor_missing"
            : !nativeDragMaterialized
              ? "native_foreground_cursor_drag_missing"
              : !nativeAnimationOk
                ? "native_foreground_cursor_animation_missing"
                : "shared_surface_cursor_mirror_missing",
    },
    {
      id: "cursor-rendered-marker",
      ok: result.cursorVisible === true,
      markerDetected: result.cursorVisible === true,
      cursorNonBackgroundRatio: result.cursorNonBackgroundRatio,
      blocker: result.cursorVisible === true ? "" : "cursor_marker_not_rendered",
    },
    {
      id: "cursor-event-coordinate-space",
      ok: result.cursorEventsPresent === true && result.coordinateSpacePresent === true,
      eventCount: result.cursorArtifact?.events?.length || 0,
      coordinateSpaceIds: Object.keys(result.cursorArtifact?.coordinateSpaces || {}),
      blocker:
        result.cursorEventsPresent === true && result.coordinateSpacePresent === true
          ? ""
          : "cursor_event_coordinate_space_missing",
    },
    {
      id: "cursor-drag-trail-rendered",
      ok: result.dragTrailVisible === true,
      dragEventCount:
        result.cursorArtifact?.events?.filter?.((event) => event.kind === "cursor.drag")?.length ||
        0,
      trailPointCount: result.cursorArtifact?.trail?.length || 0,
      cursorNonBackgroundRatio: result.dragTrailNonBackgroundRatio,
      blocker: result.dragTrailVisible === true ? "" : "cursor_drag_trail_not_rendered",
    },
    {
      id: "cursor-target-ring-rendered",
      ok: result.targetRingVisible === true,
      highlightEventCount:
        result.cursorArtifact?.events?.filter?.((event) => event.kind === "cursor.highlight")
          ?.length || 0,
      cursorNonBackgroundRatio: result.targetRingNonBackgroundRatio,
      blocker: result.targetRingVisible === true ? "" : "cursor_target_ring_not_rendered",
    },
    {
      id: "hud-low-value-negative",
      ok: result.lowValueHudHidden === true,
      hiddenKeys: result.hiddenKeys || [],
      blocker: result.lowValueHudHidden === true ? "" : "low_value_hud_state_visible",
    },
  ];
  return {
    schema: "oneesama.kwwk-cursor-visible-report.v1",
    gate: "cursor_visible",
    ok: result.ok === true && cases.every((testCase) => testCase.ok),
    generatedAt: new Date().toISOString(),
    evidenceMode: "native_foreground_cursor_and_shared_surface_mirror",
    acceptanceGateScope: "cursor_visible",
    meetRoomRequired: false,
    realAppExecution: false,
    nativeHelperExecution: nativeRequired,
    environment: {
      platform: process.platform,
      browser: "chromium",
    },
    cursor: {
      snapshot: result.cursorSnapshot || {},
      artifact: result.cursorArtifact || {},
      renderedFrameMetric: {
        nonBackgroundRatio: result.cursorNonBackgroundRatio,
        dragTrailNonBackgroundRatio: result.dragTrailNonBackgroundRatio,
        targetRingNonBackgroundRatio: result.targetRingNonBackgroundRatio,
      },
      nativeForeground: nativeEvidence,
      nativeForegroundDrag: nativeDragEvidence,
      sharedSurfaceMirror: {
        snapshot: result.cursorSnapshot || {},
        artifact: result.cursorArtifact || {},
        renderedFrameMetric: {
          nonBackgroundRatio: result.cursorNonBackgroundRatio,
          dragTrailNonBackgroundRatio: result.dragTrailNonBackgroundRatio,
          targetRingNonBackgroundRatio: result.targetRingNonBackgroundRatio,
        },
      },
    },
    hud: {
      lowValueText: result.lowValueText || "",
      visibleCells: result.lowValueCells || [],
    },
    cases,
    error: result.error || "",
  };
}

export async function runNativeForegroundCursorProbe() {
  if (process.platform !== "darwin") {
    return {
      nativeForegroundCursorRequired: false,
      nativeForegroundCursorSkipped: true,
      nativeForegroundCursorError: "non_darwin",
    };
  }

  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "packages/core/src/meeting/app-control-helper.ts", "--stdio"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ONEESAMA_KWWK_CURSOR_BOOTSTRAP_MS: process.env.ONEESAMA_KWWK_CURSOR_BOOTSTRAP_MS || "1",
        ONEESAMA_KWWK_CURSOR_PRE_MS: process.env.ONEESAMA_KWWK_CURSOR_PRE_MS || "1",
        ONEESAMA_KWWK_CURSOR_HOLD_MS: process.env.ONEESAMA_KWWK_CURSOR_HOLD_MS || "1",
        ONEESAMA_KWWK_CURSOR_DWELL_MS: process.env.ONEESAMA_KWWK_CURSOR_DWELL_MS || "1",
        ONEESAMA_KWWK_CURSOR_APPROACH_MS: process.env.ONEESAMA_KWWK_CURSOR_APPROACH_MS || "12",
        ONEESAMA_KWWK_CURSOR_APPROACH_STEP_MS:
          process.env.ONEESAMA_KWWK_CURSOR_APPROACH_STEP_MS || "4",
        ONEESAMA_KWWK_CURSOR_DRAG_MS: process.env.ONEESAMA_KWWK_CURSOR_DRAG_MS || "12",
        ONEESAMA_KWWK_CURSOR_DRAG_STEP_MS: process.env.ONEESAMA_KWWK_CURSOR_DRAG_STEP_MS || "4",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const request = {
    jsonrpc: "2.0",
    id: "native-cursor-probe",
    method: "app_control.native_cursor_overlay_probe",
    params: { kind: "click", label: "cursor-visible-gate" },
  };
  const dragRequest = {
    jsonrpc: "2.0",
    id: "native-cursor-drag-probe",
    method: "app_control.native_cursor_overlay_probe",
    params: { kind: "drag", label: "cursor-visible-gate" },
  };

  child.stdin.end(`${JSON.stringify(request)}\n${JSON.stringify(dragRequest)}\n`);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 5000);

  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);

  if (timedOut) {
    return {
      nativeForegroundCursorRequired: true,
      nativeForegroundCursorError: "native_cursor_probe_timeout",
    };
  }
  if (exit.code !== 0) {
    return {
      nativeForegroundCursorRequired: true,
      nativeForegroundCursorError: `native_cursor_probe_exit:${exit.code ?? exit.signal ?? "unknown"}:${stderr
        .join("")
        .trim()}`,
    };
  }

  const lines = stdout.join("").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return {
      nativeForegroundCursorRequired: true,
      nativeForegroundCursorError: "native_cursor_probe_no_stdout",
    };
  }

  try {
    const responses = lines.map((line) => JSON.parse(line));
    const byId = new Map(responses.map((response) => [response.id, response]));
    const response = byId.get("native-cursor-probe");
    const dragResponse = byId.get("native-cursor-drag-probe");
    if (response?.error || dragResponse?.error) {
      return {
        nativeForegroundCursorRequired: true,
        nativeForegroundCursorError: `native_cursor_probe_error:${
          response?.error?.message || dragResponse?.error?.message || "unknown"
        }`,
      };
    }
    const nativeForegroundCursor = response?.result?.nativeForegroundCursor || {};
    const nativeForegroundCursorDrag = dragResponse?.result?.nativeForegroundCursor || {};
    return {
      nativeForegroundCursorRequired: true,
      nativeForegroundCursorPresent:
        nativeForegroundCursorMaterialized(nativeForegroundCursor) &&
        nativeForegroundCursorMaterialized(nativeForegroundCursorDrag),
      nativeForegroundCursor,
      nativeForegroundCursorDrag,
    };
  } catch (error) {
    return {
      nativeForegroundCursorRequired: true,
      nativeForegroundCursorError: `native_cursor_probe_parse_failed:${error?.message || error}`,
    };
  }
}

export async function runKWWKCursorVisibleBenchmark() {
  const nativeProbe = await runNativeForegroundCursorProbe();
  const playground = createAvatarPlaygroundServer({ port: 0, botName: "Cursor Visible Gate" });
  const started = await playground.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    const page = await context.newPage();
    await page.goto(`${started.url}?avatar=fallback-canvas`);
    await page.waitForFunction(() => window.MAB_AVATAR_PLAYGROUND?.state?.ready === true, null, {
      timeout: 10_000,
    });
    const lowValueCells = await page.evaluate(() => {
      window.MAB_AVATAR_CONTROLLER?.updateState?.({
        status_kind: "idle",
        status_text: "",
        status_hold_ms: 0,
      });
      window.MAB_REALTIME_BRIDGE = {
        connected: false,
        connection: {
          peerConnectionState: "connecting",
          dataChannelReadyState: "connecting",
          currentRealtimeInputSource: "",
          responseEvents: 0,
        },
        feedback: {
          failureMatrix: {
            transport: { status: "waiting", reason: "connecting" },
            audioInput: { status: "waiting", reason: "input_audio_not_configured" },
          },
        },
      };
      return window.MAB_AVATAR_HUD_VISIBLE_CELLS();
    });
    const lowValueText = lowValueCells.map((cell) => `${cell.label} ${cell.value}`).join("\n");
    const cursorSnapshot = await page.evaluate(() =>
      window.MAB_KWWK_CURSOR_FEEDBACK({
        x: 0.18,
        y: 0.22,
        kind: "click",
        label: "点击",
        holdMs: 5000,
      }),
    );
    const cursorRender = await page.evaluate(() =>
      window.MAB_AVATAR_VISUAL_TEST.renderSnapshot({
        label: "cursor-visible-gate",
        statusKind: "idle",
        statusText: "",
      }),
    );
    const targetSnapshot = await page.evaluate(() =>
      window.MAB_KWWK_CURSOR_FEEDBACK({
        x: 0.42,
        y: 0.34,
        kind: "target",
        label: "目标",
        holdMs: 5000,
      }),
    );
    const targetRender = await page.evaluate(() =>
      window.MAB_AVATAR_VISUAL_TEST.renderSnapshot({
        label: "cursor-target-ring-gate",
        statusKind: "idle",
        statusText: "",
      }),
    );
    const dragSnapshot = await page.evaluate(() => {
      window.MAB_KWWK_CURSOR_FEEDBACK({
        x: 0.44,
        y: 0.38,
        kind: "drag",
        label: "拖拽",
        holdMs: 5000,
      });
      window.MAB_KWWK_CURSOR_FEEDBACK({
        x: 0.56,
        y: 0.5,
        kind: "drag",
        label: "拖拽",
        holdMs: 5000,
      });
      return window.MAB_KWWK_CURSOR_FEEDBACK({
        x: 0.68,
        y: 0.52,
        kind: "drag",
        label: "拖拽",
        holdMs: 5000,
      });
    });
    const dragRender = await page.evaluate(() =>
      window.MAB_AVATAR_VISUAL_TEST.renderSnapshot({
        label: "cursor-drag-trail-gate",
        statusKind: "idle",
        statusText: "",
      }),
    );
    const cursorArtifact = await page.evaluate(() => window.MAB_KWWK_CURSOR_ARTIFACT());
    const cursorNonBackgroundRatio = Number(cursorRender?.cursor?.nonBackgroundRatio || 0);
    const targetRingNonBackgroundRatio = Number(targetRender?.cursor?.nonBackgroundRatio || 0);
    const dragTrailNonBackgroundRatio = Number(dragRender?.cursor?.nonBackgroundRatio || 0);
    const coordinateSpaceIds = Object.keys(cursorArtifact?.coordinateSpaces || {});
    const eventKinds = cursorArtifact?.events?.map?.((event) => event.kind) || [];
    const hiddenKeys = ["rt", "audio", "speak"];
    return {
      ok: true,
      ...nativeProbe,
      cursorSnapshot,
      targetSnapshot,
      dragSnapshot,
      cursorArtifact,
      cursorNonBackgroundRatio,
      targetRingNonBackgroundRatio,
      dragTrailNonBackgroundRatio,
      cursorVisible: cursorSnapshot?.visible === true && cursorNonBackgroundRatio > 0.02,
      cursorEventsPresent:
        Array.isArray(cursorArtifact?.events) && cursorArtifact.events.length > 0,
      coordinateSpacePresent:
        coordinateSpaceIds.length > 0 &&
        cursorArtifact.events?.every((event) =>
          coordinateSpaceIds.includes(event.coordinateSpaceId),
        ),
      targetRingVisible:
        targetSnapshot?.visible === true &&
        targetRingNonBackgroundRatio > 0.02 &&
        cursorArtifact?.styles?.targetRing === true &&
        eventKinds.includes("cursor.highlight"),
      dragTrailVisible:
        dragSnapshot?.visible === true &&
        dragTrailNonBackgroundRatio > 0.02 &&
        cursorArtifact?.styles?.dragTrail === true &&
        (cursorArtifact?.trail?.length || 0) >= 2 &&
        eventKinds.includes("cursor.drag"),
      lowValueCells,
      lowValueText,
      hiddenKeys,
      lowValueHudHidden:
        !/连接中|没音频|没开口|没出声/u.test(lowValueText) &&
        !lowValueCells.some((cell) => hiddenKeys.includes(cell.key)),
    };
  } catch (error) {
    return { ok: false, ...nativeProbe, error: String(error?.message || error) };
  } finally {
    await browser.close();
    await playground.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runKWWKCursorVisibleBenchmark();
  const report = buildKWWKCursorVisibleReport(result);
  if (args.jsonOut) {
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `KWWK cursor-visible benchmark: ${report.ok ? "PASS" : "FAIL"} cases=${report.cases
      .map((testCase) => `${testCase.id}:${testCase.ok ? "pass" : "fail"}`)
      .join(",")}`,
  );
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`realtime-kwwk-cursor-visible-benchmark failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
