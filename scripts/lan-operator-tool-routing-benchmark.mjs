#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import { attachLanAcceptanceSlo } from "./lan-operator-acceptance-slo.mjs";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-tool-routing-latest.json";
const EXPECTED_TOOL = "kwwk_computer_use";

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 0,
    timeoutMs: 10_000,
    jsonOut: DEFAULT_JSON_OUT,
    headed: false,
    command: "switch to the first browser tab",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--command") args.command = argv[++index];
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
  console.log(`Usage: node --import tsx scripts/lan-operator-tool-routing-benchmark.mjs [options]

Options:
  --host <host>         Bind host (default: 127.0.0.1)
  --port <port>         Bind port, 0 means random (default: 0)
  --timeout-ms <n>      Benchmark timeout (default: 10000)
  --command <text>      Synthetic operator command
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

function createToolRoutingEngine(command) {
  const toolArguments = {
    instruction: command,
    target: {
      applicationName: "Chromium",
      windowTitle: "LAN tool routing fixture",
    },
  };
  return {
    id: "diagnostic_tool_routing_engine",
    receiveVoiceChunk(chunk) {
      const ts = nowIso();
      const turnId = `turn_tool_route_${Number(chunk.sequence || 1)}`;
      const responseId = `response_tool_route_${Number(chunk.sequence || 1)}`;
      return {
        result: { ok: true, engineId: this.id },
        events: [
          {
            id: "lan_tool_route_engine_connected",
            ts,
            sessionId: chunk.sessionId,
            type: "engine_connected",
            engineId: this.id,
          },
          {
            id: "lan_tool_route_speech_started",
            ts,
            sessionId: chunk.sessionId,
            type: "speech_started",
            engineId: this.id,
            turnId,
          },
          {
            id: "lan_tool_route_transcript_completed",
            ts,
            sessionId: chunk.sessionId,
            type: "transcript_completed",
            engineId: this.id,
            turnId,
            text: command,
          },
          {
            id: "lan_tool_route_started",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_call_started",
            engineId: this.id,
            turnId,
            responseId,
            itemId: "item_lan_tool_route",
            detail: {
              expectedTool: EXPECTED_TOOL,
              name: EXPECTED_TOOL,
              callId: "call_lan_tool_route",
            },
          },
          {
            id: "lan_tool_route_completed",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_call_completed",
            engineId: this.id,
            turnId,
            responseId,
            itemId: "item_lan_tool_route",
            text: JSON.stringify(toolArguments),
            detail: {
              expectedTool: EXPECTED_TOOL,
              name: EXPECTED_TOOL,
              callId: "call_lan_tool_route",
            },
          },
          {
            id: "lan_tool_route_result",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_result_accepted",
            engineId: this.id,
            turnId,
            responseId,
            itemId: "item_lan_tool_route",
            text: JSON.stringify({
              ok: true,
              jobId: "lan_tool_route_job",
              status: "queued",
              provider: "diagnostic",
            }),
            detail: {
              expectedTool: EXPECTED_TOOL,
              name: EXPECTED_TOOL,
              callId: "call_lan_tool_route",
            },
          },
          {
            id: "lan_tool_route_assistant_completed",
            ts,
            sessionId: chunk.sessionId,
            type: "assistant_text_completed",
            engineId: this.id,
            turnId,
            responseId,
            text: "queued the app-control job",
          },
        ],
      };
    },
  };
}

function buildBenchmarkReport(input) {
  const { args, listenResult, runtimeStatus, debugReport, startedAt, completedMs } = input;
  const debug = runtimeStatus?.debug || {};
  const toolRouting = debug.toolRouting || {};
  const eventCounts = debug.conversation?.eventCounts || {};
  const timeline = debugReport?.timeline || debug.timeline?.rows || [];
  const turns = debugReport?.debug?.timeline?.turns || debug.timeline?.turns || [];
  const rejectedArguments = timeline.some((row) => row.event === "tool_arguments_rejected");
  const ok =
    runtimeStatus?.ok === true &&
    toolRouting.expectedTool === EXPECTED_TOOL &&
    toolRouting.actualTool === EXPECTED_TOOL &&
    toolRouting.functionOutputDelivered === true &&
    toolRouting.argumentSafety?.ok === true &&
    eventCounts.tool_call_started >= 1 &&
    eventCounts.tool_call_completed >= 1 &&
    eventCounts.tool_result_accepted >= 1 &&
    !rejectedArguments;

  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_tool_routing",
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
      sessionId: runtimeStatus?.snapshot?.sessionId || "",
      canonicalEventCounts: eventCounts,
      latestCanonicalEvent: debug.conversation?.canonicalEvents?.at(-1)?.type || "",
      rawProviderEventsAvailable: false,
    },
    tool: {
      expectedTool: toolRouting.expectedTool || "",
      actualTool: toolRouting.actualTool || "",
      callId: toolRouting.callId || "",
      arguments: toolRouting.parsedArguments || null,
      argumentSafety: toolRouting.argumentSafety || null,
      functionOutputDelivered: toolRouting.functionOutputDelivered === true,
      functionOutput: toolRouting.functionOutput || null,
      canonicalBoundary: {
        schema: "oneesama.canonical_tool_boundary.v1",
        source: "conversation_engine_port",
        providerAgnostic: true,
        canonicalToolEventCount:
          Number(eventCounts.tool_call_started || 0) +
          Number(eventCounts.tool_call_completed || 0) +
          Number(eventCounts.tool_result_accepted || 0),
        providerRawEventLeakCount: 0,
        rawOperationsExposed: toolRouting.argumentSafety?.exposesRawOperations === true,
        coordinatesExposed: toolRouting.argumentSafety?.exposesCoordinates === true,
      },
    },
    timeline,
    turns,
    debugReport,
    timings: {
      totalWallMs: Math.round(performance.now() - startedAt),
      completedMs,
    },
    args: {
      command: args.command,
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
    sessionId: `lan_tool_routing_${Date.now().toString(36)}`,
    botName: "LAN Oneesama",
    conversationEngine: createToolRoutingEngine(args.command),
  });
  let browser = null;
  let report = null;
  let listenResult = null;
  try {
    listenResult = await surface.listen();
    browser = await chromium.launch({ headless: !args.headed });
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const page = await context.newPage();
    await page.goto(listenResult.url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: args.timeoutMs,
    });
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({
        sequence: 1,
        sampleRate: 24000,
        channels: 1,
        durationMs: 20,
        energy: 0.42,
        source: "diagnostic_tool_routing_pcm16",
      }),
    );
    const runtimeStatus = await waitForRuntimeStatus(
      listenResult.url,
      (body) =>
        body.debug.toolRouting.status === "result_accepted" &&
        body.debug.toolRouting.functionOutputDelivered === true,
      args.timeoutMs,
    );
    const completedMs = Math.round(performance.now() - startedAt);
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.markInterestingRun({ label: "lan_tool_routing_benchmark" }),
    );
    const debugReport = await fetchDebugReport(listenResult.url);
    report = buildBenchmarkReport({
      args,
      listenResult,
      runtimeStatus,
      debugReport,
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
      gate: "local_tool_routing",
      ok: false,
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

await run();
