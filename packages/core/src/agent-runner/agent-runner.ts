import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getRuntimeConfig } from "../env.js";
import { createClaudeRunner } from "./claude-runner.js";
import { createCodexAppServerRunner } from "./codex-app-server-runner.js";
import { createCodexRunner } from "./codex-runner.js";
import { createOllamaRunner } from "./ollama-runner.js";
import { createSlackAgentDRunner } from "./slack-agent-d-runner.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout"]);

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

interface RunnerJobPatch extends Partial<RunnerJob> {}

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
    return [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    async startTask({ task, context = {}, mode = "analysis", allowCodeChanges = false }: RunnerStartInput) {
      const job = store.createJob({
        task,
        context,
        mode,
        allowCodeChanges,
        status: "completed",
        result: "Dry-run agent runner accepted the task.",
      });
      store.updateJob(job.id, { status: "completed" });
      return store.getJob(job.id);
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

  async function startTask({ task, context = {}, mode = "analysis", allowCodeChanges = false }: RunnerStartInput) {
    const job = store.createJob({
      task,
      context,
      mode,
      allowCodeChanges,
      status: dryRun ? "completed" : "running",
      result: dryRun ? "Dry-run command runner accepted the task." : "",
    });
    if (dryRun) {
      store.updateJob(job.id, { status: "completed" });
      return store.getJob(job.id);
    }
    if (!config.agentCommand) {
      return store.updateJob(job.id, {
        status: "failed",
        error: "MAB_AGENT_COMMAND is required when MAB_AGENT_RUNNER=command",
      });
    }
    runCommand(job, config.agentCommand, store, runnerEnv).catch((error) => {
      store.updateJob(job.id, { status: "failed", error: String(error?.message || error) });
    });
    return job;
  }

  return { startTask, getJob: store.getJob, listJobs: store.listJobs };
}

function runCommand(
  job: RunnerJob,
  command: string,
  store: ReturnType<typeof createJobStore>,
  runnerEnv: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<RunnerJob | null>((resolve, reject) => {
    const child = spawn(command, [], {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...runnerEnv, MAB_AGENT_JOB_ID: job.id },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const parsed = parseRunnerResult(stdout, code === 0 ? "completed" : "failed");
      const patch: RunnerJobPatch = {
        status: code === 0 ? parsed.status : "failed",
        result: parsed.result,
        debug: stderr.trim(),
      };
      if (parsed.error || code !== 0)
        patch.error = parsed.error || stderr.trim() || `command exited ${code}`;
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

  async function startTask({ task, context = {}, mode = "analysis", allowCodeChanges = false }: RunnerStartInput) {
    const job = store.createJob({
      task,
      context,
      mode,
      allowCodeChanges,
      status: dryRun ? "completed" : "running",
      result: dryRun ? "Dry-run HTTP runner accepted the task." : "",
    });
    if (dryRun) {
      store.updateJob(job.id, { status: "completed" });
      return store.getJob(job.id);
    }
    if (!config.agentHttpUrl) {
      return store.updateJob(job.id, {
        status: "failed",
        error: "MAB_AGENT_HTTP_URL is required when MAB_AGENT_RUNNER=http",
      });
    }
    runHttp(job, config.agentHttpUrl, store).catch((error) => {
      store.updateJob(job.id, { status: "failed", error: String(error?.message || error) });
    });
    return job;
  }

  return { startTask, getJob: store.getJob, listJobs: store.listJobs };
}

async function runHttp(job: RunnerJob, url: string, store: ReturnType<typeof createJobStore>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job),
  });
  const text = await response.text();
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
