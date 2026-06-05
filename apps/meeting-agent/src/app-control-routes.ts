import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensureAppControlHelperBinary } from "../../../packages/core/src/meeting/app-control-helper.js";
import type { JsonHttpHandler } from "../../../packages/core/src/http-json.js";
import { compactMeetingAgentAppControlResult } from "./app-control-result.js";
import { meetingAgentControlRequestRejected } from "./internal-control-guard.js";
import type { MeetingAgentInput } from "./meeting-agent-types.js";

interface AppControlHandlerDeps {
  config: { internalAuthKey?: string };
  runDirectAppControl?: DirectAppControlRunner;
  reports: {
    create(input: {
      id: string;
      status: string;
      provider: string;
      mode: string;
      task: string;
      context: Record<string, unknown>;
      result: string;
      error: string;
    }): unknown;
  };
}

type DirectAppControlRunner = (
  body: MeetingAgentInput,
  status?: unknown,
) => Promise<Record<string, unknown>>;

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function appControlStatusTargetMaps(status: unknown) {
  const maps: Record<string, unknown>[] = [];
  const append = (value: unknown) => {
    const record = recordValue(value);
    if (Object.keys(record).length > 0) maps.push(record);
  };
  const root = recordValue(status);
  append(root);
  append(root.screenShare);
  const active = recordValue(root.active);
  append(active);
  append(active.screenShare);
  return maps;
}

function firstTargetString(candidates: Record<string, unknown>[], keys: string[]) {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = String(candidate[key] || "").trim();
      if (value) return value;
    }
  }
  return "";
}

function firstTargetNumber(candidates: Record<string, unknown>[], keys: string[]) {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = Number(candidate[key] || 0);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return 0;
}

function appControlTargetFromBody(body: MeetingAgentInput, status: unknown = null) {
  const target = recordValue(body.target);
  const candidates = [target, ...appControlStatusTargetMaps(status)];
  return {
    ...target,
    applicationName: String(
      body.applicationName ||
        firstTargetString(candidates, ["applicationName", "application_name", "appName", "name"]),
    ),
    bundleIdentifier: String(
      body.bundleIdentifier ||
        firstTargetString(candidates, ["bundleIdentifier", "bundle_identifier", "bundleId"]),
    ),
    windowTitle: String(
      body.windowTitle || firstTargetString(candidates, ["windowTitle", "window_title", "title"]),
    ),
    windowId:
      Number(body.windowId || 0) || firstTargetNumber(candidates, ["windowId", "window_id"]),
    processId:
      Number(body.processId || 0) ||
      firstTargetNumber(candidates, ["processId", "process_id", "pid"]),
  };
}

function appControlSessionIdFromBodyOrStatus(body: MeetingAgentInput, status: unknown = null) {
  const root = recordValue(status);
  const active = recordValue(root.active);
  return String(
    body.session_id ||
      body.sessionId ||
      root.activeSessionId ||
      root.sessionId ||
      root.session_id ||
      active.sessionId ||
      active.session_id ||
      "",
  ).trim();
}

function booleanInput(value: unknown) {
  if (value === true) return true;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "y"].includes(normalized);
}

function sanitizeAppControlContext(context: unknown) {
  const compact = { ...recordValue(context) };
  delete compact.operation;
  delete compact.operations;
  delete compact.realtimeBridge;
  delete compact.workerResultBridge;
  return compact;
}

function directAppControlBody(body: MeetingAgentInput) {
  const compact: MeetingAgentInput = { ...body };
  delete compact.operation;
  delete compact.operations;
  compact.context = sanitizeAppControlContext(body.context);
  return compact;
}

function tsDelegateAppControlUnavailable() {
  return compactMeetingAgentAppControlResult({
    ok: false,
    provider: "kwwk",
    status: "failed",
    error: "ts_delegate_app_control_unavailable",
    blocker: "ts_delegate_app_control_unavailable",
    summary: "TS meeting-agent only supports direct KWWK app-control.",
  });
}

async function runCompactDirectAppControl(
  runDirectAppControl: DirectAppControlRunner,
  body: MeetingAgentInput,
  status: unknown,
) {
  return compactMeetingAgentAppControlResult(
    await runDirectAppControl(directAppControlBody(body), status),
  );
}

async function runKWWKDirectAppControl(body: MeetingAgentInput, status: unknown = null) {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      provider: "kwwk",
      status: "failed",
      error: "app_control_helper_requires_darwin",
      blocker: "app_control_helper_requires_darwin",
    };
  }
  const instruction = String(body.instruction || "").trim();
  if (!instruction) {
    return {
      ok: false,
      provider: "kwwk",
      status: "failed",
      error: "instruction_required",
      blocker: "instruction_required",
    };
  }
  if (
    String(body.executionMode || body.execution_mode || "")
      .trim()
      .toLowerCase() === "delegate"
  ) {
    return {
      ok: false,
      provider: "kwwk",
      status: "failed",
      error: "ts_delegate_app_control_unavailable",
      blocker: "ts_delegate_app_control_unavailable",
      summary: "TS meeting-agent only supports direct KWWK app-control.",
    };
  }
  const timeoutMs = Number(body.timeoutMs || 15_000);
  const binary = await ensureAppControlHelperBinary();
  const child = spawn(binary, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  const stderr: string[] = [];
  const stdout: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));

  const payload = {
    jsonrpc: "2.0",
    id: `ts_app_control_${Date.now()}`,
    method: "kwwk.cu.execute",
    params: {
      session_id: String(body.session_id || body.sessionId || ""),
      instruction,
      target: appControlTargetFromBody(body, status),
      context: recordValue(body.context),
    },
  };
  child.stdin.end(`${JSON.stringify(payload)}\n`);
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    const timer = setTimeout(
      () => {
        child.kill("SIGTERM");
        resolveExit({ code: null, signal: "SIGTERM" });
      },
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolveExit({ code: null, signal: "SIGTERM" });
    });
  });
  const line = stdout.join("").trim().split(/\r?\n/u).find(Boolean);
  if (!line) {
    return {
      ok: false,
      provider: "kwwk",
      status: "failed",
      error: "app_control_helper_no_response",
      blocker: stderr.join("").slice(0, 500) || `helper exited ${exit.code ?? exit.signal}`,
    };
  }
  const rpc = JSON.parse(line) as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };
  if (rpc.error) {
    return {
      ok: false,
      provider: "kwwk",
      status: "failed",
      error: rpc.error.message || "app_control_helper_error",
      blocker: rpc.error.message || "app_control_helper_error",
    };
  }
  return compactMeetingAgentAppControlResult(rpc.result || {});
}

