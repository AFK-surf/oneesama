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
    return jobs.list().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function pollReadyForRealtime({
    limit = 1,
    markDelivered = true,
    minCreatedAt = "",
  }: {
    limit?: number;
    markDelivered?: boolean;
    minCreatedAt?: string;
  } = {}) {
    const minTime = minCreatedAt ? Date.parse(minCreatedAt) : 0;
    const ready = list()
      .filter(
        (job) =>
          ["completed", "failed", "timeout"].includes(job.status) &&
          !job.deliveredToRealtime &&
          (!minTime || Date.parse(String(job.createdAt || job.updatedAt || "")) >= minTime),
      )
      .slice(0, limit);
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
