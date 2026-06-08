#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import { attachLanAcceptanceSlo } from "./lan-operator-acceptance-slo.mjs";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-host-visual-stream-latest.json";
const EXPECTED_AVATAR_RECT = Object.freeze({ x: 0.58, y: 0.42, width: 0.28, height: 0.38 });
const RECT_EPSILON = 0.001;
const DEFAULT_DISPLAY_CAPTURE_SOURCE =
  process.env.MAB_LAN_OPERATOR_DISPLAY_CAPTURE_SOURCE || "Entire screen";
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 0,
    timeoutMs: 10_000,
    jsonOut: DEFAULT_JSON_OUT,
    headed: false,
    surfaceUrl: "",
    surfaceUrlProvided: false,
    requireDisplayCapture: false,
    displayCaptureSource: DEFAULT_DISPLAY_CAPTURE_SOURCE,
    browserChannel: process.env.MAB_LAN_OPERATOR_BROWSER_CHANNEL || "",
    manualDisplayCapturePicker: process.env.MAB_LAN_OPERATOR_MANUAL_DISPLAY_CAPTURE_PICKER === "1",
    nativeScreencaptureFallback: process.env.MAB_LAN_OPERATOR_NATIVE_SCREENCAPTURE_FALLBACK === "1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--surface-url" || arg === "--operator-url") {
      args.surfaceUrlProvided = true;
      args.surfaceUrl = argv[++index] || "";
    } else if (arg === "--require-display-capture" || arg === "--require-host-display-capture") {
      args.requireDisplayCapture = true;
    } else if (arg === "--display-capture-source") args.displayCaptureSource = argv[++index] || "";
    else if (arg === "--browser-channel") args.browserChannel = argv[++index] || "";
    else if (arg === "--manual-display-capture-picker") args.manualDisplayCapturePicker = true;
    else if (arg === "--native-screencapture-fallback") args.nativeScreencaptureFallback = true;
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
  console.log(`Usage: node --import tsx scripts/lan-operator-host-visual-acceptance.mjs [options]

Options:
  --host <host>         Bind host (default: 127.0.0.1)
  --port <port>         Bind port, 0 means random (default: 0)
  --timeout-ms <n>      Acceptance timeout (default: 10000)
  --json-out <path>     Write structured report (default: ${DEFAULT_JSON_OUT})
  --surface-url <url>   Use an already-running LAN Operator Surface instead of
                        starting a local server. In this mode, open host
                        publishers on the host Mac before running the gate.
  --require-display-capture
                        Require the host-app source to report display_capture
                        from getDisplayMedia instead of diagnostic_canvas.
  --display-capture-source <name>
                        Desktop/window source name for Chromium auto-select
                        when display capture is required (default:
                        ${DEFAULT_DISPLAY_CAPTURE_SOURCE || "<disabled>"}).
  --browser-channel <name>
                        Playwright browser channel, e.g. chrome, for display
                        capture permission checks (default: bundled Chromium).
  --manual-display-capture-picker
                        Do not pass fake-ui or auto-select capture flags; use
                        the browser picker manually in headed display mode.
  --native-screencapture-fallback
                        If getDisplayMedia does not produce a live track, use
                        macOS screencapture frames drawn into a canvas-backed
                        WebRTC track as an explicit host-Mac fallback.
  --headed              Run Chromium headed
`);
}

export function classifyDisplayCaptureFailure(errorText) {
  const text = String(errorText || "").trim();
  if (!text) return null;
  const common = {
    error: text,
    docs: [
      "https://support.apple.com/guide/mac-help/mchld6aa7d23/mac",
      "https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture",
    ],
  };
  if (/NotAllowedError|Permission denied/i.test(text)) {
    return {
      ...common,
      category: "display_capture_permission_denied",
      requiredFix:
        "Allow the browser to share a screen/window in the picker, and grant macOS Screen Recording permission to the exact browser app used for the display gate.",
    };
  }
  if (/NotReadableError|Could not start video source/i.test(text)) {
    return {
      ...common,
      category: "display_capture_source_unreadable_or_screen_recording_denied",
      requiredFix:
        "Grant macOS Screen Recording permission to the exact Chrome/Chromium app used by the gate, quit and relaunch it, then rerun the headed display gate. If it still fails, choose the source manually in a visible browser window.",
    };
  }
  if (/InvalidStateError|Invalid state/i.test(text)) {
    return {
      ...common,
      category: "display_capture_activation_or_focus_failed",
      requiredFix:
        "Run the display gate headed with the publisher page focused, then click Share Display from that visible page if automated activation is rejected.",
    };
  }
  if (/NotSupportedError|not supported/i.test(text)) {
    return {
      ...common,
      category: "display_capture_unsupported_runtime",
      requiredFix:
        "Run the strict display gate in headed Chrome/Chromium on the host Mac; headless or unsupported browser contexts cannot satisfy real getDisplayMedia evidence.",
    };
  }
  if (/NotFoundError|not found/i.test(text)) {
    return {
      ...common,
      category: "display_capture_source_not_found",
      requiredFix:
        "Rerun the headed display gate and select an available screen/window source; update MAB_LAN_OPERATOR_DISPLAY_CAPTURE_SOURCE if using auto-select.",
    };
  }
  if (/AbortError|aborted/i.test(text)) {
    return {
      ...common,
      category: "display_capture_request_aborted",
      requiredFix:
        "Rerun the headed display gate and keep the browser capture picker open until a screen/window source is selected.",
    };
  }
  return {
    ...common,
    category: "display_capture_unknown_failure",
    requiredFix:
      "Inspect the display-capture error, then rerun the headed display gate with a visible browser and a manually selected screen/window source.",
  };
}

