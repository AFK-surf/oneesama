#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { WebSocket } from "ws";

const DEFAULT_FIXTURE = "scripts/fixtures/realtime-tool-recall-cases.json";
const DEFAULT_AGENT_URL = "http://127.0.0.1:8781";
const DEFAULT_TIMEOUT_MS = 25_000;
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
  console.log(`Usage: node --import tsx scripts/realtime-tool-recall-benchmark.mjs [options]

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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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
    const errors = [];
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Best-effort close.
      }
      resolve({ calls: unique(calls), errors });
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
      if (event.type === "response.function_call_arguments.done" && event.name) {
        calls.push(event.name);
      }
      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        calls.push(event.item.name);
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

function scoreCase(testCase, calls) {
  const expected = testCase.expectedToolNames || [];
  const disallowed = testCase.disallowedToolNames || [];
  if (expected.length > 0) {
    return { ok: calls.some((name) => expected.includes(name)), kind: "positive" };
  }
  return { ok: !calls.some((name) => disallowed.includes(name)), kind: "negative" };
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
  const result = await runRealtimeTurn({
    url: minted.url,
    secret: minted.secret,
    utterance: testCase.utterance,
    timeoutMs: args.timeoutMs,
    instructions: config.instructions,
    tools,
  });
  const score = scoreCase(testCase, result.calls);
  return {
    id: testCase.id,
    iteration,
    attempts: 1,
    kind: score.kind,
    ok: score.ok,
    calls: result.calls,
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
    schema: "oneesama.realtime-tool-recall-report.v1",
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
          rows.push(await runCaseWithRetries(args, config, variant, tools, testCase, iteration));
        } catch (error) {
          rows.push({
            id: testCase.id,
            iteration,
            attempts: args.retries + 1,
            kind: (testCase.expectedToolNames || []).length ? "positive" : "negative",
            ok: false,
            calls: [],
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
}

function printReport(report) {
  console.log(
    `Realtime tool recall benchmark: model=${report.model} tools=${report.toolCount} iterations=${report.iterations} retries=${report.retries}`,
  );
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
      console.log(
        `  ${row.ok ? "ok " : "BAD"} ${row.id}#${row.iteration}: calls=[${row.calls.join(",") || "none"}] ${expectation}${attempts}${errors}`,
      );
    }
  }
}

await main().catch((error) => {
  console.error(`realtime-tool-recall-benchmark failed: ${error?.message || error}`);
  process.exit(1);
});
