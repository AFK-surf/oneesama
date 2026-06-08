import type { Database as DatabaseInstance } from "better-sqlite3";

export function tableCount(db: DatabaseInstance, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return Number(row?.count || 0);
}

/**
 * The legacy slack domain store accepts duck-typed payloads from many call
 * sites that historically passed JS objects without schema validation. We give
 * them a single permissive input shape — every known field is optional with a
 * stable type, and an index signature keeps unknown extras safe.
 */
export interface SlackDomainStoreInput {
  // identity
  id?: string | number;
  workspaceId?: string;
  workspace_id?: string;
  channelId?: string;
  channel_id?: string;
  channel?: string;
  slackChannelId?: string;
  slack_channel_id?: string;
  threadTs?: string;
  thread_ts?: string;
  slackThreadTs?: string;
  slack_thread_ts?: string;
  msgTs?: string;
  msg_ts?: string;
  userId?: string;
  user_id?: string;
  ownerUserId?: string;
  owner_user_id?: string;
  sessionId?: string;
  session_id?: string;
  assistantSessionId?: string;
  assistant_session_id?: string;
  // case / ledger
  caseType?: string;
  case_type?: string;
  type?: string;
  kind?: string;
  status?: string;
  topic?: string;
  title?: string;
  summary?: string;
  // outbound
  actionType?: string;
  action_type?: string;
  action?: string;
  actionStatus?: string;
  action_status?: string;
  actions?: unknown;
  target?: string;
  reference?: string;
  dedupeKey?: string;
  dedupe_key?: string;
  // recommendation
  recommendationType?: string;
  recommendation_type?: string;
  // pending
  params?: unknown;
  // meeting
  meetingId?: string;
  meeting_id?: string;
  remoteMeetingId?: string;
  remote_meeting_id?: string;
  // heartbeat
  followupId?: number | string;
  followup_id?: number | string;
  sourceKind?: string;
  source_kind?: string;
  sourceRef?: string;
  source_ref?: string;
  priority?: string;
  dueAt?: string;
  due_at?: string;
  nextCheckAt?: string;
  next_check_at?: string;
  requestedSurface?: string;
  requested_surface?: string;
  deliveredSurface?: string;
  delivered_surface?: string;
  blockReason?: string;
  block_reason?: string;
  error?: string;
  // triage
  toolCalls?: unknown;
  tool_calls?: unknown;
  // feedback
  entryDate?: string;
  entry_date?: string;
  entryTime?: string;
  entry_time?: string;
  confidence?: number;
  severity?: string;
  signalType?: string;
  signal_type?: string;
  desiredBehavior?: string;
  desired_behavior?: string;
  clusterKey?: string;
  cluster_key?: string;
  // misc
  at?: string;
  run?: unknown;
  metadata?: Record<string, unknown> | unknown;
  metadata_json?: string;
  [key: string]: unknown;
}

export const LEGACY_SLACK_DOMAIN_SCHEMA_VERSION = 2;

export const LEGACY_SLACK_DOMAIN_TABLES = [
  "channel",
  "channel_membership",
  "thread_case",
  "channel_brain",
  "thread_ledger",
  "event_cursor",
  "outbound_action",
  "thread_recommendation",
  "pending_action",
  "meeting_thread",
  "meeting_result_delivery",
  "triage_run",
  "triage_action",
  "triage_tool_call",
  "feedback_entry",
  "improvement_signal",
  "heartbeat_followup",
  "heartbeat_surface",
];

export function nowIso(): string {
  return new Date().toISOString();
}

export function text(value: unknown, fallback = ""): string {
  const result = String(value ?? "").trim();
  return result || fallback;
}

export function numberOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function clamp01(value: unknown): number {
  const n = numberOrZero(value);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function normalizedChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const candidate = text(value).toLowerCase();
  return (allowed as readonly string[]).includes(candidate) ? (candidate as T) : fallback;
}

export function safeJson<T = Record<string, unknown>>(value: unknown, fallback: T = {} as T): T {
  if (value && typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value || "")) as T;
  } catch {
    return fallback;
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export type Row = Record<string, unknown>;

export function rowJson(row: Row | null | undefined): Row | null {
  return row
    ? (Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          if (key.endsWith("_json") && typeof value === "string") return [key, safeJson(value, {})];
          return [key, value];
        }),
      ) as Row)
    : null;
}

export function normalizeThreadTs(value: unknown): string {
  return text(value, "channel-root");
}

export interface SlackEventBody {
  team_id?: string;
  team?: { id?: string };
  channel_id?: string;
  channel?: { id?: string; name?: string } | string;
  channel_name?: string;
  channel_type?: string;
  thread_ts?: string;
  message_ts?: string;
  event_ts?: string;
  ts?: string;
  user_id?: string;
  user?: { id?: string } | string;
  [key: string]: unknown;
}

interface SlackIdentity {
  workspaceId: string;
  channelId: string;
  channelName: string;
  channelType: string;
  threadTs: string;
  userId: string;
}

export function slackIdentity(body: SlackEventBody = {}): SlackIdentity {
  const channelObj =
    typeof body.channel === "object" && body.channel !== null ? body.channel : undefined;
  const userObj = typeof body.user === "object" && body.user !== null ? body.user : undefined;
  return {
    workspaceId: text(body.team_id || body.team?.id, "workspace"),
    channelId: text(body.channel_id || channelObj?.id, "channel"),
    channelName: text(body.channel_name || channelObj?.name),
    channelType: text(body.channel_type, "public_channel"),
    threadTs: normalizeThreadTs(body.thread_ts || body.message_ts || body.event_ts || body.ts),
    userId: text(body.user_id || userObj?.id || (typeof body.user === "string" ? body.user : "")),
  };
}

