export const MEETING_RESULT_DELIVERY_RESERVATION_TTL_MS = 10 * 60 * 1000;

export interface MeetingWebhookPayload {
  event?: string;
  meeting_id?: number | string;
  meetingId?: number | string;
  id?: number | string;
  title?: string;
  status?: string;
  error?: string;
  message?: string;
  summary?: MeetingSummaryInput | null;
  result?: { summary?: MeetingSummaryInput };
  artifacts?: Record<string, unknown>;
  transcript?: string;
  chat_transcript?: string;
  chatTranscript?: string;
  time_from?: string;
  timeFrom?: string;
  time_to?: string;
  timeTo?: string;
  slack_ref?: SlackRefInput;
  slackRef?: SlackRefInput;
  slack?: SlackRefInput;
  channel_id?: string;
  channelId?: string;
  channel?: string;
  thread_ts?: string;
  threadTs?: string;
  ts?: string;
  [key: string]: unknown;
}

export interface SlackRefInput {
  channel_id?: string;
  channelId?: string;
  channel?: string;
  thread_ts?: string;
  threadTs?: string;
  ts?: string;
  [key: string]: unknown;
}

export interface MeetingSummaryInput {
  title?: string;
  attendees?: unknown;
  duration_minutes?: number;
  durationMinutes?: number;
  highlights?: unknown;
  decisions?: unknown;
  action_items?: unknown;
  actionItems?: unknown;
  follow_ups?: unknown;
  followUps?: unknown;
  agenda?: unknown;
  next_steps?: unknown;
  nextSteps?: unknown;
  body?: string;
  notes?: string;
  text?: string;
  [key: string]: unknown;
}

export interface MeetingThreadRecord {
  slack_channel_id?: string;
  slack_thread_ts?: string;
  [key: string]: unknown;
}

function text(value: unknown, fallback: string = ""): string {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function numberOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value))
    return value.filter(
      (item) => item !== null && item !== undefined && String(item).trim() !== "",
    );
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function first(...values: unknown[]): unknown {
  return values.find((value) => text(value)) ?? "";
}

function slackRefFromPayload(payload: MeetingWebhookPayload = {}) {
  const source: SlackRefInput = payload.slack_ref || payload.slackRef || payload.slack || {};
  return {
    channelId: text(
      first(
        source.channel_id,
        source.channelId,
        source.channel,
        payload.channel_id,
        payload.channelId,
        payload.channel,
      ),
    ),
    threadTs: text(
      first(
        source.thread_ts,
        source.threadTs,
        source.ts,
        payload.thread_ts,
        payload.threadTs,
        payload.ts,
      ),
    ),
  };
}

export function normalizeMeetingWebhookPayload(payload: MeetingWebhookPayload = {}) {
  const meetingId = numberOrZero(first(payload.meeting_id, payload.meetingId, payload.id));
  const summary = payload.summary || payload.result?.summary || null;
  return {
    event: text(payload.event),
    meetingId,
    title: text(payload.title, meetingId ? `Meeting ${meetingId}` : "Meeting"),
    status: text(payload.status, summary ? "done" : ""),
    error: text(payload.error || payload.message),
    summary,
    artifacts: payload.artifacts || {},
    transcript: text(payload.transcript),
    chatTranscript: text(payload.chat_transcript || payload.chatTranscript),
    timeFrom: text(payload.time_from || payload.timeFrom),
    timeTo: text(payload.time_to || payload.timeTo),
    slackRef: slackRefFromPayload(payload),
    raw: payload,
  };
}

export type NormalizedMeetingWebhookPayload = ReturnType<typeof normalizeMeetingWebhookPayload>;

export function resolveMeetingSlackRef({
  payload,
  meetingThread = null,
}: {
  payload?: NormalizedMeetingWebhookPayload | null;
  meetingThread?: MeetingThreadRecord | null;
} = {}) {
  const direct = payload?.slackRef || { channelId: "", threadTs: "" };
  if (direct.channelId) {
    return {
      channelId: direct.channelId,
      threadTs: direct.threadTs || "",
      source: "payload",
    };
  }
  if (meetingThread?.slack_channel_id) {
    return {
      channelId: meetingThread.slack_channel_id,
      threadTs: meetingThread.slack_thread_ts || "",
      source: "meeting_thread",
    };
  }
  return { channelId: "", threadTs: "", source: "missing" };
}

