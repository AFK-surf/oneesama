#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { chromium } from "playwright";

import {
  createOpenAIRealtimeConversationEngine,
  createOpenAIRealtimeWebSocketTransport,
} from "../packages/core/src/operator/lan-operator-openai-realtime-adapter.ts";
import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import {
  buildRealtimeSessionConfig,
  realtimeToolSchemas,
} from "../packages/core/src/realtime/realtime-contract.ts";
import { attachLanAcceptanceSlo } from "./lan-operator-acceptance-slo.mjs";
import {
  attachOpenAIRealtimeFailureDiagnostics,
  sanitizeOpenAIProviderText,
} from "./lan-operator-openai-live-diagnostics.mjs";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-openai-tool-live-latest.json";
const DEFAULT_MODEL = "gpt-realtime-2";
const EXPECTED_TOOL = "kwwk_computer_use";
const DEFAULT_COMMAND = "In the shared Chrome window, switch to the first browser tab.";

function defaultApiKey() {
  if (process.env.ONEESAMA_OPENAI_API_KEY) {
    return { value: process.env.ONEESAMA_OPENAI_API_KEY, source: "ONEESAMA_OPENAI_API_KEY" };
  }
  if (process.env.MAB_OPENAI_API_KEY) {
    return { value: process.env.MAB_OPENAI_API_KEY, source: "MAB_OPENAI_API_KEY" };
  }
  if (process.env.OPENAI_API_KEY) {
    return { value: process.env.OPENAI_API_KEY, source: "OPENAI_API_KEY" };
  }
  return { value: "", source: "" };
}

function defaultModel() {
  return (
    process.env.MAB_LAN_OPENAI_REALTIME_MODEL ||
    process.env.MAB_OPENAI_REALTIME_MODEL ||
    process.env.OPENAI_REALTIME_MODEL ||
    DEFAULT_MODEL
  );
}

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 0,
    timeoutMs: 45_000,
    connectTimeoutMs: 10_000,
    drainMs: 1500,
    jsonOut: DEFAULT_JSON_OUT,
    headed: false,
    optional: false,
    command: DEFAULT_COMMAND,
    model: defaultModel(),
    url: process.env.MAB_LAN_OPENAI_REALTIME_URL || process.env.MAB_OPENAI_REALTIME_URL || "",
    toolChoice: process.env.MAB_LAN_OPENAI_REALTIME_TOOL_CHOICE || "auto",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--connect-timeout-ms") args.connectTimeoutMs = Number(argv[++index]);
    else if (arg === "--drain-ms") args.drainMs = Number(argv[++index]);
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--command") args.command = argv[++index];
    else if (arg === "--model") args.model = argv[++index];
    else if (arg === "--url") args.url = argv[++index];
    else if (arg === "--tool-choice") args.toolChoice = argv[++index];
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--optional") args.optional = true;
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
  console.log(`Usage: node --import tsx scripts/lan-operator-openai-realtime-tool-live-benchmark.mjs [options]

Options:
  --host <host>                Bind host (default: 127.0.0.1)
  --port <port>                Bind port, 0 means random (default: 0)
  --timeout-ms <n>             Live tool gate timeout (default: 45000)
  --connect-timeout-ms <n>     OpenAI Realtime WebSocket connect timeout (default: 10000)
  --drain-ms <n>               Provider event drain window after each send (default: 1500)
  --command <text>             Operator text turn sent through the LAN Surface
  --model <model>              Realtime model (default: ${DEFAULT_MODEL} or env)
  --url <wss-url>              Override Realtime WebSocket URL
  --tool-choice <mode>         Realtime tool choice (default: auto)
  --json-out <path>            Write structured report (default: ${DEFAULT_JSON_OUT})
  --headed                     Run Chromium headed
  --optional                   Exit 0 only when skipped because no OpenAI key is present
`);
}

function sanitizeProviderText(value) {
  return sanitizeOpenAIProviderText(value);
}

function kwwkToolSchema() {
  const tool = realtimeToolSchemas.find((entry) => entry.name === EXPECTED_TOOL);
  if (!tool) throw new Error("kwwk_computer_use_schema_missing");
  return tool;
}

