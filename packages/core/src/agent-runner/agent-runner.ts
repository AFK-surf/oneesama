import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getRuntimeConfig } from "../env.js";
import { createClaudeRunner } from "./claude-runner.js";
import { createCodexAppServerRunner } from "./codex-app-server-runner.js";
import { createCodexRunner } from "./codex-runner.js";
import { createOllamaRunner } from "./ollama-runner.js";
import { createSlackAgentDRunner } from "./slack-agent-d-runner.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout"]);
const commandKillGraceMs = 2_000;
const defaultAgentRunnerTimeoutMs = 120_000;
const defaultAgentRunnerOutputMaxBytes = 262_144;

type RunnerStatus = "queued" | "running" | "completed" | "failed" | "timeout";

interface RunnerJob {
  id: string;
  provider: string;
  status: RunnerStatus | string;
  mode: string;
  task: string;
  context: Record<string, unknown>;
  allowCodeChanges: boolean;
  createdAt: string;
  updatedAt: string;
  result: string;
  error?: string;
  debug?: string;
  raw?: unknown;
}

type RunnerJobPatch = Partial<RunnerJob>;

interface RunnerStartInput {
  task: string;
  context?: Record<string, unknown>;
  mode?: string;
  allowCodeChanges?: boolean;
}

interface AgentRunnerOptions {
  provider?: string;
  env?: NodeJS.ProcessEnv;
  onJobUpdate?: (job: RunnerJob) => unknown;
  dryRun?: boolean;
  [key: string]: unknown;
}

interface JobStoreOptions {
  provider: string;
  onJobUpdate?: (job: RunnerJob) => unknown;
}

interface RunnerParsedResult {
  status: string;
  result: string;
  error?: string;
  raw?: unknown;
}

interface LimitedText {
  text: string;
  truncated: boolean;
}

interface RunnerLimits {
  timeoutMs: number;
  outputMaxBytes: number;
}

type JobStore = ReturnType<typeof createJobStore>;

interface StartStoredJobOptions {
  store: JobStore;
  dryRun: boolean;
  dryRunResult: string;
  missingConfigError?: string;
  run?: (job: RunnerJob) => Promise<unknown>;
}

async function startStoredJob(
  { task, context = {}, mode = "analysis", allowCodeChanges = false }: RunnerStartInput,
  { store, dryRun, dryRunResult, missingConfigError, run }: StartStoredJobOptions,
): Promise<RunnerJob | null> {
  const job = store.createJob({
    task,
    context,
    mode,
    allowCodeChanges,
    status: dryRun ? "completed" : "running",
    result: dryRun ? dryRunResult : "",
  });
  if (dryRun) {
    store.updateJob(job.id, { status: "completed" });
    return store.getJob(job.id);
  }
  if (missingConfigError) {
    return store.updateJob(job.id, { status: "failed", error: missingConfigError });
  }
  run?.(job).catch((error) => {
    store.updateJob(job.id, { status: "failed", error: String(error?.message || error) });
  });
  return job;
}

function runnerLimitsFromConfig(config: ReturnType<typeof getRuntimeConfig>): RunnerLimits {
  return {
    timeoutMs: Math.max(1, Number(config.agentRunnerTimeoutMs || defaultAgentRunnerTimeoutMs)),
    outputMaxBytes: Math.max(
      1,
      Number(config.agentRunnerOutputMaxBytes || defaultAgentRunnerOutputMaxBytes),
    ),
  };
}

function requiredConfigError(value: unknown, message: string): string | undefined {
  return value ? undefined : message;
}

function appendLimitedText(current: LimitedText, chunk: unknown, maxTextLength: number): LimitedText {
  const next = current.text + String(chunk || "");
  if (!maxTextLength || maxTextLength <= 0 || next.length <= maxTextLength) {
    return { text: next, truncated: current.truncated };
  }
  return {
    text: next.slice(0, maxTextLength),
    truncated: true,
  };
}

function withTruncationMarker(value: string, truncated: boolean): string {
  if (!truncated) return value;
  return `${value}\n[output truncated]`;
}

