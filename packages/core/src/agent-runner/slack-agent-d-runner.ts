import crypto from "node:crypto";
import { getRuntimeConfig } from "../env.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout"]);
type FetchImpl = typeof fetch;

interface SlackAgentDJob {
  id: string;
  provider: string;
  status: string;
  mode: string;
  task: string;
  context: unknown;
  allowCodeChanges: boolean;
  createdAt: string;
  updatedAt: string;
  result: string;
  error?: string;
  debug?: string;
  providerJobId?: string;
  statusUrl?: string;
}

interface SlackAgentDRunnerOptions {
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  onJobUpdate?: (job: SlackAgentDJob) => unknown;
  fetchImpl?: FetchImpl;
}

interface SlackAgentDStartInput {
  task: string;
  context?: Record<string, unknown>;
  mode?: string;
  allowCodeChanges?: boolean;
}

interface SlackAgentDProviderResponse {
  status: string;
  result: string;
  error: string;
  providerJobId: string;
  statusUrl: string;
  raw?: unknown;
}

interface SlackAgentDHttpResult {
  ok: boolean;
  status: number;
  text: string;
  parsed: SlackAgentDProviderResponse;
}

const PRIVATE_FIELD_NAMES = new Set([
  "token",
  "response_url",
  "responseUrl",
  "trigger_id",
  "triggerId",
  "signingSecret",
  "slackSigningSecret",
  "slackBotToken",
  "slackAppToken",
  "authorization",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "clientSecret",
  "client_secret",
  "password",
  "secret",
]);

function shouldDropKey(key: string): boolean {
  return PRIVATE_FIELD_NAMES.has(key);
}

function sanitizeForBridge(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeForBridge(item));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (shouldDropKey(key)) continue;
    output[key] = sanitizeForBridge(child);
  }
  return output;
}

function assertNoPrivateFields(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  for (const field of PRIVATE_FIELD_NAMES) {
    if (serialized.includes(`"${field}"`)) {
      throw new Error(`Slack Agent D adapter payload must not include private field: ${field}`);
    }
  }
  return true;
}

function createHeaders(config: ReturnType<typeof getRuntimeConfig>): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "meeting-avatar-bot/slack-agent-d-provider",
  };
  if (config.slackAgentDToken) {
    headers.authorization = `Bearer ${config.slackAgentDToken}`;
    headers["x-meeting-avatar-bot-token"] = config.slackAgentDToken;
  }
  return headers;
}

function normalizeProviderResponse(
  text: unknown,
  fallbackStatus = "completed",
): SlackAgentDProviderResponse {
  const trimmed = String(text || "").trim();
  if (!trimmed)
    return {
      status: fallbackStatus,
      result: "",
      error: "",
      providerJobId: "",
      statusUrl: "",
    };
  try {
    const parsed = JSON.parse(trimmed);
    return {
      status: String(parsed.status || (parsed.ok === false ? "failed" : fallbackStatus)),
      result: String(parsed.result || parsed.text || parsed.message || parsed.output || trimmed),
      error: parsed.error || parsed.detail ? String(parsed.error || parsed.detail) : "",
      providerJobId: String(parsed.jobId || parsed.job_id || parsed.id || ""),
      statusUrl: String(parsed.statusUrl || parsed.status_url || ""),
      raw: parsed,
    };
  } catch {
    return {
      status: fallbackStatus,
      result: trimmed,
      error: "",
      providerJobId: "",
      statusUrl: "",
    };
  }
}

function resolveStatusUrl(statusUrl: unknown, baseUrl: string): string {
  if (!statusUrl) return "";
  try {
    return new URL(String(statusUrl), baseUrl).toString();
  } catch {
    return "";
  }
}