function liveToolSession(args) {
  const tool = kwwkToolSchema();
  return buildRealtimeSessionConfig({
    model: args.model,
    outputModalities: ["text"],
    tools: [tool],
    toolChoice: args.toolChoice,
    inputAudioTranscription: null,
    turnDetection: null,
    reasoningEffort: "none",
    instructions: [
      "You are running Oneesama's LAN Operator Surface live Realtime tool-routing acceptance probe.",
      `The only exposed functional action is ${EXPECTED_TOOL}.`,
      `For the user's app-control request, call ${EXPECTED_TOOL} exactly once before any text response.`,
      "Arguments must be high-level only: instruction, applicationName, and windowTitle. Do not emit click coordinates, operation arrays, or low-level primitives.",
      "Use applicationName Chrome and windowTitle LAN tool routing fixture when the target is not otherwise specified.",
    ].join("\n"),
  });
}

function providerCountsFrom(debug, debugReport) {
  return (
    debugReport?.summaries?.conversationPort?.providerEventCounts ||
    debug?.conversation?.provider?.providerEventCounts ||
    {}
  );
}

function canonicalCountsFrom(debug, debugReport) {
  return (
    debugReport?.summaries?.conversationPort?.canonicalEventCounts ||
    debug?.conversation?.eventCounts ||
    {}
  );
}

function providerEventTotal(providerEventCounts) {
  return Object.values(providerEventCounts || {}).reduce(
    (total, value) => total + Number(value || 0),
    0,
  );
}

function providerToolCallEventCount(providerEventCounts) {
  return [
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.added",
    "response.output_item.done",
    "response.done",
  ].reduce((total, key) => total + Number(providerEventCounts?.[key] || 0), 0);
}

function providerTextEventCount(providerEventCounts) {
  return [
    "response.output_text.delta",
    "response.output_text.done",
    "response.text.delta",
    "response.text.done",
    "response.output_audio_transcript.delta",
    "response.output_audio_transcript.done",
  ].reduce((total, key) => total + Number(providerEventCounts?.[key] || 0), 0);
}

function timeoutSummary(body) {
  const conversation = body?.debug?.conversation || {};
  const toolRouting = body?.debug?.toolRouting || {};
  const providerEventCounts = conversation.provider?.providerEventCounts || {};
  return {
    ok: body?.ok === true,
    health: body?.snapshot?.health || "",
    conversationStatus: conversation.status || "",
    engineId: conversation.engineId || "",
    providerAdapterKind: conversation.provider?.adapterKind || "",
    providerEventCounts,
    canonicalEventCounts: conversation.eventCounts || {},
    providerToolCallEventCount: providerToolCallEventCount(providerEventCounts),
    toolRouting: {
      expectedTool: toolRouting.expectedTool || "",
      actualTool: toolRouting.actualTool || "",
      status: toolRouting.status || "",
      argumentSafety: toolRouting.argumentSafety || null,
      functionOutputDelivered: toolRouting.functionOutputDelivered === true,
    },
    errors: (conversation.errors || []).slice(-4).map((entry) => ({
      ts: entry?.ts || "",
      error: sanitizeProviderText(entry?.error || ""),
    })),
  };
}

