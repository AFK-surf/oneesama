import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const TRIAGE_CONTEXT_FILE = ".triage-context.json";
export const TRIAGE_CONTEXT_ARCHIVE_DIR = "triage-archive";
export const TRIAGE_CONTEXT_MAX_SIZE = 20;
export const TRIAGE_CONTEXT_CHAR_BUDGET = 1600;

interface TriageActionInput {
  tool?: string;
  type?: string;
  channel?: string;
  channelId?: string;
  channel_id?: string;
  brief?: string;
  title?: string;
  message?: string;
  summary?: string;
  [key: string]: unknown;
}

interface TriageToolCallInput {
  tool?: string;
  action?: string;
  args?: unknown;
  success?: boolean | number | string;
  brief?: string;
  [key: string]: unknown;
}

export interface TriageContextInput {
  id?: number | string;
  session_id?: string;
  sessionId?: string;
  timestamp?: string;
  occurred_at?: string;
  occurredAt?: string;
  status?: string;
  channels?: unknown;
  channels_json?: unknown;
  actions?: TriageActionInput[];
  tool_calls?: TriageToolCallInput[];
  toolCalls?: TriageToolCallInput[];
  summary?: string;
  error?: string;
  digest?: string;
  steps?: number;
  duration_seconds?: number;
  durationSeconds?: number;
  mutations?: number;
  failures?: number;
  tokens_used?: number;
  tokensUsed?: number;
  [key: string]: unknown;
}

export interface NormalizedTriageContext {
  id: number;
  session_id: string;
  timestamp: string;
  status: string;
  channels: string[];
  actions: { tool: string; channel: string; brief: string }[];
  tool_calls: { tool: string; action: string; args: string; success: boolean; brief: string }[];
  summary: string;
  error: string;
  digest: string;
  steps: number;
  duration_seconds: number;
  mutations: number;
  failures: number;
  tokens_used: number;
}

function text(value: unknown, fallback: string = ""): string {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function numberOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeJson<T = unknown>(value: unknown, fallback: T | null = null): T | null {
  if (value && typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value || "")) as T;
  } catch {
    return fallback;
  }
}

function assertInside(rootDir: string, path: string): string {
  const root = resolve(rootDir);
  const target = resolve(path);
  const rel = relative(root, target);
  if (target === root || (!rel.startsWith("..") && rel !== "..")) return target;
  throw new Error(`triage context path escapes root: ${path}`);
}

function shanghaiDate(iso: string = ""): string {
  const date = iso ? new Date(iso) : new Date();
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(valid);
}

function shanghaiTime(iso: string = ""): string {
  const date = iso ? new Date(iso) : new Date();
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(valid);
}

function projectionPath(workspaceDir: string): string {
  return assertInside(workspaceDir, join(workspaceDir, "memory", TRIAGE_CONTEXT_FILE));
}

function archivePath(workspaceDir: string, date: string): string {
  return assertInside(
    workspaceDir,
    join(workspaceDir, "memory", TRIAGE_CONTEXT_ARCHIVE_DIR, `${date}.json`),
  );
}

function normalizeAction(action: TriageActionInput = {}) {
  return {
    tool: text(action.tool || action.type),
    channel: text(action.channel || action.channelId || action.channel_id),
    brief: text(action.brief || action.title || action.message || action.summary),
  };
}

function normalizeToolCall(call: TriageToolCallInput = {}) {
  return {
    tool: text(call.tool),
    action: text(call.action),
    args: typeof call.args === "string" ? call.args : JSON.stringify(call.args || {}),
    success: Boolean(call.success),
    brief: text(call.brief),
  };
}

function normalizeChannelList(value: unknown): string[] {
  const parsed = Array.isArray(value) ? value : safeJson<unknown[]>(value, []);
  return Array.isArray(parsed) ? parsed.map((channel) => text(channel)).filter(Boolean) : [];
}

export function normalizeTriageContext(input: TriageContextInput | unknown = {}): NormalizedTriageContext {
  const data = (input || {}) as TriageContextInput;
  const occurredAt = text(
    data.timestamp || data.occurred_at || data.occurredAt,
    new Date().toISOString(),
  );
  return {
    id: numberOrZero(data.id),
    session_id: text(data.session_id || data.sessionId),
    timestamp: occurredAt,
    status: text(data.status, "failed"),
    channels: normalizeChannelList(data.channels || data.channels_json),
    actions: (Array.isArray(data.actions) ? data.actions : [])
      .map(normalizeAction)
      .filter((action) => action.tool || action.brief),
    tool_calls: (Array.isArray(data.tool_calls) ? data.tool_calls : data.toolCalls || []).map(
      normalizeToolCall,
    ),
    summary: text(data.summary),
    error: text(data.error),
    digest: text(data.digest),
    steps: numberOrZero(data.steps),
    duration_seconds: numberOrZero(data.duration_seconds || data.durationSeconds),
    mutations: numberOrZero(data.mutations),
    failures: numberOrZero(data.failures),
    tokens_used: numberOrZero(data.tokens_used || data.tokensUsed),
  };
}

