#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join as pathJoin, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";
import {
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  defaultRealtimeToolSchemas,
} from "../packages/core/src/realtime/realtime-contract.ts";

const DEFAULT_FIXTURE = "scripts/fixtures/realtime-tool-recall-cases.json";
const DEFAULT_AGENT_URL = "http://127.0.0.1:8781";
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_RETRIES = 2;

function envMs(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const args = {
    fixture: DEFAULT_FIXTURE,
    meetingAgentUrl: process.env.MAB_MEETING_AGENT_URL || "",
    meetingAgentUrlExplicit: Boolean(process.env.MAB_MEETING_AGENT_URL),
    variants: "",
    caseFilter: "",
    runtime: "sidecar-control",
    iterations: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
    jsonOut: "",
    reportOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixture") args.fixture = argv[++i];
    else if (arg === "--meeting-agent-url") {
      args.meetingAgentUrl = argv[++i];
      args.meetingAgentUrlExplicit = true;
    } else if (arg === "--variants") args.variants = argv[++i];
    else if (arg === "--case-filter") args.caseFilter = argv[++i];
    else if (arg === "--runtime") args.runtime = argv[++i];
    else if (arg === "--iterations") args.iterations = Number(argv[++i]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--retries") args.retries = Number(argv[++i]);
    else if (arg === "--json-out") args.jsonOut = argv[++i];
    else if (arg === "--report-only") args.reportOnly = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.meetingAgentUrl) args.meetingAgentUrl = DEFAULT_AGENT_URL;
  args.meetingAgentUrl = args.meetingAgentUrl.replace(/\/+$/, "");
  args.runtime = String(args.runtime || "sidecar-control").toLowerCase();
  if (!["sidecar-control", "meet-page-csp", "raw-websocket"].includes(args.runtime)) {
    throw new Error("--runtime must be sidecar-control, meet-page-csp, or raw-websocket");
  }
  args.iterations = Number.isFinite(args.iterations) && args.iterations > 0 ? args.iterations : 1;
  args.timeoutMs =
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  args.retries =
    Number.isFinite(args.retries) && args.retries >= 0 ? args.retries : DEFAULT_RETRIES;
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/realtime-tool-recall-benchmark.mjs [options]

Options:
  --fixture <path>              Fixture JSON (default: ${DEFAULT_FIXTURE})
  --meeting-agent-url <url>     Meeting agent URL (default: builtin local harness for sidecar-control/CSP; ${DEFAULT_AGENT_URL} for raw-websocket)
  --variants <csv>              Variant names to run
  --case-filter <regex>         Run matching case ids only
  --runtime <name>              sidecar-control, meet-page-csp, or raw-websocket (default: sidecar-control; raw-websocket is diagnostic-only)
  --iterations <n>              Runs per case (default: 1)
  --timeout-ms <n>              Per Realtime response timeout (default: ${DEFAULT_TIMEOUT_MS})
  --retries <n>                 Retry transport/connect failures only (default: ${DEFAULT_RETRIES})
  --json-out <path>             Write structured report
  --report-only                 Always exit 0 after writing the report
`);
}

function runtimeIsAcceptanceGate(runtime) {
  return runtime === "sidecar-control" || runtime === "meet-page-csp";
}

export function meetingAgentToolSurfaceMetadata({ meetingAgentUrl, runtime, tools }) {
  const exposedTools = (Array.isArray(tools) ? tools : [])
    .map((tool) => String(tool?.name || ""))
    .filter(Boolean);
  return {
    url: meetingAgentUrl,
    runtimePlacement: runtime,
    exposedTools,
    staleServiceSuspected: exposedTools.includes("control_shared_app_window"),
  };
}

export function benchmarkRuntimeEvidenceProfile(runtime) {
  const normalized = String(runtime || "").toLowerCase();
  if (normalized === "sidecar-control" || normalized === "meet-page-csp") {
    return {
      evidenceMode: "sidecar_tool_recall",
      acceptanceGateScope: "sidecar_tool_recall",
      toolExecutionMode: "dry_run_local_tools",
      realAppExecution: false,
      note: "This benchmark proves sidecar tool recall, local wrapper telemetry, and function-output delivery semantics. By default it uses a built-in local harness with mock bridge transport and dry-run local tools, so it is not coupled to live service or upstream API health. Explicit live URLs still require SDK connection; use dedicated chain/live gates for real worker or app execution evidence.",
    };
  }
  return {
    evidenceMode: "diagnostic_raw_websocket_tool_selection",
    acceptanceGateScope: "diagnostic_only",
    toolExecutionMode: "no_local_tool_execution",
    realAppExecution: false,
    note: "Diagnostic raw-websocket mode observes model tool-selection events only and is not an RFC acceptance gate.",
  };
}

export function shouldUseBuiltinRecallHarness(args) {
  return (
    args?.meetingAgentUrlExplicit !== true &&
    (args?.runtime === "sidecar-control" || args?.runtime === "meet-page-csp")
  );
}

function buildBuiltinRecallHarnessConfig() {
  const tools = defaultRealtimeToolSchemas;
  const botName = "Meeting Avatar Bot";
  const instructions = buildRealtimeInstructions({ botName, tools });
  const session = buildRealtimeSessionConfig({ botName, tools, instructions });
  return {
    ok: true,
    model: session.model || "",
    reasoningEffort: session.reasoning?.effort || "",
    voice: session.audio?.output?.voice || session.voice || "",
    turnDetection: session.audio?.input?.turn_detection || session.turn_detection || null,
    sessionSchema: "realtime-2",
    instructions,
    tools,
    session,
    benchmarkHarness: "builtin-realtime-tool-recall",
  };
}

async function createBuiltinRecallHarnessServer() {
  const config = buildBuiltinRecallHarnessConfig();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const sendJson = (status, body) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("<!doctype html><title>oneesama realtime recall harness</title>");
      return;
    }
    if (request.method === "GET" && url.pathname === "/realtime/config") {
      sendJson(200, config);
      return;
    }
    if (request.method === "POST" && url.pathname === "/realtime/client-secret") {
      sendJson(200, { ok: true, client_secret: { value: "ek_benchmark_mock_sdk" } });
      return;
    }
    if (
      request.method === "POST" &&
      (url.pathname.startsWith("/tools/") || url.pathname.startsWith("/screen-share/"))
    ) {
      sendJson(200, {
        ok: true,
        dryRun: true,
        endpoint: url.pathname,
        benchmarkHarness: "builtin-realtime-tool-recall",
      });
      return;
    }
    sendJson(404, { ok: false, error: "not_found", path: url.pathname });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(resolvePath(path), "utf8"));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 400)}`);
  }
  return body;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function realtimeBenchmarkLockDir() {
  return (
    process.env.MAB_REALTIME_BENCHMARK_LOCK_DIR ||
    pathJoin(tmpdir(), "oneesama-realtime-benchmark.lock")
  );
}

