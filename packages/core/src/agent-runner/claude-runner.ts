import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getRuntimeConfig } from "../env.js";

interface ClaudeRunnerJob {
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

interface ClaudeRunnerOptions {
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  onJobUpdate?: (job: ClaudeRunnerJob) => unknown;
}

interface ClaudeRunnerStartInput {
  task: string;
  context?: Record<string, unknown>;
  mode?: string;
  allowCodeChanges?: boolean;
}

export function createClaudeRunner(options: ClaudeRunnerOptions = {}) {
  const config = getRuntimeConfig(options.env);
  const jobs = new Map<string, ClaudeRunnerJob>();
  const dryRun = Boolean(options.dryRun);
  const onJobUpdate = typeof options.onJobUpdate === "function" ? options.onJobUpdate : null;

  async function startTask({
    task,
    context = {},
    mode = "analysis",
    allowCodeChanges = false,
  }: ClaudeRunnerStartInput) {
    const job: ClaudeRunnerJob = {
      id: `job_${crypto.randomUUID().slice(0, 8)}`,
      provider: "claude",
      status: dryRun ? "completed" : "running",
      mode,
      task,
      context,
      allowCodeChanges,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: dryRun ? "Dry-run Claude Code runner accepted the task." : "",
    };
    jobs.set(job.id, job);

    if (!dryRun)
      runClaude(job).catch((error) => {
        updateJob(job.id, { status: "failed", error: String(error?.message || error) });
      });

    return job;
  }

  function updateJob(id: string, patch: Partial<ClaudeRunnerJob>) {
    const current = jobs.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    jobs.set(id, next);
    if (onJobUpdate) Promise.resolve(onJobUpdate(next)).catch(() => {});
    return next;
  }

  function getJob(id: string) {
    return jobs.get(id) || null;
  }

  function listJobs() {
    return [...jobs.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function runClaude(job: ClaudeRunnerJob) {
    return new Promise<ClaudeRunnerJob | null>((resolve, reject) => {
      const prompt = [
        "You are a background worker for an open-source meeting avatar bot.",
        "Answer in concise Chinese. If you cannot complete the task, explain the blocker.",
        `Mode: ${job.mode}`,
        `Allow code changes: ${job.allowCodeChanges ? "yes" : "no"}`,
        `Task: ${job.task}`,
        `Context: ${JSON.stringify(job.context)}`,
      ].join("\n\n");
      const permissionMode = job.allowCodeChanges
        ? config.claudeWritePermissionMode
        : config.claudeReadPermissionMode;
      const args = [
        "-p",
        "--output-format",
        "text",
        "--model",
        config.claudeModel,
        "--permission-mode",
        permissionMode,
        "--no-session-persistence",
      ];
      if (config.claudeMaxBudgetUsd) {
        args.push("--max-budget-usd", String(config.claudeMaxBudgetUsd));
      }
      args.push(prompt);

      const child = spawn(config.claudeBin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
        if (code === 0) {
          updateJob(job.id, { status: "completed", result: stdout.trim(), debug: stderr.trim() });
          resolve(getJob(job.id));
        } else {
          updateJob(job.id, {
            status: "failed",
            result: stdout.trim(),
            error: stderr.trim() || `claude exited ${code}`,
          });
          resolve(getJob(job.id));
        }
      });
    });
  }

  return { startTask, getJob, listJobs };
}
