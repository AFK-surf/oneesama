export const MEETD_ACTIVE_STATUSES = ["pending", "joining", "active", "processing"];

interface MeetdCaption {
  speaker: string;
  text: string;
  timestamp: string;
  source: string;
}

interface SlackThreadRef {
  channelId?: string;
  threadTs?: string;
}

interface MeetdSession {
  id: string;
  source?: string;
  meetdCompatId?: number | string;
  eventId?: string;
  calendarEventId?: string;
  meetUrl?: string;
  title?: string;
  startAt?: string;
  startTime?: string;
  endAt?: string;
  endTime?: string;
  status?: string;
  error?: string;
  errorMessage?: string;
  artifactsDir?: string;
  slackChannelId?: string;
  slack_channel_id?: string;
  slackThreadTs?: string;
  slack_thread_ts?: string;
  updatedAt?: string;
  createdAt?: string;
  claimedAt?: string;
  recoveryRequested?: boolean;
  recoveredAt?: string;
  avatar?: string;
  requestedBy?: string;
  meetdCaptions?: MeetdCaption[];
  meetdResult?: unknown;
  postMeetingResult?: unknown;
  transcriptText?: string;
  transcriptPath?: string;
  audioPath?: string;
  slack?: SlackThreadRef;
  result?: unknown;
}

interface MeetdSessionsStore {
  list(): MeetdSession[];
  create(input: Partial<MeetdSession>): MeetdSession;
  update(id: string, input: Partial<MeetdSession>): MeetdSession;
}

interface MeetdScheduleBody extends Partial<MeetdSession> {
  speaker?: string;
  user?: string;
  name?: string;
  text?: string;
  caption?: string;
  timestamp?: string;
  ts?: string;
  event_id?: string;
  meet_url?: string;
  start_at?: string;
  end_at?: string;
  start_time?: string;
  end_time?: string;
  requested_by?: string;
  summary?: string;
  artifacts_dir?: string;
  transcript_text?: string;
  transcript_path?: string;
  audio_path?: string;
  captions?: MeetdScheduleBody[];
  caption_segments?: MeetdScheduleBody[];
  segments?: MeetdScheduleBody[];
}

function nowIso(now: Date | string = new Date()): string {
  return new Date(now).toISOString();
}

function toDate(value: unknown): Date | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : new Date("");
  return Number.isNaN(date.getTime()) ? null : date;
}

function toMs(value: unknown): number {
  const date = toDate(value);
  return date ? date.getTime() : 0;
}

function safeString(value: unknown): string {
  return String(value || "").trim();
}

function isActiveStatus(status: unknown): boolean {
  return MEETD_ACTIVE_STATUSES.includes(safeString(status || "pending"));
}

function nextMeetdCompatId(sessions: MeetdSessionsStore): number {
  return (
    sessions
      .list()
      .filter((session) => session.source === "meetd-compat" || session.meetdCompatId)
      .reduce((max, session) => Math.max(max, Number(session.meetdCompatId || 0)), 0) + 1
  );
}

export function normalizeMeetdCaption(input: MeetdScheduleBody = {}): MeetdCaption {
  return {
    speaker: input.speaker || input.user || input.name || "",
    text: input.text || input.caption || "",
    timestamp: input.timestamp || input.ts || new Date().toISOString(),
    source: input.source || "live_caption",
  };
}

export function meetdMeetingResponse(session: Partial<MeetdSession> = {}) {
  const result = session.meetdResult || session.postMeetingResult || null;
  const body: Record<string, unknown> = {
    id: Number(session.meetdCompatId || 0),
    event_id: session.eventId || session.calendarEventId || "",
    meet_url: session.meetUrl || "",
    title: session.title || "Untitled meeting",
    start_time: session.startAt || session.startTime || "",
    end_time: session.endAt || session.endTime || "",
    status: session.status || "pending",
    error: session.error || session.errorMessage || "",
    session_id: session.id,
    artifacts_dir: session.artifactsDir || "",
    slack_channel_id: session.slackChannelId || session.slack_channel_id || "",
    slack_thread_ts: session.slackThreadTs || session.slack_thread_ts || "",
    updated_at: session.updatedAt || "",
    created_at: session.createdAt || "",
    claimed_at: session.claimedAt || "",
    recovery_requested: Boolean(session.recoveryRequested),
    recovered_at: session.recoveredAt || "",
  };
  if (result) body.result = result;
  return body;
}