export async function withRealtimeBenchmarkLock(label, run) {
  if (process.env.MAB_REALTIME_BENCHMARK_LOCK === "0") return run();
  const lockDir = realtimeBenchmarkLockDir();
  const waitMs = envMs("MAB_REALTIME_BENCHMARK_LOCK_WAIT_MS", 10 * 60 * 1000);
  const staleMs = envMs("MAB_REALTIME_BENCHMARK_LOCK_STALE_MS", 15 * 60 * 1000);
  const pollMs = Math.max(25, envMs("MAB_REALTIME_BENCHMARK_LOCK_POLL_MS", 250));
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(
        pathJoin(lockDir, "owner.json"),
        `${JSON.stringify(
          {
            label,
            pid: process.pid,
            argv: process.argv,
            acquiredAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      try {
        return await run();
      } finally {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const ageMs = await stat(lockDir)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0);
      if (ageMs > staleMs) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Realtime benchmark lock: ${lockDir}`, {
          cause: error,
        });
      }
      if (!announced) {
        announced = true;
        console.error(`Waiting for Realtime benchmark lock: ${lockDir}`);
      }
      await sleep(Math.min(pollMs, Math.max(25, deadline - Date.now())));
    }
  }
}

function collectErrorText(error, parts = []) {
  if (!error) return parts;
  parts.push(String(error?.message || error));
  if (error.code) parts.push(String(error.code));
  if (error.cause && error.cause !== error) collectErrorText(error.cause, parts);
  return parts;
}

function isRetryableTransportError(error) {
  const text = collectErrorText(error).join(" ").toLowerCase();
  if (/\bhttp\s+(500|502|503|504)\b/i.test(text)) return true;
  return [
    "client network socket disconnected",
    "fetch failed",
    "socket hang up",
    "econnreset",
    "etimedout",
    "eai_again",
    "enotfound",
    "tls",
    "und_err_connect_timeout",
    "terminated",
  ].some((needle) => text.includes(needle));
}

function retryDelayMs(attempt) {
  return Math.min(2_500, 500 * 2 ** Math.max(0, attempt - 1));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.text || part?.transcript || "")
    .filter(Boolean)
    .join("");
}

function textFromEvent(event) {
  const responseOutputContent = Array.isArray(event.response?.output)
    ? event.response.output.flatMap((item) => item?.content || [])
    : [];
  return (
    event.delta ||
    event.text ||
    event.transcript ||
    event.part?.text ||
    event.part?.transcript ||
    event.item?.text ||
    textFromContent(event.item?.content) ||
    textFromContent(responseOutputContent) ||
    ""
  );
}

