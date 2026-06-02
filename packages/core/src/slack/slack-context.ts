import { createStateCollection } from "../persistence/state-provider.js";

const PRIVATE_SLACK_FIELDS = new Set(["token", "response_url", "trigger_id", "api_app_id"]);

export interface SlackContextBody {
  team_id?: string;
  team_domain?: string;
  channel_id?: string;
  channel_name?: string;
  thread_ts?: string;
  message_ts?: string;
  user_id?: string;
  user?: string;
  user_name?: string;
  command?: string;
  text?: string;
  raw?: string;
  [key: string]: unknown;
}

export interface SlackContextParsed {
  action?: string;
  sessionId?: string;
  meetUrl?: string;
  task?: string;
  flags?: Record<string, string | boolean | undefined>;
  positionals?: string[];
  validMeetUrl?: boolean;
  avatar?: string;
  botName?: string;
  dryRunJoiner?: boolean;
  startJoiner?: boolean;
  requestedMode?: string;
  allowCodeChanges?: boolean;
  [key: string]: unknown;
}

export interface SlackContextSession {
  id?: string;
  meetUrl?: string;
  [key: string]: unknown;
}

export interface SlackContextRecord {
  id: string;
  workspaceId: string;
  teamDomain: string;
  channelId: string;
  channelName: string;
  threadTs: string;
  lastUserId: string;
  lastUserName: string;
  lastAction: string;
  lastCommandText: string;
  lastSessionId: string;
  lastMeetUrl: string;
  lastTask: string;
  commandCount: number;
  recentCommands: RecentSlackCommand[];
  channelBrain: string;
  threadLedger: SlackThreadLedger;
  source: { kind: string; note: string };
  rawPublic: Record<string, unknown>;
  updatedAt: string;
  createdAt: string;
}

export interface RecentSlackCommand {
  ts: string;
  action: string;
  text: string;
  userId: string;
  sessionId: string;
  meetUrl: string;
  task: string;
}

export interface SlackThreadLedger {
  latestSessionId?: string;
  latestMeetUrl?: string;
  latestTask?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

function text(value: unknown): string {
  return String(value || "").trim();
}

function commandText(body: SlackContextBody): string {
  return text(body.text || body.raw || "").slice(0, 4000);
}

function publicSlackBody(body: SlackContextBody = {}): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (PRIVATE_SLACK_FIELDS.has(key)) continue;
    safe[key] = value;
  }
  return safe;
}

interface ContextIdInput {
  workspaceId?: string;
  channelId?: string;
  threadTs?: string;
}

function contextId(input: ContextIdInput = {}): string {
  return [
    text(input.workspaceId) || "workspace",
    text(input.channelId) || "channel",
    text(input.threadTs) || "channel-root",
  ].join(":");
}

export interface CreateSlackContextProviderOptions {
  provider?: string;
  filePath?: string;
  sqlitePath?: string;
  collection?: string;
}

export interface RememberSlackCommandArgs {
  body?: SlackContextBody | Record<string, unknown>;
  parsed?: SlackContextParsed | Record<string, unknown>;
  session?: SlackContextSession | null;
}

export interface BuildSlackAgentContextArgs extends RememberSlackCommandArgs {
  remembered?: SlackContextRecord | null;
}