export function loadTriageContextProjection(
  workspaceDir: string,
): NormalizedTriageContext[] {
  const root = text(workspaceDir);
  if (!root) return [];
  const filePath = projectionPath(root);
  if (!existsSync(filePath)) return [];
  const parsed = safeJson<TriageContextInput[]>(readFileSync(filePath, "utf8"), []);
  return Array.isArray(parsed) ? parsed.map(normalizeTriageContext) : [];
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function archiveTriageContexts(workspaceDir: string, entries: NormalizedTriageContext[] = []) {
  const archived: { date: string; path: string; count: number; total: number }[] = [];
  const byDate = new Map<string, NormalizedTriageContext[]>();
  for (const entry of entries) {
    const normalized = normalizeTriageContext(entry);
    const date = shanghaiDate(normalized.timestamp);
    const group = byDate.get(date) || [];
    group.push(normalized);
    byDate.set(date, group);
  }

  for (const [date, group] of byDate.entries()) {
    const filePath = archivePath(workspaceDir, date);
    const existing = existsSync(filePath) ? safeJson(readFileSync(filePath, "utf8"), []) : [];
    const next = [...(Array.isArray(existing) ? existing : []), ...group].map(
      normalizeTriageContext,
    );
    writeJsonAtomic(filePath, next);
    archived.push({ date, path: filePath, count: group.length, total: next.length });
  }
  return archived;
}

export interface PersistTriageContextProjectionArgs {
  workspaceDir?: string;
  context?: unknown;
  maxSize?: number;
}

export function persistTriageContextProjection({
  workspaceDir,
  context,
  maxSize = TRIAGE_CONTEXT_MAX_SIZE,
}: PersistTriageContextProjectionArgs = {}) {
  const root = text(workspaceDir);
  if (!root) return { ok: false, error: "workspace_dir_required" };
  const normalized = normalizeTriageContext(context);
  const existing = loadTriageContextProjection(root);
  const entries = [...existing, normalized];
  const keepSize = Math.max(1, Number(maxSize) || TRIAGE_CONTEXT_MAX_SIZE);
  const evicted = entries.length > keepSize ? entries.slice(0, entries.length - keepSize) : [];
  const kept = entries.slice(Math.max(0, entries.length - keepSize));
  const archived = archiveTriageContexts(root, evicted);
  const filePath = projectionPath(root);
  writeJsonAtomic(filePath, kept);
  return {
    ok: true,
    path: filePath,
    maxSize: keepSize,
    appended: normalized,
    keptCount: kept.length,
    evictedCount: evicted.length,
    archived,
  };
}

export function triagePromptFallbackLabel(status = "") {
  switch (text(status).toLowerCase()) {
    case "failed":
      return "FAILED";
    case "timeout":
      return "TIMEOUT";
    case "error":
      return "ERROR";
    default:
      return "ACTIONLESS";
  }
}

export function formatTriageContexts(contexts = [], budget = TRIAGE_CONTEXT_CHAR_BUDGET) {
  const filtered = contexts
    .map(normalizeTriageContext)
    .filter(
      (context) =>
        !(["ok", "success"].includes(context.status.toLowerCase()) && context.actions.length === 0),
    );
  if (!filtered.length) return "";

  const lines = ["=== Previous Triage ==="];
  for (const context of filtered) {
    const channelActions = new Map();
    for (const channel of context.channels) channelActions.set(channel, []);
    for (const action of context.actions) {
      const channel = action.channel || "unknown";
      const actions = channelActions.get(channel) || [];
      actions.push(`${action.tool} "${action.brief}"`);
      channelActions.set(channel, actions);
    }
    const channelParts = [...channelActions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([channel, actions]) => {
        return actions.length
          ? `#${channel}: ${actions.join(" | ")}`
          : `#${channel}: ${triagePromptFallbackLabel(context.status)}`;
      });
    lines.push(`[${shanghaiTime(context.timestamp)}] ${channelParts.join(" | ")}`);
    if (lines.join("\n").length > budget) break;
  }
  lines.push("===");
  const result = lines.join("\n");
  return result.length > budget ? `${result.slice(0, Math.max(0, budget - 3))}...` : result;
}
