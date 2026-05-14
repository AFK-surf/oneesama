import { CUEBOARD_TRIAGE_SYSTEM_PROMPT } from "./cueboard-triage-prompts.js";

function safeString(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

interface SlackTriageMessage {
  ts?: string;
  userId?: string;
  threadTs?: string;
  text?: string;
}

interface SlackTriageMemoryEntry {
  source?: string;
  kind?: string;
  content?: string;
}

interface SlackTriagePromptInput {
  channelId?: string;
  messages?: SlackTriageMessage[];
  digest?: string;
  channelBrain?: { summary?: string | null } | null;
  localMemory?: { results?: SlackTriageMemoryEntry[] | null } | null;
  previousTriage?: { text?: string | null } | null;
}

interface SlackTriageActionLike {
  type?: string;
  actionType?: string;
  action_type?: string;
  title?: string;
  brief?: string;
  summary?: string;
  message?: string;
  text?: string;
  description?: string;
  reason?: string;
  rationale?: string;
  channelId?: string;
  channel_id?: string;
  channel?: string;
  threadTs?: string;
  thread_ts?: string;
  confidence?: number | string;
  requiresConfirmation?: boolean;
  requires_confirmation?: boolean;
}

interface SlackTriageFallback {
  actions?: SlackTriageActionLike[];
  summary?: string;
  channelId?: string;
  threadTs?: string;
}

interface ParsedSlackTriagePayload {
  actions?: SlackTriageActionLike[];
  summary?: string;
  channelBrain?: string;
  brief?: string;
}

interface SlackPendingActionLike {
  id?: number | string;
  action_type?: string;
  thread_ts?: string;
  channel_id?: string;
}

interface SlackTriageActionTextInput {
  action?: SlackTriageActionLike | null;
  pendingAction?: SlackPendingActionLike | null;
}

interface SlackInteractionAction {
  block_id?: string;
  value?: string;
  action_id?: string;
  selected_user?: string;
}

interface SlackInteractionPayload {
  actions?: SlackInteractionAction[];
  user?: { id?: string };
  user_id?: string;
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pendingActionIdFromBlockId(blockId = "") {
  const match = String(blockId || "").match(/^mab_pending_action:(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export const SLACK_PENDING_ACTION_TYPES = [
  "follow_up",
  "create_task",
  "ask_user",
  "create_issue",
  "add_comment",
  "create_event",
  "join_meeting",
  "create_channel",
  "none",
];

export const SLACK_PENDING_ACTION_INTERACTIONS = [
  "confirmed",
  "dismissed",
  "snoozed",
  "assigned",
  "opened",
];

function firstJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [
    raw,
    fenced?.[1],
    raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

export function buildSlackTriagePrompt({
  channelId = "",
  messages = [],
  digest = "",
  channelBrain = null,
  localMemory = null,
  previousTriage = null,
}: SlackTriagePromptInput = {}) {
  const recentMemory = (localMemory?.results || [])
    .slice(0, 5)
    .map(
      (entry, index) =>
        `${index + 1}. ${entry.source || entry.kind || "memory"}: ${String(entry.content || "").slice(0, 500)}`,
    )
    .join("\n");
  const contextBlock = [
    channelBrain?.summary ? `Existing channel brain:\n${channelBrain.summary}` : "",
    recentMemory ? `Relevant local memory:\n${recentMemory}` : "",
    previousTriage?.text || "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const messageBlock =
    digest ||
    messages
      .map((msg) => {
        const thread = msg.threadTs ? ` thread=${msg.threadTs}` : "";
        return `- ${msg.ts || ""} <@${msg.userId || ""}>${thread}: ${msg.text || ""}`;
      })
      .join("\n");

  return [
    CUEBOARD_TRIAGE_SYSTEM_PROMPT,
    `Channel: ${channelId}`,
    contextBlock ? `Context:\n${contextBlock}` : "",
    "Digest:",
    messageBlock,
    "",
    "Runtime output adapter:",
    "The legacy tools are represented as JSON in this runtime. Preserve the cueboard policy above; only translate the action you would have taken into the JSON action list below.",
    "- slack.postThreadReply maps to type post_thread_reply with requiresConfirmation=false.",
    '- suggest_action(action_type="join_meeting") maps to type join_meeting.',
    "- suggest_action for create_issue, add_comment, create_event, create_channel, create_task, follow_up, or ask_user maps to the matching type and requiresConfirmation=true.",
    "- If the cueboard policy says no action, return an empty actions array.",
    "",
    "Return only JSON with this shape:",
    "{",
    '  "summary": "one concise channel-brain update",',
    '  "actions": [',
    "    {",
    '      "type": "post_thread_reply | follow_up | create_task | ask_user | create_issue | add_comment | create_event | join_meeting | create_channel | none",',
    '      "title": "short action title",',
    '      "message": "reply text for post_thread_reply, or what the user should confirm for a mutation",',
    '      "channelId": "Slack channel id, optional",',
    '      "threadTs": "Slack thread ts, optional",',
    '      "confidence": 0.0,',
    '      "reason": "why this action is justified",',
    '      "requiresConfirmation": true',
    "    }",
    "  ]",
    "}",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function parseSlackTriageDecision(rawOutput: unknown, fallback: SlackTriageFallback = {}) {
  const parsed = firstJsonObject(rawOutput);
  const source = (parsed && typeof parsed === "object" ? parsed : {}) as ParsedSlackTriagePayload;
  const fallbackActions = Array.isArray(fallback.actions) ? fallback.actions : [];
  const actions = normalizeSlackTriageActions(
    Array.isArray(source.actions) ? source.actions : fallbackActions,
    fallback,
  );
  const summary = safeString(
    source.summary || source.channelBrain || source.brief || fallback.summary,
    fallback.summary || "Slack activity triage completed.",
  );
  return {
    summary,
    actions,
    raw: parsed,
    parseOk: Boolean(parsed),
  };
}

export function suggestSlackTriageFallback({
  channelId = "",
  messages = [],
}: {
  channelId?: string;
  messages?: SlackTriageMessage[];
} = {}) {
  const joined = messages.map((msg) => msg.text || "").join("\n");
  const latest = messages[messages.length - 1] || {};
  const actionable =
    /\b(todo|follow.?up|fix|bug|blocked|need|needs|should|please|明天|跟进|修|问题|阻塞|需要)\b/i.test(
      joined,
    );
  const summary = messages.length
    ? `Buffered ${messages.length} Slack message(s); latest from <@${latest.userId || "unknown"}>.`
    : "No Slack messages to triage.";
  if (!actionable) return { summary, actions: [] };
  return {
    summary,
    actions: [],
  };
}

export function normalizeSlackTriageActions(
  actions: SlackTriageActionLike[] = [],
  fallback: SlackTriageFallback = {},
) {
  const allowedTypes = new Set(SLACK_PENDING_ACTION_TYPES);
  return actions
    .map((action) => {
      const type = safeString(
        action.type || action.actionType || action.action_type,
        "follow_up",
      )
        .toLowerCase()
        .replace(/^slack\./, "");
      const aliasedType = type === "reply" || type === "answer" || type === "postthreadreply"
        ? "post_thread_reply"
        : type === "delegate"
          ? "create_task"
          : type;
      const normalizedType = allowedTypes.has(aliasedType) ? aliasedType : "follow_up";
      if (normalizedType === "none") return null;
      const title = safeString(
        action.title || action.brief || action.summary,
        "Review Slack activity",
      ).slice(0, 160);
      const message = safeString(
        action.message || action.text || action.description || action.reason,
        title,
      ).slice(0, 2000);
      return {
        type: normalizedType,
        title,
        message,
        channelId: safeString(
          action.channelId || action.channel_id || action.channel || fallback.channelId,
        ),
        threadTs: safeString(action.threadTs || action.thread_ts || fallback.threadTs),
        confidence: Math.max(0, Math.min(1, safeNumber(action.confidence, 0.5))),
        reason: safeString(action.reason || action.rationale),
        requiresConfirmation:
          normalizedType !== "post_thread_reply" &&
          (action.requiresConfirmation !== false && action.requires_confirmation !== false),
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

export function buildSlackTriageActionText({
  action,
  pendingAction,
}: SlackTriageActionTextInput = {}) {
  const confidenceValue = safeNumber(action?.confidence, Number.NaN);
  const confidence = Number.isFinite(confidenceValue)
    ? ` confidence=${Math.round(confidenceValue * 100)}%`
    : "";
  const reason = action?.reason ? `\nReason: ${action.reason}` : "";
  return [
    `Triage suggestion: ${action?.title || "Review Slack activity"}`,
    "",
    action?.message || "",
    "",
    `Action: ${action?.type || "follow_up"}${confidence}`,
    `Pending action: ${pendingAction?.id || "unrecorded"}`,
    reason,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSlackTriageActionBlocks({
  action,
  pendingAction,
}: SlackTriageActionTextInput = {}) {
  const valueBase = {
    kind: "mab_pending_action",
    id: pendingAction?.id,
  };
  const value = (status, extra = {}) => JSON.stringify({ ...valueBase, status, ...extra });
  const actionType = action?.type || pendingAction?.action_type || "follow_up";
  const threadTs = action?.threadTs || pendingAction?.thread_ts || "";
  const contextParts = [
    `Action: \`${actionType}\``,
    `Confidence: ${Math.round(safeNumber(action?.confidence, 0) * 100)}%`,
    `Pending: ${pendingAction?.id || "unrecorded"}`,
    threadTs ? `Thread: \`${threadTs}\`` : "",
  ].filter(Boolean);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Triage suggestion:* ${action?.title || "Review Slack activity"}\n${action?.message || ""}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: contextParts.join(" | "),
        },
      ],
    },
    ...(action?.reason
      ? [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `Reason: ${action.reason}` }],
          },
        ]
      : []),
    {
      type: "actions",
      block_id: `mab_pending_action:${pendingAction?.id || "new"}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Confirm" },
          style: "primary",
          action_id: "mab_pending_action_confirm",
          value: value("confirmed"),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Dismiss" },
          style: "danger",
          action_id: "mab_pending_action_dismiss",
          value: value("dismissed"),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Snooze" },
          action_id: "mab_pending_action_snooze",
          value: value("snoozed", { snoozeMinutes: 60 }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Open thread" },
          action_id: "mab_pending_action_open_thread",
          value: value("opened", {
            channelId: action?.channelId || pendingAction?.channel_id || "",
            threadTs,
          }),
        },
        {
          type: "users_select",
          action_id: "mab_pending_action_assign",
          placeholder: { type: "plain_text", text: "Assign" },
        },
      ],
    },
  ];
}

export function parsePendingActionInteraction(payload: SlackInteractionPayload = {}) {
  const action = payload.actions?.[0] || {};
  const fallbackId = pendingActionIdFromBlockId(action.block_id);
  let parsed;
  if (action.value) {
    try {
      parsed = JSON.parse(action.value);
    } catch {
      return null;
    }
  } else if (action.action_id === "mab_pending_action_assign" && fallbackId > 0) {
    parsed = {
      kind: "mab_pending_action",
      id: fallbackId,
      status: "assigned",
    };
  } else {
    return null;
  }
  try {
    if (parsed.kind !== "mab_pending_action") return null;
    let status = safeString(parsed.status, "dismissed");
    if (action.action_id === "mab_pending_action_assign") status = "assigned";
    if (!SLACK_PENDING_ACTION_INTERACTIONS.includes(status)) status = "dismissed";
    const assigneeUserId = safeString(
      action.selected_user || parsed.assigneeUserId || parsed.assignee_user_id,
    );
    const snoozeMinutes = Math.max(
      0,
      Math.round(safeNumber(parsed.snoozeMinutes || parsed.snooze_minutes, 0)),
    );
    return {
      id: Number.parseInt(parsed.id, 10),
      status,
      userId: safeString(payload.user?.id || payload.user_id),
      actionId: safeString(action.action_id),
      assigneeUserId,
      snoozeMinutes,
      channelId: safeString(parsed.channelId || parsed.channel_id),
      threadTs: safeString(parsed.threadTs || parsed.thread_ts),
    };
  } catch {
    return null;
  }
}
