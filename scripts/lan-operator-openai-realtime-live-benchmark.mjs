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
import { attachLanAcceptanceSlo } from "./lan-operator-acceptance-slo.mjs";
import {
  attachOpenAIRealtimeFailureDiagnostics,
  sanitizeOpenAIProviderText,
} from "./lan-operator-openai-live-diagnostics.mjs";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-openai-live-latest.json";
const DEFAULT_TEXT =
  "LAN live Realtime acceptance probe. Reply with exactly these three words: LAN LIVE OK";
const DEFAULT_MODEL = "gpt-realtime-2";

function defaultApiKey() {
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
    timeoutMs: 30_000,
    connectTimeoutMs: 10_000,
    drainMs: 6_000,
    jsonOut: DEFAULT_JSON_OUT,
    headed: false,
    optional: false,
    text: DEFAULT_TEXT,
    model: defaultModel(),
    url: process.env.MAB_LAN_OPENAI_REALTIME_URL || process.env.MAB_OPENAI_REALTIME_URL || "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--connect-timeout-ms") args.connectTimeoutMs = Number(argv[++index]);
    else if (arg === "--drain-ms") args.drainMs = Number(argv[++index]);
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--text") args.text = argv[++index];
    else if (arg === "--model") args.model = argv[++index];
    else if (arg === "--url") args.url = argv[++index];
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
  console.log(`Usage: node --import tsx scripts/lan-operator-openai-realtime-live-benchmark.mjs [options]

Options:
  --host <host>                Bind host (default: 127.0.0.1)
  --port <port>                Bind port, 0 means random (default: 0)
  --timeout-ms <n>             Live gate timeout (default: 30000)
  --connect-timeout-ms <n>     OpenAI Realtime WebSocket connect timeout (default: 10000)
  --drain-ms <n>               Provider event drain window after each send (default: 6000)
  --text <text>                Text turn sent through the LAN Operator Surface
  --model <model>              Realtime model (default: ${DEFAULT_MODEL} or env)
  --url <wss-url>              Override Realtime WebSocket URL
  --json-out <path>            Write structured report (default: ${DEFAULT_JSON_OUT})
  --headed                     Run Chromium headed
  --optional                   Exit 0 only when skipped because no OpenAI key is present
`);
}

function sanitizeProviderText(value) {
  return sanitizeOpenAIProviderText(value);
}