export function migrate(db: DatabaseInstance): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS mab_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'public_channel',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channel_membership (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS thread_case (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      case_type TEXT NOT NULL DEFAULT 'mention',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, channel_id, thread_ts)
    );

    CREATE TABLE IF NOT EXISTS channel_brain (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      summary_version INTEGER NOT NULL DEFAULT 0,
      last_session_id TEXT NOT NULL DEFAULT '',
      last_thread_ts TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS thread_ledger (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      assistant_session_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      owner_user_id TEXT NOT NULL DEFAULT '',
      last_user_id TEXT NOT NULL DEFAULT '',
      last_user_message_at TEXT,
      last_assistant_message_at TEXT,
      last_action_type TEXT NOT NULL DEFAULT '',
      last_action_status TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, channel_id, thread_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_ledger_channel_thread
      ON thread_ledger(channel_id, thread_ts);

    CREATE TABLE IF NOT EXISTS event_cursor (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS outbound_action (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      target TEXT NOT NULL,
      reference TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(action_type, target, reference)
    );

    CREATE TABLE IF NOT EXISTS thread_recommendation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      recommendation_type TEXT NOT NULL,
      card_ts TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel_id, thread_ts, recommendation_type)
    );

    CREATE TABLE IF NOT EXISTS pending_action (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      card_ts TEXT NOT NULL DEFAULT '',
      action_type TEXT NOT NULL,
      params TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      confirmed_by TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS meeting_thread (
      dedupe_key TEXT PRIMARY KEY,
      remote_meeting_id INTEGER NOT NULL DEFAULT 0,
      slack_channel_id TEXT NOT NULL,
      slack_thread_ts TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_thread_remote_id ON meeting_thread(remote_meeting_id);

    CREATE TABLE IF NOT EXISTS meeting_result_delivery (
      meeting_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_result_delivery_status_created_at
      ON meeting_result_delivery(status, created_at);

    CREATE TABLE IF NOT EXISTS triage_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'failed',
      summary TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      digest TEXT NOT NULL DEFAULT '',
      steps INTEGER NOT NULL DEFAULT 0,
      duration_seconds REAL NOT NULL DEFAULT 0,
      mutations INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      channels_json TEXT NOT NULL DEFAULT '[]',
      raw_output TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_triage_run_occurred_at
      ON triage_run(occurred_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS triage_action (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      tool TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT '',
      brief TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(run_id) REFERENCES triage_run(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_triage_action_run_pos
      ON triage_action(run_id, position, id);

    CREATE TABLE IF NOT EXISTS triage_tool_call (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      tool TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT '',
      args TEXT NOT NULL DEFAULT '',
      success INTEGER NOT NULL DEFAULT 0,
      brief TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(run_id) REFERENCES triage_run(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_triage_tool_call_run_pos
      ON triage_tool_call(run_id, position, id);

    CREATE TABLE IF NOT EXISTS feedback_entry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL,
      entry_time TEXT NOT NULL,
      action TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT '',
      action_type TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_entry_date_time
      ON feedback_entry(entry_date, entry_time, id);

    CREATE TABLE IF NOT EXISTS improvement_signal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL DEFAULT '',
      signal_type TEXT NOT NULL DEFAULT 'complaint',
      summary TEXT NOT NULL DEFAULT '',
      desired_behavior TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'medium',
      confidence REAL NOT NULL DEFAULT 0,
      channel_id TEXT NOT NULL DEFAULT '',
      thread_ts TEXT NOT NULL DEFAULT '',
      msg_ts TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      cluster_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_improvement_signal_cluster_status
      ON improvement_signal(cluster_key, status, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_improvement_signal_topic_status
      ON improvement_signal(topic, status, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_improvement_signal_channel_thread
      ON improvement_signal(channel_id, thread_ts, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_improvement_signal_created_at
      ON improvement_signal(created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS heartbeat_followup (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'reminder',
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT 'dm',
      channel_id TEXT NOT NULL DEFAULT '',
      thread_ts TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      due_at TEXT,
      next_check_at TEXT,
      last_surfaced_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_heartbeat_followup_status_next_check
      ON heartbeat_followup(status, next_check_at, due_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_heartbeat_followup_channel_thread
      ON heartbeat_followup(channel_id, thread_ts, updated_at DESC);

    CREATE TABLE IF NOT EXISTS heartbeat_surface (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      followup_id INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      requested_surface TEXT NOT NULL DEFAULT '',
      delivered_surface TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL DEFAULT '',
      thread_ts TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'sent',
      block_reason TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_heartbeat_surface_created_at
      ON heartbeat_surface(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_heartbeat_surface_followup_created_at
      ON heartbeat_surface(followup_id, created_at DESC, id DESC);
  `);

  db.prepare(
    `
    INSERT OR IGNORE INTO mab_schema_migrations (version, name, applied_at)
    VALUES (?, ?, ?)
  `,
  ).run(LEGACY_SLACK_DOMAIN_SCHEMA_VERSION, "legacy_slack_domain_schema", nowIso());
}

export interface CreateLegacySlackDomainStoreOptions {
  dbPath?: string;
}

export interface UpsertChannelInput {
  id?: string;
  name?: string;
  type?: string;
}
