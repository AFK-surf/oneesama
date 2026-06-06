#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import { attachLanAcceptanceSlo } from "./lan-operator-acceptance-slo.mjs";
import { diagnosticCanonicalParityEvidence } from "./lan-operator-canonical-parity-slo.mjs";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-debug-panel-latest.json";
const EXPECTED_TOOL = "kwwk_computer_use";
const FAILURE_LAYERS = Object.freeze([
  {
    id: "audio_input",
    label: "Audio input",
    timelineLayer: "audio_input",
    event: "operator_voice_chunk_forward_failed",
    blocker: "voice_forward_failed",
  },
  {
    id: "conversation_engine",
    label: "Conversation Engine",
    timelineLayer: "conversation_engine",
    event: "engine_error",
    blocker: "engine_down",
  },
  {
    id: "tool_routing",
    label: "Tool routing",
    timelineLayer: "tool_routing",
    event: "tool_arguments_rejected",
    blocker: "unsafe_tool_arguments",
  },
  {
    id: "kwwk_planner",
    label: "KWWK planner",
    timelineLayer: "kwwk",
    event: "kwwk_failed",
    blocker: "planner_validation_failed",
  },
  {
    id: "kwwk_execution",
    label: "KWWK execution",
    timelineLayer: "kwwk",
    event: "kwwk_failed",
    blocker: "execution_surface_failed",
  },
  {
    id: "verification",
    label: "Verification",
    timelineLayer: "kwwk",
    event: "kwwk_blocked",
    blocker: "verification_target_missing",
  },
  {
    id: "output_audio",
    label: "Output audio",
    timelineLayer: "output_audio",
    event: "assistant_audio_failed",
    blocker: "output_device_failed",
  },
]);

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 0,
    timeoutMs: 10_000,
    jsonOut: DEFAULT_JSON_OUT,
    headed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--headed") args.headed = true;
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
  console.log(`Usage: node --import tsx scripts/lan-operator-debug-panel-benchmark.mjs [options]

Options:
  --host <host>         Bind host (default: 127.0.0.1)
  --port <port>         Bind port, 0 means random (default: 0)
  --timeout-ms <n>      Benchmark timeout (default: 10000)
  --json-out <path>     Write structured report (default: ${DEFAULT_JSON_OUT})
  --headed              Run Chromium headed
`);
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

function nowIso() {
  return new Date().toISOString();
}