function timeoutSummary(body) {
  const conversation = body?.debug?.conversation || {};
  const errors = Array.isArray(conversation.errors) ? conversation.errors : [];
  return {
    ok: body?.ok === true,
    health: body?.snapshot?.health || "",
    conversationStatus: conversation.status || "",
    engineId: conversation.engineId || "",
    providerAdapterKind: conversation.provider?.adapterKind || "",
    providerEventCounts: conversation.provider?.providerEventCounts || {},
    canonicalEventCounts: conversation.eventCounts || {},
    errors: errors.slice(-4).map((entry) => ({
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
      throw new Error(`runtime_status_failed: ${JSON.stringify(timeoutSummary(body))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`runtime_status_timeout: ${JSON.stringify(timeoutSummary(lastBody))}`);
}

async function fetchDebugReport(url) {
  const body = await (await fetch(new URL("/runtime/report", url))).json();
  return body.report || body;
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

function providerEventTotal(providerEventCounts) {
  return Object.values(providerEventCounts || {}).reduce(
    (total, value) => total + Number(value || 0),
    0,
  );
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
    completedMs,
    apiKeySource,
  } = input;
  const debug = runtimeStatus?.debug || {};
  const conversation = debug.conversation || {};
  const providerEventCounts = providerCountsFrom(debug, debugReport);
  const canonicalEventCounts = canonicalCountsFrom(debug, debugReport);
  const rawProviderEventsAvailable =
    debugReport?.summaries?.conversationPort?.rawEventDrilldownAvailable === true ||
    conversation.provider?.rawEventDrilldownAvailable === true;
  const providerAdapterKind =
    debugReport?.summaries?.conversationPort?.providerAdapterKind ||
    conversation.provider?.adapterKind ||
    "";
  const recentProviderEvents =
    debugReport?.summaries?.conversationPort?.recentProviderEvents ||
    conversation.provider?.recentEvents ||
    [];
  const failedRows = (debugReport?.timeline || debug.timeline?.rows || []).filter(
    (row) => row.ok === false,
  );
  const outputText =
    debugReport?.summaries?.conversationTurn?.assistantTranscript ||
    debug.output?.assistantText?.completedText ||
    debug.output?.assistantText?.currentText ||
    "";
  const ok =
    runtimeStatus?.ok === true &&
    providerAdapterKind === "openai_realtime" &&
    conversation.engineId === "openai_realtime" &&
    conversation.status === "connected" &&
    Number(providerEventCounts["session.created"] || 0) >= 1 &&
    rawProviderEventsAvailable &&
    providerEventTotal(providerEventCounts) >= 2 &&
    providerTextEventCount(providerEventCounts) >= 1 &&
    Number(canonicalEventCounts.engine_connected || 0) >= 1 &&
    Number(canonicalEventCounts.assistant_text_completed || 0) >= 1 &&
    failedRows.length === 0;

  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_openai_realtime_live",
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
      completedMs,
      textInputSent: clientState?.lastTextInput?.sent === true,
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
      providerTextEventCount: providerTextEventCount(providerEventCounts),
      rawProviderEventsAvailable,
      latestProviderEventType:
        debugReport?.summaries?.conversationPort?.latestProviderEventType ||
        conversation.provider?.latestProviderEventType ||
        "",
      recentProviderEvents,
      canonicalEventCounts,
      latestCanonicalEvent:
        debugReport?.summaries?.conversationPort?.latestCanonicalEvent ||
        conversation.canonicalEvents?.at(-1)?.type ||
        "",
      assistantTranscript: outputText,
    },
    provider: {
      name: "openai",
      realtimeModel: args.model,
      apiKeySource,
      urlOverridden: Boolean(args.url),
      responseCreate: { output_modalities: ["text"] },
      rawPayloadStored: false,
      rawEventSummariesStored: rawProviderEventsAvailable,
    },
    timeline: debugReport?.timeline || debug.timeline?.rows || [],
    turns: debugReport?.debug?.timeline?.turns || debug.timeline?.turns || [],
    debugReport,
    timings: {
      totalWallMs: Math.round(performance.now() - startedAt),
      readyMs,
      connectedMs,
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
      textLength: args.text.length,
      model: args.model,
      urlOverridden: Boolean(args.url),
    },
  };
}

function skippedReport(args, apiKeySource, reason) {
  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_openai_realtime_live",
    ok: false,
    functionalOk: false,
    diagnosticOnly: false,
    skipped: true,
    acceptanceSatisfied: false,
    generatedAt: new Date().toISOString(),
    blocker: reason,
    host: { url: "" },
    operatorSurface: { readyMs: null, connectedMs: null, completedMs: null },
    conversationEngine: {
      kind: "openai_realtime",
      transport: "openai_realtime",
      engineId: "openai_realtime",
      status: "skipped",
      providerAdapterKind: "",
      providerEventCounts: {},
      providerEventTotal: 0,
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
      responseCreate: { output_modalities: ["text"] },
      rawPayloadStored: false,
      rawEventSummariesStored: false,
    },
    timeline: [],
    turns: [],
    timings: { totalWallMs: 0, readyMs: null, connectedMs: null, completedMs: null },
    args: {
      timeoutMs: args.timeoutMs,
      connectTimeoutMs: args.connectTimeoutMs,
      drainMs: args.drainMs,
      headed: args.headed,
      optional: args.optional,
      textLength: args.text.length,
      model: args.model,
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
  const conversationEngine = createOpenAIRealtimeConversationEngine({
    transport: createOpenAIRealtimeWebSocketTransport({
      apiKey,
      model: args.model,
      url: args.url || undefined,
      connectTimeoutMs: args.connectTimeoutMs,
      drainMs: args.drainMs,
      instructions:
        "You are running Oneesama's LAN Operator Surface live Realtime acceptance probe. Keep responses short.",
      response: {
        output_modalities: ["text"],
      },
    }),
  });
  const surface = createLanOperatorSurfaceServer({
    host: args.host,
    port: args.port,
    sessionId: `lan_openai_live_${Date.now().toString(36)}`,
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
        reason: "lan_openai_realtime_live_gate",
      }),
    );
    const connectedStatus = await waitForRuntimeStatus(
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
      (text) => window.MAB_LAN_OPERATOR_SURFACE.sendTextInput(text),
      args.text,
    );
    if (!textResult?.ok) {
      throw new Error(
        `operator_text_input_send_failed:${sanitizeProviderText(textResult?.error || "unknown")}`,
      );
    }
    const runtimeStatus = await waitForRuntimeStatus(
      listenResult.url,
      (body) => {
        const providerCounts = body.debug?.conversation?.provider?.providerEventCounts || {};
        return (
          body.debug?.conversation?.engineId === "openai_realtime" &&
          body.debug?.conversation?.status === "connected" &&
          providerTextEventCount(providerCounts) >= 1 &&
          Number(body.debug?.conversation?.eventCounts?.assistant_text_completed || 0) >= 1
        );
      },
      args.timeoutMs,
      (body) => body.debug?.conversation?.status === "failed",
    );
    const completedMs = Math.round(performance.now() - startedAt);
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.markInterestingRun({
        label: "lan_openai_realtime_live",
        note: "live provider evidence gate",
      }),
    );
    const clientState = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      lastTextInput: window.MAB_LAN_OPERATOR_SURFACE.state.lastTextInput || null,
    }));
    const debugReport = await fetchDebugReport(listenResult.url);
    await context.close();
    return buildAcceptanceReport({
      args,
      listenResult,
      runtimeStatus: runtimeStatus || connectedStatus,
      debugReport,
      clientState,
      startedAt,
      readyMs,
      connectedMs,
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
      gate: "local_openai_realtime_live",
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
        responseCreate: { output_modalities: ["text"] },
        rawPayloadStored: false,
      },
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
        textLength: args.text.length,
        model: args.model,
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
      gate: "local_openai_realtime_live",
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
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: report.error,
        jsonOut: args.jsonOut,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
