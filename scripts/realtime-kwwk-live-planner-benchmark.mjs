#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { ensureAppControlHelperBinary } from "../packages/core/src/meeting/app-control-helper.ts";

const DEFAULT_PROVIDER = "gemini";
const DEFAULT_MODEL = "gemini-3.5-flash";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PLANNER_TIMEOUT_MS = 3000;
const DEFAULT_PLANNER_SLO_MS = 1200;
const DEFAULT_REASONING_EFFORT = "minimal";
const DEFAULT_OPENROUTER_PROVIDER_SORT = "latency";
const DEFAULT_OPENROUTER_REQUIRE_PARAMETERS = true;
const DEFAULT_LIVE_ENV_FILES = [
  "oneesama-live-env-from-proc.sh",
  "oneesama-openai-live.sh",
  "oneesama-app-control-live.sh",
];
const ALLOWED_ACTION_KINDS = new Set([
  "state",
  "click",
  "double_click",
  "type_text",
  "press_key",
  "scroll",
  "drag",
]);

function firstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function parseArgs(argv) {
  const args = {
    jsonOut: "",
    envFiles: [],
    loadLiveEnv: true,
    cueboardConfig: "",
    provider: firstEnv(
      "ONEESAMA_KWWK_CU_PLANNER_PROVIDER",
      "ONEESAMA_KWWK_PLANNER_PROVIDER",
      "MAB_KWWK_CU_PLANNER_PROVIDER",
      "MAB_KWWK_PLANNER_PROVIDER",
    ),
    model: firstEnv(
      "ONEESAMA_KWWK_CU_PLANNER_MODEL",
      "ONEESAMA_KWWK_PLANNER_MODEL",
      "MAB_KWWK_CU_PLANNER_MODEL",
      "MAB_KWWK_PLANNER_MODEL",
    ),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    plannerTimeoutMs: DEFAULT_PLANNER_TIMEOUT_MS,
    plannerSloMs: DEFAULT_PLANNER_SLO_MS,
    warmupRuns: 1,
    plannerRuns: 1,
    reasoningEffort: firstEnv(
      "ONEESAMA_KWWK_CU_PLANNER_REASONING_EFFORT",
      "ONEESAMA_KWWK_PLANNER_REASONING_EFFORT",
      "MAB_KWWK_CU_PLANNER_REASONING_EFFORT",
      "MAB_KWWK_PLANNER_REASONING_EFFORT",
    ),
    serviceTier: firstEnv(
      "ONEESAMA_KWWK_CU_PLANNER_SERVICE_TIER",
      "ONEESAMA_KWWK_PLANNER_SERVICE_TIER",
      "MAB_KWWK_CU_PLANNER_SERVICE_TIER",
      "MAB_KWWK_PLANNER_SERVICE_TIER",
    ),
    reportOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json-out") args.jsonOut = argv[++i];
    else if (arg === "--env") args.envFiles.push(argv[++i]);
    else if (arg === "--no-live-env") args.loadLiveEnv = false;
    else if (arg === "--cueboard-config") args.cueboardConfig = argv[++i];
    else if (arg === "--provider") args.provider = argv[++i];
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--planner-timeout-ms") args.plannerTimeoutMs = Number(argv[++i]);
    else if (arg === "--planner-slo-ms") args.plannerSloMs = Number(argv[++i]);
    else if (arg === "--warmup-runs") args.warmupRuns = Number(argv[++i]);
    else if (arg === "--planner-runs") args.plannerRuns = Number(argv[++i]);
    else if (arg === "--reasoning-effort") args.reasoningEffort = argv[++i];
    else if (arg === "--service-tier") args.serviceTier = argv[++i];
    else if (arg === "--report-only") args.reportOnly = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.provider = String(args.provider || DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();
  if (!["openai", "openrouter", "gemini"].includes(args.provider)) {
    throw new Error(`unsupported live planner provider: ${args.provider}`);
  }
  args.model = String(args.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  args.timeoutMs =
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  args.plannerTimeoutMs =
    Number.isFinite(args.plannerTimeoutMs) && args.plannerTimeoutMs > 0
      ? args.plannerTimeoutMs
      : DEFAULT_PLANNER_TIMEOUT_MS;
  args.plannerSloMs =
    Number.isFinite(args.plannerSloMs) && args.plannerSloMs > 0
      ? args.plannerSloMs
      : DEFAULT_PLANNER_SLO_MS;
  args.warmupRuns =
    Number.isFinite(args.warmupRuns) && args.warmupRuns >= 0 ? Math.floor(args.warmupRuns) : 1;
  args.plannerRuns =
    Number.isFinite(args.plannerRuns) && args.plannerRuns > 0 ? Math.floor(args.plannerRuns) : 1;
  args.reasoningEffort =
    String(args.reasoningEffort || DEFAULT_REASONING_EFFORT).trim() || DEFAULT_REASONING_EFFORT;
  args.serviceTier = String(args.serviceTier || "")
    .trim()
    .toLowerCase();
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/realtime-kwwk-live-planner-benchmark.mjs [options]

Options:
  --provider <name>              Planner provider: openrouter, openai, or gemini (default: ${DEFAULT_PROVIDER})
  --model <name>                 Planner model (default: env override or ${DEFAULT_MODEL})
  --planner-timeout-ms <n>       Planner model timeout (default: ${DEFAULT_PLANNER_TIMEOUT_MS})
  --planner-slo-ms <n>           Planner latency SLO (default: ${DEFAULT_PLANNER_SLO_MS})
  --warmup-runs <n>              Planner calls before measured cases (default: 1)
  --planner-runs <n>             Measured planner calls (default: 1)
  --reasoning-effort <value>     Planner reasoning effort (default: ${DEFAULT_REASONING_EFFORT})
  --service-tier <value>         Optional Responses service_tier: auto/default/flex/priority
  --timeout-ms <n>               Overall helper timeout (default: ${DEFAULT_TIMEOUT_MS})
  --env <path>                   Load an env file before running (repeatable)
  --cueboard-config <path>       Load provider key/base_url/headers from a Cueboard JSON config
  --no-live-env                  Do not load default oneesama meeting-agent live env files
  --json-out <path>              Write structured report
  --report-only                  Always exit 0 after writing the report
`);
}

function defaultLiveEnvPaths() {
  const base =
    process.env.ONEESAMA_LIVE_DEFAULT_ENV_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "oneesama", "live-env");
  return DEFAULT_LIVE_ENV_FILES.map((name) => join(base, name));
}

function parseShellAssignmentLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
  if (!match) return null;
  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

function loadEnvFiles(paths) {
  const loaded = [];
  const keys = new Set();
  for (const filePath of paths) {
    if (!filePath || !existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf8");
    let loadedAny = false;
    for (const line of content.split(/\r?\n/u)) {
      const assignment = parseShellAssignmentLine(line);
      if (!assignment) continue;
      const [key, value] = assignment;
      if (!process.env[key] && value) {
        process.env[key] = value;
        keys.add(key);
        loadedAny = true;
      }
    }
    loaded.push({ path: filePath, loaded: loadedAny });
  }
  return { files: loaded, keys: [...keys].toSorted() };
}

function loadCueboardProviderConfig(filePath, providerName) {
  const trimmedPath = String(filePath || "").trim();
  if (!trimmedPath) return { loaded: false, path: "", provider: providerName, keys: [] };
  if (!existsSync(trimmedPath)) {
    return {
      loaded: false,
      path: trimmedPath,
      provider: providerName,
      error: "cueboard_config_not_found",
      keys: [],
    };
  }
  const config = JSON.parse(readFileSync(trimmedPath, "utf8"));
  const provider = (config?.copilot?.llm?.providers || []).find(
    (entry) => String(entry?.name || "").trim() === providerName,
  );
  if (!provider) {
    return {
      loaded: false,
      path: trimmedPath,
      provider: providerName,
      error: "cueboard_provider_not_found",
      keys: [],
    };
  }
  const loadedKeys = [];
  const setIfPresent = (key, value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return;
    process.env[key] = trimmed;
    loadedKeys.push(key);
  };
  if (providerName === "openrouter") {
    setIfPresent("ONEESAMA_OPENROUTER_API_KEY", provider.api_key);
    setIfPresent("ONEESAMA_OPENROUTER_BASE_URL", provider.base_url);
    setIfPresent("ONEESAMA_OPENROUTER_HTTP_REFERER", provider.headers?.["HTTP-Referer"]);
    setIfPresent("ONEESAMA_OPENROUTER_X_TITLE", provider.headers?.["X-Title"]);
  } else if (providerName === "gemini") {
    setIfPresent("ONEESAMA_GEMINI_API_KEY", provider.api_key);
    setIfPresent("ONEESAMA_GEMINI_BASE_URL", provider.base_url);
  } else if (providerName === "openai") {
    setIfPresent("ONEESAMA_OPENAI_API_KEY", provider.api_key);
    setIfPresent("ONEESAMA_OPENAI_BASE_URL", provider.base_url);
  }
  return {
    loaded: loadedKeys.length > 0,
    path: trimmedPath,
    provider: providerName,
    mode: String(provider.mode || ""),
    baseURLConfigured: Boolean(String(provider.base_url || "").trim()),
    apiKeyConfigured: Boolean(String(provider.api_key || "").trim()),
    defaultHeadersConfigured: Boolean(provider.headers && Object.keys(provider.headers).length > 0),
    keys: loadedKeys.toSorted(),
  };
}

function loadPlannerEnv(args) {
  const paths = [...(args.envFiles || [])];
  if (args.loadLiveEnv !== false) paths.unshift(...defaultLiveEnvPaths());
  const envFiles = loadEnvFiles(paths);
  const cueboardConfig = loadCueboardProviderConfig(args.cueboardConfig, args.provider);
  return {
    files: envFiles.files,
    keys: [...new Set([...envFiles.keys, ...(cueboardConfig.keys || [])])].toSorted(),
    cueboardConfig,
  };
}

function apiKeyPresent(provider) {
  if (provider === "openrouter") {
    return Boolean(
      firstEnv(
        "ONEESAMA_OPENROUTER_API_KEY",
        "MAB_OPENROUTER_API_KEY",
        "OPENROUTER_API_KEY",
        "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_API_KEY",
        "MAB_KWWK_CU_PLANNER_OPENROUTER_API_KEY",
      ),
    );
  }
  if (provider === "gemini") {
    return Boolean(
      firstEnv(
        "ONEESAMA_GEMINI_API_KEY",
        "MAB_GEMINI_API_KEY",
        "GEMINI_API_KEY",
        "ONEESAMA_KWWK_CU_PLANNER_GEMINI_API_KEY",
        "MAB_KWWK_CU_PLANNER_GEMINI_API_KEY",
      ),
    );
  }
  return Boolean(firstEnv("ONEESAMA_OPENAI_API_KEY", "MAB_OPENAI_API_KEY", "OPENAI_API_KEY"));
}

function livePlannerCase() {
  return {
    id: "live-planner-click-visible-send-button",
    instruction: "Click the visible Send button in the shared app.",
    target: {
      applicationName: "KWWK Fixture App",
      windowTitle: "Planner Fixture",
    },
    observation: {
      accessibility: [
        {
          role: "AXButton",
          label: "Send",
          enabled: true,
          visible: true,
          frame: { x: 320, y: 180, width: 96, height: 36 },
        },
      ],
      screenshot: {
        elements: [
          { role: "button", label: "Send", frame: { x: 320, y: 180, width: 96, height: 36 } },
        ],
      },
    },
  };
}

function spawnHelper(binary, args, helperPath) {
  const child = spawn(binary, ["--stdio"], {
    env: {
      ...process.env,
      ONEESAMA_APP_CONTROL_HELPER: helperPath,
      ONEESAMA_KWWK_CU_PLANNER_PROVIDER: args.provider,
      ONEESAMA_KWWK_CU_PLANNER_MODEL: args.model,
      ONEESAMA_KWWK_CU_PLANNER_TIMEOUT_MS: String(args.plannerTimeoutMs),
      ONEESAMA_KWWK_CU_PLANNER_REASONING_EFFORT: args.reasoningEffort,
      ...(args.serviceTier ? { ONEESAMA_KWWK_CU_PLANNER_SERVICE_TIER: args.serviceTier } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const pending = [];
  let exited = false;
  const settlePending = (payload) => {
    while (pending.length > 0) {
      pending.shift()?.(payload);
    }
  };
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    settlePending({ ok: false, error: "helper_overall_timeout" });
  }, args.timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/u);
    stdout = lines.pop() || "";
    for (const line of lines.filter(Boolean)) {
      try {
        pending.shift()?.({ ok: true, value: JSON.parse(line) });
      } catch (error) {
        pending.shift()?.({ ok: false, error: String(error?.message || error), raw: line });
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("exit", (code, signal) => {
    exited = true;
    clearTimeout(timer);
    settlePending({ ok: false, error: `helper_exited_${code ?? signal ?? "unknown"}` });
  });
  child.nextResponse = () =>
    new Promise((resolve) => {
      if (exited) {
        resolve({ ok: false, error: "helper_already_exited" });
        return;
      }
      pending.push(resolve);
    });
  child.closeHelper = async () => {
    clearTimeout(timer);
    child.stdin.end();
    if (exited || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  };
  child.stderrText = () => stderr.trim();
  return child;
}

async function callPlanner(helper, testCase, args) {
  const started = performance.now();
  helper.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: testCase.id,
      method: "kwwk.cu.plan",
      params: {
        instruction: testCase.instruction,
        target: testCase.target,
        observation: testCase.observation,
      },
    })}\n`,
  );
  const response = await helper.nextResponse();
  const roundTripMs = Math.round(performance.now() - started);
  if (!response?.ok) {
    return {
      id: testCase.id,
      ok: false,
      roundTripMs,
      blocker: response?.error || "jsonrpc_parse_failed",
      raw: response?.raw || "",
    };
  }
  const envelope = response.value || {};
  const result = envelope.result || {};
  const planner = result.planner || {};
  const operations = Array.isArray(result.operations) ? result.operations : [];
  const actionKinds = operations.map((operation) => String(operation?.kind || "")).filter(Boolean);
  const schemaValid =
    operations.length > 0 &&
    operations.length <= Number(planner.maxActions || 3) &&
    actionKinds.every((kind) => ALLOWED_ACTION_KINDS.has(kind));
  const provider = String(planner.provider || "");
  const modelName = String(planner.modelName || "");
  const actualServiceTier = String(planner.serviceTier || "");
  const modelLatencyMs = Number(planner.modelLatencyMs || 0);
  const blocker = String(result.blocker || "");
  const withinPlannerSlo = modelLatencyMs <= args.plannerSloMs;
  const expectedProvider = `model_first_${args.provider}`;
  const ok =
    envelope.error === undefined &&
    result.ok === true &&
    provider === expectedProvider &&
    planner.modelUsed === true &&
    modelName.trim().length > 0 &&
    modelLatencyMs >= 0 &&
    schemaValid &&
    !blocker;
  return {
    id: testCase.id,
    ok,
    status: String(result.status || ""),
    provider,
    modelUsed: planner.modelUsed === true,
    modelName,
    requestedModel: String(planner.modelConfig?.model || ""),
    serviceTier: String(planner.modelConfig?.serviceTier || ""),
    actualServiceTier,
    modelLatencyMs,
    plannerRuntime: planner.runtime || {},
    deterministicOperationsMatched: planner.deterministicOperationsMatched === true,
    deterministicOperationsMismatch: planner.deterministicOperationsMismatch || {},
    plannerSloMs: args.plannerSloMs,
    withinPlannerSlo,
    roundTripMs,
    schemaValid,
    schemaRefusal: blocker === "planner_model_refusal",
    actionKinds,
    operations,
    blocker: ok ? "" : blocker || envelope.error?.message || "live_planner_gate_failed",
  };
}

function percentileNearestRank(values, percentile) {
  const sorted = values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .toSorted((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

export function buildLivePlannerReport(args, runResult) {
  const cases = Array.isArray(runResult.cases) ? runResult.cases : [];
  const warmupCases = Array.isArray(runResult.warmupCases) ? runResult.warmupCases : [];
  const measuredModelMs = cases.map((testCase) => Number(testCase.modelLatencyMs || 0));
  const measuredRoundTripMs = cases.map((testCase) => Number(testCase.roundTripMs || 0));
  const latencyGate = {
    ok: cases.length > 0 && percentileNearestRank(measuredModelMs, 95) <= args.plannerSloMs,
    plannerSloMs: args.plannerSloMs,
    p50ModelMs: percentileNearestRank(measuredModelMs, 50),
    p90ModelMs: percentileNearestRank(measuredModelMs, 90),
    p95ModelMs: percentileNearestRank(measuredModelMs, 95),
    maxModelMs: percentileNearestRank(measuredModelMs, 100),
    p95RoundTripMs: percentileNearestRank(measuredRoundTripMs, 95),
    measuredCount: measuredModelMs.length,
    exceededCount: cases.filter((testCase) => testCase.withinPlannerSlo === false).length,
  };
  const ok =
    runResult.ok === true &&
    runResult.apiKeyPresent === true &&
    cases.length === args.plannerRuns &&
    latencyGate.ok === true &&
    cases.every((testCase) => testCase.ok === true);
  return {
    schema: "oneesama.realtime-kwwk-live-planner-report.v1",
    gate: "kwwk_live_planner",
    ok,
    generatedAt: new Date().toISOString(),
    evidenceMode: `${args.provider}_structured_outputs_live_planner`,
    acceptanceGateScope: "kwwk_live_planner",
    meetRoomRequired: false,
    realAppExecution: false,
    docsEvidence: {
      structuredOutputs:
        "https://developers.openai.com/api/docs/guides/structured-outputs#structured-outputs-vs-json-mode",
      endpoint:
        args.provider === "openrouter"
          ? "https://openrouter.ai/api/v1/chat/completions"
          : args.provider === "gemini"
            ? "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            : "https://api.openai.com/v1/responses",
    },
    environment: {
      platform: process.platform,
      apiKeyPresent: runResult.apiKeyPresent === true,
      baseURLConfigured: Boolean(
        args.provider === "openrouter"
          ? firstEnv(
              "ONEESAMA_OPENROUTER_BASE_URL",
              "MAB_OPENROUTER_BASE_URL",
              "OPENROUTER_BASE_URL",
              "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_BASE_URL",
              "MAB_KWWK_CU_PLANNER_OPENROUTER_BASE_URL",
            )
          : args.provider === "gemini"
            ? firstEnv(
                "ONEESAMA_GEMINI_BASE_URL",
                "MAB_GEMINI_BASE_URL",
                "GEMINI_BASE_URL",
                "ONEESAMA_KWWK_CU_PLANNER_GEMINI_BASE_URL",
                "MAB_KWWK_CU_PLANNER_GEMINI_BASE_URL",
              )
            : firstEnv("ONEESAMA_OPENAI_BASE_URL", "MAB_OPENAI_BASE_URL", "OPENAI_BASE_URL"),
      ),
      loadedEnvKeys: Array.isArray(runResult.loadedEnvKeys) ? runResult.loadedEnvKeys : [],
      loadedEnvFiles: Array.isArray(runResult.loadedEnvFiles) ? runResult.loadedEnvFiles : [],
      cueboardConfig: runResult.cueboardConfig || { loaded: false },
    },
    requestedProvider: args.provider,
    requestedModel: args.model,
    providerRuntime: providerRuntimeEvidence(args.provider),
    latencyGate,
    timeoutMs: args.timeoutMs,
    plannerTimeoutMs: args.plannerTimeoutMs,
    plannerSloMs: args.plannerSloMs,
    warmupRuns: args.warmupRuns,
    plannerRuns: args.plannerRuns,
    reasoningEffort: args.reasoningEffort,
    serviceTier: args.serviceTier,
    timings: {
      totalMs: runResult.durationMs || 0,
      compileMs: runResult.compileMs || 0,
      startupMs: runResult.startupMs || 0,
      warmupModelMs: warmupCases.map((testCase) => testCase.modelLatencyMs || 0),
      warmupRoundTripMs: warmupCases.map((testCase) => testCase.roundTripMs || 0),
      modelMs: cases.map((testCase) => testCase.modelLatencyMs || 0),
      roundTripMs: cases.map((testCase) => testCase.roundTripMs || 0),
    },
    summaryCounts: {
      schemaValid: cases.filter((testCase) => testCase.schemaValid === true).length,
      plannerLatencySloExceeded: cases.filter(
        (testCase) =>
          testCase.withinPlannerSlo === false ||
          testCase.blocker === "planner_model_latency_slo_exceeded",
      ).length,
      invalidResponse: cases.filter(
        (testCase) => testCase.blocker === "blocked_planner_model_invalid_response",
      ).length,
      timeout: cases.filter((testCase) => testCase.blocker === "blocked_planner_model_timeout")
        .length,
    },
    proofBoundary: {
      proves: ok
        ? [
            `${args.provider} planner path is reachable with the configured API key`,
            "the helper requests Structured Outputs through kwwk.cu.plan and records modelUsed",
            "the returned plan is schema-valid and action-bearing before execution",
          ]
        : [
            "the live planner gate ran and recorded a hard blocker instead of using a local fallback",
          ],
      doesNotProve: [
        ...(ok ? [] : [`${args.provider} planner availability or schema-valid action planning`]),
        "Realtime foreground tool recall",
        "live app execution",
        "real Google Meet sidecar integration",
      ],
    },
    warmupCases,
    cases,
    error: runResult.error || "",
    exitCode: runResult.exitCode ?? null,
  };
}

function boolEnvDefault(value, fallback) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "no", "off"].includes(raw);
}

function providerRuntimeEvidence(provider) {
  if (provider === "gemini") {
    const reasoningEffort = firstEnv(
      "ONEESAMA_KWWK_CU_PLANNER_REASONING_EFFORT",
      "ONEESAMA_KWWK_PLANNER_REASONING_EFFORT",
      "MAB_KWWK_CU_PLANNER_REASONING_EFFORT",
      "MAB_KWWK_PLANNER_REASONING_EFFORT",
    );
    const requested = String(reasoningEffort || DEFAULT_REASONING_EFFORT)
      .trim()
      .toLowerCase();
    const hedgeWidth = Number(
      firstEnv(
        "ONEESAMA_KWWK_CU_PLANNER_GEMINI_HEDGE_WIDTH",
        "ONEESAMA_KWWK_PLANNER_GEMINI_HEDGE_WIDTH",
        "MAB_KWWK_CU_PLANNER_GEMINI_HEDGE_WIDTH",
        "MAB_KWWK_PLANNER_GEMINI_HEDGE_WIDTH",
      ) || 24,
    );
    return {
      endpoint: "generateContent",
      responseSchema: "responseMimeType+responseSchema",
      thinkingLevel: ["low", "medium", "high"].includes(requested) ? requested : "",
      thinkingBudget: ["low", "medium", "high"].includes(requested) ? null : 0,
      deterministicPlannerShape: "operation_id_selection",
      deterministicHedgeWidth: Number.isFinite(hedgeWidth) && hedgeWidth > 0 ? hedgeWidth : 24,
      openAICompatibility: false,
    };
  }
  if (provider !== "openrouter") return {};
  const sort = firstEnv(
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_PROVIDER_SORT",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_PROVIDER_SORT",
    "ONEESAMA_OPENROUTER_PROVIDER_SORT",
    "MAB_OPENROUTER_PROVIDER_SORT",
  );
  const requireParameters = firstEnv(
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_REQUIRE_PARAMETERS",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_REQUIRE_PARAMETERS",
    "ONEESAMA_OPENROUTER_REQUIRE_PARAMETERS",
    "MAB_OPENROUTER_REQUIRE_PARAMETERS",
  );
  const allowFallbacks = firstEnv(
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_ALLOW_FALLBACKS",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_ALLOW_FALLBACKS",
    "ONEESAMA_OPENROUTER_ALLOW_FALLBACKS",
    "MAB_OPENROUTER_ALLOW_FALLBACKS",
  );
  const stream = firstEnv(
    "ONEESAMA_KWWK_CU_PLANNER_OPENROUTER_STREAM",
    "MAB_KWWK_CU_PLANNER_OPENROUTER_STREAM",
    "ONEESAMA_OPENROUTER_STREAM",
    "MAB_OPENROUTER_STREAM",
  );
  return {
    sort: String(sort || DEFAULT_OPENROUTER_PROVIDER_SORT).toLowerCase(),
    requireParameters: boolEnvDefault(requireParameters, DEFAULT_OPENROUTER_REQUIRE_PARAMETERS),
    allowFallbacks: allowFallbacks ? boolEnvDefault(allowFallbacks, false) : null,
    stream: boolEnvDefault(stream, false),
  };
}

export async function runLivePlannerBenchmark(args) {
  const started = performance.now();
  const loadedEnv = loadPlannerEnv(args);
  if (process.platform !== "darwin") {
    return {
      ok: false,
      apiKeyPresent: apiKeyPresent(args.provider),
      loadedEnvKeys: loadedEnv.keys,
      loadedEnvFiles: loadedEnv.files,
      cueboardConfig: loadedEnv.cueboardConfig,
      error: "app_control_helper_requires_darwin",
      cases: [],
      durationMs: Math.round(performance.now() - started),
    };
  }
  if (!apiKeyPresent(args.provider)) {
    const requiredKey =
      args.provider === "openrouter"
        ? "openrouter_api_key_required"
        : args.provider === "gemini"
          ? "gemini_api_key_required"
          : "openai_api_key_required";
    return {
      ok: false,
      apiKeyPresent: false,
      loadedEnvKeys: loadedEnv.keys,
      loadedEnvFiles: loadedEnv.files,
      cueboardConfig: loadedEnv.cueboardConfig,
      error: requiredKey,
      cases: [
        {
          id: livePlannerCase().id,
          ok: false,
          blocker: requiredKey,
        },
      ],
      durationMs: Math.round(performance.now() - started),
    };
  }
  const dir = await mkdtemp(join(tmpdir(), "oneesama-kwwk-live-planner-"));
  const compileStarted = performance.now();
  const binary = await ensureAppControlHelperBinary();
  const compileMs = Math.round(performance.now() - compileStarted);
  const startupStarted = performance.now();
  const helper = spawnHelper(binary, args, join(dir, "helper"));
  const startupMs = Math.round(performance.now() - startupStarted);
  try {
    const warmupCases = [];
    for (let index = 0; index < args.warmupRuns; index += 1) {
      warmupCases.push(
        await callPlanner(helper, { ...livePlannerCase(), id: `warmup-${index + 1}` }, args),
      );
    }
    const cases = [];
    for (let index = 0; index < args.plannerRuns; index += 1) {
      cases.push(
        await callPlanner(helper, { ...livePlannerCase(), id: `planner-${index + 1}` }, args),
      );
    }
    return {
      ok: cases.every((testCase) => testCase.ok === true),
      apiKeyPresent: true,
      loadedEnvKeys: loadedEnv.keys,
      loadedEnvFiles: loadedEnv.files,
      cueboardConfig: loadedEnv.cueboardConfig,
      compileMs,
      startupMs,
      warmupCases,
      cases,
      durationMs: Math.round(performance.now() - started),
      exitCode: helper.exitCode,
    };
  } catch (error) {
    return {
      ok: false,
      apiKeyPresent: true,
      loadedEnvKeys: loadedEnv.keys,
      loadedEnvFiles: loadedEnv.files,
      cueboardConfig: loadedEnv.cueboardConfig,
      compileMs,
      startupMs,
      error: String(error?.message || error),
      cases: [],
      durationMs: Math.round(performance.now() - started),
      exitCode: helper.exitCode,
      stderr: helper.stderrText(),
    };
  } finally {
    await helper.closeHelper();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runResult = await runLivePlannerBenchmark(args);
  const report = buildLivePlannerReport(args, runResult);
  if (args.jsonOut) {
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `KWWK live planner benchmark: ${report.ok ? "PASS" : "FAIL"} provider=${args.provider} model=${args.model} cases=${report.cases
      .map((testCase) => `${testCase.id}:${testCase.ok ? "pass" : "fail"}`)
      .join(",")}`,
  );
  process.exitCode = report.ok || args.reportOnly ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`realtime-kwwk-live-planner-benchmark failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