function createDebugPanelEngine() {
  const command = "click the primary button";
  const toolArguments = {
    instruction: command,
    target: {
      applicationName: "Chromium",
      windowTitle: "LAN debug panel fixture",
    },
  };
  const unsafeToolArguments = {
    instruction: "click the primary button",
    target: { applicationName: "Chromium", windowTitle: "LAN debug panel fixture" },
    operations: [{ kind: "click", x: 10, y: 20 }],
  };
  return {
    id: "diagnostic_debug_panel_engine",
    receiveVoiceChunk(chunk) {
      const ts = nowIso();
      const sequence = Number(chunk.sequence || 1);
      const turnId = `turn_debug_panel_${sequence}`;
      const responseId = `response_debug_panel_${sequence}`;
      if (sequence === 2) {
        return {
          result: { ok: false, error: "voice_forward_failed", engineId: this.id },
          events: [
            {
              id: "debug_panel_engine_down",
              ts,
              sessionId: chunk.sessionId,
              type: "engine_error",
              engineId: this.id,
              turnId,
              responseId,
              error: "engine_down",
              detail: { sequence, error: "engine_down" },
            },
          ],
        };
      }
      if (sequence === 3) {
        return {
          result: { ok: true, engineId: this.id },
          events: [
            {
              id: "debug_panel_unsafe_tool_started",
              ts,
              sessionId: chunk.sessionId,
              type: "tool_call_started",
              engineId: this.id,
              turnId,
              responseId,
              itemId: "item_debug_panel_unsafe",
              detail: {
                expectedTool: EXPECTED_TOOL,
                name: EXPECTED_TOOL,
                callId: "call_debug_panel_unsafe",
              },
            },
            {
              id: "debug_panel_unsafe_tool_completed",
              ts,
              sessionId: chunk.sessionId,
              type: "tool_call_completed",
              engineId: this.id,
              turnId,
              responseId,
              itemId: "item_debug_panel_unsafe",
              text: JSON.stringify(unsafeToolArguments),
              detail: {
                expectedTool: EXPECTED_TOOL,
                name: EXPECTED_TOOL,
                callId: "call_debug_panel_unsafe",
              },
            },
          ],
        };
      }
      return {
        result: { ok: true, engineId: this.id },
        events: [
          {
            id: "debug_panel_engine_connected",
            ts,
            sessionId: chunk.sessionId,
            type: "engine_connected",
            engineId: this.id,
          },
          {
            id: "debug_panel_speech_started",
            ts,
            sessionId: chunk.sessionId,
            type: "speech_started",
            engineId: this.id,
            turnId,
          },
          {
            id: "debug_panel_transcript_completed",
            ts,
            sessionId: chunk.sessionId,
            type: "transcript_completed",
            engineId: this.id,
            turnId,
            text: command,
          },
          {
            id: "debug_panel_tool_started",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_call_started",
            engineId: this.id,
            turnId,
            responseId,
            itemId: "item_debug_panel",
            detail: {
              expectedTool: EXPECTED_TOOL,
              name: EXPECTED_TOOL,
              callId: "call_debug_panel",
            },
          },
          {
            id: "debug_panel_tool_completed",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_call_completed",
            engineId: this.id,
            turnId,
            responseId,
            itemId: "item_debug_panel",
            text: JSON.stringify(toolArguments),
            detail: {
              expectedTool: EXPECTED_TOOL,
              name: EXPECTED_TOOL,
              callId: "call_debug_panel",
            },
          },
          {
            id: "debug_panel_tool_result",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_result_accepted",
            engineId: this.id,
            turnId,
            responseId,
            itemId: "item_debug_panel",
            text: JSON.stringify({
              ok: true,
              jobId: "debug_panel_kwwk_job",
              status: "queued",
            }),
            detail: {
              expectedTool: EXPECTED_TOOL,
              name: EXPECTED_TOOL,
              callId: "call_debug_panel",
            },
          },
          {
            id: "debug_panel_assistant_completed",
            ts,
            sessionId: chunk.sessionId,
            type: "assistant_text_completed",
            engineId: this.id,
            turnId,
            responseId,
            text: "Done.",
          },
        ],
      };
    },
  };
}

async function visibleDebugPanelState(page) {
  return await page.evaluate(() => ({
    embedded: Boolean(document.querySelector("[data-debug-panel='dense']")),
    opened: document.getElementById("debug-panel")?.dataset.debugPanelOpened === "true",
    timeline: document.getElementById("debug-timeline-table")?.innerText || "",
    turnCorrelation: document.getElementById("debug-turn-table")?.innerText || "",
    turnTimelineSummary: document.getElementById("debug-turn-timeline-summary")?.innerText || "",
    turnTimeline: document.getElementById("debug-turn-timeline-table")?.innerText || "",
    turnTimelineRowCount: document.querySelectorAll("#debug-turn-timeline-table tr").length,
    conversation: document.getElementById("debug-conversation-table")?.innerText || "",
    toolSummary: document.getElementById("debug-tool-routing-summary")?.innerText || "",
    toolTable: document.getElementById("debug-tool-routing-table")?.innerText || "",
    kwwkSummary: document.getElementById("debug-kwwk-summary")?.innerText || "",
    kwwkTable: document.getElementById("debug-kwwk-table")?.innerText || "",
    composition: document.getElementById("debug-composition-table")?.innerText || "",
    visualSources: document.getElementById("debug-visual-source-table")?.innerText || "",
    artifacts: document.getElementById("debug-artifact-table")?.innerText || "",
    json: document.getElementById("debug-json")?.innerText || "",
  }));
}

