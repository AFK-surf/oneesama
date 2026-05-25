export const MEETING_COPILOT_MIN_CHAT_INTERVAL_MS = 2 * 60 * 1000;
export const MEETING_COPILOT_MAX_FINAL_LINE_LEN = 240;
export const MEETING_COPILOT_DISABLED_REASON = "meeting_copilot_disabled_realtime_foreground";

export interface MeetingCopilotPayload {
  meetingId?: number | string;
  meeting_id?: number | string;
  id?: number | string;
  title?: string;
  status?: string;
  transcript?: string;
  chat_transcript?: string;
  chatTranscript?: string;
  time_from?: string;
  timeFrom?: string;
  time_to?: string;
  timeTo?: string;
  raw?: { copilot_effects?: CopilotEffectInput[]; copilotEffects?: CopilotEffectInput[] };
  copilotEffects?: CopilotEffectInput[];
  copilot_effects?: CopilotEffectInput[];
  [key: string]: unknown;
}

export interface CopilotEffectInput {
  type?: string;
  kind?: string;
  tool?: string;
  text?: string;
  message?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface MeetingCopilotState {
  lastChatAt?: string;
  lastTranscriptDigest?: string;
  lastChatDigest?: string;
  priorActions?: string[];
  [key: string]: unknown;
}

export interface MeetingCopilotJob {
  result?: string;
  finalMessage?: string;
  text?: string;
  message?: string;
  status?: string;
  [key: string]: unknown;
}

function text(value: unknown, fallback: string = ""): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function truncate(value: unknown, max: number = 160): string {
  const normalized = String(value || "").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function safeMeetingId(payload: MeetingCopilotPayload = {}): string {
  const id = Number(payload.meetingId || payload.meeting_id || payload.id || 0);
  return Number.isFinite(id) && id > 0 ? String(id) : text(payload.title, "unknown");
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function shanghaiTime(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(now);
}

export function incrementalTranscript(previous: unknown, current: unknown): string {
  const normalizedCurrent = text(current);
  if (!normalizedCurrent) return "";
  const normalizedPrevious = text(previous);
  if (!normalizedPrevious) return normalizedCurrent;
  if (normalizedPrevious === normalizedCurrent) return "";

  const seen = new Set(
    normalizedPrevious
      .split("\n")
      .map((line) => text(line))
      .filter(Boolean),
  );
  return normalizedCurrent
    .split("\n")
    .map((line) => text(line))
    .filter((line) => line && !seen.has(line))
    .join("\n");
}

export function containsExplicitMeetingFollowUp(transcript: unknown): boolean {
  const lower = text(transcript).toLowerCase();
  if (!lower) return false;

  const requestPhrases = [
    "帮我",
    "帮忙",
    "查一下",
    "看一下",
    "问一下",
    "记一下",
    "同步一下",
    "发一下",
    "什么状态",
    "有没有",
    "能不能",
    "可以帮",
    "look up",
    "check",
    "status",
    "can you",
    "could you",
    "please",
    "note this",
    "follow up",
    "remind",
  ];
  const wakePhrases = [
    "notetaker",
    "note taker",
    "onee_sama",
    "onee-sama",
    "assistant",
    "记录员",
    "机器人",
    "小助手",
    "bot",
  ];
  const requestHit = requestPhrases.some((phrase) => lower.includes(phrase));
  if (requestHit) return true;
  return wakePhrases.some((phrase) => lower.includes(phrase)) && /[?？]/.test(lower);
}

export function containsMeetingCopilotRealtimeControlRequest(transcript: unknown): boolean {
  const lower = text(transcript).toLowerCase();
  if (!lower) return false;

  const controlTerms = [
    "computer use",
    "control shared app",
    "control_shared_app_window",
    "activity monitor",
    "活动监视器",
    "共享屏幕",
    "分享屏幕",
    "共享窗口",
    "分享窗口",
    "控制窗口",
    "操作窗口",
    "操作应用",
    "激活窗口",
    "切窗口",
    "切到",
    "切换",
  ];
  if (controlTerms.some((phrase) => lower.includes(phrase))) return true;
  if (
    lower.includes("cpu") &&
    (lower.includes("窗口") || lower.includes("切") || lower.includes("占用") || lower.includes("进程"))
  ) {
    return true;
  }
  return (
    (lower.includes("cu") || lower.includes("comp")) &&
    (lower.includes("切") || lower.includes("窗口") || lower.includes("控制"))
  );
}

interface NormalizedCopilotEffect {
  type: string;
  text: string;
  summary: string;
}

function normalizeEffect(effect: CopilotEffectInput | string | null | undefined): NormalizedCopilotEffect | null {
  if (!effect) return null;
  if (typeof effect === "string") return { type: "other", text: "", summary: effect };
  return {
    type: text(effect.type || effect.kind || effect.tool || "other"),
    text: text(effect.text || effect.message || effect.summary),
    summary: text(effect.summary || effect.text || effect.message),
  };
}

function payloadEffects(payload: MeetingCopilotPayload = {}): NormalizedCopilotEffect[] {
  const raw = (payload.raw || payload) as MeetingCopilotPayload;
  const source = raw.copilot_effects || raw.copilotEffects || payload.copilotEffects || [];
  return Array.isArray(source)
    ? (source.map(normalizeEffect).filter(Boolean) as NormalizedCopilotEffect[])
    : [];
}

function jobResultContent(job: MeetingCopilotJob = {}): string {
  return text(job.result || job.finalMessage || job.text || job.message);
}

export function meetingCopilotHasVerboseFinalText(job: MeetingCopilotJob): boolean {
  const content = jobResultContent(job);
  return Boolean(
    content && (content.length > MEETING_COPILOT_MAX_FINAL_LINE_LEN || /[\r\n]/.test(content)),
  );
}

export interface BuildMeetingCopilotPromptArgs {
  payload?: MeetingCopilotPayload;
  transcriptDelta?: string;
  chatDelta?: string;
  state?: MeetingCopilotState;
  now?: Date;
}

export function buildMeetingCopilotPrompt({
  payload = {},
  transcriptDelta = "",
  chatDelta = "",
  state = {},
  now = new Date(),
}: BuildMeetingCopilotPromptArgs & { state?: MeetingCopilotState & { priorActions?: string[] } } = {}) {
  const lines = [`## Meeting: ${text(payload.title, "Meeting")}`, ""];
  if (state.lastChatAt) {
    lines.push(
      "## Recent chat cooldown",
      `You last sent a meeting chat at ${shanghaiTime(new Date(state.lastChatAt))}. Avoid sending another one unless these NEW transcript lines or chat messages contain a materially new, explicit follow-up request.`,
      "",
    );
  }
  if (text(transcriptDelta)) {
    lines.push(
      `## New transcript lines (${text(payload.timeFrom || payload.time_from)} - ${text(payload.timeTo || payload.time_to)})`,
    );
    lines.push(text(transcriptDelta));
  }
  if (text(chatDelta)) {
    lines.push(
      "",
      `## New in-meeting chat messages (${text(payload.timeFrom || payload.time_from)} - ${text(payload.timeTo || payload.time_to)})`,
    );
    lines.push(text(chatDelta));
  }
  if (state.priorActions?.length) {
    lines.push("", "## Prior actions this meeting (do NOT repeat these)");
    for (const action of state.priorActions) lines.push(`- ${action}`);
  }
  lines.push("", `Generated at: ${nowIso(now)}`);
  return `${lines.join("\n").trim()}\n`;
}

function summarizeEffects(effects: NormalizedCopilotEffect[] = []): string {
  const parts: string[] = [];
  for (const effect of effects) {
    if (effect.type === "meeting_chat" || effect.type === "send_meeting_chat") {
      parts.push(
        `sent meeting chat: ${truncate(effect.text || effect.summary || "meeting chat sent", 80)}`,
      );
    } else if (effect.type === "slack_notify" || effect.type === "notify_meeting_slack") {
      parts.push("notified linked Slack thread");
    } else if (effect.summary) {
      parts.push(truncate(effect.summary, 160));
    } else if (effect.type) {
      parts.push(effect.type);
    }
  }
  return parts.length ? parts.join("; ") : "no action";
}

function recordEffects(
  state: { priorActions: string[]; lastChatAt?: string; [key: string]: unknown },
  effects: NormalizedCopilotEffect[] = [],
  now: Date = new Date(),
): void {
  for (const effect of effects) {
    if (effect.type === "meeting_chat" || effect.type === "send_meeting_chat") {
      const summary = truncate(effect.text || effect.summary || "meeting chat sent", 160);
      state.priorActions.push(`[${shanghaiTime(now).replace(/\sGMT[+-].*$/, "")}] ${summary}`);
      state.lastChatAt = now.toISOString();
    } else if (effect.type === "slack_notify" || effect.type === "notify_meeting_slack") {
      state.priorActions.push(
        `[${shanghaiTime(now).replace(/\sGMT[+-].*$/, "")}] notified linked Slack thread`,
      );
    } else if (effect.summary || effect.type) {
      state.priorActions.push(
        `[${shanghaiTime(now).replace(/\sGMT[+-].*$/, "")}] ${truncate(effect.summary || effect.type, 160)}`,
      );
    }
  }
  if (state.priorActions.length > 10) state.priorActions = state.priorActions.slice(-10);
}

interface CopilotRunRecord {
  at: string;
  jobId?: string;
  provider?: string;
  status?: string;
  transcriptDelta?: string;
  chatDelta?: string;
  effectsSummary?: string;
  sessionGeneration?: number;
  sessionKey?: string;
  codexThreadId?: string;
  verboseFinalText?: boolean;
  [key: string]: unknown;
}

interface CopilotInternalState {
  meetingId: string;
  lastDigest: string;
  lastChatFeed: string;
  lastChatAt: string;
  priorActions: string[];
  runs: CopilotRunRecord[];
  sessionGeneration: number;
  stopped: boolean;
  stopReason: string;
  createdAt: string;
  updatedAt: string;
}

function createState(meetingId: string): CopilotInternalState {
  return {
    meetingId,
    lastDigest: "",
    lastChatFeed: "",
    lastChatAt: "",
    priorActions: [],
    runs: [],
    sessionGeneration: 0,
    stopped: false,
    stopReason: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function compactState(state: CopilotInternalState | null | undefined) {
  if (!state) return null;
  return {
    meetingId: state.meetingId,
    stopped: state.stopped,
    stopReason: state.stopReason,
    sessionGeneration: state.sessionGeneration,
    lastChatAt: state.lastChatAt,
    priorActions: state.priorActions,
    runs: state.runs.slice(-10),
    updatedAt: state.updatedAt,
  };
}

export interface CreateMeetingCopilotRunnerOptions {
  agentRunner?: {
    startTask: (input: Record<string, unknown>) => Promise<MeetingCopilotJob>;
    [key: string]: unknown;
  };
  clock?: () => Date;
}

export function createMeetingCopilotRunner({
  agentRunner,
  clock = () => new Date(),
}: CreateMeetingCopilotRunnerOptions = {}) {
  if (!agentRunner?.startTask) {
    throw new Error("createMeetingCopilotRunner requires an agentRunner with startTask()");
  }
  const states = new Map<string, CopilotInternalState>();

  function getState(meetingId: string): CopilotInternalState {
    const key = String(meetingId);
    if (!states.has(key)) states.set(key, createState(key));
    return states.get(key)!;
  }

  async function enqueue(payload: MeetingCopilotPayload = {}) {
    const meetingId = safeMeetingId(payload);
    const state = getState(meetingId);
    const now = clock();
    state.stopped = false;
    state.stopReason = "";

    state.lastDigest = text(payload.transcript);
    state.lastChatFeed = text(payload.chatTranscript || payload.chat_transcript);
    state.updatedAt = now.toISOString();
    return {
      ok: true,
      accepted: true,
      event: payload.event || "meeting.digest",
      meetingId: payload.meetingId || meetingId,
      copilotQueued: false,
      skippedReason: MEETING_COPILOT_DISABLED_REASON,
      state: compactState(state),
    };
  }

  function stop(meetingId, reason = "meeting_result") {
    const key = String(meetingId || "");
    const state = states.get(key);
    if (!state) return { ok: true, stopped: false, reason: "missing_state", meetingId };
    state.stopped = true;
    state.stopReason = reason;
    state.updatedAt = new Date().toISOString();
    return { ok: true, stopped: true, meetingId, reason, state: compactState(state) };
  }

  function status() {
    return {
      ok: true,
      count: states.size,
      states: [...states.values()].map(compactState),
    };
  }

  return { enqueue, stop, status };
}
