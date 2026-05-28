import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeTriageContext } from "./triage-context.js";
import { LEGACY_SLACK_DOMAIN_SCHEMA_VERSION, LEGACY_SLACK_DOMAIN_TABLES, clamp01, json, migrate, normalizeThreadTs, normalizedChoice, nowIso, numberOrZero, rowJson, safeJson, slackIdentity, text, type CreateLegacySlackDomainStoreOptions, type Row, type SlackDomainStoreInput, type SlackEventBody, type UpsertChannelInput } from "./legacy-slack-domain-store-shared.js";
export { LEGACY_SLACK_DOMAIN_SCHEMA_VERSION, LEGACY_SLACK_DOMAIN_TABLES }; export type { CreateLegacySlackDomainStoreOptions, SlackDomainStoreInput, SlackEventBody, UpsertChannelInput };
export function createLegacySlackDomainStore({ dbPath }: CreateLegacySlackDomainStoreOptions = {}) {
  if (!dbPath) throw new Error("dbPath is required for Legacy Slack domain store");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma("busy_timeout = 5000");
  migrate(db);
  function tableCount(table: string): number {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number } | undefined;
    return Number(row?.count || 0);
  }
  function upsertChannel({ id, name = "", type = "public_channel" }: UpsertChannelInput = {}) {
    const channelId = text(id);
    if (!channelId) return null;
    const channelName = text(name);
    db.prepare(
      `
      INSERT INTO channel (id, name, type)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN ? <> '' THEN excluded.name ELSE channel.name END,
        type = excluded.type,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(channelId, channelName || channelId, text(type, "public_channel"), channelName);
    return getChannel(channelId);
  }
  function getChannel(id: string) {
    return (
      (db
        .prepare("SELECT id, name, type, created_at, updated_at FROM channel WHERE id = ?")
        .get(id) as Row | undefined) || null
    );
  }
  function syncChannelMembers(channelId: string, memberIds: string[] = []) {
    const channel = text(channelId);
    if (!channel) return { channelId: "", memberCount: 0 };
    const tx = db.transaction((ids) => {
      db.prepare("DELETE FROM channel_membership WHERE channel_id = ?").run(channel);
      const insert = db.prepare(
        "INSERT INTO channel_membership (channel_id, user_id) VALUES (?, ?)",
      );
      for (const id of ids.map((value) => text(value)).filter(Boolean)) insert.run(channel, id);
    });
    tx(memberIds);
    return { channelId: channel, memberCount: memberIds.length };
  }
  function listChannelMemberIds(channelId: string) {
    return db
      .prepare(
        `
      SELECT user_id FROM channel_membership WHERE channel_id = ? ORDER BY user_id
    `,
      )
      .all(channelId)
      .map((row) => row.user_id);
  }
  function setEventCursor(key: string, value: string) {
    db.prepare(
      `
      INSERT INTO event_cursor (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `,
    ).run(text(key), text(value));
    return getEventCursor(key);
  }
  function getEventCursor(key: string) {
    return (
      db.prepare("SELECT key, value, updated_at FROM event_cursor WHERE key = ?").get(text(key)) ||
      null
    );
  }
  function upsertThreadCase(input: SlackDomainStoreInput = {}) {
    const workspaceId = text(input.workspaceId || input.workspace_id, "workspace");
    const channelId = text(input.channelId || input.channel_id, "channel");
    const threadTs = normalizeThreadTs(input.threadTs || input.thread_ts);
    db.prepare(
      `
      INSERT INTO thread_case (workspace_id, channel_id, thread_ts, user_id, session_id, status, case_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, channel_id, thread_ts) DO UPDATE SET
        user_id = CASE WHEN excluded.user_id <> '' THEN excluded.user_id ELSE thread_case.user_id END,
        session_id = CASE WHEN excluded.session_id <> '' THEN excluded.session_id ELSE thread_case.session_id END,
        status = excluded.status,
        case_type = excluded.case_type,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(
      workspaceId,
      channelId,
      threadTs,
      text(input.userId || input.user_id),
      text(input.sessionId || input.session_id),
      text(input.status, "active"),
      text(input.caseType || input.case_type, "mention"),
    );
    return getThreadCase({ workspaceId, channelId, threadTs });
  }
  function getThreadCase(input: SlackDomainStoreInput = {}) {
    return (
      db
        .prepare(
          `
      SELECT * FROM thread_case WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?
    `,
        )
        .get(
          text(input.workspaceId || input.workspace_id, "workspace"),
          text(input.channelId || input.channel_id, "channel"),
          normalizeThreadTs(input.threadTs || input.thread_ts),
        ) || null
    );
  }
  function touchChannelBrain({ workspaceId = "workspace", channelId = "channel", sessionId = "", threadTs = "" }: { workspaceId?: string; channelId?: string; sessionId?: string; threadTs?: string } = {}) {
    db.prepare(
      `
      INSERT INTO channel_brain (workspace_id, channel_id, last_session_id, last_thread_ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, channel_id) DO UPDATE SET
        last_session_id = CASE WHEN excluded.last_session_id <> '' THEN excluded.last_session_id ELSE channel_brain.last_session_id END,
        last_thread_ts = CASE WHEN excluded.last_thread_ts <> '' THEN excluded.last_thread_ts ELSE channel_brain.last_thread_ts END,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(
      text(workspaceId, "workspace"),
      text(channelId, "channel"),
      text(sessionId),
      text(threadTs),
    );
    return getChannelBrain({ workspaceId, channelId });
  }
  function getChannelBrain(input: SlackDomainStoreInput = {}) {
    return (
      db
        .prepare(
          `
      SELECT * FROM channel_brain WHERE workspace_id = ? AND channel_id = ?
    `,
        )
        .get(
          text(input.workspaceId || input.workspace_id, "workspace"),
          text(input.channelId || input.channel_id, "channel"),
        ) || null
    );
  }

  function upsertChannelBrainSummary({
    workspaceId = "workspace",
    channelId = "channel",
    summary = "",
  } = {}) {
    const existing = getChannelBrain({ workspaceId, channelId });
    const nextVersion =
      existing?.summary === summary
        ? numberOrZero(existing.summary_version)
        : Math.max(1, numberOrZero(existing?.summary_version) + 1);
    db.prepare(
      `
      INSERT INTO channel_brain (workspace_id, channel_id, summary, summary_version)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, channel_id) DO UPDATE SET
        summary = excluded.summary,
        summary_version = excluded.summary_version,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(text(workspaceId, "workspace"), text(channelId, "channel"), text(summary), nextVersion);
    return getChannelBrain({ workspaceId, channelId });
  }

  function upsertThreadLedger(input: SlackDomainStoreInput = {}) {
    const workspaceId = text(input.workspaceId || input.workspace_id, "workspace");
    const channelId = text(input.channelId || input.channel_id, "channel");
    const threadTs = normalizeThreadTs(input.threadTs || input.thread_ts);
    db.prepare(
      `
      INSERT INTO thread_ledger (workspace_id, channel_id, thread_ts, assistant_session_id, status, owner_user_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, channel_id, thread_ts) DO UPDATE SET
        assistant_session_id = CASE WHEN excluded.assistant_session_id <> '' THEN excluded.assistant_session_id ELSE thread_ledger.assistant_session_id END,
        status = CASE WHEN excluded.status <> '' THEN excluded.status ELSE thread_ledger.status END,
        owner_user_id = CASE WHEN excluded.owner_user_id <> '' THEN excluded.owner_user_id ELSE thread_ledger.owner_user_id END,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(
      workspaceId,
      channelId,
      threadTs,
      text(input.sessionId || input.assistantSessionId || input.assistant_session_id),
      text(input.status, "active"),
      text(input.ownerUserId || input.owner_user_id),
    );
    return getThreadLedger({ workspaceId, channelId, threadTs });
  }

  function recordThreadLedgerInbound(input: SlackDomainStoreInput = {}) {
    const workspaceId = text(input.workspaceId || input.workspace_id, "workspace");
    const channelId = text(input.channelId || input.channel_id, "channel");
    const threadTs = normalizeThreadTs(input.threadTs || input.thread_ts);
    const userId = text(input.userId || input.user_id);
    db.prepare(
      `
      INSERT INTO thread_ledger (workspace_id, channel_id, thread_ts, status, owner_user_id, last_user_id, last_user_message_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(workspace_id, channel_id, thread_ts) DO UPDATE SET
        owner_user_id = CASE WHEN thread_ledger.owner_user_id = '' AND excluded.owner_user_id <> '' THEN excluded.owner_user_id ELSE thread_ledger.owner_user_id END,
        last_user_id = excluded.last_user_id,
        last_user_message_at = excluded.last_user_message_at,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(workspaceId, channelId, threadTs, userId, userId, text(input.at, nowIso()));
    return getThreadLedger({ workspaceId, channelId, threadTs });
  }

  function recordThreadLedgerOutbound(input: SlackDomainStoreInput = {}) {
    const workspaceId = text(input.workspaceId || input.workspace_id, "workspace");
    const channelId = text(input.channelId || input.channel_id, "channel");
    const threadTs = normalizeThreadTs(input.threadTs || input.thread_ts);
    db.prepare(
      `
      INSERT INTO thread_ledger (workspace_id, channel_id, thread_ts, status, last_assistant_message_at, summary)
      VALUES (?, ?, ?, 'active', ?, ?)
      ON CONFLICT(workspace_id, channel_id, thread_ts) DO UPDATE SET
        last_assistant_message_at = excluded.last_assistant_message_at,
        summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE thread_ledger.summary END,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(
      workspaceId,
      channelId,
      threadTs,
      text(input.at, nowIso()),
      text(input.summary).slice(0, 1200),
    );
    return getThreadLedger({ workspaceId, channelId, threadTs });
  }

  function recordThreadLedgerAction(input: SlackDomainStoreInput = {}) {
    const workspaceId = text(input.workspaceId || input.workspace_id, "workspace");
    const channelId = text(input.channelId || input.channel_id, "channel");
    const threadTs = normalizeThreadTs(input.threadTs || input.thread_ts);
    const actionStatus = text(input.actionStatus || input.action_status, "seen");
    const status = actionStatus === "pending" ? "awaiting_confirmation" : "active";
    db.prepare(
      `
      INSERT INTO thread_ledger (workspace_id, channel_id, thread_ts, status, last_action_type, last_action_status)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, channel_id, thread_ts) DO UPDATE SET
        status = excluded.status,
        last_action_type = excluded.last_action_type,
        last_action_status = excluded.last_action_status,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(
      workspaceId,
      channelId,
      threadTs,
      status,
      text(input.actionType || input.action_type),
      actionStatus,
    );
    return getThreadLedger({ workspaceId, channelId, threadTs });
  }

  function getThreadLedger(input: SlackDomainStoreInput = {}) {
    return (
      db
        .prepare(
          `
      SELECT * FROM thread_ledger WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?
    `,
        )
        .get(
          text(input.workspaceId || input.workspace_id, "workspace"),
          text(input.channelId || input.channel_id, "channel"),
          normalizeThreadTs(input.threadTs || input.thread_ts),
        ) || null
    );
  }

  function listRecentThreadLedgers({
    workspaceId = "workspace",
    channelId = "channel",
    limit = 5,
  }: { workspaceId?: string; channelId?: string; limit?: number } = {}) {
    return db
      .prepare(
        `
      SELECT * FROM thread_ledger
      WHERE workspace_id = ? AND channel_id = ?
      ORDER BY updated_at DESC, thread_ts DESC
      LIMIT ?
    `,
      )
      .all(
        text(workspaceId, "workspace"),
        text(channelId, "channel"),
        Math.max(1, Number(limit) || 5),
      );
  }

  function reserveOutboundAction(input: SlackDomainStoreInput = {}) {
    const result = db
      .prepare(
        `
      INSERT OR IGNORE INTO outbound_action (action_type, target, reference, session_id, summary, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `,
      )
      .run(
        text(input.actionType || input.action_type),
        text(input.target),
        text(input.reference),
        text(input.sessionId || input.session_id),
        text(input.summary),
      );
    return { id: result.changes ? result.lastInsertRowid : 0, reserved: result.changes > 0 };
  }

  function getOutboundAction(id: string | number) {
    return rowJson(db.prepare("SELECT * FROM outbound_action WHERE id = ?").get(id));
  }

  function listOutboundActions({ status = "", limit = 20 }: { status?: string; limit?: number } = {}) {
    return db
      .prepare(
        `
      SELECT * FROM outbound_action
      WHERE (? = '' OR status = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
      )
      .all(text(status), text(status), Math.max(1, Number.parseInt(String(limit), 10) || 20))
      .map(rowJson);
  }

  function setOutboundActionStatus(id: string | number, status: string) {
    db.prepare(
      "UPDATE outbound_action SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(text(status), id);
    return getOutboundAction(id);
  }

  function reserveThreadRecommendation(input: SlackDomainStoreInput = {}) {
    const result = db
      .prepare(
        `
      INSERT OR IGNORE INTO thread_recommendation (channel_id, thread_ts, recommendation_type, status)
      VALUES (?, ?, ?, 'pending')
    `,
      )
      .run(
        text(input.channelId || input.channel_id),
        normalizeThreadTs(input.threadTs || input.thread_ts),
        text(input.recommendationType || input.recommendation_type || input.type),
      );
    return { id: result.changes ? result.lastInsertRowid : 0, reserved: result.changes > 0 };
  }

  function getThreadRecommendation(id: string | number) {
    return rowJson(db.prepare("SELECT * FROM thread_recommendation WHERE id = ?").get(id));
  }

  function setThreadRecommendationStatus(id: string | number, status: string, cardTs: string = "") {
    db.prepare(
      `
      UPDATE thread_recommendation
      SET status = ?, card_ts = CASE WHEN ? <> '' THEN ? ELSE card_ts END
      WHERE id = ?
    `,
    ).run(text(status), text(cardTs), text(cardTs), id);
    return getThreadRecommendation(id);
  }

  function listThreadRecommendations({ status = "", limit = 20 }: { status?: string; limit?: number } = {}) {
    return db
      .prepare(
        `
      SELECT * FROM thread_recommendation
      WHERE (? = '' OR status = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
      )
      .all(text(status), text(status), Math.max(1, Number.parseInt(String(limit), 10) || 20))
      .map(rowJson);
  }

  function insertPendingAction(input: SlackDomainStoreInput = {}) {
    const result = db
      .prepare(
        `
      INSERT INTO pending_action (channel_id, thread_ts, action_type, params)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(
        text(input.channelId || input.channel_id, "channel"),
        normalizeThreadTs(input.threadTs || input.thread_ts),
        text(input.actionType || input.action_type),
        typeof input.params === "string" ? input.params : json(input.params || {}),
      );
    return getPendingAction(result.lastInsertRowid);
  }

  function setPendingActionCardTs(id: string | number, cardTs: string) {
    db.prepare(
      "UPDATE pending_action SET card_ts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(text(cardTs), id);
    return getPendingAction(id);
  }

  function setPendingActionStatus(id: string | number, status: string, confirmedBy: string = "", result: string = "") {
    db.prepare(
      `
      UPDATE pending_action
      SET status = ?, confirmed_by = ?, result = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(text(status), text(confirmedBy), typeof result === "string" ? result : json(result), id);
    return getPendingAction(id);
  }

  function getPendingAction(id: string | number) {
    return rowJson(db.prepare("SELECT * FROM pending_action WHERE id = ?").get(id));
  }

  function listPendingActions(limit: number = 20) {
    return db
      .prepare("SELECT * FROM pending_action ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map(rowJson);
  }

  function insertMeetingThread(input: SlackDomainStoreInput = {}) {
    const dedupeKey = text(
      input.dedupeKey ||
        input.dedupe_key ||
        `remote:${input.remoteMeetingId || input.remote_meeting_id || input.meetingId || input.meeting_id}`,
    );
    const remoteMeetingId = numberOrZero(
      input.remoteMeetingId || input.remote_meeting_id || input.meetingId || input.meeting_id,
    );
    const channelId = text(
      input.channelId || input.channel_id || input.slackChannelId || input.slack_channel_id,
    );
    const threadTs = normalizeThreadTs(
      input.threadTs || input.thread_ts || input.slackThreadTs || input.slack_thread_ts,
    );
    if (!dedupeKey || !remoteMeetingId || !channelId)
      return { inserted: false, reason: "missing_meeting_thread_fields" };
    const result = db
      .prepare(
        `
      INSERT OR IGNORE INTO meeting_thread (dedupe_key, remote_meeting_id, slack_channel_id, slack_thread_ts)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(dedupeKey, remoteMeetingId, channelId, threadTs);
    return {
      inserted: result.changes > 0,
      meetingThread: getMeetingThreadByRemoteId(remoteMeetingId),
    };
  }

  function getMeetingThreadByRemoteId(remoteMeetingId: string | number) {
    return rowJson(
      db
        .prepare(
          `
      SELECT dedupe_key, remote_meeting_id, slack_channel_id, slack_thread_ts, created_at
      FROM meeting_thread
      WHERE remote_meeting_id = ?
    `,
        )
        .get(numberOrZero(remoteMeetingId)),
    );
  }

  function reserveMeetingResultDelivery(meetingId: string | number) {
    const id = numberOrZero(meetingId);
    if (!id) return { reserved: false, reason: "missing_meeting_id" };
    const result = db
      .prepare(
        `
      INSERT OR IGNORE INTO meeting_result_delivery (meeting_id, status)
      VALUES (?, 'pending')
    `,
      )
      .run(id);
    return {
      reserved: result.changes > 0,
      delivery: getMeetingResultDelivery(id),
    };
  }

  function confirmMeetingResultDelivery(meetingId: string | number) {
    const id = numberOrZero(meetingId);
    db.prepare(
      `
      UPDATE meeting_result_delivery
      SET status = 'processed', updated_at = CURRENT_TIMESTAMP
      WHERE meeting_id = ?
    `,
    ).run(id);
    return getMeetingResultDelivery(id);
  }

  function failMeetingResultDelivery(meetingId: string | number) {
    const id = numberOrZero(meetingId);
    db.prepare(
      "DELETE FROM meeting_result_delivery WHERE meeting_id = ? AND status = 'pending'",
    ).run(id);
    return getMeetingResultDelivery(id);
  }

  function cleanupStalePendingMeetingResultDeliveries(olderThanMs: number = 600000) {
    const cutoff = new Date(Date.now() - Math.max(0, Number(olderThanMs) || 0))
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const result = db
      .prepare(
        `
      DELETE FROM meeting_result_delivery
      WHERE status = 'pending' AND created_at < ?
    `,
      )
      .run(cutoff);
    return { cleaned: result.changes };
  }

  function getMeetingResultDelivery(meetingId: string | number) {
    return rowJson(
      db
        .prepare(
          `
      SELECT meeting_id, status, created_at, updated_at
      FROM meeting_result_delivery
      WHERE meeting_id = ?
    `,
        )
        .get(numberOrZero(meetingId)),
    );
  }

  function createHeartbeatFollowup(input: SlackDomainStoreInput = {}) {
    const result = db
      .prepare(
        `
      INSERT INTO heartbeat_followup (
        kind, title, summary, source_kind, channel_id, thread_ts, source_ref,
        status, priority, due_at, next_check_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        text(input.kind, "reminder"),
        text(input.title),
        text(input.summary),
        text(input.sourceKind || input.source_kind, "dm"),
        text(input.channelId || input.channel_id),
        normalizeThreadTs(input.threadTs || input.thread_ts),
        text(input.sourceRef || input.source_ref),
        text(input.status, "open"),
        text(input.priority, "normal"),
        text(input.dueAt || input.due_at),
        text(input.nextCheckAt || input.next_check_at),
        json(input.metadata || input.metadata_json || {}),
      );
    return db.prepare("SELECT * FROM heartbeat_followup WHERE id = ?").get(result.lastInsertRowid);
  }

  function listHeartbeatFollowups({ status = "open", limit = 20 }: { status?: string; limit?: number } = {}) {
    return db
      .prepare(
        `
      SELECT * FROM heartbeat_followup
      WHERE (? = '' OR status = ?)
      ORDER BY COALESCE(next_check_at, due_at, updated_at) ASC, id ASC
      LIMIT ?
    `,
      )
      .all(text(status), text(status), Math.max(1, Number.parseInt(String(limit), 10) || 20))
      .map(rowJson);
  }

  function setHeartbeatFollowupStatus(id: string | number, status: string) {
    db.prepare(
      `
      UPDATE heartbeat_followup
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(text(status), id);
    return rowJson(db.prepare("SELECT * FROM heartbeat_followup WHERE id = ?").get(id));
  }

  function recordHeartbeatSurface(input: SlackDomainStoreInput = {}) {
    const result = db
      .prepare(
        `
      INSERT INTO heartbeat_surface (
        followup_id, session_id, title, summary, requested_surface, delivered_surface,
        channel_id, thread_ts, status, block_reason, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        numberOrZero(input.followupId || input.followup_id),
        text(input.sessionId || input.session_id),
        text(input.title),
        text(input.summary),
        text(input.requestedSurface || input.requested_surface),
        text(input.deliveredSurface || input.delivered_surface),
        text(input.channelId || input.channel_id),
        normalizeThreadTs(input.threadTs || input.thread_ts),
        text(input.status, "sent"),
        text(input.blockReason || input.block_reason),
        text(input.error),
      );
    return db.prepare("SELECT * FROM heartbeat_surface WHERE id = ?").get(result.lastInsertRowid);
  }

  function listHeartbeatSurfaces({ followupId = 0, status = "", limit = 20 }: { followupId?: number; status?: string; limit?: number } = {}) {
    const followup = numberOrZero(followupId);
    return db
      .prepare(
        `
      SELECT * FROM heartbeat_surface
      WHERE (? = 0 OR followup_id = ?) AND (? = '' OR status = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
      )
      .all(
        followup,
        followup,
        text(status),
        text(status),
        Math.max(1, Number.parseInt(String(limit), 10) || 20),
      )
      .map(rowJson);
  }

  interface TriageActionInput {
    tool?: string;
    channel?: string;
    brief?: string;
  }
  interface TriageToolCallInput {
    tool?: string;
    action?: string;
    args?: unknown;
    success?: boolean | number;
    brief?: string;
    result?: unknown;
  }
  interface TriageRunRow {
    status?: string;
    summary?: string;
    error?: string;
    digest?: string;
    steps?: number;
    duration_seconds?: number;
    mutations?: number;
    failures?: number;
    tokens_used?: number;
    channels_json?: string;
    raw_output?: string;
    [key: string]: unknown;
  }

  function recordTriageRun(input: SlackDomainStoreInput = {}) {
    const run = ((input.run as SlackDomainStoreInput | undefined) || input) as SlackDomainStoreInput & {
      occurredAt?: string;
      occurred_at?: string;
      steps?: number;
      durationSeconds?: number;
      duration_seconds?: number;
      mutations?: number;
      failures?: number;
      tokensUsed?: number;
      tokens_used?: number;
      channels?: unknown;
      channels_json?: string;
      rawOutput?: string;
      raw_output?: string;
      digest?: string;
    };
    const tx = db.transaction(() => {
      const result = db
        .prepare(
          `
        INSERT INTO triage_run (
          session_id, occurred_at, status, summary, error, digest, steps,
          duration_seconds, mutations, failures, tokens_used, channels_json, raw_output
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          text(run.sessionId || run.session_id),
          text(run.occurredAt || run.occurred_at, nowIso()),
          text(run.status, "failed"),
          text(run.summary),
          text(run.error),
          text(run.digest),
          numberOrZero(run.steps),
          numberOrZero(run.durationSeconds || run.duration_seconds),
          numberOrZero(run.mutations),
          numberOrZero(run.failures),
          numberOrZero(run.tokensUsed || run.tokens_used),
          json(run.channels || run.channels_json || []),
          text(run.rawOutput || run.raw_output),
        );
      const runId = result.lastInsertRowid;
      const actionStmt = db.prepare(`
        INSERT INTO triage_action (run_id, position, tool, channel, brief)
        VALUES (?, ?, ?, ?, ?)
      `);
      const actions = (input.actions as TriageActionInput[] | undefined) || [];
      for (const [index, action] of actions.entries()) {
        actionStmt.run(runId, index, text(action.tool), text(action.channel), text(action.brief));
      }
      const toolStmt = db.prepare(`
        INSERT INTO triage_tool_call (run_id, position, tool, action, args, success, brief, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const toolCalls =
        ((input.toolCalls || input.tool_calls) as TriageToolCallInput[] | undefined) || [];
      for (const [index, call] of toolCalls.entries()) {
        toolStmt.run(
          runId,
          index,
          text(call.tool),
          text(call.action),
          typeof call.args === "string" ? call.args : json(call.args || {}),
          call.success ? 1 : 0,
          text(call.brief),
          typeof call.result === "string" ? call.result : json(call.result || {}),
        );
      }
      return runId;
    });
    return db.prepare("SELECT * FROM triage_run WHERE id = ?").get(tx());
  }

  function updateTriageRun(input: SlackDomainStoreInput = {}) {
    const run = ((input.run as SlackDomainStoreInput | undefined) || input) as SlackDomainStoreInput & {
      id?: number | string;
      steps?: number;
      durationSeconds?: number;
      duration_seconds?: number;
      mutations?: number;
      failures?: number;
      tokensUsed?: number;
      tokens_used?: number;
      channels?: unknown;
      channels_json?: string;
      rawOutput?: string;
      raw_output?: string;
      digest?: string;
    };
    const id = numberOrZero(run.id || input.id);
    if (!id) return null;
    const existing = getTriageRun(id) as TriageRunRow | null;
    if (!existing) return null;
    const tx = db.transaction(() => {
      db.prepare(
        `
        UPDATE triage_run
        SET
          status = ?,
          summary = ?,
          error = ?,
          digest = ?,
          steps = ?,
          duration_seconds = ?,
          mutations = ?,
          failures = ?,
          tokens_used = ?,
          channels_json = ?,
          raw_output = ?
        WHERE id = ?
      `,
      ).run(
        text(run.status, existing.status),
        text(run.summary, existing.summary),
        text(run.error, existing.error),
        text(run.digest, existing.digest),
        numberOrZero(run.steps ?? existing.steps),
        numberOrZero(run.durationSeconds || run.duration_seconds || existing.duration_seconds),
        numberOrZero(run.mutations ?? existing.mutations),
        numberOrZero(run.failures ?? existing.failures),
        numberOrZero(run.tokensUsed || run.tokens_used || existing.tokens_used),
        json(run.channels || run.channels_json || safeJson(existing.channels_json, [])),
        text(run.rawOutput || run.raw_output, existing.raw_output),
        id,
      );
      db.prepare("DELETE FROM triage_action WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM triage_tool_call WHERE run_id = ?").run(id);
      const actionStmt = db.prepare(`
        INSERT INTO triage_action (run_id, position, tool, channel, brief)
        VALUES (?, ?, ?, ?, ?)
      `);
      const actions = (input.actions as TriageActionInput[] | undefined) || [];
      for (const [index, action] of actions.entries()) {
        actionStmt.run(id, index, text(action.tool), text(action.channel), text(action.brief));
      }
      const toolStmt = db.prepare(`
        INSERT INTO triage_tool_call (run_id, position, tool, action, args, success, brief, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const toolCalls =
        ((input.toolCalls || input.tool_calls) as TriageToolCallInput[] | undefined) || [];
      for (const [index, call] of toolCalls.entries()) {
        toolStmt.run(
          id,
          index,
          text(call.tool),
          text(call.action),
          typeof call.args === "string" ? call.args : json(call.args || {}),
          call.success ? 1 : 0,
          text(call.brief),
          typeof call.result === "string" ? call.result : json(call.result || {}),
        );
      }
    });
    tx();
    return getTriageRun(id);
  }

  function getTriageRun(id: string | number) {
    return rowJson(db.prepare("SELECT * FROM triage_run WHERE id = ?").get(numberOrZero(id)));
  }

  function listTriageRuns(limit: number = 20) {
    return db
      .prepare("SELECT * FROM triage_run ORDER BY occurred_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map(rowJson);
  }

  function listTriageContexts(limit: number = 20) {
    return listTriageRuns(limit).map((run) => {
      const runId = numberOrZero(run.id);
      const actions = db
        .prepare(
          `
        SELECT tool, channel, brief
        FROM triage_action
        WHERE run_id = ?
        ORDER BY position ASC, id ASC
      `,
        )
        .all(runId);
      const toolCalls = db
        .prepare(
          `
        SELECT tool, action, args, success, brief
        FROM triage_tool_call
        WHERE run_id = ?
        ORDER BY position ASC, id ASC
      `,
        )
        .all(runId)
        .map((call) => Object.assign({}, call, { success: Boolean(call.success) }));
      return normalizeTriageContext({
        ...run,
        actions,
        tool_calls: toolCalls,
      });
    });
  }

  function recordFeedbackEntry(input: SlackDomainStoreInput = {}) {
    const at = input.at ? new Date(input.at) : new Date();
    const iso = Number.isNaN(at.getTime()) ? nowIso() : at.toISOString();
    const result = db
      .prepare(
        `
      INSERT INTO feedback_entry (entry_date, entry_time, action, channel, action_type, summary, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        text(input.entryDate || input.entry_date, iso.slice(0, 10)),
        text(input.entryTime || input.entry_time, iso.slice(11, 16)),
        text(input.action),
        text(input.channel || input.channelId || input.channel_id),
        text(input.actionType || input.action_type),
        text(input.summary),
        text(input.userId || input.user_id),
      );
    return rowJson(
      db.prepare("SELECT * FROM feedback_entry WHERE id = ?").get(result.lastInsertRowid),
    );
  }

  function listFeedbackEntries({ dates = [], limit = 20 }: { dates?: string[]; limit?: number } = {}) {
    const dateList = Array.isArray(dates) ? dates : [dates];
    const normalizedDates = dateList.map((date) => text(date)).filter(Boolean);
    const rowLimit = Math.max(1, Number.parseInt(String(limit), 10) || 20);
    if (normalizedDates.length) {
      const placeholders = normalizedDates.map(() => "?").join(",");
      return db
        .prepare(
          `
        SELECT * FROM feedback_entry
        WHERE entry_date IN (${placeholders})
        ORDER BY entry_date ASC, entry_time ASC, id ASC
        LIMIT ?
      `,
        )
        .all(...normalizedDates, rowLimit)
        .map(rowJson);
    }
    return db
      .prepare(
        `
      SELECT * FROM feedback_entry
      ORDER BY entry_date DESC, entry_time DESC, id DESC
      LIMIT ?
    `,
      )
      .all(rowLimit)
      .map(rowJson);
  }

  function recordImprovementSignal(input: SlackDomainStoreInput = {}) {
    const topic = text(input.topic);
    const desiredBehavior = text(input.desiredBehavior || input.desired_behavior);
    const summary = text(input.summary, desiredBehavior);
    if (!topic) throw new Error("improvement signal topic is required");
    if (!summary) throw new Error("improvement signal summary is required");
    const metadata = input.metadata_json ?? input.metadata ?? {};
    const result = db
      .prepare(
        `
      INSERT INTO improvement_signal (
        topic, signal_type, summary, desired_behavior, severity, confidence,
        channel_id, thread_ts, msg_ts, session_id, cluster_key, status, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        topic,
        normalizedChoice(
          input.signalType || input.signal_type,
          ["proposal", "preference", "success", "confirm", "dismiss"],
          "complaint",
        ),
        summary,
        desiredBehavior,
        normalizedChoice(input.severity, ["low", "high", "critical"], "medium"),
        clamp01(input.confidence),
        text(input.channelId || input.channel_id),
        normalizeThreadTs(input.threadTs || input.thread_ts),
        text(input.msgTs || input.msg_ts),
        text(input.sessionId || input.session_id),
        text(input.clusterKey || input.cluster_key, topic),
        normalizedChoice(input.status, ["absorbed", "resolved"], "open"),
        typeof metadata === "string" ? metadata : json(metadata),
      );
    return getImprovementSignal(result.lastInsertRowid);
  }

  function getImprovementSignal(id) {
    return rowJson(
      db.prepare("SELECT * FROM improvement_signal WHERE id = ?").get(numberOrZero(id)),
    );
  }

  function listImprovementSignals({ status = "", topic = "", clusterKey = "", limit = 20 } = {}) {
    return db
      .prepare(
        `
      SELECT * FROM improvement_signal
      WHERE (? = '' OR status = ?)
        AND (? = '' OR topic = ?)
        AND (? = '' OR cluster_key = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
      )
      .all(
        text(status),
        text(status),
        text(topic),
        text(topic),
        text(clusterKey),
        text(clusterKey),
        Math.max(1, Number.parseInt(String(limit), 10) || 20),
      )
      .map(rowJson);
  }

  interface RecordSlackCommandArgs {
    body?: SlackEventBody & { command?: string };
    parsed?: { sessionId?: string; action?: string; [key: string]: unknown };
    session?: { id?: string } | null;
    responseSummary?: string;
  }

  function recordSlackCommand({
    body = {},
    parsed = {},
    session = null,
    responseSummary = "",
  }: RecordSlackCommandArgs = {}) {
    const identity = slackIdentity(body);
    upsertChannel({
      id: identity.channelId,
      name: identity.channelName || identity.channelId,
      type: identity.channelType,
    });
    upsertThreadCase({
      workspaceId: identity.workspaceId,
      channelId: identity.channelId,
      threadTs: identity.threadTs,
      userId: identity.userId,
      sessionId: session?.id || parsed.sessionId || "",
      status: parsed.action === "stop" ? "resolved" : "active",
      caseType: body.command === "app_mention" ? "mention" : "command",
    });
    touchChannelBrain({
      workspaceId: identity.workspaceId,
      channelId: identity.channelId,
      sessionId: session?.id || parsed.sessionId || "",
      threadTs: identity.threadTs,
    });
    recordThreadLedgerInbound({
      workspaceId: identity.workspaceId,
      channelId: identity.channelId,
      threadTs: identity.threadTs,
      userId: identity.userId,
    });
    if (parsed.action) {
      recordThreadLedgerAction({
        workspaceId: identity.workspaceId,
        channelId: identity.channelId,
        threadTs: identity.threadTs,
        actionType: parsed.action,
        actionStatus: parsed.action === "delegate" ? "pending" : "seen",
      });
    }
    if (responseSummary) {
      recordThreadLedgerOutbound({
        workspaceId: identity.workspaceId,
        channelId: identity.channelId,
        threadTs: identity.threadTs,
        summary: responseSummary,
      });
    }
    return {
      identity,
      threadCase: getThreadCase({ ...identity }),
      channelBrain: getChannelBrain({ ...identity }),
      threadLedger: getThreadLedger({ ...identity }),
    };
  }

  function recordSlackMessageEvent(
    event: {
      channel?: string;
      channel_type?: string;
      user?: string;
      thread_ts?: string;
      ts?: string;
      event_ts?: string;
      [key: string]: unknown;
    } = {},
    payload: { team_id?: string; team?: { id?: string }; [key: string]: unknown } = {},
  ) {
    const body: SlackEventBody = {
      team_id: payload.team_id || payload.team?.id || "",
      channel_id: event.channel || "",
      channel_type: event.channel_type || "",
      user_id: event.user || "",
      thread_ts: event.thread_ts || event.ts || "",
      event_ts: event.ts || event.event_ts || "",
    };
    const identity = slackIdentity(body);
    upsertChannel({ id: identity.channelId, type: identity.channelType });
    return recordThreadLedgerInbound({
      workspaceId: identity.workspaceId,
      channelId: identity.channelId,
      threadTs: identity.threadTs,
      userId: identity.userId,
      at: event.ts || nowIso(),
    });
  }

  function context({
    workspaceId = "workspace",
    channelId = "channel",
    threadTs = "channel-root",
    limit = 5,
  }: { workspaceId?: string; channelId?: string; threadTs?: string; limit?: number } = {}) {
    return {
      channel: getChannel(channelId),
      channelMembers: listChannelMemberIds(channelId),
      channelBrain: getChannelBrain({ workspaceId, channelId }),
      threadLedger: getThreadLedger({ workspaceId, channelId, threadTs }),
      recentThreads: listRecentThreadLedgers({ workspaceId, channelId, limit }),
      pendingActions: listPendingActions(limit),
      heartbeatFollowups: listHeartbeatFollowups({ limit }),
      feedbackEntries: listFeedbackEntries({ limit }),
      improvementSignals: listImprovementSignals({ status: "open", limit }),
    };
  }

  function stats() {
    return {
      provider: "sqlite",
      path: dbPath,
      schemaVersion: LEGACY_SLACK_DOMAIN_SCHEMA_VERSION,
      tables: Object.fromEntries(
        LEGACY_SLACK_DOMAIN_TABLES.map((table) => [table, tableCount(table)]),
      ),
    };
  }

  return {
    provider: "sqlite",
    path: dbPath,
    schemaVersion: LEGACY_SLACK_DOMAIN_SCHEMA_VERSION,
    schemaTables: LEGACY_SLACK_DOMAIN_TABLES,
    upsertChannel,
    getChannel,
    syncChannelMembers,
    listChannelMemberIds,
    setEventCursor,
    getEventCursor,
    upsertThreadCase,
    getThreadCase,
    touchChannelBrain,
    getChannelBrain,
    upsertChannelBrainSummary,
    upsertThreadLedger,
    recordThreadLedgerInbound,
    recordThreadLedgerOutbound,
    recordThreadLedgerAction,
    getThreadLedger,
    listRecentThreadLedgers,
    reserveOutboundAction,
    getOutboundAction,
    listOutboundActions,
    setOutboundActionStatus,
    reserveThreadRecommendation,
    getThreadRecommendation,
    setThreadRecommendationStatus,
    listThreadRecommendations,
    insertPendingAction,
    setPendingActionCardTs,
    setPendingActionStatus,
    getPendingAction,
    listPendingActions,
    insertMeetingThread,
    getMeetingThreadByRemoteId,
    reserveMeetingResultDelivery,
    confirmMeetingResultDelivery,
    failMeetingResultDelivery,
    cleanupStalePendingMeetingResultDeliveries,
    getMeetingResultDelivery,
    createHeartbeatFollowup,
    listHeartbeatFollowups,
    setHeartbeatFollowupStatus,
    recordHeartbeatSurface,
    listHeartbeatSurfaces,
    recordTriageRun,
    updateTriageRun,
    getTriageRun,
    listTriageRuns,
    listTriageContexts,
    recordFeedbackEntry,
    listFeedbackEntries,
    recordImprovementSignal,
    getImprovementSignal,
    listImprovementSignals,
    recordSlackCommand,
    recordSlackMessageEvent,
    context,
    stats,
    close() {
      db.close();
    },
  };
}