async function visibleDebugFilterState(page, query) {
  return await page.evaluate((value) => {
    const result = window.MAB_LAN_OPERATOR_SURFACE?.setDebugFilter?.(value) || {};
    const visibleSections = Array.from(
      document.querySelectorAll(".debug-section:not([data-filter-hidden='true'])"),
    );
    const hiddenSections = Array.from(
      document.querySelectorAll(".debug-section[data-filter-hidden='true']"),
    );
    const visibleRows = Array.from(
      document.querySelectorAll(
        ".debug-section:not([data-filter-hidden='true']) tbody tr:not([data-filter-hidden='true'])",
      ),
    );
    const hiddenRows = Array.from(
      document.querySelectorAll(".debug-table tr[data-filter-hidden='true']"),
    );
    const visibleText = visibleSections.map((section) => section.innerText || "").join("\\n");
    return {
      query: document.getElementById("debug-filter-input")?.value || String(value || ""),
      stateText: document.getElementById("debug-filter-state")?.innerText || "",
      visibleSectionCount: visibleSections.length,
      hiddenSectionCount: hiddenSections.length,
      matchedRowCount: visibleRows.length,
      hiddenRowCount: hiddenRows.length,
      kwwkVisible:
        document.getElementById("debug-kwwk-table")?.closest(".debug-section")?.dataset
          .filterHidden !== "true",
      conversationVisible:
        document.getElementById("debug-conversation-table")?.closest(".debug-section")?.dataset
          .filterHidden !== "true",
      visibleText,
      raw: result,
    };
  }, query);
}

function includesAll(value, patterns) {
  return patterns.every((pattern) => value.includes(pattern));
}

function buildFailureMatrix(debugReport, debug) {
  const timeline = Array.isArray(debugReport?.timeline)
    ? debugReport.timeline
    : Array.isArray(debug?.timeline?.rows)
      ? debug.timeline.rows
      : [];
  const layers = FAILURE_LAYERS.map((expected) => {
    const row = timeline.find(
      (candidate) =>
        candidate?.layer === expected.timelineLayer &&
        candidate?.event === expected.event &&
        candidate?.blocker === expected.blocker &&
        candidate?.ok === false,
    );
    return {
      id: expected.id,
      label: expected.label,
      observed: Boolean(row),
      timelineLayer: expected.timelineLayer,
      event: expected.event,
      blocker: expected.blocker,
      timelineRowId: row?.id || null,
      timelineAt: row?.at || null,
    };
  });
  return {
    schemaVersion: 1,
    expectedCount: FAILURE_LAYERS.length,
    observedCount: layers.filter((layer) => layer.observed).length,
    timelineRowCount: layers.filter((layer) => layer.timelineRowId).length,
    missingLayers: layers.filter((layer) => !layer.observed).map((layer) => layer.id),
    layers,
  };
}