function compactText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function createStrictCspMeetFixtureServer() {
  const server = http.createServer((request, response) => {
    if (request.url !== "/meet-csp") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader(
      "content-security-policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "connect-src *",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "require-trusted-types-for 'script'",
        "trusted-types oneesama",
      ].join("; "),
    );
    response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Strict CSP Meet fixture</title>
  </head>
  <body>
    <main data-fixture="meet-page-csp">Strict CSP Meet fixture</main>
  </body>
</html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/meet-csp`;
  return {
    url,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function textFromHistoryItem(item = {}) {
  return compactText(
    textFromContent(item.content) ||
      textFromContent(item.output) ||
      item.text ||
      item.transcript ||
      item.item?.text ||
      textFromContent(item.item?.content),
  );
}

function toolNameFromHistoryItem(item = {}) {
  return compactText(item.name || item.tool_name || item.toolName || item.item?.name || "");
}

function resultFromHistory(history = []) {
  const calls = [];
  const text = [];
  const callEvents = [];
  const textEvents = [];
  let sequence = 0;
  for (const item of Array.isArray(history) ? history : []) {
    sequence += 1;
    const name = toolNameFromHistoryItem(item);
    if (name) {
      calls.push(name);
      callEvents.push({ name, type: item.type || "history.tool", sequence });
    }
    const role = String(item.role || item.item?.role || "");
    const itemText = textFromHistoryItem(item);
    if (role === "assistant" && itemText) {
      text.push(itemText);
      textEvents.push({
        type: item.type || "history.message",
        mode: "full",
        text: itemText,
        sequence,
      });
    }
  }
  return {
    calls: unique(calls),
    callEvents,
    assistantText: compactText(text.join(" ")),
    textEvents,
    errors: [],
  };
}

function sdkToolEventsFromInbound(inbound = []) {
  return (Array.isArray(inbound) ? inbound : [])
    .filter((entry) => {
      const type = String(entry?.type || entry?.eventType || "");
      return /agents_sdk\.(agent_)?tool_(start|end)$/u.test(type);
    })
    .map((entry) => ({
      type: String(entry?.type || entry?.eventType || ""),
      name: String(entry?.tool || entry?.name || ""),
      callId: String(entry?.callId || entry?.call_id || ""),
    }))
    .filter((entry) => entry.name || entry.callId);
}

function wrapperTelemetryFromToolCalls(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call) => ({
    name: String(call?.name || call?.toolName || call?.tool_name || ""),
    callId: String(call?.callId || call?.call_id || ""),
    arguments: call?.arguments || call?.args || {},
    hasResult: call?.result !== undefined,
    deliveryReason: String(call?.delivery?.reason || call?.delivery?.policy?.reason || ""),
    deliveryChannel: String(call?.delivery?.outputChannel || ""),
    policyChannel: String(call?.delivery?.policy?.channel || ""),
  }));
}

function appControlTelemetryFromState(state = {}) {
  const jobs = state.turnPolicy?.appControlJobs || {};
  return Object.entries(jobs).map(([jobId, job]) => ({
    jobId,
    callId: String(job?.callId || job?.call_id || ""),
    status: String(job?.status || ""),
    visibility: String(job?.visibility || ""),
    reason: String(job?.reason || ""),
  }));
}

function historyItemType(item = {}) {
  return String(item.type || item.item?.type || item.object || "");
}

function functionCallOutputDeliveryFromState(state = {}) {
  const historyTail = Array.isArray(state.historyTail) ? state.historyTail : [];
  const historyOutputs = historyTail
    .filter((item) => historyItemType(item) === "function_call_output")
    .map((item) => ({
      callId: String(item.call_id || item.callId || item.item?.call_id || item.item?.callId || ""),
    }));
  const decisions = Array.isArray(state.turnPolicy?.decisions) ? state.turnPolicy.decisions : [];
  const wrapperOutputs = decisions
    .filter((decision) => decision?.outputChannel)
    .map((decision) => ({
      callId: String(decision?.callId || decision?.call_id || ""),
      outputChannel: String(decision?.outputChannel || ""),
    }));
  const toolCalls = [
    ...(state.meetToolCalls || []),
    ...(state.workspaceToolCalls || []),
    ...(state.workerToolCalls || []),
  ];
  const producedToolResult = toolCalls.some((call) => call?.result !== undefined);
  return {
    delivered: historyOutputs.length > 0 || wrapperOutputs.length > 0,
    producedToolResult,
    historyOutputs,
    wrapperOutputs,
  };
}

function pickTools(allTools, variant) {
  if (variant.toolNames === "*") return allTools;
  const allowed = new Set(variant.toolNames || []);
  return allTools.filter((tool) => allowed.has(tool.name));
}

function wrapperMatchesRawSdkEvent(wrapper, event) {
  if (!wrapper || !event) return false;
  const wrapperCallId = String(wrapper.callId || "");
  const eventCallId = String(event.callId || "");
  if (wrapperCallId && eventCallId && wrapperCallId === eventCallId) return true;
  return Boolean(wrapper.name && event.name && wrapper.name === event.name);
}

function runtimeFailureReason(testCase, result) {
  const runtime = result.bridgeRuntime || {};
  if (runtime.runtimePlacement !== "sidecar") return "";
  if ((result.errors || []).length > 0) return "sidecar_runtime_error";
  if (runtime.sdkConnectionRequired === false) {
    if (runtime.bridgeConnected !== true) return "sidecar_bridge_not_connected";
  } else if (runtime.sdkConnected !== true) {
    return "sidecar_sdk_not_connected";
  }
  const meetSurface = runtime.meetSurface || {};
  if (meetSurface.hasSDKGlobal) return "meet_surface_sdk_global_present";
  if (meetSurface.sdkSuppressedOnMeetSurface !== true) return "meet_surface_sdk_not_suppressed";
  if (runtime.requireStrictCsp && meetSurface.strictCspEnforced !== true) {
    return "meet_page_csp_not_enforced";
  }
  const rawSdkToolEvents = runtime.rawSdkToolEvents || [];
  const wrapperTelemetry = runtime.wrapperTelemetry || [];
  const missingWrapper = rawSdkToolEvents.some(
    (event) => !wrapperTelemetry.some((wrapper) => wrapperMatchesRawSdkEvent(wrapper, event)),
  );
  if (missingWrapper) return "raw_sdk_tool_event_without_wrapper_telemetry";
  const functionOutput = runtime.functionCallOutputDelivery || {};
  const expectedTools = new Set(testCase.expectedToolNames || []);
  const expectedWrapperResultProduced = wrapperTelemetry.some(
    (entry) => expectedTools.has(entry.name) && entry.hasResult,
  );
  if (expectedWrapperResultProduced && functionOutput.delivered === false) {
    return "function_call_output_missing";
  }
  const expectsAppControl = (testCase.expectedToolNames || []).some((name) =>
    ["kwwk_computer_use", "control_shared_app_window"].includes(name),
  );
  if (expectsAppControl) {
    const failedAppControl = (runtime.appControlTelemetry || []).find((job) =>
      ["blocked", "failed", "error", "timeout", "stale"].includes(
        String(job?.status || "").toLowerCase(),
      ),
    );
    if (failedAppControl) return `app_control_job_${failedAppControl.status || "failed"}`;
  }
  return "";
}

function secretFromMint(body) {
  return body?.value || body?.client_secret?.value || body?.session?.client_secret?.value || "";
}

function wsUrlFromMint(body, model) {
  if (process.env.MAB_REALTIME_BENCHMARK_WS_URL) {
    const base = process.env.MAB_REALTIME_BENCHMARK_WS_URL.replace(/\/+$/, "");
    return `${base}?model=${encodeURIComponent(model)}`;
  }
  const upstream = String(body?.upstream?.baseUrl || "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
  return `${upstream.replace(/^http/i, "ws")}/realtime?model=${encodeURIComponent(model)}`;
}

async function mintSecret({ meetingAgentUrl, tools, config, variantName, caseId, iteration }) {
  const hash = createHash("sha256")
    .update(`${variantName}:${caseId}:${iteration}`)
    .digest("hex")
    .slice(0, 16);
  const body = await fetchJson(`${meetingAgentUrl}/realtime/client-secret`, {
    method: "POST",
    body: JSON.stringify({
      instructions: config.instructions,
      tools,
      outputModalities: ["text"],
      toolChoice: "auto",
      safetyIdentifier: `realtime-tool-recall-${hash}`,
    }),
  });
  const secret = secretFromMint(body);
  if (!secret) {
    throw new Error(`client secret missing (${body?.error || "unknown error"})`);
  }
  const model = body?.session?.model || config?.session?.model || config?.model || "gpt-realtime-2";
  return { secret, model, url: wsUrlFromMint(body, model) };
}

function runRealtimeTurn({ url, secret, utterance, timeoutMs, instructions, tools }) {
  return new Promise((resolve, reject) => {
    const calls = [];
    const callEvents = [];
    const textEvents = [];
    const errors = [];
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    let settled = false;
    let sequence = 0;
    const recordCall = (name, type) => {
      calls.push(name);
      callEvents.push({ name, type, sequence });
    };
    const recordText = (event) => {
      const text = textFromEvent(event);
      if (!text) return;
      const type = event.type || "";
      textEvents.push({
        type,
        mode: type.endsWith(".delta") ? "delta" : "full",
        text: compactText(text),
        sequence,
      });
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Best-effort close.
      }
      const deltaText = textEvents
        .filter((event) => event.mode === "delta")
        .map((event) => event.text)
        .join("");
      const fallbackText = textEvents.map((event) => event.text).join("");
      resolve({
        calls: unique(calls),
        callEvents,
        assistantText: compactText(deltaText || fallbackText),
        textEvents,
        errors,
      });
    };
    const timer = setTimeout(finish, timeoutMs);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            instructions,
            tools,
            tool_choice: "auto",
            output_modalities: ["text"],
          },
        }),
      );
      ws.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: utterance }],
          },
        }),
      );
      ws.send(JSON.stringify({ type: "response.create" }));
    });
    ws.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      sequence += 1;
      if (event.type === "response.function_call_arguments.done" && event.name) {
        recordCall(event.name, event.type);
      }
      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        recordCall(event.item.name, event.type);
      }
      if (
        event.type === "response.text.delta" ||
        event.type === "response.text.done" ||
        event.type === "response.output_text.delta" ||
        event.type === "response.output_text.done" ||
        event.type === "response.audio_transcript.delta" ||
        event.type === "response.audio_transcript.done" ||
        event.type === "response.content_part.added" ||
        event.type === "response.output_item.done" ||
        event.type === "response.done"
      ) {
        recordText(event);
      }
      if (event.type === "error") errors.push(event.error || event);
      if (event.type === "response.done") finish();
    });
    ws.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runSidecarControlTurn({
  meetingAgentUrl,
  utterance,
  timeoutMs,
  instructions,
  tools,
  strictCspMeetPage = false,
  useMockAgentSDK = false,
}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: process.env.MAB_REALTIME_BENCHMARK_HEADED !== "1",
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
  });
  const strictCspFixture = strictCspMeetPage ? await createStrictCspMeetFixtureServer() : null;
  const context = await browser.newContext();
  const meetPage = await context.newPage();
  const sidecarPage = await context.newPage();
  try {
    await meetPage.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "agents-sdk",
        agentRuntime: "agents-sdk",
        sessionId: "benchmark-sidecar-control",
        realtimeRuntimePlacement: "sidecar",
        realtimePageRole: "meet-surface",
      }),
    });
    await sidecarPage.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: useMockAgentSDK ? "mock" : "agents-sdk",
        agentRuntime: useMockAgentSDK ? "mock" : "agents-sdk",
        realtimeRuntimePlacement: "sidecar",
        realtimePageRole: "sidecar",
        sessionId: "benchmark-sidecar-control",
        botName: "Meeting Avatar Bot",
        autoConnect: true,
        autoReconnect: false,
        tokenUrl: `${meetingAgentUrl}/realtime/client-secret`,
        toolCallbackToken: "benchmark-dry-run",
        instructions,
        tools,
        toolChoice: "auto",
        session: { output_modalities: ["text"] },
        dryRunLocalTools: true,
        directTextTurnToolRouting: true,
        observeMeetChat: false,
      }),
    });
    await meetPage.goto(strictCspFixture?.url || `${meetingAgentUrl}/healthz`);
    await sidecarPage.goto(`${meetingAgentUrl}/healthz#realtime-sidecar-control`);
    await sidecarPage.waitForFunction(
      () =>
        Boolean(window.MAB_REALTIME_BRIDGE) &&
        typeof window.MAB_REALTIME_CLIENT?.requestRealtimeTextTurn === "function",
      undefined,
      { timeout: timeoutMs },
    );
    let sdkConnectTimedOut = false;
    await sidecarPage
      .waitForFunction(
        (expectMockBridge) =>
          expectMockBridge
            ? window.MAB_REALTIME_BRIDGE?.connected === true
            : window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
        useMockAgentSDK,
        { timeout: Math.min(timeoutMs, envMs("MAB_REALTIME_BENCHMARK_SDK_WAIT_MS", 15000)) },
      )
      .catch(() => {
        sdkConnectTimedOut = true;
      });
    await sidecarPage.evaluate(
      ({ text, turnInstructions }) =>
        window.MAB_REALTIME_CLIENT?.requestRealtimeTextTurn?.({
          text,
          instructions: turnInstructions,
        }),
      { text: utterance, turnInstructions: instructions },
    );
    try {
      await sidecarPage.waitForFunction(
        () => {
          const bridge = window.MAB_REALTIME_BRIDGE || {};
          const calls = [
            ...(bridge.meetTools?.calls || []),
            ...(bridge.workspaceTools?.calls || []),
            ...(bridge.workerTools?.calls || []),
          ];
          const assistantText =
            bridge.contextHealth?.latestFunctionalTurn?.assistantText ||
            (bridge.contextHealth?.lastHistoryTail || [])
              .filter((entry) => entry.role === "assistant")
              .map((entry) => entry.text || "")
              .join(" ");
          return calls.length > 0 || Boolean(assistantText);
        },
        undefined,
        { timeout: timeoutMs },
      );
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const state = await sidecarPage.evaluate(() => {
      const bridge = window.MAB_REALTIME_BRIDGE || {};
      return {
        agentRuntime: bridge.agentRuntime || null,
        connected: bridge.connected === true,
        connection: bridge.connection || null,
        inbound: bridge.inbound || [],
        meetToolCalls: bridge.meetTools?.calls || [],
        workspaceToolCalls: bridge.workspaceTools?.calls || [],
        workerToolCalls: bridge.workerTools?.calls || [],
        turnPolicy: bridge.turnPolicy || null,
        latestFunctionalTurn: bridge.contextHealth?.latestFunctionalTurn || null,
        historyTail: bridge.contextHealth?.lastHistoryTail || [],
        feedback: bridge.feedback || null,
        errors: bridge.errors || [],
      };
    });
    const meetSurface = await meetPage.evaluate(() => {
      let inlineScriptExecuted = false;
      let inlineScriptError = "";
      try {
        const script = document.createElement("script");
        script.text = "window.__MAB_CSP_INLINE_SCRIPT_RAN = true";
        document.documentElement.appendChild(script);
        inlineScriptExecuted = window.__MAB_CSP_INLINE_SCRIPT_RAN === true;
      } catch (error) {
        inlineScriptError = String(error?.message || error);
      }
      const strictCspEnforced =
        inlineScriptExecuted === false &&
        (Boolean(inlineScriptError) ||
          Boolean(document.querySelector('[data-fixture="meet-page-csp"]')));
      return {
        url: location.href,
        runtimePlacement: window.MAB_REALTIME_BRIDGE?.runtimePlacement || "",
        sdkSuppressedOnMeetSurface:
          window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkSuppressedOnMeetSurface === true,
        hasSDKGlobal: Boolean(window.OpenAIAgentsRealtime),
        trustedTypesAvailable: Boolean(window.trustedTypes),
        inlineScriptExecuted,
        inlineScriptError,
        strictCspEnforced,
      };
    });
    const toolCalls = [
      ...state.meetToolCalls,
      ...state.workspaceToolCalls,
      ...state.workerToolCalls,
    ];
    const calls = unique(
      toolCalls.map((call) => call.name || call.toolName || call.tool_name || ""),
    );
    const callEvents = toolCalls.map((call, index) => ({
      name: call.name || call.toolName || call.tool_name || "",
      type: "sidecar_control.tool_call",
      sequence: index + 1,
    }));
    const assistantText = compactText(
      state.latestFunctionalTurn?.assistantText ||
        state.historyTail
          .filter((entry) => entry.role === "assistant")
          .map((entry) => entry.text || "")
          .join(" "),
    );
    return {
      calls,
      callEvents,
      assistantText,
      textEvents: assistantText
        ? [
            {
              type: "sidecar_control.assistant_text",
              mode: "full",
              text: assistantText,
              sequence: 1,
            },
          ]
        : [],
      sdkHistoryTail: state.historyTail,
      errors: state.errors || [],
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        requireStrictCsp: strictCspMeetPage,
        sdkConnectionRequired: useMockAgentSDK !== true,
        sdkConnected: state.agentRuntime?.sdkConnected === true,
        bridgeConnected: state.connected === true,
        bridgeMode: state.connection?.mode || state.agentRuntime?.active || "",
        sdkConnectTimedOut,
        meetSurface,
        rawSdkToolEvents: sdkToolEventsFromInbound(state.inbound),
        wrapperTelemetry: wrapperTelemetryFromToolCalls(toolCalls),
        appControlTelemetry: appControlTelemetryFromState(state),
        functionCallOutputDelivery: functionCallOutputDeliveryFromState(state),
        feedback: state.feedback || null,
      },
    };
  } finally {
    await sidecarPage
      .evaluate(() => window.MAB_REALTIME_CLIENT?.disconnect?.())
      .catch(() => undefined);
    await sleep(envMs("MAB_REALTIME_BENCHMARK_DISCONNECT_SETTLE_MS", 250));
    await browser.close();
    await sleep(envMs("MAB_REALTIME_BENCHMARK_CASE_COOLDOWN_MS", 750));
    await strictCspFixture?.close().catch(() => {});
  }
}