export function buildMeetingJoinedPost(payload: { title?: string } = {}) {
  const title = text(payload.title, "Untitled meeting");
  const textBody = [
    `:studio_microphone: *Joined: ${title}*`,
    "Recording -- summary will be posted when the meeting ends.",
    "",
    ":robot_face: _oneesama meeting bot_",
  ].join("\n");
  return {
    text: textBody,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:studio_microphone: *Joined: ${title}*\nRecording -- summary will be posted when the meeting ends.`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: ":robot_face: _oneesama meeting bot_" }],
      },
    ],
  };
}

export function meetingProcessingStatus() {
  return "Generating meeting summary...";
}

export function meetingRecordingStatus() {
  return "Recording meeting...";
}

interface NormalizedMeetingSummary {
  title: string;
  attendees: unknown[];
  durationMinutes: number;
  keyPoints: unknown[];
  decisions: unknown[];
  openQuestions: unknown[];
  blockers: unknown[];
  actionItems: unknown[];
}

interface ExtendedMeetingSummary extends MeetingSummaryInput {
  key_points?: unknown;
  keyPoints?: unknown;
  open_questions?: unknown;
  openQuestions?: unknown;
  blockers?: unknown;
}

function normalizeSummary(
  summary: ExtendedMeetingSummary | null | undefined = {},
  title: string = "",
): NormalizedMeetingSummary {
  const source: ExtendedMeetingSummary = summary || {};
  return {
    title: text(source.title, title),
    attendees: array(source.attendees),
    durationMinutes: numberOrZero(source.duration_minutes || source.durationMinutes),
    keyPoints: array(source.key_points || source.keyPoints || source.highlights),
    decisions: array(source.decisions),
    openQuestions: array(source.open_questions || source.openQuestions),
    blockers: array(source.blockers),
    actionItems: array(source.action_items || source.actionItems),
  };
}

interface ActionItemShape {
  description?: string;
  text?: string;
  title?: string;
  owner?: string;
  deadline?: string;
  due?: string;
}

function formatActionItem(item: unknown): string {
  if (typeof item === "string") return item;
  const obj = (item || {}) as ActionItemShape;
  const description = text(obj.description || obj.text || obj.title);
  const owner = text(obj.owner);
  const deadline = text(obj.deadline || obj.due);
  const suffix = [owner ? `owner: ${owner}` : "", deadline ? `due: ${deadline}` : ""]
    .filter(Boolean)
    .join(", ");
  return suffix ? `${description} (${suffix})` : description;
}

function appendList(
  lines: string[],
  title: string,
  items: unknown,
  formatter: (item: unknown) => string = (item) => String(item),
): void {
  const normalized = array(items)
    .map(formatter)
    .map((item) => text(item))
    .filter(Boolean);
  if (!normalized.length) return;
  lines.push("", `*${title}*`);
  for (const item of normalized) lines.push(`- ${item}`);
}

interface MeetingArtifacts {
  transcript_path?: string;
  transcriptPath?: string;
  transcript?: string;
  audio_path?: string;
  audioPath?: string;
  audio?: string;
  [key: string]: unknown;
}

function artifactLines(artifacts: MeetingArtifacts = {}): string[] {
  const transcript = text(
    artifacts.transcript_path || artifacts.transcriptPath || artifacts.transcript,
  );
  const audio = text(artifacts.audio_path || artifacts.audioPath || artifacts.audio);
  const links: string[] = [];
  if (transcript) links.push(`Transcript: ${transcript}`);
  if (audio) links.push(`Audio: ${audio}`);
  return links;
}

export interface BuildMeetingResultPostPayload {
  summary?: ExtendedMeetingSummary | null;
  title?: string;
  artifacts?: MeetingArtifacts;
  meetingId?: number | string;
  [key: string]: unknown;
}

export function buildMeetingResultPost(payload: BuildMeetingResultPostPayload = {}) {
  const summary = normalizeSummary(payload.summary || {}, payload.title);
  const duration = summary.durationMinutes ? ` · ${summary.durationMinutes} min` : "";
  const lines = [
    `:memo: *Meeting Summary: ${summary.title || payload.title || "Untitled meeting"}*${duration}`,
  ];
  if (summary.attendees.length) lines.push(`:busts_in_silhouette: ${summary.attendees.join(", ")}`);
  appendList(lines, "Key points", summary.keyPoints);
  appendList(lines, "Decisions", summary.decisions);
  appendList(lines, "Action items", summary.actionItems, formatActionItem);
  appendList(lines, "Open questions", summary.openQuestions);
  appendList(lines, "Blockers", summary.blockers);
  const artifacts = artifactLines(payload.artifacts);
  appendList(lines, "Artifacts", artifacts);
  if (lines.length === 1) {
    lines.push("", "No structured summary was included in the webhook payload.");
  }
  return {
    text: `${lines.join("\n")}\n`,
    summary,
  };
}

export function buildMeetingFailurePost(payload: { error?: string } = {}) {
  const error = text(payload.error, "unknown error");
  return {
    text: `:x: Meeting failed: ${error}`,
  };
}

export function buildMeetingCanvasArtifact(payload: BuildMeetingResultPostPayload = {}) {
  const summary = normalizeSummary(payload.summary || {}, payload.title);
  return {
    id: `meeting-${payload.meetingId || "unknown"}`,
    meetingId: payload.meetingId,
    title: summary.title || payload.title || "Meeting summary",
    summary: {
      highlights: summary.keyPoints,
      decisions: summary.decisions,
      actionItems: summary.actionItems.map(formatActionItem),
    },
    files: {
      transcript: payload.artifacts?.transcript_path || payload.artifacts?.transcriptPath || "",
      audio: payload.artifacts?.audio_path || payload.artifacts?.audioPath || "",
    },
  };
}