async function waitForRuntimeStatus(url, predicate, timeoutMs, failPredicate = null) {
  const statusUrl = new URL("/runtime/status", url);
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(statusUrl)).json();
    lastBody = body;
    if (predicate(body)) return body;
    if (failPredicate?.(body)) {
      throw new Error(`runtime_status_failed:${JSON.stringify(timeoutSummary(body))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`runtime_status_timeout:${JSON.stringify(timeoutSummary(lastBody))}`);
}

async function fetchDebugReport(url) {
  const body = await (await fetch(new URL("/runtime/report", url))).json();
  return body.report || body;
}

function buildAcceptanceReport(input) {
  const {
    args,
    listenResult,
    runtimeStatus,
    debugReport,
    clientState,
    startedAt,
    readyMs,
    connectedMs,
    toolCallMs,
    completedMs,
    apiKeySource,
  } = input;
  const debug = runtimeStatus?.debug || {};
  const conversation = debug.conversation || {};
  const toolRouting = debug.toolRouting || {};
  const providerEventCounts = providerCountsFrom(debug, debugReport);
  const canonicalEventCounts = canonicalCountsFrom(debug, debugReport);
  const rawProviderEventsAvailable =
    debugReport?.summaries?.conversationPort?.rawEventDrilldownAvailable === true ||
    conversation.provider?.rawEventDrilldownAvailable === true;
  const providerAdapterKind =
    debugReport?.summaries?.conversationPort?.providerAdapterKind ||
    conversation.provider?.adapterKind ||
    "";
  const failedRows = (debugReport?.timeline || debug.timeline?.rows || []).filter(
    (row) => row.ok === false,
  );
  const ok =
    runtimeStatus?.ok === true &&
    providerAdapterKind === "openai_realtime" &&
    conversation.engineId === "openai_realtime" &&
    conversation.status === "connected" &&
    Number(providerEventCounts["session.created"] || 0) >= 1 &&
    providerToolCallEventCount(providerEventCounts) >= 1 &&
    toolRouting.expectedTool === EXPECTED_TOOL &&
    toolRouting.actualTool === EXPECTED_TOOL &&
    toolRouting.argumentSafety?.ok === true &&
    toolRouting.functionOutputDelivered === true &&
    Number(canonicalEventCounts.tool_call_started || 0) >= 1 &&
    Number(canonicalEventCounts.tool_call_completed || 0) >= 1 &&
    Number(canonicalEventCounts.tool_result_accepted || 0) >= 1 &&
    providerTextEventCount(providerEventCounts) >= 1 &&
    rawProviderEventsAvailable &&
    failedRows.length === 0;

  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_openai_realtime_tool_live",
    ok,
    functionalOk: ok,
    diagnosticOnly: false,
    skipped: false,
    acceptanceSatisfied: ok,
    generatedAt: new Date().toISOString(),
    host: {
      url: listenResult?.url || "",
      lanAddress: listenResult?.host || "",
      trustedLanOperatorMode: true,
      lanModeExplicitlyEnabled: true,
    },
    operatorSurface: {
      id: runtimeStatus?.snapshot?.sessionId || "",
      userAgent: clientState?.userAgent || "",
      readyMs,
      connectedMs,
      toolCallMs,
      completedMs,
      textInputSent: clientState?.lastTextInput?.sent === true,
      toolResultSubmitted: clientState?.toolResultSubmitted === true,
    },
    conversationEngine: {
      kind: "openai_realtime",
      transport: "openai_realtime",
      engineId: conversation.engineId || "",
      sessionId: runtimeStatus?.snapshot?.sessionId || "",
      status: conversation.status || "",
      connected: conversation.status === "connected",
      providerAdapterKind,
      providerEventCounts,
      providerEventTotal: providerEventTotal(providerEventCounts),
      providerToolCallEventCount: providerToolCallEventCount(providerEventCounts),
      providerTextEventCount: providerTextEventCount(providerEventCounts),
      rawProviderEventsAvailable,
      latestProviderEventType:
        debugReport?.summaries?.conversationPort?.latestProviderEventType ||
        conversation.provider?.latestProviderEventType ||
        "",
      recentProviderEvents:
        debugReport?.summaries?.conversationPort?.recentProviderEvents ||
        conversation.provider?.recentEvents ||
        [],
      canonicalEventCounts,
      latestCanonicalEvent:
        debugReport?.summaries?.conversationPort?.latestCanonicalEvent ||
        conversation.canonicalEvents?.at(-1)?.type ||
        "",
    },
    provider: {
      name: "openai",
      realtimeModel: args.model,
      apiKeySource,
      urlOverridden: Boolean(args.url),
      toolsExposed: [EXPECTED_TOOL],
      toolChoice: args.toolChoice,
      responseCreate: { output_modalities: ["text"] },
      rawPayloadStored: false,
      rawEventSummariesStored: rawProviderEventsAvailable,
    },
    tool: {
      expectedTool: toolRouting.expectedTool || "",
      actualTool: toolRouting.actualTool || "",
      callId: toolRouting.callId || "",
      itemId: toolRouting.itemId || "",
      status: toolRouting.status || "",
      arguments: toolRouting.parsedArguments || null,
      argumentSafety: toolRouting.argumentSafety || null,
      functionOutputDelivered: toolRouting.functionOutputDelivered === true,
      functionOutput: toolRouting.functionOutput || null,
    },
    timeline: debugReport?.timeline || debug.timeline?.rows || [],
    turns: debugReport?.debug?.timeline?.turns || debug.timeline?.turns || [],
    debugReport,
    timings: {
      totalWallMs: Math.round(performance.now() - startedAt),
      readyMs,
      connectedMs,
      toolCallMs,
      completedMs,
      providerDrainMs: args.drainMs,
    },
    failureRows: failedRows,
    args: {
      timeoutMs: args.timeoutMs,
      connectTimeoutMs: args.connectTimeoutMs,
      drainMs: args.drainMs,
      headed: args.headed,
      optional: args.optional,
      command: args.command,
      model: args.model,
      toolChoice: args.toolChoice,
      urlOverridden: Boolean(args.url),
    },
  };
}

function skippedReport(args, apiKeySource, reason) {
  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_openai_realtime_tool_live",
    ok: false,
    functionalOk: false,
    diagnosticOnly: false,
    skipped: true,
    acceptanceSatisfied: false,
    generatedAt: new Date().toISOString(),
    blocker: reason,
    host: { url: "" },
    operatorSurface: { readyMs: null, connectedMs: null, toolCallMs: null, completedMs: null },
    conversationEngine: {
      kind: "openai_realtime",
      transport: "openai_realtime",
      engineId: "openai_realtime",
      status: "skipped",
      providerAdapterKind: "",
      providerEventCounts: {},
      providerEventTotal: 0,
      providerToolCallEventCount: 0,
      providerTextEventCount: 0,
      rawProviderEventsAvailable: false,
      canonicalEventCounts: {},
      latestCanonicalEvent: "",
    },
    provider: {
      name: "openai",
      realtimeModel: args.model,
      apiKeySource,
      urlOverridden: Boolean(args.url),
      toolsExposed: [EXPECTED_TOOL],
      toolChoice: args.toolChoice,
      responseCreate: { output_modalities: ["text"] },
      rawPayloadStored: false,
      rawEventSummariesStored: false,
    },
    tool: {
      expectedTool: EXPECTED_TOOL,
      actualTool: "",
      functionOutputDelivered: false,
    },
    timeline: [],
    turns: [],
    timings: {
      totalWallMs: 0,
      readyMs: null,
      connectedMs: null,
      toolCallMs: null,
      completedMs: null,
    },
    args: {
      timeoutMs: args.timeoutMs,
      connectTimeoutMs: args.connectTimeoutMs,
      drainMs: args.drainMs,
      headed: args.headed,
      optional: args.optional,
      command: args.command,
      model: args.model,
      toolChoice: args.toolChoice,
      urlOverridden: Boolean(args.url),
    },
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runLive(args, apiKey, apiKeySource) {
  const startedAt = performance.now();
  const session = liveToolSession(args);
  const conversationEngine = createOpenAIRealtimeConversationEngine({
    transport: createOpenAIRealtimeWebSocketTransport({
      apiKey,
      model: args.model,
      url: args.url || undefined,
      connectTimeoutMs: args.connectTimeoutMs,
      drainMs: args.drainMs,
      session,
      response: {
        output_modalities: ["text"],
        tool_choice: args.toolChoice,
      },
    }),
  });
  const surface = createLanOperatorSurfaceServer({
    host: args.host,
    port: args.port,
    sessionId: `lan_openai_tool_live_${Date.now().toString(36)}`,
    botName: "LAN Oneesama",
    conversationTransport: "openai_realtime",
    conversationEngine,
  });
  let browser = null;
  let listenResult = null;
  try {
    listenResult = await surface.listen();
    browser = await chromium.launch({
      headless: !args.headed,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    });
    const context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1366, height: 860 },
    });
    const page = await context.newPage();
    await page.goto(listenResult.url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: args.timeoutMs,
    });
    await waitForRuntimeStatus(
      listenResult.url,
      (body) => body.debug?.transport?.events?.state === "open",
      args.timeoutMs,
    );
    const readyMs = Math.round(performance.now() - startedAt);
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("connect", {
        reason: "lan_openai_realtime_tool_live_gate",
      }),
    );
    await waitForRuntimeStatus(
      listenResult.url,
      (body) =>
        body.debug?.conversation?.engineId === "openai_realtime" &&
        body.debug?.conversation?.status === "connected" &&
        Number(body.debug?.conversation?.provider?.providerEventCounts?.["session.created"] || 0) >=
          1,
      args.timeoutMs,
      (body) => body.debug?.conversation?.status === "failed",
    );
    const connectedMs = Math.round(performance.now() - startedAt);
    const textResult = await page.evaluate(
      (command) => window.MAB_LAN_OPERATOR_SURFACE.sendTextInput(command),
      args.command,
    );
    if (!textResult?.ok) {
      throw new Error(
        `operator_text_input_send_failed:${sanitizeProviderText(textResult?.error || "unknown")}`,
      );
    }
    await waitForRuntimeStatus(
      listenResult.url,
      (body) => {
        const providerCounts = body.debug?.conversation?.provider?.providerEventCounts || {};
        const canonicalCounts = body.debug?.conversation?.eventCounts || {};
        const toolRouting = body.debug?.toolRouting || {};
        return (
          toolRouting.actualTool === EXPECTED_TOOL &&
          toolRouting.argumentSafety?.ok === true &&
          Number(canonicalCounts.tool_call_completed || 0) >= 1 &&
          providerToolCallEventCount(providerCounts) >= 1
        );
      },
      args.timeoutMs,
      (body) => body.debug?.conversation?.status === "failed",
    );
    const toolCallMs = Math.round(performance.now() - startedAt);
    const submitResult = await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.submitToolResult({
        status: "completed",
        source: "kwwk",
        jobId: "lan_openai_tool_live_job",
        output: {
          ok: true,
          status: "queued",
          jobId: "lan_openai_tool_live_job",
          provider: "live_openai_tool_gate",
        },
      }),
    );
    if (!submitResult) throw new Error("operator_tool_result_submit_failed");
    const runtimeStatus = await waitForRuntimeStatus(
      listenResult.url,
      (body) => {
        const providerCounts = body.debug?.conversation?.provider?.providerEventCounts || {};
        const canonicalCounts = body.debug?.conversation?.eventCounts || {};
        const toolRouting = body.debug?.toolRouting || {};
        return (
          toolRouting.actualTool === EXPECTED_TOOL &&
          toolRouting.argumentSafety?.ok === true &&
          toolRouting.functionOutputDelivered === true &&
          Number(canonicalCounts.tool_result_accepted || 0) >= 1 &&
          providerTextEventCount(providerCounts) >= 1
        );
      },
      args.timeoutMs,
      (body) => body.debug?.conversation?.status === "failed",
    );
    const completedMs = Math.round(performance.now() - startedAt);
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.markInterestingRun({
        label: "lan_openai_realtime_tool_live",
        note: "live provider tool-routing evidence gate",
      }),
    );
    const clientState = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      lastTextInput: window.MAB_LAN_OPERATOR_SURFACE.state.lastTextInput || null,
      toolResultSubmitted:
        window.MAB_LAN_OPERATOR_SURFACE.state.toolRouting?.functionOutputDelivered === true,
    }));
    const debugReport = await fetchDebugReport(listenResult.url);
    await context.close();
    return buildAcceptanceReport({
      args,
      listenResult,
      runtimeStatus,
      debugReport,
      clientState,
      startedAt,
      readyMs,
      connectedMs,
      toolCallMs,
      completedMs,
      apiKeySource,
    });
  } catch (error) {
    const runtimeStatus = surface.status("failed");
    const debugReport = listenResult
      ? await fetchDebugReport(listenResult.url).catch(() => null)
      : null;
    return {
      schema: "oneesama.lan_voice_acceptance.v1",
      gate: "local_openai_realtime_tool_live",
      ok: false,
      functionalOk: false,
      diagnosticOnly: false,
      skipped: false,
      acceptanceSatisfied: false,
      generatedAt: new Date().toISOString(),
      error: sanitizeProviderText(error?.message || error),
      host: { url: listenResult?.url || "" },
      conversationEngine: {
        kind: "openai_realtime",
        transport: "openai_realtime",
        engineId: runtimeStatus?.debug?.conversation?.engineId || "openai_realtime",
        status: runtimeStatus?.debug?.conversation?.status || "failed",
        providerAdapterKind: runtimeStatus?.debug?.conversation?.provider?.adapterKind || "",
        providerEventCounts:
          runtimeStatus?.debug?.conversation?.provider?.providerEventCounts || {},
        providerEventTotal: providerEventTotal(
          runtimeStatus?.debug?.conversation?.provider?.providerEventCounts || {},
        ),
        providerToolCallEventCount: providerToolCallEventCount(
          runtimeStatus?.debug?.conversation?.provider?.providerEventCounts || {},
        ),
        providerTextEventCount: providerTextEventCount(
          runtimeStatus?.debug?.conversation?.provider?.providerEventCounts || {},
        ),
        rawProviderEventsAvailable:
          runtimeStatus?.debug?.conversation?.provider?.rawEventDrilldownAvailable === true,
        canonicalEventCounts: runtimeStatus?.debug?.conversation?.eventCounts || {},
        latestCanonicalEvent:
          runtimeStatus?.debug?.conversation?.canonicalEvents?.at(-1)?.type || "",
      },
      provider: {
        name: "openai",
        realtimeModel: args.model,
        apiKeySource,
        urlOverridden: Boolean(args.url),
        toolsExposed: [EXPECTED_TOOL],
        toolChoice: args.toolChoice,
        responseCreate: { output_modalities: ["text"] },
        rawPayloadStored: false,
      },
      tool: runtimeStatus?.debug?.toolRouting || { expectedTool: EXPECTED_TOOL },
      timeline: debugReport?.timeline || runtimeStatus?.debug?.timeline?.rows || [],
      turns: debugReport?.debug?.timeline?.turns || runtimeStatus?.debug?.timeline?.turns || [],
      debugReport,
      runtimeStatus,
      timings: {
        totalWallMs: Math.round(performance.now() - startedAt),
        providerDrainMs: args.drainMs,
      },
      args: {
        timeoutMs: args.timeoutMs,
        connectTimeoutMs: args.connectTimeoutMs,
        drainMs: args.drainMs,
        headed: args.headed,
        optional: args.optional,
        command: args.command,
        model: args.model,
        toolChoice: args.toolChoice,
        urlOverridden: Boolean(args.url),
      },
    };
  } finally {
    await browser?.close();
    await surface.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { value: apiKey, source: apiKeySource } = defaultApiKey();
  let report = null;
  if (!apiKey) {
    report = skippedReport(args, apiKeySource, "openai_realtime_api_key_missing");
  } else {
    report = await runLive(args, apiKey, apiKeySource);
  }
  report = attachOpenAIRealtimeFailureDiagnostics(attachLanAcceptanceSlo(report));
  await writeJson(args.jsonOut, report);
  const shouldExitZero = report.ok === true || (report.skipped === true && args.optional);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        functionalOk: report.functionalOk,
        sloOk: report.slo?.ok,
        skipped: report.skipped === true,
        acceptanceSatisfied: report.acceptanceSatisfied === true,
        sloFailures: report.slo?.failures?.map((failure) => failure.id) || [],
        acceptanceBlocker: report.acceptanceBlocker || "",
        providerFailure: report.provider?.failure || null,
        providerEventCounts: report.conversationEngine?.providerEventCounts || {},
        providerToolCallEventCount: report.conversationEngine?.providerToolCallEventCount || 0,
        tool: {
          expectedTool: report.tool?.expectedTool || "",
          actualTool: report.tool?.actualTool || "",
          functionOutputDelivered: report.tool?.functionOutputDelivered === true,
        },
        jsonOut: args.jsonOut,
        gate: report.gate,
      },
      null,
      2,
    ),
  );
  process.exit(shouldExitZero ? 0 : 1);
}

main().catch(async (error) => {
  const args = parseArgs(process.argv.slice(2));
  const report = attachOpenAIRealtimeFailureDiagnostics(
    attachLanAcceptanceSlo({
      schema: "oneesama.lan_voice_acceptance.v1",
      gate: "local_openai_realtime_tool_live",
      ok: false,
      functionalOk: false,
      diagnosticOnly: false,
      skipped: false,
      acceptanceSatisfied: false,
      generatedAt: new Date().toISOString(),
      error: sanitizeProviderText(error?.message || error),
    }),
  );
  await writeJson(args.jsonOut, report);
  console.error(JSON.stringify({ ok: false, error: report.error, jsonOut: args.jsonOut }, null, 2));
  process.exit(1);
});