export function createMeetdRuntimeStore({ sessions }: { sessions: MeetdSessionsStore }) {
  if (!sessions) throw new Error("sessions store is required");

  function list() {
    return sessions
      .list()
      .filter((session) => session.source === "meetd-compat" || session.meetdCompatId);
  }

  function findMeeting(id) {
    const raw = safeString(id);
    if (!raw) return null;
    return (
      list().find((session) => String(session.meetdCompatId || "") === raw || session.id === raw) ||
      null
    );
  }

  function listByStatus(status = "") {
    const wanted = safeString(status);
    return list().filter((session) => !wanted || session.status === wanted);
  }

  function getByEventId(eventId = "") {
    const wanted = safeString(eventId);
    if (!wanted) return null;
    return (
      list().find((session) => (session.eventId || session.calendarEventId) === wanted) || null
    );
  }

  function getActiveMeetingByUrl(meetUrl = "", startAt = "") {
    const wantedUrl = safeString(meetUrl);
    const wantedStart = toMs(startAt);
    if (!wantedUrl || !wantedStart) return null;
    return (
      list()
        .filter(
          (session) => safeString(session.meetUrl) === wantedUrl && isActiveStatus(session.status),
        )
        .find(
          (session) =>
            Math.abs(toMs(session.startAt || session.startTime) - wantedStart) < 30 * 60 * 1000,
        ) || null
    );
  }

  function scheduleMeeting(body: MeetdScheduleBody = {}) {
    const eventId = safeString(body.event_id || body.eventId || body.calendarEventId);
    const meetUrl = safeString(body.meet_url || body.meetUrl);
    const startAt = body.start_at || body.startAt || body.start_time || body.startTime || "";
    const endAt = body.end_at || body.endAt || body.end_time || body.endTime || "";
    if (!eventId && !meetUrl)
      return { ok: false, status: 400, error: "meet_url or event_id is required" };
    if (!toDate(startAt) || !toDate(endAt))
      return { ok: false, status: 400, error: "start_at and end_at are required" };

    const existingByEvent = getByEventId(eventId);
    if (existingByEvent)
      return {
        ok: true,
        meeting_id: Number(existingByEvent.meetdCompatId),
        session: existingByEvent,
        idempotent: "event_id",
      };

    const existingByUrl = getActiveMeetingByUrl(meetUrl, startAt);
    if (existingByUrl)
      return {
        ok: true,
        meeting_id: Number(existingByUrl.meetdCompatId),
        session: existingByUrl,
        idempotent: "meet_url_start_window",
      };

    const session = sessions.create({
      source: "meetd-compat",
      meetUrl,
      avatar: body.avatar || "hiyori",
      requestedBy: body.requested_by || body.requestedBy || eventId || "meetd-compat",
    });
    const captions = (body.captions || body.caption_segments || body.segments || []).map(
      normalizeMeetdCaption,
    );
    const next = sessions.update(session.id, {
      meetdCompatId: nextMeetdCompatId(sessions),
      eventId,
      calendarEventId: eventId,
      title: body.title || body.summary || "Untitled meeting",
      startAt: nowIso(startAt),
      endAt: nowIso(endAt),
      startTime: nowIso(startAt),
      endTime: nowIso(endAt),
      status: body.status || "pending",
      error: body.error || "",
      artifactsDir: body.artifacts_dir || body.artifactsDir || "",
      slackChannelId: body.slack_channel_id || body.slackChannelId || body.slack?.channelId || "",
      slackThreadTs: body.slack_thread_ts || body.slackThreadTs || body.slack?.threadTs || "",
      transcriptText: body.transcript_text || body.transcriptText || "",
      transcriptPath: body.transcript_path || body.transcriptPath || "",
      audioPath: body.audio_path || body.audioPath || "",
      meetdCaptions: captions,
      meetdResult: body.result || null,
    });
    return { ok: true, meeting_id: Number(next.meetdCompatId), session: next, created: true };
  }

  function updateStatus(id: string | number, status: string, error = "") {
    const session = findMeeting(id);
    if (!session) return null;
    return sessions.update(session.id, { status, error, errorMessage: error });
  }

  function claimMeetingForJoin(id: string | number) {
    const session = findMeeting(id);
    if (!session) return { ok: false, error: "meeting_not_found" };
    if ((session.status || "pending") !== "pending")
      return { ok: false, error: `meeting ${session.meetdCompatId} not in pending state`, session };
    return {
      ok: true,
      session: sessions.update(session.id, {
        status: "joining",
        claimedAt: new Date().toISOString(),
      }),
    };
  }

  function cleanupStaleMeetings({
    olderThanMs = 30 * 60 * 1000,
    now = new Date(),
  }: { olderThanMs?: number; now?: Date } = {}) {
    const rawThreshold = Number(olderThanMs);
    const thresholdMs = Number.isFinite(rawThreshold) ? rawThreshold : 30 * 60 * 1000;
    const cleanAll = thresholdMs < 0;
    const cutoff = new Date(now).getTime() - Math.max(0, thresholdMs);
    const cleaned = [];
    for (const session of list()) {
      if (!["joining", "active"].includes(session.status)) continue;
      const updatedAt = toMs(session.updatedAt || session.createdAt);
      if (cleanAll || (updatedAt && updatedAt < cutoff)) {
        cleaned.push(
          sessions.update(session.id, {
            status: "failed",
            error: "daemon restart",
            errorMessage: "daemon restart",
          }),
        );
      }
    }
    return cleaned;
  }

  function recoverProcessingMeetings({ now = new Date() }: { now?: Date } = {}) {
    return listByStatus("processing").map((session) =>
      sessions.update(session.id, { recoveredAt: nowIso(now), recoveryRequested: true }),
    );
  }

  return {
    list,
    findMeeting,
    listByStatus,
    getByEventId,
    getActiveMeetingByUrl,
    scheduleMeeting,
    updateStatus,
    claimMeetingForJoin,
    cleanupStaleMeetings,
    recoverProcessingMeetings,
  };
}