function classifyDisplayCaptureState({ captureStatus, errorText, manualDisplayCapturePicker }) {
  const errorFailure = classifyDisplayCaptureFailure(errorText);
  if (errorFailure) return errorFailure;
  if (captureStatus === "requesting") {
    return {
      category: manualDisplayCapturePicker
        ? "display_capture_picker_waiting_for_user_selection"
        : "display_capture_request_pending",
      error: "",
      requiredFix: manualDisplayCapturePicker
        ? "Select a screen/window in the visible browser picker, approve any macOS Screen Recording prompt for Google Chrome, then rerun the manual display picker gate."
        : "Rerun the headed display gate and keep the browser visible until getDisplayMedia returns a live display track or a concrete error.",
      docs: [
        "https://support.apple.com/guide/mac-help/mchld6aa7d23/mac",
        "https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture",
      ],
    };
  }
  return null;
}

function displayCaptureBrowserLaunchArgs(args) {
  if (!args.requireDisplayCapture) return [];
  if (args.manualDisplayCapturePicker) return ["--enable-usermedia-screen-capturing"];
  const launchArgs = ["--enable-usermedia-screen-capturing", "--use-fake-ui-for-media-stream"];
  if (args.displayCaptureSource) {
    launchArgs.push(`--auto-select-desktop-capture-source=${args.displayCaptureSource}`);
  }
  return launchArgs;
}

function browserExecutablePathForArgs(args) {
  if (args.browserChannel) return "";
  return chromium.executablePath();
}