async function readResponseTextLimited(response: Response, maxTextLength: number): Promise<string> {
  if (!response.body) {
    const raw = await response.text();
    const limited = appendLimitedText({ text: "", truncated: false }, raw, maxTextLength);
    return withTruncationMarker(limited.text, limited.truncated);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let state = { text: "", truncated: false };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      state = appendLimitedText(state, decoder.decode(value, { stream: true }), maxTextLength);
      if (state.truncated) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (!state.truncated) {
      state = appendLimitedText(state, decoder.decode(), maxTextLength);
    }
  } finally {
    reader.releaseLock();
  }
  return withTruncationMarker(state.text, state.truncated);
}

function createJobStore({ provider, onJobUpdate }: JobStoreOptions) {
  const jobs = new Map<string, RunnerJob>();
  const notify = typeof onJobUpdate === "function" ? onJobUpdate : null;

  function createJob({
    task,
    context = {},
    mode = "analysis",
    allowCodeChanges = false,
    status = "running",
    result = "",
  }: RunnerStartInput & { status?: RunnerStatus | string; result?: string }): RunnerJob {
    const job: RunnerJob = {
      id: `job_${crypto.randomUUID().slice(0, 8)}`,
      provider,
      status,
      mode,
      task,
      context,
      allowCodeChanges,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result,
    };
    jobs.set(job.id, job);
    return job;
  }

  function updateJob(id: string, patch: RunnerJobPatch) {
    const current = jobs.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    jobs.set(id, next);
    if (notify && TERMINAL_STATUSES.has(next.status)) Promise.resolve(notify(next)).catch(() => {});
    return next;
  }

  function getJob(id: string) {
    return jobs.get(id) || null;
  }

  function listJobs() {
    return [...jobs.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return { createJob, updateJob, getJob, listJobs };
}

function normalizeProvider(provider: unknown): string {
  return String(provider || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

function parseRunnerResult(text: unknown, fallbackStatus = "completed"): RunnerParsedResult {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { status: fallbackStatus, result: "" };
  try {
    const parsed = JSON.parse(trimmed);
    return {
      status: String(parsed.status || fallbackStatus),
      result: String(parsed.result || parsed.text || parsed.message || trimmed),
      error: parsed.error ? String(parsed.error) : "",
      raw: parsed,
    };
  } catch {
    return { status: fallbackStatus, result: trimmed };
  }
}

function createDryRunRunner(options: AgentRunnerOptions = {}) {
  const store = createJobStore({ provider: "dry-run", onJobUpdate: options.onJobUpdate });
  return {
    async startTask(input: RunnerStartInput) {
      return startStoredJob(input, {
        store,
        dryRun: true,
        dryRunResult: "Dry-run agent runner accepted the task.",
      });
    },
    getJob: store.getJob,
    listJobs: store.listJobs,
  };
}

function createCommandRunner(options: AgentRunnerOptions = {}) {
  const config = getRuntimeConfig(options.env);
  const store = createJobStore({ provider: "command", onJobUpdate: options.onJobUpdate });
  const dryRun = Boolean(options.dryRun);
  const runnerEnv = options.env || process.env;
  const limits = runnerLimitsFromConfig(config);

  async function startTask(input: RunnerStartInput) {
    return startStoredJob(input, {
      store,
      dryRun,
      dryRunResult: "Dry-run command runner accepted the task.",
      missingConfigError: requiredConfigError(
        config.agentCommand,
        "MAB_AGENT_COMMAND is required when MAB_AGENT_RUNNER=command",
      ),
      run: (job) => runCommand(job, config.agentCommand, store, runnerEnv, limits),
    });
  }

  return { startTask, getJob: store.getJob, listJobs: store.listJobs };
}

function runCommand(
  job: RunnerJob,
  command: string,
  store: ReturnType<typeof createJobStore>,
  runnerEnv: NodeJS.ProcessEnv = process.env,
  {
    timeoutMs = defaultAgentRunnerTimeoutMs,
    outputMaxBytes = defaultAgentRunnerOutputMaxBytes,
  }: Partial<RunnerLimits> = {},
) {
  return new Promise<RunnerJob | null>((resolve, reject) => {
    const child = spawn(command, [], {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...runnerEnv, MAB_AGENT_JOB_ID: job.id },
    });
    let stdout = { text: "", truncated: false };
    let stderr = { text: "", truncated: false };
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), commandKillGraceMs);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    };
    child.stdout.on("data", (chunk) => {
      stdout = appendLimitedText(stdout, chunk, outputMaxBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimitedText(stderr, chunk, outputMaxBytes);
    });
    child.on("error", (error) => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (timedOut) {
        store.updateJob(job.id, {
          status: "timeout",
          result: withTruncationMarker(stdout.text, stdout.truncated),
          error: `agent command timed out after ${timeoutMs}ms`,
          debug: withTruncationMarker(stderr.text.trim(), stderr.truncated),
        });
        resolve(store.getJob(job.id));
        return;
      }
      const output = withTruncationMarker(stdout.text, stdout.truncated);
      const parsed = parseRunnerResult(output, code === 0 ? "completed" : "failed");
      const patch: RunnerJobPatch = {
        status: code === 0 ? parsed.status : "failed",
        result: parsed.result,
        debug: withTruncationMarker(stderr.text.trim(), stderr.truncated),
      };
      if (parsed.error || code !== 0)
        patch.error = parsed.error || stderr.text.trim() || `command exited ${code}`;
      store.updateJob(job.id, patch);
      resolve(store.getJob(job.id));
    });
    child.stdin.end(JSON.stringify(job, null, 2));
  });
}

