const PRIVATE_SLACK_FIELDS = new Set([
  "token",
  "response_url",
  "responseUrl",
  "trigger_id",
  "triggerId",
]);

type FetchLike = typeof fetch;

export interface ShadowTapCommandFragment {
  team_id?: string;
  teamId?: string;
  team_domain?: string;
  teamDomain?: string;
  channel_id?: string;
  channelId?: string;
  channel_name?: string;
  channelName?: string;
  user_id?: string;
  userId?: string;
  user_name?: string;
  userName?: string;
  command?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ShadowTapInput {
  slackCommand?: ShadowTapCommandFragment;
  command?: ShadowTapCommandFragment;
  source?: string;
  sessionId?: string;
  jobId?: string;
  status?: string;
  commandTs?: string;
  eventId?: string;
  event_id?: string;
  oldStack?: {
    source?: string;
    sessionId?: string;
    jobId?: string;
    status?: string;
    commandTs?: string;
    eventId?: string;
    [key: string]: unknown;
  };
  team_id?: string;
  teamId?: string;
  team_domain?: string;
  teamDomain?: string;
  channel_id?: string;
  channelId?: string;
  channel_name?: string;
  channelName?: string;
  user_id?: string;
  userId?: string;
  user_name?: string;
  userName?: string;
  command_name?: string;
  commandName?: string;
  text?: string;
  commandText?: string;
  [key: string]: unknown;
}

export interface ShadowTapPayload {
  source: string;
  eventId: string;
  team_id: string;
  channel_id: string;
  user_id: string;
  command_name: string;
  text: string;
  oldStack: Record<string, unknown>;
  team_domain?: string;
  channel_name?: string;
  user_name?: string;
  [key: string]: unknown;
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

function randomEventId(): string {
  return `shadow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createShadowTapHeaders({ secret = "" }: { secret?: string } = {}): Record<
  string,
  string
> {
  if (!String(secret || "").trim()) {
    throw new Error("MAB_SHADOW_TAP_SECRET is required before mirroring old-stack commands");
  }
  return {
    "content-type": "application/json",
    "x-mab-shadow-tap-secret": String(secret),
  };
}

export function createShadowTapPayload(input: ShadowTapInput = {}): ShadowTapPayload {
  const command: ShadowTapCommandFragment = input.slackCommand || input.command || {};
  const oldStack: Record<string, string> = {
    source: firstNonEmpty(input.source, input.oldStack?.source, "legacy-slack-agentd"),
    sessionId: firstNonEmpty(input.sessionId, input.oldStack?.sessionId),
    jobId: firstNonEmpty(input.jobId, input.oldStack?.jobId),
    status: firstNonEmpty(input.status, input.oldStack?.status),
    commandTs: firstNonEmpty(input.commandTs, input.oldStack?.commandTs),
  };
  for (const key of Object.keys(oldStack)) {
    if (!oldStack[key]) delete oldStack[key];
  }

  const payload: ShadowTapPayload = {
    source: oldStack.source,
    eventId: firstNonEmpty(input.eventId, input.event_id, input.oldStack?.eventId, randomEventId()),
    team_id: firstNonEmpty(input.team_id, input.teamId, command.team_id, command.teamId),
    channel_id: firstNonEmpty(
      input.channel_id,
      input.channelId,
      command.channel_id,
      command.channelId,
    ),
    user_id: firstNonEmpty(input.user_id, input.userId, command.user_id, command.userId),
    command_name: firstNonEmpty(input.command_name, input.commandName, command.command, "/avatar"),
    text: firstNonEmpty(input.text, input.commandText, command.text),
    oldStack,
  };

  const optionalFields: Record<string, string> = {
    team_domain: firstNonEmpty(
      input.team_domain,
      input.teamDomain,
      command.team_domain,
      command.teamDomain,
    ),
    channel_name: firstNonEmpty(
      input.channel_name,
      input.channelName,
      command.channel_name,
      command.channelName,
    ),
    user_name: firstNonEmpty(input.user_name, input.userName, command.user_name, command.userName),
  };
  for (const [key, value] of Object.entries(optionalFields)) {
    if (value) payload[key] = value;
  }

  for (const field of PRIVATE_SLACK_FIELDS) {
    delete payload[field];
    delete (payload.oldStack as Record<string, unknown>)[field];
  }

  return payload;
}

export function assertNoPrivateSlackFields(payload: Record<string, unknown> = {}): boolean {
  const serialized = JSON.stringify(payload);
  for (const field of PRIVATE_SLACK_FIELDS) {
    if (Object.hasOwn(payload, field) || serialized.includes(`"${field}"`)) {
      throw new Error(`shadow tap payload must not include private Slack field: ${field}`);
    }
  }
  return true;
}

export interface PostShadowTapOptions {
  endpoint?: string;
  secret?: string;
  payload?: Record<string, unknown>;
  fetchImpl?: FetchLike;
}

export async function postShadowTap({
  endpoint = "",
  secret = "",
  payload = {},
  fetchImpl = fetch,
}: PostShadowTapOptions = {}) {
  assertNoPrivateSlackFields(payload);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: createShadowTapHeaders({ secret }),
      body: JSON.stringify(payload),
    });
    return { ok: response.ok, status: response.status, body: await response.json() };
  } catch (error) {
    const err = error as { message?: string };
    return {
      ok: false,
      status: 0,
      body: {
        ok: false,
        error: "shadow_tap_post_failed",
        detail: String(err?.message || error),
      },
    };
  }
}