export function createSlackAgentDRunner(options: SlackAgentDRunnerOptions = {}) {
  const config = getRuntimeConfig(options.env);
  const jobs = new Map<string, SlackAgentDJob>();
  const dryRun = Boolean(options.dryRun);
  const onJobUpdate = typeof options.onJobUpdate === "function" ? options.onJobUpdate : null;
  const fetchImpl = options.fetchImpl || fetch;

  async function startTask({
    task,
    context = {},
    mode = "analysis",
    allowCodeChanges = false,
  }: SlackAgentDStartInput) {
    const safeContext = sanitizeForBridge(context);
    const job: SlackAgentDJob = {
      id: `job_${crypto.randomUUID().slice(0, 8)}`,
      provider: "slack-agent-d",
      status: dryRun ? "completed" : "running",
      mode,
      task,
      context: safeContext,
      allowCodeChanges,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: dryRun ? `Dry-run Slack Agent D adapter accepted the task: ${task}` : "",
    };
    jobs.set(job.id, job);

    if (!dryRun)
      runSlackAgentD(job).catch((error) => {
        updateJob(job.id, { status: "failed", error: String(error?.message || error) });
      });

    return job;
  }

  function updateJob(id: string, patch: Partial<SlackAgentDJob>) {
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
    return [...jobs.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function runSlackAgentD(job: SlackAgentDJob) {
    if (!config.slackAgentDUrl) {
      updateJob(job.id, {
        status: "failed",
        error: "MAB_SLACK_AGENT_D_URL is required when MAB_AGENT_RUNNER=slack-agent-d",
      });
      return getJob(job.id);
    }

    const payload = {
      jobId: job.id,
      task: job.task,
      mode: job.mode,
      allowCodeChanges: job.allowCodeChanges,
      context: job.context,
      source: {
        provider: "meeting-avatar-bot",
        adapter: "slack-agent-d",
        createdAt: job.createdAt,
      },
    };
    assertNoPrivateFields(payload);

    const firstResponse = await postJson(config.slackAgentDUrl, payload);
    if (!firstResponse.ok) {
      updateJob(job.id, {
        status: "failed",
        result: firstResponse.parsed.result,
        error:
          firstResponse.parsed.error || `Slack Agent D adapter returned ${firstResponse.status}`,
        debug: firstResponse.text,
      });
      return getJob(job.id);
    }

    let parsed = firstResponse.parsed;
    let status = parsed.status || "completed";
    const statusUrl = resolveStatusUrl(parsed.statusUrl, config.slackAgentDUrl);
    const deadline = Date.now() + config.slackAgentDTimeoutMs;
    if (statusUrl) {
      while (!TERMINAL_STATUSES.has(status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, config.slackAgentDPollIntervalMs));
        const pollResponse = await getJson(statusUrl);
        parsed = pollResponse.parsed;
        status = parsed.status || (pollResponse.ok ? "completed" : "failed");
        if (!pollResponse.ok) break;
      }
    }

    if (!TERMINAL_STATUSES.has(status) && statusUrl) {
      status = "timeout";
      parsed = {
        ...parsed,
        error: `Slack Agent D adapter status poll timed out after ${config.slackAgentDTimeoutMs}ms`,
      };
    }

    updateJob(job.id, {
      status,
      result: parsed.result || "",
      error: parsed.error || "",
      providerJobId: parsed.providerJobId || "",
      statusUrl,
      debug: parsed.raw ? JSON.stringify(parsed.raw) : "",
    });
    return getJob(job.id);
  }

  async function postJson(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<SlackAgentDHttpResult> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: createHeaders(config),
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      parsed: normalizeProviderResponse(text, response.ok ? "completed" : "failed"),
    };
  }

  async function getJson(url: string): Promise<SlackAgentDHttpResult> {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: createHeaders(config),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      parsed: normalizeProviderResponse(text, response.ok ? "completed" : "failed"),
    };
  }

  return { startTask, getJob, listJobs };
}

export const slackAgentDProviderInternals = {
  sanitizeForBridge,
  assertNoPrivateFields,
};