export function createMeetdRuntime({
  store,
  now = () => new Date(),
}: {
  store: ReturnType<typeof createMeetdRuntimeStore>;
  now?: () => Date;
}) {
  if (!store) throw new Error("store is required");

  function processReadyMeetings(
    options: { now?: Date; dryRunJoiner?: boolean } = {},
  ) {
    const current = toDate(options.now || now()) || new Date();
    const dryRunJoiner = options.dryRunJoiner !== false;
    const results = [];
    for (const session of store.listByStatus("pending")) {
      const start = toDate(session.startAt || session.startTime);
      if (!start) continue;
      if (current.getTime() < start.getTime() - 60 * 1000) {
        results.push({
          meeting_id: Number(session.meetdCompatId),
          action: "not_ready",
          status: session.status,
        });
        continue;
      }
      if (current.getTime() > start.getTime() + 5 * 60 * 1000) {
        const cancelled = store.updateStatus(
          session.meetdCompatId,
          "cancelled",
          "missed start window",
        );
        results.push({
          meeting_id: Number(session.meetdCompatId),
          action: "cancelled",
          status: cancelled?.status,
        });
        continue;
      }
      const claimed = store.claimMeetingForJoin(session.meetdCompatId);
      if (!claimed.ok) {
        results.push({
          meeting_id: Number(session.meetdCompatId),
          action: "claim_failed",
          error: claimed.error,
        });
        continue;
      }
      results.push({
        meeting_id: Number(session.meetdCompatId),
        action: dryRunJoiner ? "join_planned" : "join_claimed",
        status: claimed.session.status,
        session_id: claimed.session.id,
      });
    }
    return results;
  }

  function tick(options: { now?: Date; staleMs?: number; olderThanMs?: number; dryRunJoiner?: boolean } = {}) {
    const current = options.now || now();
    const cleaned = store.cleanupStaleMeetings({
      now: current,
      olderThanMs: options.staleMs ?? options.olderThanMs,
    });
    const recovered = store.recoverProcessingMeetings({ now: current });
    const ready = processReadyMeetings({ now: current, dryRunJoiner: options.dryRunJoiner });
    return {
      ok: true,
      now: nowIso(current),
      cleaned: cleaned.map(meetdMeetingResponse),
      recovered: recovered.map(meetdMeetingResponse),
      ready,
    };
  }

  return {
    tick,
    processReadyMeetings,
  };
}
