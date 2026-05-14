import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getRuntimeConfig } from "../env.js";

interface CodexRunnerJob {
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

interface CodexRunnerOptions {
  dryRun?: boolean;
  onJobUpdate?: (job: CodexRunnerJob) => unknown;
}

interface CodexRunnerStartInput {
  task: string;
  context?: Record<string, unknown>;
  mode?: string;
  allowCodeChanges?: boolean;
}

export function createCodexRunner(options: CodexRunnerOptions = {}) {
  const config = getRuntimeConfig();
  const jobs = new Map<string, CodexRunnerJob>();
  const dryRun = Boolean(options.dryRun);
  const onJobUpdate = typeof options.onJobUpdate === "function" ? options.onJobUpdate : null;

  async function startTask({
    task,
    context = {},
    mode = "analysis",
    allowCodeChanges = false,
  }: CodexRunnerStartInput) {
    const job: CodexRunnerJob = {
      id: `job_${crypto.randomUUID().slice(0, 8)}`,
      provider: "codex",
      status: dryRun ? "completed" : "running",
      mode,
      task,
      context,
      allowCodeChanges,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: dryRun ? "Dry-run Codex runner accepted the task." : "",
    };
    jobs.set(job.id, job);

    if (!dryRun)
      runCodex(job).catch((error) => {
        updateJob(job.id, { status: "failed", error: String(error?.message || error) });
      });

    return job;
  }

  function updateJob(id: string, patch: Partial<CodexRunnerJob>) {
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
    return [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function runCodex(job: CodexRunnerJob) {
    return new Promise<CodexRunnerJob | null>((resolve, reject) => {
      const sandbox =
        config.codexSandbox || (job.allowCodeChanges ? "workspace-write" : "read-only");
      const prompt = [
        "You are a background worker for an open-source meeting avatar bot.",
        "Answer in concise Chinese. If you cannot complete the task, explain the blocker.",
        `Mode: ${job.mode}`,
        `Task: ${job.task}`,
        `Context: ${JSON.stringify(job.context)}`,
      ].join("\n\n");
      const child = spawn(
        config.codexBin,
        [
          "exec",
          "-m",
          config.codexModel,
          "-c",
          'approval_policy="never"',
          "-s",
          sandbox,
          "--skip-git-repo-check",
          "--ephemeral",
          "-",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

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
            error: stderr.trim() || `codex exited ${code}`,
          });
          resolve(getJob(job.id));
        }
      });
      child.stdin.end(prompt);
    });
  }

  return { startTask, getJob, listJobs };
}