function createHttpRunner(options: AgentRunnerOptions = {}) {
  const config = getRuntimeConfig(options.env);
  const store = createJobStore({ provider: "http", onJobUpdate: options.onJobUpdate });
  const dryRun = Boolean(options.dryRun);
  const limits = runnerLimitsFromConfig(config);

  async function startTask(input: RunnerStartInput) {
    return startStoredJob(input, {
      store,
      dryRun,
      dryRunResult: "Dry-run HTTP runner accepted the task.",
      missingConfigError: requiredConfigError(
        config.agentHttpUrl,
        "MAB_AGENT_HTTP_URL is required when MAB_AGENT_RUNNER=http",
      ),
      run: (job) => runHttp(job, config.agentHttpUrl, store, limits),
    });
  }

  return { startTask, getJob: store.getJob, listJobs: store.listJobs };
}

async function runHttp(
  job: RunnerJob,
  url: string,
  store: ReturnType<typeof createJobStore>,
  {
    timeoutMs = defaultAgentRunnerTimeoutMs,
    outputMaxBytes = defaultAgentRunnerOutputMaxBytes,
  }: Partial<RunnerLimits> = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("upstream_timeout")), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      store.updateJob(job.id, {
        status: "timeout",
        error: `agent HTTP runner timed out after ${timeoutMs}ms`,
      });
      return store.getJob(job.id);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await readResponseTextLimited(response, outputMaxBytes);
  const parsed = parseRunnerResult(text, response.ok ? "completed" : "failed");
  store.updateJob(job.id, {
    status: response.ok ? parsed.status : "failed",
    result: parsed.result,
    error: parsed.error || (response.ok ? "" : `agent HTTP runner returned ${response.status}`),
    debug: parsed.raw ? "" : text,
  });
  return store.getJob(job.id);
}

export function createAgentRunner(options: AgentRunnerOptions = {}) {
  const config = getRuntimeConfig(options.env);
  const provider = normalizeProvider(options.provider || config.agentRunner || "dry-run");
  const dryRun =
    Boolean(options.dryRun) ||
    config.dryRunAgent ||
    (provider === "codex" && config.dryRunCodex) ||
    (provider === "codex-app-server" && config.dryRunCodex) ||
    provider === "dry-run";
  if (provider === "dry-run") return createDryRunRunner({ ...options, dryRun: true });
  if (provider === "codex" && normalizeProvider(config.codexRunnerMode) === "app-server") {
    return createCodexAppServerRunner({ ...options, dryRun });
  }
  if (provider === "codex-app-server" || provider === "codex-appserver")
    return createCodexAppServerRunner({ ...options, dryRun });
  if (provider === "codex") return createCodexRunner({ ...options, dryRun });
  if (provider === "claude" || provider === "claude-code")
    return createClaudeRunner({ ...options, dryRun });
  if (provider === "ollama" || provider === "ollama-http" || provider === "local-ollama")
    return createOllamaRunner({ ...options, dryRun });
  if (
    provider === "slack-agent-d" ||
    provider === "slack-agentd" ||
    provider === "legacy-slack-agent-d"
  )
    return createSlackAgentDRunner({ ...options, dryRun });
  if (provider === "command") return createCommandRunner({ ...options, dryRun });
  if (provider === "http" || provider === "http-json")
    return createHttpRunner({ ...options, dryRun });
  throw new Error(`Unsupported MAB_AGENT_RUNNER provider: ${provider}`);
}