export function scoreCase(testCase, result) {
  if (Array.isArray(result.history)) {
    return scoreCase(testCase, { ...resultFromHistory(result.history), history: undefined });
  }
  const expected = testCase.expectedToolNames || [];
  const runtimeFailure = runtimeFailureReason(testCase, result);
  if (runtimeFailure) {
    return {
      ok: false,
      kind: expected.length > 0 ? "positive" : "negative",
      reason: runtimeFailure,
      fakeExecution: false,
    };
  }
  const calls = result.calls || [];
  const disallowed = testCase.disallowedToolNames || [];
  if (expected.length > 0) {
    const matched = calls.some((name) => expected.includes(name));
    const fakeExecution = !matched && Boolean(result.assistantText);
    return {
      ok: matched,
      kind: "positive",
      reason: matched
        ? "expected_tool_called"
        : fakeExecution
          ? "assistant_text_without_expected_tool"
          : "expected_tool_missing",
      fakeExecution,
    };
  }
  const disallowedCalled = calls.some((name) => disallowed.includes(name));
  return {
    ok: !disallowedCalled,
    kind: "negative",
    reason: disallowedCalled ? "disallowed_tool_called" : "no_disallowed_tool_called",
    fakeExecution: false,
  };
}

async function runCase(args, config, variant, tools, testCase, iteration) {
  if (Array.isArray(testCase.history)) {
    const result = resultFromHistory(testCase.history);
    const score = scoreCase(testCase, result);
    return {
      id: testCase.id,
      iteration,
      attempts: 1,
      kind: score.kind,
      ok: score.ok,
      reason: score.reason,
      fakeExecution: score.fakeExecution,
      calls: result.calls,
      callEvents: result.callEvents,
      assistantText: result.assistantText,
      expectedToolNames: testCase.expectedToolNames || [],
      disallowedToolNames: testCase.disallowedToolNames || [],
      errors: [],
    };
  }
  const result =
    args.runtime === "sidecar-control" || args.runtime === "meet-page-csp"
      ? await runSidecarControlTurn({
          meetingAgentUrl: args.meetingAgentUrl,
          utterance: testCase.utterance,
          timeoutMs: args.timeoutMs,
          instructions: config.instructions,
          tools,
          strictCspMeetPage: args.runtime === "meet-page-csp",
          useMockAgentSDK: args.useBuiltinRecallHarness === true,
        })
      : await (async () => {
          const minted = await mintSecret({
            meetingAgentUrl: args.meetingAgentUrl,
            tools,
            config,
            variantName: variant.name,
            caseId: testCase.id,
            iteration,
          });
          return runRealtimeTurn({
            url: minted.url,
            secret: minted.secret,
            utterance: testCase.utterance,
            timeoutMs: args.timeoutMs,
            instructions: config.instructions,
            tools,
          });
        })();
  const score = scoreCase(testCase, result);
  return {
    id: testCase.id,
    iteration,
    attempts: 1,
    kind: score.kind,
    ok: score.ok,
    reason: score.reason,
    fakeExecution: score.fakeExecution,
    calls: result.calls,
    callEvents: result.callEvents,
    assistantText: result.assistantText,
    sdkHistoryTail: result.sdkHistoryTail || [],
    bridgeRuntime: result.bridgeRuntime || null,
    wrapperTelemetry: result.bridgeRuntime?.wrapperTelemetry || [],
    appControlTelemetry: result.bridgeRuntime?.appControlTelemetry || [],
    functionCallOutputDelivery: result.bridgeRuntime?.functionCallOutputDelivery || null,
    expectedToolNames: testCase.expectedToolNames || [],
    disallowedToolNames: testCase.disallowedToolNames || [],
    errors: result.errors.map((error) => ({
      type: error?.type || "",
      code: error?.code || "",
      message: String(error?.message || error).slice(0, 240),
    })),
  };
}