async function nativeScreencaptureDataUrl() {
  const dir = await mkdtemp(join(tmpdir(), "oneesama-native-display-capture-"));
  const path = join(dir, "frame.png");
  try {
    await execFileAsync("/usr/sbin/screencapture", ["-x", "-t", "png", path], {
      timeout: 5000,
    });
    const bytes = await readFile(path);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function listenResultFromSurfaceUrl(surfaceUrl) {
  const url = new URL(surfaceUrl);
  return {
    url: url.toString(),
    host: url.hostname,
    external: true,
  };
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.")
  );
}

async function waitForRuntimeStatus(url, predicate, timeoutMs) {
  const statusUrl = new URL("/runtime/status", url);
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(statusUrl)).json();
    lastBody = body;
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime_status_timeout: ${JSON.stringify(lastBody)}`);
}

async function fetchDebugReport(url) {
  const body = await (await fetch(new URL("/runtime/report", url))).json();
  return body.report || body;
}

function hostSourceFrom(debug) {
  return (debug.visual?.sources || []).find((source) => source.id === "host-app") || null;
}

function avatarSourceFrom(debug) {
  return (debug.visual?.sources || []).find((source) => source.id === "avatar") || null;
}

function requiredVisualSources(debug) {
  return [hostSourceFrom(debug), avatarSourceFrom(debug)].filter(Boolean);
}

function closeEnough(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.001;
}

function finiteRect(rect) {
  return Boolean(
    rect &&
    Number.isFinite(Number(rect.x)) &&
    Number.isFinite(Number(rect.y)) &&
    Number.isFinite(Number(rect.width)) &&
    Number.isFinite(Number(rect.height)) &&
    Number(rect.width) > 0 &&
    Number(rect.height) > 0,
  );
}

function avatarRectMatches(composition) {
  const rect = composition?.sourceRects?.avatar;
  return Boolean(
    rect &&
    closeEnough(rect.x, EXPECTED_AVATAR_RECT.x) &&
    closeEnough(rect.y, EXPECTED_AVATAR_RECT.y) &&
    closeEnough(rect.width, EXPECTED_AVATAR_RECT.width) &&
    closeEnough(rect.height, EXPECTED_AVATAR_RECT.height),
  );
}

function layoutUpdateProvesMoveResize(layoutUpdate) {
  const composedTrack = layoutUpdate?.composedTrack || {};
  const sourceTracks = layoutUpdate?.sourceTracks || {};
  return Boolean(
    layoutUpdate?.schema === "oneesama.operator_visual_layout_update.v1" &&
    layoutUpdate.sourceId === "avatar" &&
    layoutUpdate.action === "move_resize" &&
    finiteRect(layoutUpdate.beforeRect) &&
    finiteRect(layoutUpdate.afterRect) &&
    layoutUpdate.moved === true &&
    layoutUpdate.resized === true &&
    composedTrack.liveBefore === true &&
    composedTrack.liveAfter === true &&
    composedTrack.trackKindBefore === "video" &&
    composedTrack.trackKindAfter === "video" &&
    composedTrack.trackIdStable === true &&
    sourceTracks.hostAppStable === true &&
    sourceTracks.avatarStable === true,
  );
}

function sourceEvidenceFromDebug(debug) {
  const hostSource = hostSourceFrom(debug) || {};
  const avatarSource = avatarSourceFrom(debug) || {};
  return {
    hostApp: {
      sourceMode: hostSource.sourceMode || "",
      captureStatus: hostSource.captureStatus || "",
      captureError: hostSource.captureError || "",
      captureAttemptCount: Number(hostSource.captureAttemptCount || 0) || 0,
      displaySurface: hostSource.displaySurface || "",
      trackLabel: hostSource.trackLabel || "",
      kind: hostSource.kind || "",
      label: hostSource.label || "",
      trackReadyState: hostSource.trackReadyState || "",
    },
    avatar: {
      sourceMode: avatarSource.sourceMode || "",
      avatarRenderer: avatarSource.avatarRenderer || "",
      avatarReady: avatarSource.avatarReady ?? null,
      trackReadyState: avatarSource.trackReadyState || "",
    },
  };
}

function mergePublisherEvidence(debug, publisherEvidence) {
  const runtimeEvidence = sourceEvidenceFromDebug(debug);
  return {
    hostApp: {
      ...runtimeEvidence.hostApp,
      ...publisherEvidence?.hostApp,
    },
    avatar: {
      ...runtimeEvidence.avatar,
      ...publisherEvidence?.avatar,
    },
  };
}

function lanPeerEvidenceFrom(debug, debugReport) {
  return (
    debugReport?.summaries?.surfaceContext?.lanPeerEvidence ||
    debug?.surfaceContext?.lanPeerEvidence ||
    null
  );
}

async function operatorVisualSnapshot(operatorPage) {
  return await operatorPage.evaluate(() => ({
    pageUrl: location.href,
    userAgent: navigator.userAgent,
    hasVideo: Boolean(window.MAB_LAN_OPERATOR_SURFACE.visualReceiver?.()?.sourceVideo("host-app")),
    hasAvatarVideo: Boolean(
      window.MAB_LAN_OPERATOR_SURFACE.visualReceiver?.()?.sourceVideo("avatar"),
    ),
    composedTrackLive:
      window.MAB_LAN_OPERATOR_SURFACE.getComposedVideoTrack?.()?.readyState === "live",
    composition: window.MAB_LAN_OPERATOR_SURFACE.currentComposition(),
  }));
}

function buildAcceptanceReport(input) {
  const {
    args,
    listenResult,
    runtimeStatus,
    debugReport,
    operatorVisual,
    layoutUpdate,
    publisherEvidence,
    startedAt,
    readyMs,
    connectedMs,
    browserLaunchArgs,
    browserExecutablePath,
  } = input;
  const debug = runtimeStatus?.debug || {};
  const surfaceContext = debugReport?.summaries?.surfaceContext || debug.surfaceContext || {};
  const lanPeerEvidence = lanPeerEvidenceFrom(debug, debugReport);
  const visual = debug.visual || {};
  const hostSource = hostSourceFrom(debug);
  const avatarSource = avatarSourceFrom(debug);
  const effectivePublisherEvidence = mergePublisherEvidence(debug, publisherEvidence);
  const hostSourceMode =
    effectivePublisherEvidence.hostApp.sourceMode || hostSource?.sourceMode || "";
  const hostCaptureStatus =
    effectivePublisherEvidence.hostApp.captureStatus || hostSource?.captureStatus || "";
  const hostCaptureError =
    effectivePublisherEvidence.hostApp.captureError || hostSource?.captureError || "";
  const avatarSourceMode =
    effectivePublisherEvidence.avatar.sourceMode || avatarSource?.sourceMode || "";
  const avatarRenderer =
    effectivePublisherEvidence.avatar.avatarRenderer || avatarSource?.avatarRenderer || "";
  const displayCaptureLive = hostSourceMode === "display_capture" && hostCaptureStatus === "live";
  const displayCaptureFailure =
    args.requireDisplayCapture && !displayCaptureLive
      ? classifyDisplayCaptureState({
          captureStatus: hostCaptureStatus,
          errorText: hostCaptureError,
          manualDisplayCapturePicker: args.manualDisplayCapturePicker,
        })
      : null;
  const blocker =
    args.requireDisplayCapture && !displayCaptureLive
      ? "host_visual_display_capture_source_observed"
      : null;
  const requiredSources = requiredVisualSources(debug);
  const maxFrameAgeMs = requiredSources.length
    ? Math.max(...requiredSources.map((source) => Number(source?.frameAgeMs) || 0))
    : null;
  const minFrameRate = requiredSources.length
    ? Math.min(...requiredSources.map((source) => Number(source?.frameRate) || 0))
    : null;
  const composition = visual.composition || {};
  const ok =
    runtimeStatus?.ok === true &&
    visual.connectionState === "connected" &&
    visual.receiverWebSocketState === "open" &&
    visual.hostPublisherConnections >= 2 &&
    visual.trackCount >= 2 &&
    hostSource?.state === "live" &&
    hostSource?.trackReadyState === "live" &&
    avatarSource?.state === "live" &&
    avatarSource?.trackReadyState === "live" &&
    Number(hostSource?.width) > 0 &&
    Number(hostSource?.height) > 0 &&
    Number(avatarSource?.width) > 0 &&
    Number(avatarSource?.height) > 0 &&
    Number(hostSource?.frameAgeMs) < 1200 &&
    Number(avatarSource?.frameAgeMs) < 1200 &&
    composition.localComposedTrack === true &&
    composition.trackReadyState === "live" &&
    composition.layoutRevision >= 1 &&
    composition.focusedSourceId === "avatar" &&
    composition.overlayCount >= 1 &&
    avatarRectMatches(composition) &&
    layoutUpdateProvesMoveResize(layoutUpdate) &&
    operatorVisual?.hasVideo === true &&
    operatorVisual?.hasAvatarVideo === true &&
    operatorVisual?.composedTrackLive === true &&
    (!args.requireDisplayCapture || displayCaptureLive) &&
    avatarSourceMode === "avatar_renderer" &&
    Boolean(avatarRenderer);

  const surfaceUrl = new URL(listenResult?.url || "http://127.0.0.1/");
  const externalSurfaceMode = Boolean(args.surfaceUrl);

  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_host_visual",
    ok,
    functionalOk: ok,
    blocker,
    generatedAt: new Date().toISOString(),
    host: {
      url: listenResult?.url || "",
      lanAddress: listenResult?.host || "",
      trustedLanOperatorMode: surfaceContext.trustedLanOperatorMode ?? true,
      lanModeExplicitlyEnabled: surfaceContext.lanModeExplicitlyEnabled ?? !externalSurfaceMode,
      reachability: surfaceContext.lanReachability || null,
    },
    lanEvidence: {
      externalSurfaceMode,
      surfaceReachability: surfaceContext.lanReachability || null,
      surfaceHost: surfaceUrl.hostname,
      nonLoopbackSurfaceHost: !isLoopbackHost(surfaceUrl.hostname),
      peerEvidence: lanPeerEvidence,
      operatorNonLoopbackPeerCount: Number(lanPeerEvidence?.operatorNonLoopbackPeerCount || 0),
      operatorPrivateLanPeerCount: Number(lanPeerEvidence?.operatorPrivateLanPeerCount || 0),
      publisherMode: externalSurfaceMode
        ? "preexisting_host_publishers"
        : "self_contained_local_publishers",
      operatorPageUrl: operatorVisual?.pageUrl || "",
      operatorUserAgent: operatorVisual?.userAgent || "",
    },
    operatorSurface: {
      id: runtimeStatus?.snapshot?.sessionId || "",
      userAgent: operatorVisual?.userAgent || "",
      readyMs,
      connectedMs,
    },
    visual: {
      direction: "host_to_operator",
      transport: "webrtc_video",
      connectionState: visual.connectionState || "",
      iceConnectionState: visual.iceConnectionState || "",
      peerConnectionState: visual.peerConnectionState || "",
      signalingState: visual.signalingState || "",
      trackCount: visual.trackCount || 0,
      trackState: hostSource?.trackReadyState || "",
      sourceKind: "combined",
      sources: visual.sources || [],
      composition,
      layoutUpdate,
      publisherEvidence: effectivePublisherEvidence,
      hostSourceMode,
      hostCaptureStatus,
      hostCaptureError,
      hostDisplayCaptureRequired: Boolean(args.requireDisplayCapture),
      hostDisplayCaptureFailureCategory: displayCaptureFailure?.category || "",
      hostDisplayCaptureRequiredFix: displayCaptureFailure?.requiredFix || "",
      avatarSourceMode,
      avatarRenderer,
      frameRate: minFrameRate,
      frameAgeMs: maxFrameAgeMs,
      overlayVisible: composition.overlayCount > 0,
      operatorScreenBackflow: false,
    },
    timeline: debugReport?.timeline || debug.timeline?.rows || [],
    debugReport,
    requiredFix: displayCaptureFailure?.requiredFix || "",
    timings: {
      totalWallMs: Math.round(performance.now() - startedAt),
      readyMs,
      connectedMs,
      visualConnectedAfterReadyMs:
        Number.isFinite(Number(connectedMs)) && Number.isFinite(Number(readyMs))
          ? Math.max(0, Number(connectedMs) - Number(readyMs))
          : null,
    },
    args: {
      timeoutMs: args.timeoutMs,
      headed: args.headed,
      surfaceUrl: args.surfaceUrl || "",
      diagnosticPublisher: !externalSurfaceMode,
      externalSurfaceMode,
      requireDisplayCapture: Boolean(args.requireDisplayCapture),
      displayCaptureSource: args.displayCaptureSource || "",
      browserLaunchArgs: browserLaunchArgs || [],
      browserChannel: args.browserChannel || "",
      browserExecutablePath: browserExecutablePath || "",
      manualDisplayCapturePicker: Boolean(args.manualDisplayCapturePicker),
      nativeScreencaptureFallback: Boolean(args.nativeScreencaptureFallback),
    },
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function missingSurfaceUrlReport(args) {
  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_host_visual",
    ok: false,
    functionalOk: false,
    generatedAt: new Date().toISOString(),
    blocker: "missing_lan_operator_surface_url",
    reason: "missing_env",
    missingEnv: ["MAB_LAN_OPERATOR_SURFACE_URL"],
    requiredFix:
      "Set MAB_LAN_OPERATOR_SURFACE_URL to the host Mac LAN Operator Surface URL before running the external LAN visual or display gate.",
    command:
      "MAB_LAN_OPERATOR_SURFACE_URL=http://<host-lan-ip>:18913/ vp run acceptance:realtime-lan-host-visual-stream:external",
    lanEvidence: {
      externalSurfaceMode: true,
      surfaceHost: "",
      nonLoopbackSurfaceHost: false,
      publisherMode: "preexisting_host_publishers",
      operatorNonLoopbackPeerCount: 0,
      operatorPrivateLanPeerCount: 0,
    },
    visual: {
      direction: "host_to_operator",
      transport: "webrtc_video",
      hostDisplayCaptureRequired: Boolean(args.requireDisplayCapture),
      hostSourceMode: "",
      hostCaptureStatus: "",
      hostCaptureError: "",
      hostDisplayCaptureFailureCategory: "",
      hostDisplayCaptureRequiredFix: "",
      operatorScreenBackflow: false,
    },
    args: {
      timeoutMs: args.timeoutMs,
      headed: args.headed,
      surfaceUrl: "",
      surfaceUrlProvided: true,
      externalSurfaceMode: true,
      requireDisplayCapture: Boolean(args.requireDisplayCapture),
      displayCaptureSource: args.displayCaptureSource || "",
      browserLaunchArgs: [],
      browserChannel: args.browserChannel || "",
      browserExecutablePath: browserExecutablePathForArgs(args),
      manualDisplayCapturePicker: Boolean(args.manualDisplayCapturePicker),
    },
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.surfaceUrlProvided && !String(args.surfaceUrl || "").trim()) {
    const report = attachLanAcceptanceSlo(missingSurfaceUrlReport(args));
    await writeJson(args.jsonOut, report);
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          functionalOk: report.functionalOk,
          sloOk: report.slo?.ok,
          sloFailures: report.slo?.failures?.map((failure) => failure.id) || [],
          blocker: report.blocker,
          jsonOut: args.jsonOut,
          gate: report.gate,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  const startedAt = performance.now();
  const useExternalSurface = Boolean(args.surfaceUrl);
  const surface = useExternalSurface
    ? null
    : createLanOperatorSurfaceServer({
        host: args.host,
        port: args.port,
        sessionId: `lan_host_visual_acceptance_${Date.now().toString(36)}`,
        botName: "LAN Oneesama",
      });
  let browser = null;
  let report = null;
  let listenResult = null;
  let context = null;
  let operatorPage = null;
  let readyMs = null;
  const browserLaunchArgs = displayCaptureBrowserLaunchArgs(args);
  const browserExecutablePath = browserExecutablePathForArgs(args);
  try {
    listenResult = useExternalSurface
      ? listenResultFromSurfaceUrl(args.surfaceUrl)
      : await surface.listen();
    browser = await chromium.launch({
      headless: !args.headed,
      args: browserLaunchArgs,
      channel: args.browserChannel || undefined,
    });
    context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    if (args.nativeScreencaptureFallback) {
      await context.exposeFunction("MAB_NATIVE_SCREENCAPTURE_FRAME", nativeScreencaptureDataUrl);
    }
    operatorPage = await context.newPage();
    await operatorPage.goto(listenResult.url);
    await operatorPage.waitForFunction(
      () =>
        window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true &&
        window.MAB_LAN_OPERATOR_SURFACE.state.visual.receiverWebSocketState === "open",
      null,
      { timeout: args.timeoutMs },
    );
    readyMs = Math.round(performance.now() - startedAt);

    async function startNativeScreencaptureFallback(publisherPage) {
      await publisherPage.evaluate(async () => {
        const publisher = window.MAB_LAN_HOST_VISUAL_PUBLISHER;
        if (!publisher) throw new Error("host_visual_publisher_missing");
        if (typeof window.MAB_NATIVE_SCREENCAPTURE_FRAME !== "function") {
          throw new Error("native_screencapture_provider_missing");
        }
        const canvas = document.getElementById("diagnostic");
        const canvasContext = canvas.getContext("2d");
        canvas.hidden = false;
        canvas.width = 1280;
        canvas.height = 720;
        const state = publisher.state;
        state.sourceMode = "display_capture";
        state.captureStatus = "requesting";
        state.captureError = null;
        state.captureAttemptCount += 1;
        state.captureLastAttemptAt = new Date().toISOString();
        let latestImage = null;
        async function loadImage(dataUrl) {
          const image = new Image();
          await new Promise((resolve, reject) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener(
              "error",
              () => reject(new Error("native_screencapture_image_load_failed")),
              { once: true },
            );
            image.src = dataUrl;
          });
          return image;
        }
        async function refreshNativeFrame() {
          try {
            latestImage = await loadImage(await window.MAB_NATIVE_SCREENCAPTURE_FRAME());
            state.captureStatus = "live";
            state.captureError = null;
            state.captureLastSuccessAt = new Date().toISOString();
          } catch (error) {
            state.captureStatus = "failed";
            state.captureError = String(error?.message || error);
            state.captureLastErrorAt = new Date().toISOString();
            throw error;
          }
        }
        await refreshNativeFrame();
        const paint = () => {
          canvasContext.fillStyle = "#0f172a";
          canvasContext.fillRect(0, 0, canvas.width, canvas.height);
          if (latestImage) canvasContext.drawImage(latestImage, 0, 0, canvas.width, canvas.height);
          canvasContext.fillStyle = "rgba(15, 23, 42, 0.74)";
          canvasContext.fillRect(20, 20, 560, 64);
          canvasContext.fillStyle = "#f8fafc";
          canvasContext.font = "600 24px system-ui, sans-serif";
          canvasContext.fillText("native screencapture display source", 40, 58);
          canvasContext.font = "16px system-ui, sans-serif";
          canvasContext.fillText(new Date().toISOString(), 40, 82);
          requestAnimationFrame(paint);
        };
        paint();
        clearInterval(window.__MAB_NATIVE_SCREENCAPTURE_INTERVAL);
        window.__MAB_NATIVE_SCREENCAPTURE_INTERVAL = setInterval(() => {
          void refreshNativeFrame().catch(() => {});
        }, 500);
        state.displaySurface = "monitor";
        state.trackLabel = "native_screencapture";
        return await publisher.publishStream(canvas.captureStream(30));
      });
      await publisherPage.waitForFunction(
        () =>
          window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.captureStatus === "live" &&
          window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.trackReadyState === "live",
        null,
        { timeout: args.timeoutMs },
      );
    }

    async function openPublisher(sourceId, label, kind, input = {}) {
      const publisherPage = await context.newPage();
      const publisherUrl = new URL("/host-visual", listenResult.url);
      if (input.avatar) publisherUrl.searchParams.set("avatar", "1");
      else if (!input.displayCapture) publisherUrl.searchParams.set("diagnostic", "1");
      publisherUrl.searchParams.set("sourceId", sourceId);
      publisherUrl.searchParams.set("label", label);
      publisherUrl.searchParams.set("kind", kind);
      await publisherPage.goto(publisherUrl.toString());
      if (input.displayCapture) {
        await publisherPage.waitForFunction(
          () => window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.websocketState === "open",
          null,
          { timeout: args.timeoutMs },
        );
        if (args.nativeScreencaptureFallback) {
          await startNativeScreencaptureFallback(publisherPage);
          return publisherPage;
        }
        await publisherPage.bringToFront();
        await publisherPage.focus("#share-display");
        await publisherPage.click("#share-display");
        await publisherPage.waitForFunction(
          () => {
            const state = window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state;
            return state?.captureStatus === "live" || state?.captureStatus === "failed";
          },
          null,
          { timeout: args.timeoutMs },
        );
        const captureState = await publisherPage.evaluate(
          () => window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.captureStatus,
        );
        if (captureState !== "live" && args.nativeScreencaptureFallback) {
          await startNativeScreencaptureFallback(publisherPage);
          return publisherPage;
        }
        if (captureState !== "live") return publisherPage;
      }
      await publisherPage.waitForFunction(
        () => window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.trackReadyState === "live",
        null,
        { timeout: args.timeoutMs },
      );
      return publisherPage;
    }
    let publisherEvidence = null;
    if (!useExternalSurface) {
      const [hostPublisherPage, avatarPublisherPage] = await Promise.all([
        openPublisher("host-app", "App view", "desktop_app", {
          displayCapture: args.requireDisplayCapture,
        }),
        openPublisher("avatar", "Avatar", "avatar", { avatar: true }),
      ]);
      publisherEvidence = {
        hostApp: await hostPublisherPage.evaluate(() => ({
          sourceMode: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.sourceMode,
          captureStatus: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.captureStatus,
          captureError: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.captureError,
          captureAttemptCount: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.captureAttemptCount,
          displaySurface: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.displaySurface,
          trackLabel: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.trackLabel,
          trackReadyState: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.trackReadyState,
        })),
        avatar: await avatarPublisherPage.evaluate(() => ({
          sourceMode: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.sourceMode,
          avatarRenderer: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.avatarRenderer,
          avatarReady: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.avatarReady,
          trackReadyState: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.trackReadyState,
        })),
      };
    }
    if (args.requireDisplayCapture && publisherEvidence?.hostApp?.captureStatus !== "live") {
      const runtimeStatus = await fetch(new URL("/runtime/status", listenResult.url))
        .then((response) => response.json())
        .catch(() => null);
      const debugReport = await fetchDebugReport(listenResult.url).catch(() => null);
      const operatorVisual = await operatorVisualSnapshot(operatorPage).catch(() => null);
      report = buildAcceptanceReport({
        args,
        listenResult,
        runtimeStatus,
        debugReport,
        operatorVisual,
        layoutUpdate: null,
        publisherEvidence,
        startedAt,
        readyMs,
        connectedMs: Math.round(performance.now() - startedAt),
        browserLaunchArgs,
        browserExecutablePath,
      });
      await context.close();
      context = null;
    }
    if (!report) {
      await waitForRuntimeStatus(
        listenResult.url,
        (body) => {
          const source = hostSourceFrom(body.debug);
          const avatar = avatarSourceFrom(body.debug);
          const composition = body.debug.visual.composition;
          return (
            body.debug.visual.connectionState === "connected" &&
            body.debug.visual.trackCount >= 2 &&
            body.debug.visual.receiverWebSocketState === "open" &&
            body.debug.visual.hostPublisherConnections >= 2 &&
            source?.state === "live" &&
            source?.trackReadyState === "live" &&
            avatar?.state === "live" &&
            avatar?.trackReadyState === "live" &&
            composition.localComposedTrack === true &&
            composition.trackReadyState === "live" &&
            composition.trackKind === "video"
          );
        },
        args.timeoutMs,
      );
      const layoutUpdate = await operatorPage.evaluate(
        (input) => {
          const avatarRect = input.avatarRect;
          const epsilon = Number(input.epsilon);
          function hasFiniteRect(rect) {
            return Boolean(
              rect &&
              Number.isFinite(Number(rect.x)) &&
              Number.isFinite(Number(rect.y)) &&
              Number.isFinite(Number(rect.width)) &&
              Number.isFinite(Number(rect.height)),
            );
          }
          function delta(left, right, key) {
            return Math.abs(Number(left?.[key] || 0) - Number(right?.[key] || 0));
          }
          function trackSnapshot() {
            return Object.fromEntries(
              (window.MAB_LAN_OPERATOR_SURFACE.state.sources || []).map((source) => [
                source.id,
                source.trackId || null,
              ]),
            );
          }
          const before = window.MAB_LAN_OPERATOR_SURFACE.currentComposition();
          const beforeRect = { ...before.sourceRects?.avatar };
          const beforeTrackIds = trackSnapshot();
          const composition = window.MAB_LAN_OPERATOR_SURFACE.moveSource("avatar", avatarRect);
          const after = window.MAB_LAN_OPERATOR_SURFACE.currentComposition();
          const afterRect = { ...after.sourceRects?.avatar };
          const afterTrackIds = trackSnapshot();
          const overlay = window.MAB_LAN_OPERATOR_SURFACE.emitKwwkOverlay({
            sourceId: "host-app",
            kind: "click",
            x: 0.45,
            y: 0.52,
            label: "Host visual acceptance",
          });
          return {
            schema: "oneesama.operator_visual_layout_update.v1",
            sourceId: "avatar",
            action: "move_resize",
            beforeRect,
            afterRect,
            rectDelta: {
              x: delta(beforeRect, afterRect, "x"),
              y: delta(beforeRect, afterRect, "y"),
              width: delta(beforeRect, afterRect, "width"),
              height: delta(beforeRect, afterRect, "height"),
            },
            moved:
              hasFiniteRect(beforeRect) &&
              hasFiniteRect(afterRect) &&
              (delta(beforeRect, afterRect, "x") > epsilon ||
                delta(beforeRect, afterRect, "y") > epsilon),
            resized:
              hasFiniteRect(beforeRect) &&
              hasFiniteRect(afterRect) &&
              (delta(beforeRect, afterRect, "width") > epsilon ||
                delta(beforeRect, afterRect, "height") > epsilon),
            revisionBefore: before.layoutRevision,
            revisionAfter: after.layoutRevision,
            focusedSourceIdAfter: after.focusedSourceId,
            composedTrack: {
              liveBefore: before.localComposedTrack === true && before.trackReadyState === "live",
              liveAfter: after.localComposedTrack === true && after.trackReadyState === "live",
              trackIdBefore: before.trackId || null,
              trackIdAfter: after.trackId || null,
              trackKindBefore: before.trackKind || null,
              trackKindAfter: after.trackKind || null,
              trackIdStable: Boolean(
                before.trackId && after.trackId && before.trackId === after.trackId,
              ),
            },
            sourceTracks: {
              hostAppBefore: beforeTrackIds["host-app"] || null,
              hostAppAfter: afterTrackIds["host-app"] || null,
              hostAppStable: Boolean(
                beforeTrackIds["host-app"] &&
                beforeTrackIds["host-app"] === afterTrackIds["host-app"],
              ),
              avatarBefore: beforeTrackIds.avatar || null,
              avatarAfter: afterTrackIds.avatar || null,
              avatarStable: Boolean(
                beforeTrackIds.avatar && beforeTrackIds.avatar === afterTrackIds.avatar,
              ),
            },
            composition,
            overlay,
          };
        },
        { avatarRect: EXPECTED_AVATAR_RECT, epsilon: RECT_EPSILON },
      );

      const runtimeStatus = await waitForRuntimeStatus(
        listenResult.url,
        (body) => {
          const source = hostSourceFrom(body.debug);
          const avatar = avatarSourceFrom(body.debug);
          const composition = body.debug.visual.composition;
          return (
            body.debug.visual.connectionState === "connected" &&
            body.debug.visual.trackCount >= 2 &&
            body.debug.visual.receiverWebSocketState === "open" &&
            body.debug.visual.hostPublisherConnections >= 2 &&
            source?.state === "live" &&
            source?.trackReadyState === "live" &&
            avatar?.state === "live" &&
            avatar?.trackReadyState === "live" &&
            Number(source?.width) > 0 &&
            Number(source?.height) > 0 &&
            Number(avatar?.width) > 0 &&
            Number(avatar?.height) > 0 &&
            Number(source?.frameAgeMs) < 1200 &&
            Number(avatar?.frameAgeMs) < 1200 &&
            composition.localComposedTrack === true &&
            composition.trackReadyState === "live" &&
            composition.layoutRevision >= 1 &&
            composition.focusedSourceId === "avatar" &&
            composition.overlayCount >= 1 &&
            avatarRectMatches(composition)
          );
        },
        args.timeoutMs,
      );
      const connectedMs = Math.round(performance.now() - startedAt);
      const operatorVisual = await operatorVisualSnapshot(operatorPage);
      await operatorPage.evaluate(() =>
        window.MAB_LAN_OPERATOR_SURFACE.markInterestingRun({ label: "lan_host_visual_acceptance" }),
      );
      const debugReport = await fetchDebugReport(listenResult.url);
      report = buildAcceptanceReport({
        args,
        listenResult,
        runtimeStatus,
        debugReport,
        operatorVisual,
        layoutUpdate,
        publisherEvidence,
        startedAt,
        readyMs,
        connectedMs,
        browserLaunchArgs,
        browserExecutablePath,
      });
      await context.close();
      context = null;
    }
  } catch (error) {
    const runtimeStatus =
      surface?.status("failed") ||
      (listenResult
        ? await fetch(new URL("/runtime/status", listenResult.url))
            .then((response) => response.json())
            .catch(() => null)
        : null);
    const debugReport = listenResult
      ? await fetchDebugReport(listenResult.url).catch(() => null)
      : null;
    const operatorVisual = operatorPage
      ? await operatorVisualSnapshot(operatorPage).catch(() => null)
      : null;
    if (listenResult && runtimeStatus) {
      report = buildAcceptanceReport({
        args,
        listenResult,
        runtimeStatus,
        debugReport,
        operatorVisual,
        layoutUpdate: null,
        publisherEvidence: null,
        startedAt,
        readyMs: readyMs ?? Math.round(performance.now() - startedAt),
        connectedMs: Math.round(performance.now() - startedAt),
        browserLaunchArgs,
        browserExecutablePath,
      });
      report.error = String(error?.message || error);
      report.functionalOk = false;
      report.ok = false;
      if (!report.blocker) report.blocker = "host_visual_acceptance_timeout";
    } else {
      report = {
        schema: "oneesama.lan_voice_acceptance.v1",
        gate: "local_host_visual",
        ok: false,
        functionalOk: false,
        blocker: "host_visual_acceptance_failed",
        generatedAt: new Date().toISOString(),
        error: String(error?.message || error),
        host: { url: listenResult?.url || "" },
        debugReport,
        runtimeStatus,
      };
    }
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close();
    await surface?.close();
  }

  report = attachLanAcceptanceSlo(report);
  await writeJson(args.jsonOut, report);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        functionalOk: report.functionalOk,
        sloOk: report.slo?.ok,
        sloFailures: report.slo?.failures?.map((failure) => failure.id) || [],
        jsonOut: args.jsonOut,
        gate: report.gate,
      },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("lan-operator-host-visual-acceptance.mjs")) {
  await run();
}