export function createSlackContextProvider(options: CreateSlackContextProviderOptions = {}) {
  const contexts = createStateCollection({
    provider: options.provider || (options.filePath ? "json-file" : "memory"),
    filePath: options.filePath,
    sqlitePath: options.sqlitePath,
    collection: options.collection || "slack_workspace_contexts",
  });

  function rememberCommand({
    body = {},
    parsed = {},
    session = null,
  }: RememberSlackCommandArgs = {}): SlackContextRecord {
    const b = body as SlackContextBody;
    const p = parsed as SlackContextParsed;
    const workspaceId = text(b.team_id);
    const channelId = text(b.channel_id);
    const threadTs = text(b.thread_ts || b.message_ts);
    const id = contextId({ workspaceId, channelId, threadTs });
    const previous =
      (contexts.get(id) as SlackContextRecord | undefined) || ({} as Partial<SlackContextRecord>);
    const now = new Date().toISOString();
    const recentCommand: RecentSlackCommand = {
      ts: now,
      action: p.action || "unknown",
      text: commandText(body),
      userId: text(b.user_id || b.user),
      sessionId: session?.id || p.sessionId || "",
      meetUrl: session?.meetUrl || p.meetUrl || "",
      task: p.task || "",
    };
    const recentCommands = [...(previous.recentCommands || []), recentCommand].slice(-12);
    const next: SlackContextRecord = {
      id,
      workspaceId,
      teamDomain: text(b.team_domain),
      channelId,
      channelName: text(b.channel_name),
      threadTs,
      lastUserId: recentCommand.userId,
      lastUserName: text(b.user_name),
      lastAction: recentCommand.action,
      lastCommandText: recentCommand.text,
      lastSessionId: recentCommand.sessionId,
      lastMeetUrl: recentCommand.meetUrl,
      lastTask: recentCommand.task,
      commandCount: Number(previous.commandCount || 0) + 1,
      recentCommands,
      channelBrain: previous.channelBrain || "",
      threadLedger: {
        ...previous.threadLedger,
        latestSessionId: recentCommand.sessionId || previous.threadLedger?.latestSessionId || "",
        latestMeetUrl: recentCommand.meetUrl || previous.threadLedger?.latestMeetUrl || "",
        latestTask: recentCommand.task || previous.threadLedger?.latestTask || "",
        updatedAt: now,
      },
      source: {
        kind: "slack-command",
        note: "Derived from Slack slash-command payload; private response_url/trigger_id/token fields are intentionally omitted.",
      },
      rawPublic: publicSlackBody(body),
      updatedAt: now,
      createdAt: previous.createdAt || now,
    };
    contexts.set(id, next);
    return next;
  }

  function buildAgentContext({
    body = {},
    parsed = {},
    session = null,
    remembered = null,
  }: BuildSlackAgentContextArgs = {}) {
    const b = body as SlackContextBody;
    const p = parsed as SlackContextParsed;
    const workspace: SlackContextRecord =
      remembered ||
      (contexts.get(
        contextId({
          workspaceId: b.team_id,
          channelId: b.channel_id,
          threadTs: b.thread_ts || b.message_ts,
        }),
      ) as SlackContextRecord | undefined) ||
      rememberCommand({ body, parsed, session });
    return {
      sessionId: session?.id || p.sessionId || "",
      meetUrl: session?.meetUrl || p.meetUrl || "",
      requestedBy: text(b.user_id || b.user),
      source: "slack-agent",
      slack: {
        workspaceId: workspace.workspaceId,
        teamDomain: workspace.teamDomain,
        channelId: workspace.channelId,
        channelName: workspace.channelName,
        threadTs: workspace.threadTs,
        userId: text(b.user_id || b.user),
        userName: text(b.user_name),
        command: text(b.command || "/avatar"),
        action: p.action || workspace.lastAction,
      },
      workspaceContext: {
        commandCount: workspace.commandCount,
        recentCommands: workspace.recentCommands || [],
        channelBrain: workspace.channelBrain,
        threadLedger: workspace.threadLedger,
        provenance:
          "Legacy Slack Agent D inspired: channel/thread workspace context is collected here, while private workspace memory stays behind adapters.",
      },
    };
  }

  return {
    rememberCommand,
    buildAgentContext,
    get: (id: string) => contexts.get(id) as SlackContextRecord | undefined,
    list: () =>
      (contexts.list() as SlackContextRecord[]).sort((a, b) =>
        a.updatedAt.localeCompare(b.updatedAt),
      ),
    provider: contexts.provider,
    path: contexts.path,
    collection: contexts.collection,
    close() {
      contexts.close?.();
    },
  };
}
