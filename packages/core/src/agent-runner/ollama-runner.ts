import crypto from "node:crypto";
import { getRuntimeConfig } from "../env.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout"]);

interface OllamaRunnerJob {
  id: string;
  provider: string;
  status: string;
  mode: string;
  task: string;
  context: Record<string, unknown>;
  allowCodeChanges: boolean;
  createdAt: string;
  updatedAt: string;
  result: string;
  error?: string;
  debug?: string;
}

interface OllamaRunnerOptions {
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  onJobUpdate?: (job: OllamaRunnerJob) => unknown;
}

interface OllamaRunnerStartInput {
  task: string;
  context?: Record<string, unknown>;
  mode?: string;
  allowCodeChanges?: boolean;
}

export function createOllamaRunner(options: OllamaRunnerOptions = {}) {
  const config = getRuntimeConfig(options.env);
  const jobs = new Map<string, OllamaRunnerJob>();
  const dryRun = Boolean(options.dryRun);
  const onJobUpdate = typeof options.onJobUpdate === "function" ? options.onJobUpdate : null;

  async function startTask({
    task,
    context = {},
    mode = "analysis",
    allowCodeChanges = false,
  }: OllamaRunnerStartInput) {
    const job: OllamaRunnerJob = {
      id: `job_${crypto.randomUUID().slice(0, 8)}`,
      provider: "ollama",
      status: dryRun ? "completed" : "running",
      mode,
      task,
      context,
      allowCodeChanges,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: dryRun ? `Dry-run Ollama runner accepted the task: ${task}` : "",
    };
    jobs.set(job.id, job);

    if (!dryRun)
      runOllama(job).catch((error) => {
        updateJob(job.id, { status: "failed", error: String(error?.message || error) });
      });

    return job;
  }

  function updateJob(id: string, patch: Partial<OllamaRunnerJob>) {
    const current = jobs.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    jobs.set(id, next);
    if (onJobUpdate && TERMINAL_STATUSES.has(next.status))
      Promise.resolve(onJobUpdate(next)).catch(() => {});
    return next;
  }

  function getJob(id: string) {
    return jobs.get(id) || null;
  }

  function listJobs() {
    return [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function runOllama(job: OllamaRunnerJob) {
    const prompt = [
      "You are a background worker for an open-source meeting avatar bot.",
      "Answer in concise Chinese. If you cannot complete the task, explain the blocker.",
      `Mode: ${job.mode}`,
      `Allow code changes: ${job.allowCodeChanges ? "yes" : "no"}`,
      `Task: ${job.task}`,
      `Context: ${JSON.stringify(job.context)}`,
    ].join("\n\n");
    const url = `${config.ollamaBaseUrl}/api/generate`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        prompt,
        stream: false,
      }),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = null;
    }
    const result = parsed?.response || parsed?.message?.content || parsed?.result || text.trim();
    if (!response.ok) {
      updateJob(job.id, {
        status: "failed",
        result,
        error: result || `ollama returned ${response.status}`,
        debug: text,
      });
      return getJob(job.id);
    }
    updateJob(job.id, {
      status: "completed",
      result: String(result || "").trim(),
      debug: parsed
        ? JSON.stringify({
            model: parsed.model || config.ollamaModel,
            done: parsed.done,
            totalDuration: parsed.total_duration,
          })
        : text,
    });
    return getJob(job.id);
  }

  return { startTask, getJob, listJobs };
}
