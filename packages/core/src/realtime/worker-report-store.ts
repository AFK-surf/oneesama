import crypto from "node:crypto";
import {
  createStateCollection,
  type StateCollection,
  type StateProviderOptions,
} from "../persistence/state-provider.js";

export interface WorkerReport {
  id: string;
  status: string;
  provider: string;
  mode: string;
  task: string;
  context: Record<string, unknown>;
  allowCodeChanges: boolean;
  result: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  deliveredToRealtime: boolean;
  deliveredToSlack: boolean;
  [key: string]: unknown;
}

export interface WorkerReportStoreOptions extends StateProviderOptions {}

export function createWorkerReportStore(options: WorkerReportStoreOptions = {}) {
  const jobs = createStateCollection({
    provider: options.provider || (options.filePath ? "json-file" : "memory"),
    filePath: options.filePath,
    sqlitePath: options.sqlitePath,
    collection: options.collection || "worker_reports",
  }) as StateCollection<WorkerReport>;

  function create(job: Partial<WorkerReport>) {
    const now = new Date().toISOString();
    const next: WorkerReport = {
      id: job.id || `job_${crypto.randomUUID().slice(0, 8)}`,
      status: job.status || "queued",
      provider: job.provider || "",
      mode: job.mode || "",
      task: job.task || "",
      context: job.context || {},
      allowCodeChanges: Boolean(job.allowCodeChanges),
      result: job.result || "",
      error: job.error || "",
      createdAt: job.createdAt || now,
      updatedAt: now,
      deliveredToRealtime: false,
      deliveredToSlack: false,
    };
    jobs.set(next.id, next);
    return next;
  }

  function update(id: string, patch: Partial<WorkerReport>) {
    const current = jobs.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    jobs.set(id, next);
    return next;
  }

  function get(id: string) {
    return jobs.get(id);
  }

  function list() {
    return jobs.list().toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function pollReadyForRealtime({
    limit = 1,
    markDelivered = true,
    minCreatedAt = "",
    sessionId = "",
  }: {
    limit?: number;
    markDelivered?: boolean;
    minCreatedAt?: string;
    sessionId?: string;
  } = {}) {
    const minTime = minCreatedAt ? Date.parse(minCreatedAt) : 0;
    const ready: WorkerReport[] = [];
    for (const job of list()) {
      if (ready.length >= limit) break;
      if (!["completed", "failed", "timeout"].includes(job.status) || job.deliveredToRealtime) {
        continue;
      }
      if (minTime && Date.parse(String(job.createdAt || job.updatedAt || "")) < minTime) {
        continue;
      }
      const suppressChannel = realtimeSuppressChannel(job, sessionId);
      if (suppressChannel) {
        if (markDelivered) {
          update(job.id, {
            deliveredToRealtime: true,
            realtimeDelivery: { channel: suppressChannel, deliveredAt: new Date().toISOString() },
          });
        }
        continue;
      }
      ready.push(job);
    }
    if (markDelivered) {
      for (const job of ready) update(job.id, { deliveredToRealtime: true });
    }
    return ready;
  }

  function pollReadyForSlack({
    limit = 10,
    markDelivered = true,
  }: {
    limit?: number;
    markDelivered?: boolean;
  } = {}) {
    const ready = list()
      .filter(
        (job) => ["completed", "failed", "timeout"].includes(job.status) && !job.deliveredToSlack,
      )
      .slice(0, limit);
    if (markDelivered) {
      for (const job of ready) update(job.id, { deliveredToSlack: true });
    }
    return ready;
  }

  function realtimeSuppressChannel(job: WorkerReport, sessionId = "") {
    if (!isRealtimeMeetingScoped(job)) return "realtime_non_meeting_suppressed";
    const targetSessionId = workerMeetingSessionId(job);
    if (sessionId && targetSessionId && targetSessionId !== sessionId) {
      return "realtime_session_mismatch_suppressed";
    }
    return "";
  }

  function isRealtimeMeetingScoped(job: WorkerReport) {
    const context = job.context || {};
    const kind = String(context.session_kind || context.sessionKind || "").trim();
    if (kind) {
      const normalized = kind.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
      if (
        [
          "meeting-copilot",
          "meeting-calibrate",
          "meeting-summary",
          "meeting-demo-surface",
          "meeting-demo-execution",
          "meeting-app-control",
        ].includes(normalized)
      ) {
        return true;
      }
      if (
        ["secretary-lookup", "slack-triage", "slack-case", "memory-compact"].includes(normalized)
      ) {
        return false;
      }
    }
    const source = String(context.source || "")
      .trim()
      .toLowerCase();
    if (!source) return false;
    if (
      source.includes("persona_delegate") ||
      source.includes("triage") ||
      source.includes("secretary")
    ) {
      return false;
    }
    return source.startsWith("meeting-") || source.startsWith("meeting_");
  }

  function workerMeetingSessionId(job: WorkerReport) {
    const context = job.context || {};
    return String(
      context.meeting_session_id ||
        context.meetingSessionId ||
        context.meetingSessionID ||
        context.session_id ||
        context.sessionId ||
        "",
    ).trim();
  }

  return {
    create,
    update,
    get,
    list,
    pollReadyForRealtime,
    pollReadyForSlack,
    provider: jobs.provider,
    path: jobs.path,
    collection: jobs.collection,
    close() {
      jobs.close?.();
    },
  };
}
