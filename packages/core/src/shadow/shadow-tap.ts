import type { IncomingMessage } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ShadowSlackCommandBody {
  slackCommand?: ShadowSlackCommandBody;
  command?: ShadowSlackCommandBody | string;
  user?: { id?: string; name?: string } | string;
  channel?: { id?: string; name?: string } | string;
  team?: { id?: string; domain?: string };
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
  response_url?: string;
  responseUrl?: string;
  trigger_id?: string;
  triggerId?: string;
  source?: string;
  eventId?: string;
  event_id?: string;
  oldStack?: { source?: string; eventId?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

export interface VerifyShadowTapRequestArgs {
  secret?: string;
  req?: IncomingMessage;
}

export function verifyShadowTapRequest({ secret = "", req }: VerifyShadowTapRequestArgs = {}) {
  if (!secret) {
    return { ok: false, status: 503, error: "shadow_tap_secret_not_configured" };
  }
  const headerSecretRaw = req?.headers?.["x-mab-shadow-tap-secret"];
  const headerSecret = Array.isArray(headerSecretRaw)
    ? headerSecretRaw[0] || ""
    : headerSecretRaw || "";
  const authorizationRaw = req?.headers?.authorization;
  const authorization = Array.isArray(authorizationRaw)
    ? authorizationRaw[0] || ""
    : authorizationRaw || "";
  if (headerSecret === secret || authorization === `Bearer ${secret}`) {
    return { ok: true };
  }
  return { ok: false, status: 401, error: "invalid_shadow_tap_secret" };
}

export function normalizeShadowSlackCommand(body: ShadowSlackCommandBody = {}) {
  const command: ShadowSlackCommandBody =
    (typeof body.slackCommand === "object" && body.slackCommand) ||
    (typeof body.command === "object" && body.command) ||
    {};
  const user =
    (typeof body.user === "object" && body.user) || ({} as { id?: string; name?: string });
  const channel =
    (typeof body.channel === "object" && body.channel) || ({} as { id?: string; name?: string });
  const team = body.team || ({} as { id?: string; domain?: string });
  return {
    token: "shadow-tap",
    team_id: firstNonEmpty(body.team_id, body.teamId, command.team_id, command.teamId, team.id),
    team_domain: firstNonEmpty(
      body.team_domain,
      body.teamDomain,
      command.team_domain,
      command.teamDomain,
      team.domain,
      "shadow",
    ),
    channel_id: firstNonEmpty(
      body.channel_id,
      body.channelId,
      command.channel_id,
      command.channelId,
      channel.id,
    ),
    channel_name: firstNonEmpty(
      body.channel_name,
      body.channelName,
      command.channel_name,
      command.channelName,
      channel.name,
      "shadow",
    ),
    user_id: firstNonEmpty(body.user_id, body.userId, command.user_id, command.userId, user.id),
    user_name: firstNonEmpty(
      body.user_name,
      body.userName,
      command.user_name,
      command.userName,
      user.name,
      "shadow-user",
    ),
    command: firstNonEmpty(
      body.command_name,
      body.commandName,
      typeof command.command === "string" ? command.command : "",
      "/avatar",
    ),
    text: firstNonEmpty(body.text, body.commandText, command.text),
    response_url: firstNonEmpty(
      body.response_url,
      body.responseUrl,
      command.response_url,
      command.responseUrl,
      "https://shadow.local/response",
    ),
    trigger_id: firstNonEmpty(
      body.trigger_id,
      body.triggerId,
      command.trigger_id,
      command.triggerId,
      "shadow-trigger",
    ),
  };
}

export function shadowTapSummary(body: ShadowSlackCommandBody = {}) {
  const normalized = normalizeShadowSlackCommand(body);
  return {
    source: firstNonEmpty(body.source, body.oldStack?.source, "unknown"),
    eventId: firstNonEmpty(body.eventId, body.event_id, body.oldStack?.eventId),
    command: normalized.command,
    text: normalized.text,
    teamId: normalized.team_id,
    channelId: normalized.channel_id,
    userId: normalized.user_id,
    oldStack: body.oldStack || null,
  };
}

export async function appendShadowTapEvent(
  reportPath: string,
  event: Record<string, unknown> = {},
) {
  const entry = {
    ts: new Date().toISOString(),
    ...event,
  };
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
  }
  return entry;
}

export async function readShadowTapReport(reportPath: string): Promise<Record<string, unknown>[]> {
  if (!reportPath) return [];
  try {
    const raw = await readFile(reportPath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return [];
    throw error;
  }
}