interface TSAppControlJob {
  id: string;
  status: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  request: MeetingAgentInput;
  screenShareStatus: unknown;
  result?: Record<string, unknown>;
  error?: string;
}

export function createInternalControlGuard(config: AppControlHandlerDeps["config"]) {
  return function withInternalControlGuard(handler: JsonHttpHandler): JsonHttpHandler {
    return (args) => {
      const rejected = meetingAgentControlRequestRejected(args.req, {
        internalAuthKey: config.internalAuthKey,
      });
      if (rejected) return rejected;
      return handler(args);
    };
  };
}

export function createTSAppControlToolHandler({
  reports,
  runDirectAppControl = runKWWKDirectAppControl,
}: AppControlHandlerDeps) {
  const tsAppControlJobs = new Map<string, TSAppControlJob>();
  let tsAppControlQueueTail = Promise.resolve();

  function appControlJobEnvelope(job: TSAppControlJob) {
    return {
      ok: !["failed", "timeout"].includes(job.status),
      provider: job.provider,
      status: job.status,
      jobId: job.id,
      job_id: job.id,
      screenShare: appControlTargetFromBody(job.request, job.screenShareStatus),
      result: job.result || null,
      error: job.error || "",
    };
  }

  function rememberTSAppControlJob(job: TSAppControlJob) {
    tsAppControlJobs.set(job.id, job);
    if (tsAppControlJobs.size <= 100) return;
    const oldest = [...tsAppControlJobs.values()].toSorted((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )[0];
    if (oldest) tsAppControlJobs.delete(oldest.id);
  }

  function reportTSAppControlJob(job: TSAppControlJob) {
    const result = job.result || {};
    const context = {
      ...recordValue(job.request.context),
      session_kind: "meeting_app_control",
      meeting_session_id: appControlSessionIdFromBodyOrStatus(job.request, job.screenShareStatus),
      source: "meeting-app-control",
    };
    reports.create({
      id: job.id,
      status: job.status === "completed" ? "completed" : "failed",
      provider: job.provider,
      mode: "app-control",
      task: String(job.request.instruction || ""),
      context,
      result: JSON.stringify(result),
      error: job.error || String(result.error || result.blocker || ""),
    });
  }

  async function runQueuedTSAppControlJob(job: TSAppControlJob) {
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    rememberTSAppControlJob(job);
    try {
      const result = await runCompactDirectAppControl(
        runDirectAppControl,
        job.request,
        job.screenShareStatus,
      );
      job.result = result as Record<string, unknown>;
      job.status = result.ok === true ? "completed" : "failed";
      job.error = result.ok === true ? "" : String(result.error || result.blocker || "");
    } catch (error) {
      job.result = {
        ok: false,
        provider: job.provider,
        status: "failed",
        error: String((error as { message?: string })?.message || error),
        blocker: "app_control_helper_error",
      };
      job.status = "failed";
      job.error = String((error as { message?: string })?.message || error);
    } finally {
      job.updatedAt = new Date().toISOString();
      rememberTSAppControlJob(job);
      reportTSAppControlJob(job);
    }
  }

  function queueTSAppControlJob(body: MeetingAgentInput, status: unknown = null) {
    const now = new Date().toISOString();
    const id = `ts_app_control_${randomUUID().slice(0, 8)}`;
    const job: TSAppControlJob = {
      id,
      status: "queued",
      provider: "kwwk",
      createdAt: now,
      updatedAt: now,
      request: body,
      screenShareStatus: status,
    };
    rememberTSAppControlJob(job);
    queueMicrotask(() => {
      tsAppControlQueueTail = tsAppControlQueueTail
        .catch(() => undefined)
        .then(() => runQueuedTSAppControlJob(job));
    });
    return appControlJobEnvelope(job);
  }

  return async function handleTSAppControlTool(body: MeetingAgentInput, status: unknown = null) {
    const jobId = String(body.job_id || body.jobId || "").trim();
    if (jobId) {
      const job = tsAppControlJobs.get(jobId);
      if (!job) {
        return {
          ok: false,
          provider: "kwwk",
          status: "failed",
          jobId,
          job_id: jobId,
          error: "app_control_job_not_found",
          blocker: "app_control_job_not_found",
        };
      }
      return appControlJobEnvelope(job);
    }
    const executionMode = String(body.executionMode || body.execution_mode || "")
      .trim()
      .toLowerCase();
    if (executionMode === "delegate") {
      return {
        ...tsDelegateAppControlUnavailable(),
        screenShare: appControlTargetFromBody(body, status),
      };
    }
    if (booleanInput(body.wait)) {
      const result = await runCompactDirectAppControl(runDirectAppControl, body, status);
      return {
        ...result,
        screenShare: appControlTargetFromBody(body, status),
      };
    }
    return queueTSAppControlJob(body, status);
  };
}