function buildBenchmarkReport(input) {
  const {
    args,
    listenResult,
    runtimeStatus,
    debugReport,
    panelState,
    filterEvidence,
    startedAt,
    completedMs,
  } = input;
  const debug = runtimeStatus?.debug || {};
  const toolRouting = debug.toolRouting || {};
  const kwwk = debug.kwwk || {};
  const visual = debug.visual || {};
  const composition = visual.composition || {};
  const timeline = debugReport?.timeline || debug.timeline?.rows || [];
  const turns = debugReport?.debug?.timeline?.turns || debug.timeline?.turns || [];
  const failureMatrix = buildFailureMatrix(debugReport, debug);
  const diagnosticCanonicalParity = diagnosticCanonicalParityEvidence({ debugReport });
  const primaryBlocker = debugReport?.summaries?.primaryBlocker || null;
  const meetHudTelemetry = debugReport?.summaries?.meetHudTelemetry || null;
  const artifactBundle =
    debugReport?.summaries?.artifactBundle || debug.artifacts?.bundles?.at?.(-1) || null;
  const artifactCount =
    Number(debug?.artifacts?.reportCopyCount || 0) +
    Number(debug?.artifacts?.reportDownloadCount || 0) +
    Number(debug?.artifacts?.interestingMarks?.length || 0);
  const largeArtifactLinks = Number(debug?.artifacts?.largeArtifacts?.length || 0);
  const sectionChecks = {
    timelineHasToolAndKwwk: includesAll(panelState.timeline, [
      "tool_result_accepted",
      "kwwk_blocked",
    ]),
    toolRoutingVisible:
      panelState.toolSummary.includes(`${EXPECTED_TOOL} -> ${EXPECTED_TOOL}`) &&
      panelState.toolTable.includes("Function output") &&
      panelState.toolTable.includes("delivered"),
    kwwkBlockerVisible:
      panelState.kwwkSummary.includes("verification_target_missing") &&
      panelState.kwwkTable.includes("debug_panel_kwwk_job"),
    compositionVisible:
      panelState.composition.includes("1280x720 @30fps") &&
      panelState.visualSources.includes("Host app / host-app") &&
      panelState.visualSources.includes("Avatar / avatar"),
    rawJsonVisible:
      panelState.json.includes("toolRouting") &&
      panelState.json.includes("verification_target_missing"),
    failureMatrixVisible: includesAll(panelState.timeline, [
      "operator_voice_chunk_forward_failed",
      "engine_error",
      "tool_arguments_rejected",
      "assistant_audio_failed",
    ]),
    goodTurnMilestonesVisible: includesAll(panelState.turnCorrelation, [
      "turn_debug_panel_1",
      "heard -> speech -> transcript -> tool -> kwwk -> verify -> output",
    ]),
    perTurnTimelineVisible:
      panelState.turnTimelineRowCount >= 10 &&
      includesAll(panelState.turnTimeline, [
        "turn_debug_panel_1",
        "tool_result_accepted",
        "kwwk_verifying",
        "assistant_text_completed",
      ]),
    primaryBlockerVisible:
      panelState.conversation.includes("Primary blocker") &&
      panelState.conversation.includes("output_audio") &&
      panelState.conversation.includes("output_device_failed"),
    artifactPolicyVisible:
      panelState.artifacts.includes("linked_only") && panelState.json.includes("largeArtifacts"),
    artifactBundleVisible:
      panelState.artifacts.includes("bundle") &&
      Boolean(artifactBundle?.latest || artifactBundle?.entries),
    debugFilterVisible:
      filterEvidence?.query === "verification" &&
      filterEvidence?.kwwkVisible === true &&
      filterEvidence?.matchedRowCount >= 1 &&
      filterEvidence?.hiddenRowCount >= 1 &&
      String(filterEvidence?.visibleText || "").includes("verification_target_missing"),
    debugPanelEmbedded: panelState.embedded,
    debugPanelOpenedFromSurface: panelState.opened,
    meetHudTelemetryAvailable:
      meetHudTelemetry?.schema === "oneesama.lan_operator_hud_telemetry.v1" &&
      meetHudTelemetry?.source === "lan_operator_debug_state" &&
      Array.isArray(meetHudTelemetry?.signals),
  };
  const ok =
    runtimeStatus?.ok === true &&
    toolRouting.actualTool === EXPECTED_TOOL &&
    toolRouting.functionOutputDelivered === true &&
    kwwk.status === "blocked" &&
    kwwk.blocker === "verification_target_missing" &&
    composition.localComposedTrack === true &&
    failureMatrix.observedCount === failureMatrix.expectedCount &&
    primaryBlocker?.layer === "output_audio" &&
    primaryBlocker?.blocker === "output_device_failed" &&
    sectionChecks.meetHudTelemetryAvailable === true &&
    artifactCount >= 2 &&
    largeArtifactLinks >= 1 &&
    Object.values(sectionChecks).every(Boolean);

  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_debug_panel",
    ok,
    functionalOk: ok,
    generatedAt: new Date().toISOString(),
    host: {
      url: listenResult?.url || "",
      lanAddress: listenResult?.host || "",
      trustedLanOperatorMode: true,
      lanModeExplicitlyEnabled: true,
    },
    operatorSurface: {
      id: runtimeStatus?.snapshot?.sessionId || "",
      voiceMode: "always_on",
    },
    conversationEngine: {
      kind: "diagnostic",
      transport: "mock",
      engineId: "diagnostic_debug_panel_engine",
      canonicalEventCounts: debugReport?.summaries?.canonicalConversationEvents || {},
      rawProviderEventsAvailable: false,
      providerRawEventLeakCount: 0,
      diagnosticCanonicalParity,
    },
    debugPanel: {
      densePanelVisible: true,
      embedded: panelState.embedded,
      openedFromSurface: panelState.opened,
      sectionChecks,
      failureMatrix,
      primaryBlocker,
      meetHudTelemetry,
      artifactBundle,
      artifacts: debug.artifacts || {},
      artifactCount,
      largeArtifactLinks,
      filterEvidence,
      timelineText: panelState.timeline,
      turnCorrelationText: panelState.turnCorrelation,
      turnTimelineText: panelState.turnTimeline,
      turnTimelineSummary: panelState.turnTimelineSummary,
      turnTimelineRowCount: panelState.turnTimelineRowCount,
      conversationText: panelState.conversation,
      toolRoutingText: panelState.toolTable,
      kwwkText: panelState.kwwkTable,
      compositionText: panelState.composition,
      visualSourcesText: panelState.visualSources,
      artifactText: panelState.artifacts,
    },
    tool: {
      expectedTool: toolRouting.expectedTool || "",
      actualTool: toolRouting.actualTool || "",
      callId: toolRouting.callId || "",
      argumentSafety: toolRouting.argumentSafety || null,
      functionOutputDelivered: toolRouting.functionOutputDelivered === true,
    },
    kwwk: {
      jobId: kwwk.currentJobId || "",
      status: kwwk.status || "",
      blocker: kwwk.blocker || "",
      latestActionKind: kwwk.latestActionKind || "",
      actionCount: kwwk.actionCount || 0,
      cursorEventCount: kwwk.cursorEventCount || 0,
      timings: kwwk.timings || {},
    },
    visual: {
      transport: "webrtc_video",
      connectionState: visual.connectionState || "",
      trackCount: visual.trackCount || 0,
      sources: visual.sources || [],
      composition,
      operatorScreenBackflow: false,
    },
    artifacts: debug.artifacts || {},
    artifactBundle,
    failureMatrix,
    primaryBlocker,
    meetHudTelemetry,
    timeline,
    turns,
    debugReport,
    timings: {
      totalWallMs: Math.round(performance.now() - startedAt),
      completedMs,
    },
    args: {
      timeoutMs: args.timeoutMs,
      headed: args.headed,
    },
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = performance.now();
  const surface = createLanOperatorSurfaceServer({
    host: args.host,
    port: args.port,
    sessionId: `lan_debug_panel_${Date.now().toString(36)}`,
    botName: "LAN Oneesama",
    conversationEngine: createDebugPanelEngine(),
  });
  let browser = null;
  let listenResult = null;
  let report = null;
  try {
    listenResult = await surface.listen();
    browser = await chromium.launch({ headless: !args.headed });
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const page = await context.newPage();
    await page.goto(listenResult.url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: args.timeoutMs,
    });
    await page.click("#open-debug-panel-button");
    await page.waitForFunction(
      () => document.getElementById("debug-panel")?.dataset.debugPanelOpened === "true",
      null,
      { timeout: args.timeoutMs },
    );
    await page.evaluate(() => {
      window.MAB_LAN_OPERATOR_SURFACE.moveSource("avatar", {
        x: 0.58,
        y: 0.42,
        width: 0.28,
        height: 0.38,
      });
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkOverlay({
        sourceId: "host-app",
        kind: "click",
        x: 0.45,
        y: 0.52,
        label: "Debug panel click",
      });
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({
        sequence: 1,
        sampleRate: 24000,
        channels: 1,
        durationMs: 20,
        energy: 0.42,
        source: "diagnostic_debug_panel_pcm16",
      });
    });
    await waitForRuntimeStatus(
      listenResult.url,
      (body) =>
        body.debug.toolRouting.status === "result_accepted" &&
        body.debug.toolRouting.functionOutputDelivered === true,
      args.timeoutMs,
    );
    await page.evaluate(() => {
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        turnId: "turn_debug_panel_1",
        responseId: "response_debug_panel_1",
        jobId: "debug_panel_good_kwwk_job",
        status: "verifying",
        action: { kind: "click", label: "primary button", status: "completed" },
        cursorEventCountDelta: 1,
        verification: {
          schema: "oneesama.kwwk.verification.v1",
          ok: true,
          status: "passed",
          reason: "fixture target reached",
          checks: [{ name: "target_visible", passed: true }],
        },
        phaseEvidence: {
          verify: {
            status: "passed",
            durationMs: 18,
            summary: "fixture verification passed",
            detail: { checkCount: 1 },
          },
        },
        timings: { executeMs: 61, verifyMs: 18, totalMs: 79 },
      });
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        turnId: "turn_debug_panel_1",
        responseId: "response_debug_panel_1",
        jobId: "debug_panel_good_kwwk_job",
        status: "completed",
        timings: { executeMs: 61, verifyMs: 18, totalMs: 79 },
      });
    });
    await waitForRuntimeStatus(
      listenResult.url,
      (body) => {
        const turn = body.debug.timeline.turns.find((item) => item.turnId === "turn_debug_panel_1");
        return (
          turn?.milestones?.heard === true &&
          turn?.milestones?.speechStarted === true &&
          turn?.milestones?.transcript === true &&
          turn?.milestones?.tool === true &&
          turn?.milestones?.kwwk === true &&
          turn?.milestones?.verification === true &&
          turn?.milestones?.output === true
        );
      },
      args.timeoutMs,
    );
    await page.evaluate(() => {
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({
        sequence: 2,
        sampleRate: 24000,
        channels: 1,
        durationMs: 20,
        energy: 0.35,
        source: "diagnostic_debug_panel_pcm16",
      });
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({
        sequence: 3,
        sampleRate: 24000,
        channels: 1,
        durationMs: 20,
        energy: 0.31,
        source: "diagnostic_debug_panel_pcm16",
      });
    });
    await waitForRuntimeStatus(
      listenResult.url,
      (body) =>
        body.debug.voice.forwardFailures >= 1 &&
        body.debug.conversation.eventCounts.engine_error >= 1 &&
        body.debug.timeline.rows.some((row) => row.event === "tool_arguments_rejected"),
      args.timeoutMs,
    );
    await page.evaluate(() => {
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        jobId: "debug_panel_kwwk_planner_failure",
        status: "failed",
        blocker: "planner_validation_failed",
        target: { app: "DebugPanelFixture", window: "Dense panel" },
        phaseEvidence: {
          plan: {
            status: "failed",
            durationMs: 34,
            summary: "planner rejected unsafe target",
            detail: { blocker: "planner_validation_failed" },
          },
        },
        timings: { observeMs: 12, planMs: 34, totalMs: 46 },
      });
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        jobId: "debug_panel_kwwk_execution_failure",
        status: "failed",
        blocker: "execution_surface_failed",
        action: { kind: "click", label: "primary button", status: "failed" },
        cursorEventCountDelta: 1,
        phaseEvidence: {
          execute: {
            status: "failed",
            durationMs: 88,
            summary: "executor could not focus target surface",
            detail: { blocker: "execution_surface_failed" },
          },
        },
        timings: { executeMs: 88, totalMs: 88 },
      });
      window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState({
        jobId: "debug_panel_kwwk_job",
        status: "blocked",
        blocker: "verification_target_missing",
        action: { kind: "click", label: "primary button", status: "completed" },
        cursorEventCountDelta: 2,
        timings: { executeMs: 88, verifyMs: 21, totalMs: 155 },
      });
      const output = window.MAB_LAN_OPERATOR_SURFACE.state.output.assistantAudio;
      output.status = "failed";
      output.lastError = "output_device_failed";
      window.MAB_LAN_OPERATOR_SURFACE.outputClient()?.emitOutputState?.();
    });
    await waitForRuntimeStatus(
      listenResult.url,
      (body) =>
        body.debug.kwwk.status === "blocked" &&
        body.debug.timeline.rows.some((row) => row.event === "kwwk_blocked") &&
        body.debug.timeline.rows.some((row) => row.event === "assistant_audio_failed"),
      args.timeoutMs,
    );
    await page.waitForFunction(
      () =>
        document.getElementById("debug-timeline-table")?.innerText.includes("kwwk_blocked") &&
        document.getElementById("debug-tool-routing-table")?.innerText.includes("delivered") &&
        document
          .getElementById("debug-kwwk-summary")
          ?.innerText.includes("verification_target_missing") &&
        document
          .getElementById("debug-conversation-table")
          ?.innerText.includes("output_device_failed"),
      null,
      { timeout: args.timeoutMs },
    );
    const completedMs = Math.round(performance.now() - startedAt);
    await page.evaluate(async () => {
      window.MAB_LAN_OPERATOR_SURFACE.registerArtifactLink({
        label: "debug-panel-screen-capture",
        kind: "screenshot",
        href: "artifact://lan-debug-panel/screen-capture.png",
        bytes: 524288,
        contentType: "image/png",
        reason: "large_visual_debug_artifact",
      });
      await window.MAB_LAN_OPERATOR_SURFACE.copyDiagnostics();
      window.MAB_LAN_OPERATOR_SURFACE.markInterestingRun({ label: "lan_debug_panel_benchmark" });
      await window.MAB_LAN_OPERATOR_SURFACE.createDebugBundle({ label: "lan_debug_panel_bundle" });
    });
    const artifactStatus = await waitForRuntimeStatus(
      listenResult.url,
      (body) =>
        body.debug.artifacts.reportCopyCount >= 1 &&
        body.debug.artifacts.interestingMarks.length >= 1 &&
        body.debug.artifacts.largeArtifacts.length >= 1 &&
        body.debug.artifacts.bundleCount >= 1,
      args.timeoutMs,
    );
    const panelState = await visibleDebugPanelState(page);
    const filterEvidence = await visibleDebugFilterState(page, "verification");
    const debugReport = await fetchDebugReport(listenResult.url);
    report = buildBenchmarkReport({
      args,
      listenResult,
      runtimeStatus: artifactStatus,
      debugReport,
      panelState,
      filterEvidence,
      startedAt,
      completedMs,
    });
    await context.close();
  } catch (error) {
    const runtimeStatus = surface.status("failed");
    const debugReport = listenResult
      ? await fetchDebugReport(listenResult.url).catch(() => null)
      : null;
    report = {
      schema: "oneesama.lan_voice_acceptance.v1",
      gate: "local_debug_panel",
      ok: false,
      functionalOk: false,
      generatedAt: new Date().toISOString(),
      error: String(error?.message || error),
      host: { url: listenResult?.url || "" },
      debugReport,
      runtimeStatus,
    };
  } finally {
    await browser?.close();
    await surface.close();
  }

  report = attachLanAcceptanceSlo(report);
  await writeJson(args.jsonOut, report);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        functionalOk: report.functionalOk,
        sloOk: report.slo?.ok,
        jsonOut: args.jsonOut,
        gate: report.gate,
      },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
}

await run();