async function runCaseWithRetries(args, config, variant, tools, testCase, iteration) {
  let lastError;
  for (let attempt = 1; attempt <= args.retries + 1; attempt += 1) {
    try {
      const row = await runCase(args, config, variant, tools, testCase, iteration);
      return { ...row, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt > args.retries || !isRetryableTransportError(error)) break;
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastError;
}

function summarizeVariant(variant, rows) {
  const positives = rows.filter((row) => row.kind === "positive");
  const negatives = rows.filter((row) => row.kind === "negative");
  const recall = positives.length ? positives.filter((row) => row.ok).length / positives.length : 1;
  const disallowedRate = negatives.length
    ? negatives.filter((row) => !row.ok).length / negatives.length
    : 0;
  const ok =
    recall >= Number(variant.minRecall ?? 1) &&
    disallowedRate <= Number(variant.maxDisallowedRate ?? 0);
  return {
    ok,
    recall,
    disallowedRate,
    retriedRows: rows.filter((row) => row.attempts > 1).length,
    maxAttempts: Math.max(1, ...rows.map((row) => row.attempts || 1)),
    positivePassed: positives.filter((row) => row.ok).length,
    positiveTotal: positives.length,
    negativePassed: negatives.filter((row) => row.ok).length,
    negativeTotal: negatives.length,
    minRecall: Number(variant.minRecall ?? 1),
    maxDisallowedRate: Number(variant.maxDisallowedRate ?? 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let builtinHarness = null;
  try {
    if (shouldUseBuiltinRecallHarness(args)) {
      builtinHarness = await createBuiltinRecallHarnessServer();
      args.meetingAgentUrl = builtinHarness.url;
      args.useBuiltinRecallHarness = true;
    }
    const fixture = await readJson(args.fixture);
    const config = await fetchJson(`${args.meetingAgentUrl}/realtime/config`);
    const allTools = Array.isArray(config.tools) ? config.tools : [];
    if (allTools.length === 0) throw new Error("/realtime/config returned no tools");
    const meetingAgent = meetingAgentToolSurfaceMetadata({
      meetingAgentUrl: args.meetingAgentUrl,
      runtime: args.runtime,
      tools: allTools,
    });
    const selectedVariants = (fixture.variants || []).filter(
      (variant) => !args.variants || args.variants.split(",").includes(variant.name),
    );
    const caseRegex = args.caseFilter ? new RegExp(args.caseFilter) : null;
    const selectedCases = (fixture.cases || []).filter(
      (entry) => !caseRegex || caseRegex.test(entry.id),
    );
    const report = {
      schema: "oneesama.realtime-tool-recall-report.v1",
      gate: "realtime_tool_recall",
      ok: true,
      createdAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
      meetingAgentUrl: args.meetingAgentUrl,
      meetingAgent,
      environment: {
        platform: process.platform,
        model: config.model || config.session?.model || "",
        upstreamAvailable: true,
        builtinHarness: args.useBuiltinRecallHarness === true,
      },
      runtime: args.runtime,
      acceptanceGate: runtimeIsAcceptanceGate(args.runtime),
      notAcceptanceGate: !runtimeIsAcceptanceGate(args.runtime),
      ...benchmarkRuntimeEvidenceProfile(args.runtime),
      model: config.model || config.session?.model || "",
      toolCount: allTools.length,
      exposedToolNames: meetingAgent.exposedTools,
      staleServiceSuspected: meetingAgent.staleServiceSuspected,
      fixture: args.fixture,
      iterations: args.iterations,
      retries: args.retries,
      variants: [],
    };
    for (const variant of selectedVariants) {
      const tools = pickTools(allTools, variant);
      const rows = [];
      for (const testCase of selectedCases) {
        for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
          try {
            rows.push(await runCaseWithRetries(args, config, variant, tools, testCase, iteration));
          } catch (error) {
            rows.push({
              id: testCase.id,
              iteration,
              attempts: args.retries + 1,
              kind: (testCase.expectedToolNames || []).length ? "positive" : "negative",
              ok: false,
              reason: "benchmark_error",
              fakeExecution: false,
              calls: [],
              callEvents: [],
              assistantText: "",
              expectedToolNames: testCase.expectedToolNames || [],
              disallowedToolNames: testCase.disallowedToolNames || [],
              errors: [{ message: String(error?.message || error).slice(0, 240) }],
            });
          }
        }
      }
      const summary = summarizeVariant(variant, rows);
      report.variants.push({
        name: variant.name,
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
        summary,
        cases: rows,
      });
      report.ok = report.ok && summary.ok;
    }
    printReport(report);
    if (args.jsonOut) {
      await writeFile(resolvePath(args.jsonOut), `${JSON.stringify(report, null, 2)}\n`);
    }
    if (!report.ok && !args.reportOnly) process.exitCode = 1;
  } finally {
    await builtinHarness?.close();
  }
}

function printReport(report) {
  console.log(
    `Realtime tool recall benchmark: runtime=${report.runtime} model=${report.model} tools=${report.toolCount} iterations=${report.iterations} retries=${report.retries}`,
  );
  if (report.notAcceptanceGate) {
    console.log(`Runtime ${report.runtime} is diagnostic-only and is not an RFC acceptance gate.`);
  }
  for (const variant of report.variants) {
    const { summary } = variant;
    console.log(
      `\n${summary.ok ? "PASS" : "FAIL"} ${variant.name}: recall ${summary.positivePassed}/${summary.positiveTotal} (${summary.recall.toFixed(2)})` +
        `, negatives ${summary.negativePassed}/${summary.negativeTotal}, retried=${summary.retriedRows}, maxAttempts=${summary.maxAttempts}, tools=${variant.toolCount}`,
    );
    for (const row of variant.cases) {
      const expectation =
        row.kind === "positive"
          ? `want=${row.expectedToolNames.join("/")}`
          : `disallow=${row.disallowedToolNames.join("/")}`;
      const errors = row.errors.length
        ? ` errors=${row.errors.map((e) => e.message).join(" | ")}`
        : "";
      const attempts = row.attempts > 1 ? ` attempts=${row.attempts}` : "";
      const reason = row.reason ? ` reason=${row.reason}` : "";
      const fake = row.fakeExecution ? " fakeExecution=true" : "";
      const text =
        row.assistantText && (!row.ok || row.fakeExecution)
          ? ` assistantText=${JSON.stringify(row.assistantText)}`
          : "";
      console.log(
        `  ${row.ok ? "ok " : "BAD"} ${row.id}#${row.iteration}: calls=[${row.calls.join(",") || "none"}] ${expectation}${attempts}${reason}${fake}${errors}${text}`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await withRealtimeBenchmarkLock("realtime-tool-recall", main).catch((error) => {
    console.error(`realtime-tool-recall-benchmark failed: ${error?.message || error}`);
    process.exit(1);
  });
}
