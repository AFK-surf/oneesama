#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { WebSocket } from "ws";

const DEFAULT_FIXTURE = "scripts/fixtures/realtime-tool-chain-cases.json";
const DEFAULT_AGENT_URL = "http://127.0.0.1:8781";
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_RETRIES = 2;

function parseArgs(argv) {
  const args = {
    fixture: DEFAULT_FIXTURE,
    meetingAgentUrl: process.env.MAB_MEETING_AGENT_URL || DEFAULT_AGENT_URL,
    variants: "",
    caseFilter: "",
    iterations: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
    jsonOut: "",
    reportOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixture") args.fixture = argv[++i];
    else if (arg === "--meeting-agent-url") args.meetingAgentUrl = argv[++i];
    else if (arg === "--variants") args.variants = argv[++i];
    else if (arg === "--case-filter") args.caseFilter = argv[++i];
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
  args.meetingAgentUrl = args.meetingAgentUrl.replace(/\/+$/, "");
  args.iterations = Number.isFinite(args.iterations) && args.iterations > 0 ? args.iterations : 1;
  args.timeoutMs =
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  args.retries =
    Number.isFinite(args.retries) && args.retries >= 0 ? args.retries : DEFAULT_RETRIES;
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/realtime-tool-chain-benchmark.mjs [options]

Options:
  --fixture <path>              Fixture JSON (default: ${DEFAULT_FIXTURE})
  --meeting-agent-url <url>     Meeting agent URL (default: ${DEFAULT_AGENT_URL})
  --variants <csv>              Variant names to run
  --case-filter <regex>         Run matching case ids only
  --iterations <n>              Runs per case (default: 1)
  --timeout-ms <n>              Per Realtime response timeout (default: ${DEFAULT_TIMEOUT_MS})
  --retries <n>                 Retry transport/connect failures only (default: ${DEFAULT_RETRIES})
  --json-out <path>             Write structured report
  --report-only                 Always exit 0 after writing the report
`);
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

function pickTools(allTools, variant) {
  if (variant.toolNames === "*") return allTools;
  const allowed = new Set(variant.toolNames || []);
  return allTools.filter((tool) => allowed.has(tool.name));
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
      safetyIdentifier: `realtime-tool-chain-${hash}`,
    }),
  });
  const secret = secretFromMint(body);
  if (!secret) {
    throw new Error(`client secret missing (${body?.error || "unknown error"})`);
  }
  const model = body?.session?.model || config?.session?.model || config?.model || "gpt-realtime-2";
  return { secret, model, url: wsUrlFromMint(body, model) };
}

function uniqueCalls(calls) {
  const seen = new Set();
  const out = [];
  for (const call of calls) {
    const key = call.callId || `${call.name}:${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(call);
  }
  return out;
}

function waitForResponse(ws, timeoutMs) {
  return new Promise((resolve) => {
    const calls = [];
    const errors = [];
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      resolve({ calls: uniqueCalls(calls), errors, reason });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const rememberCall = (name, callId = "", args = "") => {
      if (!name) return;
      const existing = calls.find((call) => call.callId && call.callId === callId);
      if (existing) {
        existing.arguments = args || existing.arguments;
        return;
      }
      calls.push({ name, callId, arguments: args });
    };
    const onMessage = (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        rememberCall(event.item.name, event.item.call_id, event.item.arguments);
      }
      if (event.type === "response.function_call_arguments.done" && event.name) {
        rememberCall(event.name, event.call_id, event.arguments);
      }
      if (event.type === "error") errors.push(event.error || event);
      if (event.type === "response.done") finish("done");
    };
    const onError = (error) => {
      errors.push({ message: String(error?.message || error) });
      finish("error");
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

function matchedCall(calls, expectedNames) {
  return calls.find((call) => expectedNames.includes(call.name)) || null;
}

function sendUserTurn(ws, utterance) {
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
}

function sendFunctionOutput(ws, callId, output, instructions) {
  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    }),
  );
  ws.send(
    JSON.stringify({
      type: "response.create",
      response: { instructions },
    }),
  );
}

async function connectRealtime({ url, secret, config, tools }) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${secret}` } });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: config.instructions,
        tools,
        tool_choice: "auto",
        output_modalities: ["text"],
      },
    }),
  );
  return ws;
}

async function runCase(args, config, variant, tools, testCase, iteration) {
  const minted = await mintSecret({
    meetingAgentUrl: args.meetingAgentUrl,
    tools,
    config,
    variantName: variant.name,
    caseId: testCase.id,
    iteration,
  });
  const ws = await connectRealtime({
    url: minted.url,
    secret: minted.secret,
    config,
    tools,
  });
  const rows = [];
  try {
    sendUserTurn(ws, testCase.utterance);
    for (let index = 0; index < testCase.steps.length; index += 1) {
      const step = testCase.steps[index];
      const result = await waitForResponse(ws, args.timeoutMs);
      const expectedToolNames = step.expectedToolNames || [];
      const call = matchedCall(result.calls, expectedToolNames);
      rows.push({
        id: testCase.id,
        iteration,
        step: index + 1,
        ok: Boolean(call),
        calls: result.calls.map((entry) => entry.name),
        expectedToolNames,
        errors: result.errors.map((error) => ({
          type: error?.type || "",
          code: error?.code || "",
          message: String(error?.message || error).slice(0, 240),
        })),
        reason: result.reason,
      });
      if (!call || !step.output || index === testCase.steps.length - 1) continue;
      const instructions =
        step.responseInstructions ||
        testCase.responseInstructions ||
        "Summarize the result in concise Chinese. If it failed, state the exact blocker without mentioning internal routing names.";
      sendFunctionOutput(ws, call.callId, step.output, instructions);
    }
  } finally {
    try {
      ws.close();
    } catch {
      // Best-effort close.
    }
  }
  return rows;
}

async function runCaseWithRetries(args, config, variant, tools, testCase, iteration) {
  let lastError;
  for (let attempt = 1; attempt <= args.retries + 1; attempt += 1) {
    try {
      const rows = await runCase(args, config, variant, tools, testCase, iteration);
      for (const row of rows) {
        row.attempts = attempt;
      }
      return rows;
    } catch (error) {
      lastError = error;
      if (attempt > args.retries || !isRetryableTransportError(error)) break;
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastError;
}

function summarizeVariant(variant, rows) {
  const passed = rows.filter((row) => row.ok).length;
  const recall = rows.length ? passed / rows.length : 1;
  return {
    ok: recall >= Number(variant.minStepRecall ?? 1),
    stepPassed: passed,
    stepTotal: rows.length,
    recall,
    retriedRows: rows.filter((row) => row.attempts > 1).length,
    maxAttempts: Math.max(1, ...rows.map((row) => row.attempts || 1)),
    minStepRecall: Number(variant.minStepRecall ?? 1),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = await readJson(args.fixture);
  const config = await fetchJson(`${args.meetingAgentUrl}/realtime/config`);
  const allTools = Array.isArray(config.tools) ? config.tools : [];
  if (allTools.length === 0) throw new Error("/realtime/config returned no tools");
  const selectedVariants = (fixture.variants || []).filter(
    (variant) => !args.variants || args.variants.split(",").includes(variant.name),
  );
  const caseRegex = args.caseFilter ? new RegExp(args.caseFilter) : null;
  const selectedCases = (fixture.cases || []).filter(
    (entry) => !caseRegex || caseRegex.test(entry.id),
  );
  const report = {
    schema: "oneesama.realtime-tool-chain-report.v1",
    ok: true,
    createdAt: new Date().toISOString(),
    meetingAgentUrl: args.meetingAgentUrl,
    model: config.model || config.session?.model || "",
    toolCount: allTools.length,
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
          rows.push(
            ...(await runCaseWithRetries(args, config, variant, tools, testCase, iteration)),
          );
        } catch (error) {
          rows.push({
            id: testCase.id,
            iteration,
            step: 0,
            attempts: args.retries + 1,
            ok: false,
            calls: [],
            expectedToolNames: [],
            errors: [{ message: String(error?.message || error).slice(0, 240) }],
            reason: "error",
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
}

function printReport(report) {
  console.log(
    `Realtime tool chain benchmark: model=${report.model} tools=${report.toolCount} iterations=${report.iterations} retries=${report.retries}`,
  );
  for (const variant of report.variants) {
    const { summary } = variant;
    console.log(
      `\n${summary.ok ? "PASS" : "FAIL"} ${variant.name}: steps ${summary.stepPassed}/${summary.stepTotal} (${summary.recall.toFixed(2)}), retried=${summary.retriedRows}, maxAttempts=${summary.maxAttempts}, tools=${variant.toolCount}`,
    );
    for (const row of variant.cases) {
      const errors = row.errors.length
        ? ` errors=${row.errors.map((entry) => entry.message).join(" | ")}`
        : "";
      const attempts = row.attempts > 1 ? ` attempts=${row.attempts}` : "";
      console.log(
        `  ${row.ok ? "ok " : "BAD"} ${row.id}#${row.iteration}.${row.step}: calls=[${row.calls.join(",") || "none"}] want=${row.expectedToolNames.join("/")}${attempts}${errors}`,
      );
    }
  }
}

await main().catch((error) => {
  console.error(`realtime-tool-chain-benchmark failed: ${error?.message || error}`);
  process.exit(1);
});
