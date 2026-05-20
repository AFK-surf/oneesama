import { readFileSync } from "node:fs";
import { createJsonServer } from "../../../packages/core/src/http-json.js";
import { getRuntimeConfig } from "../../../packages/core/src/env.js";
import { createPersistentSessionStore } from "../../../packages/core/src/session-store.js";
import { createAgentRunner } from "../../../packages/core/src/agent-runner/agent-runner.js";
import {
  avatarCommandUsage,
  parseAvatarCommand,
  slackTextResponse,
} from "../../../packages/core/src/control-plane/avatar-command.js";
import { createCutoverController } from "../../../packages/core/src/cutover/cutover-controller.js";
import {
  appendShadowTapEvent,
  normalizeShadowSlackCommand,
  readShadowTapReport,
  shadowTapSummary,
  verifyShadowTapRequest,
} from "../../../packages/core/src/shadow/shadow-tap.js";
import { createSlackPoster } from "../../../packages/core/src/slack/slack-poster.js";
import { createSlackContextProvider } from "../../../packages/core/src/slack/slack-context.js";
import { createLocalSlackMemoryProvider } from "../../../packages/core/src/slack/local-memory.js";
import {
  callSlackApi,
  createCanvasPublisher,
  type CanvasArtifact,
} from "../../../packages/core/src/slack/canvas-publisher.js";
import { createLegacySlackToolRegistry } from "../../../packages/core/src/slack/legacy-slack-tool-registry.js";
import {
  createLegacySlackDomainStore,
  type SlackEventBody,
} from "../../../packages/core/src/slack/legacy-slack-domain-store.js";
import { createInMemoryAssistantScheduleManager } from "../../../packages/core/src/slack/assistant-schedule-tool.js";
import {
  MAX_APP_MENTION_THREAD_MESSAGES,
  buildSlackAppMentionContext,
} from "../../../packages/core/src/slack/app-mention-context.js";
import {
  ensureSlackWorkspaceFiles,
  validateSlackAgentRuntime,
} from "../../../packages/core/src/slack/workspace-bootstrap.js";
import {
  buildSlackOAuthAuthorizeUrl,
  createOneeSamaSlackManifest,
  exchangeSlackOAuthCode,
  maskSlackOAuthResult,
  parseSlackAppManifest,
  validateSlackAppManifest,
} from "../../../packages/core/src/slack/slack-app-manifest.js";
import {
  MEETING_RESULT_DELIVERY_RESERVATION_TTL_MS,
  buildMeetingCanvasArtifact,
  buildMeetingFailurePost,
  buildMeetingJoinedPost,
  buildMeetingResultPost,
  meetingProcessingStatus,
  meetingRecordingStatus,
  normalizeMeetingWebhookPayload,
  resolveMeetingSlackRef,
} from "../../../packages/core/src/slack/meeting-webhook-delivery.js";
import { createMeetingCopilotRunner } from "../../../packages/core/src/slack/meeting-copilot-runner.js";
import { verifyDigestWebhookSignature } from "../../../packages/core/src/meeting/digest-webhook.js";
import {
  buildSlackTriageActionBlocks,
  buildSlackTriageActionText,
  buildSlackTriagePrompt,
  parsePendingActionInteraction,
  parseSlackTriageDecision,
  suggestSlackTriageFallback,
} from "../../../packages/core/src/slack/triage-flow.js";
import {
  formatTriageContexts,
  loadTriageContextProjection,
  normalizeTriageContext,
  persistTriageContextProjection,
} from "../../../packages/core/src/slack/triage-context.js";
import { buildDailyNoteCompactionTask } from "../../../packages/core/src/slack/scanner-compaction.js";
import { verifySlackRequest } from "../../../packages/core/src/slack/slack-signature.js";

/**
 * Permissive input shape for HTTP route handlers in this file. All routes accept
 * a JSON body whose schema is best described as "duck-typed Slack payload": each
 * handler probes for both camelCase and snake_case variants and falls back to
 * defaults. We give every known field an optional precise type and keep an
 * index signature so unknown extras stay typed as `unknown` rather than `any`.
 */
interface SlackHandlerInput {
  workspace?: string;
  workspaceId?: string;
  workspace_id?: string;
  workspaceDir?: string;
  workspace_dir?: string;
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
  user_name?: string;
  channel?: string;
  channel_id?: string;
  channelName?: string;
  channel_name?: string;
  channelType?: string;
  channel_type?: string;
  channels?: SlackChannelLike[];
  messages?: SlackMessageLike[];
  oldest?: string;
  limit?: number | string;
  memberLimit?: number | string;
  excludeArchived?: boolean;
  types?: string;
  fetchMembers?: boolean;
  flush?: boolean;
  date?: string;
  run?: boolean | string;
  status?: string;
  threadTs?: string;
  thread_ts?: string;
  ts?: string;
  text?: string;
  title?: string;
  summary?: string;
  kind?: string;
  sourceKind?: string;
  source_kind?: string;
  sourceRef?: string;
  source_ref?: string;
  priority?: string;
  dueAt?: string;
  due_at?: string;
  nextCheckAt?: string;
  next_check_at?: string;
  metadata?: Record<string, unknown>;
  requestedSurface?: string;
  requested_surface?: string;
  deliveredSurface?: string;
  delivered_surface?: string;
  surfaceStatus?: string;
  surface_status?: string;
  blockReason?: string;
  block_reason?: string;
  error?: string;
  recommendationType?: string;
  recommendation_type?: string;
  recommendationStatus?: string;
  recommendation_status?: string;
  cardTs?: string;
  card_ts?: string;
  outboundActionType?: string;
  outbound_action_type?: string;
  outboundStatus?: string;
  outbound_status?: string;
  followupStatus?: string;
  followup_status?: string;
  sessionId?: string;
  session_id?: string;
  target?: string;
  reference?: string;
  [key: string]: unknown;
}

interface SlackChannelLike {
  id?: string;
  channel?: string;
  channel_id?: string;
  name?: string;
  name_normalized?: string;
  type?: string;
  channel_type?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  members?: string[];
  messages?: SlackMessageLike[];
  [key: string]: unknown;
}

interface SlackMessageLike {
  ts?: string;
  event_ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  type?: string;
  channel?: string;
  channel_type?: string;
  [key: string]: unknown;
}

interface SlackApiPageResult<T = unknown> {
  ok: boolean;
  items?: T[];
  error?: string;
  method?: string;
  fixture?: boolean;
  detail?: unknown;
  status?: number;
  source?: string;
  messages?: T[];
}

interface SlackEventLike {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_id?: string;
  channel_type?: string;
  user?: string;
  user_id?: string;
  bot_id?: string;
  ts?: string;
  event_ts?: string;
  thread_ts?: string;
  text?: string;
  data?: unknown;
  context?: unknown;
  assistant_thread?: unknown;
  assistantThread?: unknown;
  replies?: SlackMessageLike[];
  threadMessages?: SlackMessageLike[];
  thread_messages?: SlackMessageLike[];
  thread_permalink?: string;
  thread?: { ts?: string; messages?: SlackMessageLike[] };
  threadTimeStamp?: string;
  meeting_context?: unknown;
  [key: string]: unknown;
}

interface SlackPayloadLike {
  team?: { id?: string; domain?: string };
  team_id?: string;
  event?: SlackEventLike;
  event_id?: string;
  eventId?: string;
  type?: string;
  channel?: { id?: string; name?: string } | string;
  channel_id?: string;
  user?: { id?: string; name?: string } | string;
  user_id?: string;
  actions?: Array<Record<string, unknown>>;
  meeting_context?: unknown;
  meetingContext?: unknown;
  text?: string;
  ts?: string;
  thread_ts?: string;
  threadTs?: string;
  thread_permalink?: string;
  threadPermalink?: string;
  thread_messages?: SlackMessageLike[];
  threadMessages?: SlackMessageLike[];
  replies?: SlackMessageLike[];
  thread?: { ts?: string; messages?: SlackMessageLike[]; replies?: SlackMessageLike[] };
  meeting_id?: string;
  meetingId?: string;
  title?: string;
  status?: string;
  summary?: unknown;
  error?: string;
  artifacts?: Record<string, unknown>;
  transcript?: string;
  chat_transcript?: string;
  chatTranscript?: string;
  time_from?: string;
  timeFrom?: string;
  time_to?: string;
  timeTo?: string;
  slack_ref?: { channel_id?: string; thread_ts?: string };
  slackRef?: { channel_id?: string; thread_ts?: string };
  slack?: unknown;
  [key: string]: unknown;
}

interface SlackJobLike {
  id?: string;
  sessionId?: string;
  session_id?: string;
  status?: string;
  source?: string;
  task?: unknown;
  context?: SlackHandlerInput & {
    channelId?: string;
    threadTs?: string;
    sessionKind?: string;
    [key: string]: unknown;
  };
  result?: unknown;
  error?: unknown;
  threadTs?: string;
  channelId?: string;
  startedAt?: string;
  finishedAt?: string;
  meetingId?: string;
  [key: string]: unknown;
}

interface SlackWorkerResponseBody {
  status?: string;
  text?: string;
  message?: string;
  ok?: boolean;
  job?: SlackJobLike;
  result?: unknown;
  ackText?: string;
  keepStatus?: boolean;
  [key: string]: unknown;
}

const config = getRuntimeConfig();
const sqlitePath = config.stateSqlitePath || `${config.dataDir}/meeting-avatar-bot.sqlite3`;
const sessions = createPersistentSessionStore(`${config.dataDir}/slack-sessions.json`, {
  provider: config.stateProvider,
  sqlitePath,
  collection: "slack_sessions",
});
const cutover = createCutoverController({
  mode: config.cutoverMode,
  canaryPercent: config.cutoverCanaryPercent,
  reportPath: config.cutoverReportPath,
  seed: "slack-agent",
});
const poster = createSlackPoster({
  botToken: config.slackBotToken,
  mock: config.slackPosterMock || !config.slackBotToken,
});
const canvasPublisher = createCanvasPublisher({
  provider: config.canvasPublisher,
  outDir: config.canvasDir,
  poster,
});
const workspaceContext = createSlackContextProvider({
  provider: config.stateProvider,
  filePath: `${config.dataDir}/slack-workspace-context.json`,
  sqlitePath,
  collection: "slack_workspace_contexts",
});
const localSlackMemory = createLocalSlackMemoryProvider({
  enabled: config.slackMemoryEnabled,
  rootDir: config.slackMemoryDir,
});
const slackWorkspaceDir =
  process.env.MAB_SLACK_WORKSPACE_DIR || `${config.dataDir}/slack-workspace`;
let lastScannerCompactionHash = "";
const slackWorkspaceBootstrapEnabled = process.env.MAB_SLACK_WORKSPACE_BOOTSTRAP !== "0";
const slackWorkspaceBootstrap = slackWorkspaceBootstrapEnabled
  ? ensureSlackWorkspaceFiles({ workspaceDir: slackWorkspaceDir })
  : { ok: true, skipped: true, workspaceDir: slackWorkspaceDir };
const expectedSlackManifest = createOneeSamaSlackManifest({
  publicBaseUrl: config.publicBaseUrl,
  displayName: config.botName || "Onee-sama",
});

function loadConfiguredSlackManifest() {
  if (!config.slackAppManifestPath) return null;
  return parseSlackAppManifest(readFileSync(config.slackAppManifestPath, "utf8"));
}

if (process.env.MAB_SLACK_VALIDATE_ONLY === "1") {
  const validation = await validateSlackAgentRuntime({
    meetingAgentUrl: process.env.MAB_VALIDATE_MEETING_AGENT_URL || config.meetingAgentUrl,
    webhookListen: process.env.MAB_MEET_WEBHOOK_LISTEN || "",
    slackBotToken: config.slackBotToken,
    slackAppToken: config.slackAppToken,
    slackSigningSecret: config.slackSigningSecret,
    requireSlackTokens: process.env.MAB_REQUIRE_SLACK_TOKENS === "1",
  });
  const manifest = loadConfiguredSlackManifest();
  const manifestValidation = manifest
    ? validateSlackAppManifest(manifest, { expected: expectedSlackManifest })
    : { ok: true, skipped: true, reason: "manifest_path_empty" };
  const result = {
    ok: slackWorkspaceBootstrap.ok && validation.ok && manifestValidation.ok,
    workspace: slackWorkspaceBootstrap,
    validation,
    manifestValidation,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
function loadAssistantScheduleManager(filePath) {
  if (!filePath) return null;
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  const definitions = Array.isArray(parsed) ? parsed : parsed.definitions || parsed.schedules || [];
  return createInMemoryAssistantScheduleManager(definitions);
}
const assistantScheduleManager = loadAssistantScheduleManager(
  config.assistantScheduleDefinitionsPath,
);
const slackDomainStore = config.slackDomainStoreEnabled
  ? createLegacySlackDomainStore({ dbPath: config.slackDomainDbPath })
  : null;
const legacyTools = createLegacySlackToolRegistry({
  botToken: config.slackBotToken,
  localMemory: localSlackMemory,
  scheduleManager: assistantScheduleManager,
  workspaceDir: process.cwd(),
  runtimeStatus: () => ({
    service: "slack-agent",
    sessions: sessions.list().length,
    jobs: runner?.listJobs?.().length || 0,
    socketMode: slackInbound.socketMode,
    eventBuffer: slackInbound.eventBuffer,
    memory: localSlackMemory.summary(),
    domainStore: slackDomainStore?.stats?.() || { enabled: false },
  }),
});
let runner;
const slackInbound = {
  socketMode: {
    enabled: config.slackSocketMode,
    connected: false,
    connecting: false,
    lastConnectedAt: "",
    lastClosedAt: "",
    lastError: "",
    lastEventAt: "",
    eventsHandled: 0,
    slashCommandsHandled: 0,
    interactionsHandled: 0,
    reconnects: 0,
  },
  eventBuffer: {
    enabled: config.slackEventBuffer,
    debounceMs: config.slackEventDebounceMs,
    maxBatch: config.slackEventMaxBatch,
    allowBotMessages: config.slackEventAllowBotMessages,
    triageEnabled: config.slackEventTriage,
    bufferedMessages: 0,
    flushes: 0,
    lastBufferedAt: "",
    lastFlushAt: "",
    lastFlushChannel: "",
    lastFlushCount: 0,
    lastTriageJobId: "",
    lastError: "",
    channels: {},
  },
};
const meetingDigestWebhooks = [];
const slackMessageBuffers = new Map();
const finalizedTriageJobs = new Set();
const finalizedWorkerJobReports = new Map();
const triageJobResults = new Map();
let slackSocketReconnectTimer = null;
const slackApiMockCalls = [];
const assistantStatusByThread = new Map();
const activeSlackMentionThreads = new Set();
const recentSlackMentionEvents = new Map();

const assistantToolStatusLabels = {
  read_doc: "Reading documentation...",
  bash: "Running in workspace...",
  read: "Reading files...",
  edit: "Editing files...",
  write: "Writing files...",
  python: "Running Python...",
  memory_search: "Searching memory...",
  memory_get: "Reading memory...",
  memory_write: "Updating memory...",
  slack_api: "Working with Slack...",
  linear_api: "Querying Linear...",
  google_calendar_api: "Checking calendar...",
  figma_api: "Checking Figma...",
  exa_search: "Searching the web...",
  exa_contents: "Reading webpage...",
  manage_task: "Updating tasks...",
  manage_schedule: "Checking schedules...",
};
const assistantStatusMinIntervalMs = 2000;

function assistantStatusPriority(status = "") {
  const normalized = String(status || "").trim();
  if (!normalized) return 0;
  if (normalized === "Thinking..." || normalized === "Working on it...") return 1;
  if (normalized === "Starting Codex..." || normalized === "Planning...") return 2;
  if (normalized === "Composing reply...") return 3;
  if (
    normalized.startsWith("Running ") ||
    normalized.startsWith("Using ") ||
    normalized.startsWith("Editing ") ||
    normalized.startsWith("Inspecting ") ||
    normalized.startsWith("Delegating ") ||
    normalized.startsWith("Waiting ") ||
    normalized.startsWith("Messaging ") ||
    normalized.startsWith("Checking ")
  ) {
    return 4;
  }
  return 2;
}

function shouldBypassAssistantStatusThrottle(status = "") {
  return assistantStatusPriority(status) >= 3;
}

async function collectSlackApiPages<T = unknown>(
  method: string,
  payload: Record<string, unknown> = {},
  itemKey: string = "",
): Promise<SlackApiPageResult<T>> {
  const items: T[] = [];
  let cursor = "";
  do {
    const result = await callSlackApi({
      botToken: config.slackBotToken,
      method,
      payload: {
        ...payload,
        ...(cursor ? { cursor } : {}),
      },
    });
    if (!result.ok)
      return { ok: false, error: result.error, method, detail: result } as SlackApiPageResult<T>;
    const body = result.body as Record<string, unknown> | undefined;
    const chunk = (body?.[itemKey] as T[] | undefined) || [];
    items.push(...chunk);
    const metadata = body?.response_metadata as { next_cursor?: string } | undefined;
    cursor = metadata?.next_cursor || "";
  } while (cursor);
  return { ok: true, items };
}

function slackInstallModel(inputManifest = null) {
  const redirectUri =
    config.slackRedirectUri || `${config.publicBaseUrl.replace(/\/+$/, "")}/slack/oauth`;
  const manifest = expectedSlackManifest;
  const configuredManifest = inputManifest || loadConfiguredSlackManifest();
  const manifestValidation = configuredManifest
    ? validateSlackAppManifest(configuredManifest, { expected: manifest })
    : { ok: false, skipped: true, reason: "no_manifest_supplied" };
  const installUrl = buildSlackOAuthAuthorizeUrl({
    clientId: config.slackClientId,
    redirectUri,
  });
  return {
    ok: true,
    manifest,
    manifestValidation,
    oauth: {
      configured: Boolean(config.slackClientId && config.slackClientSecret),
      installUrl,
      redirectUri,
      clientIdConfigured: Boolean(config.slackClientId),
      clientSecretConfigured: Boolean(config.slackClientSecret),
    },
    permissionModel: {
      mode: "socket_mode_plus_assistant_dm",
      notes: [
        "Manifest/App Home changes must be followed by Reinstall to Workspace.",
        "Live event handling should stay disabled until local validation and self-trigger-loop smokes are green.",
      ],
    },
  };
}

async function refreshSlackDomainCache(input: SlackHandlerInput = {}) {
  if (!slackDomainStore) return { ok: false, error: "slack_domain_store_disabled" };
  const workspaceId =
    input.workspace || input.workspaceId || input.team || input.team_id || "workspace";
  const source: SlackApiPageResult<SlackChannelLike> =
    Array.isArray(input.channels) && input.channels.length
      ? { ok: true, items: input.channels, fixture: true }
      : await collectSlackApiPages<SlackChannelLike>(
          "conversations.list",
          {
            exclude_archived: input.excludeArchived !== false,
            types: input.types || "public_channel,private_channel",
            limit: Number(input.limit || 200),
          },
          "channels",
        );
  if (!source.ok) return source;

  const refreshed = [];
  for (const channel of source.items || []) {
    const channelId = channel.id || channel.channel_id || "";
    if (!channelId) continue;
    const type =
      channel.type ||
      (channel.is_im
        ? "im"
        : channel.is_mpim
          ? "mpim"
          : channel.is_private
            ? "private_channel"
            : "public_channel");
    const stored = slackDomainStore.upsertChannel({
      id: channelId,
      name: channel.name || channel.name_normalized || channelId,
      type,
    });
    let members: string[] = Array.isArray(channel.members) ? channel.members : [];
    if (!members.length && input.fetchMembers !== false && !source.fixture) {
      const memberResult = await collectSlackApiPages<string>(
        "conversations.members",
        {
          channel: channelId,
          limit: Number(input.memberLimit || 1000),
        },
        "members",
      );
      if (memberResult.ok) members = memberResult.items || [];
      else
        refreshed.push({ workspaceId, channelId, memberError: memberResult.error, fixture: false });
    }
    const membership = slackDomainStore.syncChannelMembers(channelId, members);
    refreshed.push({
      workspaceId,
      channel: stored,
      memberCount: membership.memberCount,
      fixture: Boolean(source.fixture),
    });
  }
  slackDomainStore.setEventCursor(`domain-refresh:${workspaceId}`, new Date().toISOString());
  return {
    ok: true,
    workspaceId,
    source: source.fixture ? "fixture" : "slack_web_api",
    refreshed,
    channelCount: refreshed.length,
    memberCount: refreshed.reduce((sum, item) => sum + Number(item.memberCount || 0), 0),
    domain: slackDomainStore.stats(),
  };
}

function slackTsAfter(value = "", cursor = "") {
  if (!cursor) return true;
  const current = Number(value);
  const previous = Number(cursor);
  if (Number.isFinite(current) && Number.isFinite(previous)) return current > previous;
  return String(value || "") > String(cursor || "");
}

interface NormalizedSweepChannel {
  id: string;
  name: string;
  type: string;
  messages: SlackMessageLike[];
}

function normalizeSweepChannels(input: SlackHandlerInput = {}): NormalizedSweepChannel[] {
  if (Array.isArray(input.channels) && input.channels.length) {
    return input.channels
      .map((channel) => ({
        id: channel.id || channel.channel || channel.channel_id || "",
        name: channel.name || "",
        type: channel.type || channel.channel_type || "public_channel",
        messages: Array.isArray(channel.messages) ? channel.messages : [],
      }))
      .filter((channel) => channel.id);
  }
  const channelId = input.channel || input.channel_id || "";
  if (!channelId) return [];
  return [
    {
      id: channelId,
      name: input.channelName || input.channel_name || "",
      type: input.channelType || input.channel_type || "public_channel",
      messages: Array.isArray(input.messages) ? input.messages : [],
    },
  ];
}

async function collectSlackHistory(
  channelId: string,
  input: SlackHandlerInput = {},
  cursor = "",
): Promise<SlackApiPageResult<SlackMessageLike> & { messages?: SlackMessageLike[] }> {
  if (Array.isArray(input.messages))
    return { ok: true, messages: input.messages, source: "fixture" };
  const result = await collectSlackApiPages<SlackMessageLike>(
    "conversations.history",
    {
      channel: channelId,
      oldest: cursor || input.oldest || "0",
      inclusive: false,
      limit: Number(input.limit || 100),
    },
    "messages",
  );
  if (!result.ok) return result;
  return { ok: true, messages: result.items || [], source: "slack_web_api" };
}

async function sweepSlackScanner(input: SlackHandlerInput = {}) {
  if (!slackDomainStore) return { ok: false, error: "slack_domain_store_disabled" };
  const workspaceId =
    input.workspace || input.workspaceId || input.team || input.team_id || "workspace";
  const channels = normalizeSweepChannels(input);
  if (!channels.length) return { ok: false, error: "channel_required" };

  const sweeps = [];
  for (const channel of channels) {
    slackDomainStore.upsertChannel({
      id: channel.id,
      name: channel.name || channel.id,
      type: channel.type,
    });
    const cursorKey = `scanner:${workspaceId}:${channel.id}`;
    const previousCursor = slackDomainStore.getEventCursor(cursorKey)?.value || "";
    const history = channel.messages.length
      ? { ok: true, messages: channel.messages, source: "fixture" }
      : await collectSlackHistory(channel.id, input, previousCursor);
    if (!history.ok) {
      sweeps.push({ channelId: channel.id, ok: false, error: history.error, previousCursor });
      continue;
    }
    const messages = [...history.messages]
      .filter((message) => slackTsAfter(message.ts || message.event_ts || "", previousCursor))
      .sort((a, b) =>
        String(a.ts || a.event_ts || "").localeCompare(String(b.ts || b.event_ts || "")),
      );
    let nextCursor = previousCursor;
    let buffered = 0;
    for (const message of messages) {
      const event = {
        type: "message",
        channel: channel.id,
        channel_type: channel.type,
        user: message.user || message.bot_id || "",
        bot_id: message.bot_id || "",
        subtype: message.subtype || "",
        text: message.text || "",
        ts: message.ts || message.event_ts || "",
        event_ts: message.event_ts || message.ts || "",
        thread_ts: message.thread_ts || "",
      };
      const result = bufferSlackMessageEvent(event, { team_id: workspaceId });
      if (result.buffered) buffered += 1;
      if (slackTsAfter(event.ts, nextCursor)) nextCursor = event.ts;
    }
    if (nextCursor && nextCursor !== previousCursor)
      slackDomainStore.setEventCursor(cursorKey, nextCursor);
    let flushed = null;
    if (input.flush !== false && buffered > 0) {
      flushed = await flushSlackMessageBuffer(channel.id);
    }
    sweeps.push({
      channelId: channel.id,
      ok: true,
      source: history.source,
      previousCursor,
      nextCursor,
      scanned: history.messages.length,
      buffered,
      flushed: flushed ? { count: flushed.messages.length, digest: flushed.digest } : null,
    });
  }
  return {
    ok: sweeps.every((sweep) => sweep.ok),
    workspaceId,
    sweeps,
    inbound: slackInbound,
  };
}

async function compactSlackDailyNotes(input: SlackHandlerInput = {}) {
  const workspaceDir = input.workspaceDir || input.workspace_dir || slackWorkspaceDir;
  const task = buildDailyNoteCompactionTask({
    workspaceDir,
    date: input.date || "",
  });
  if (!task.ok || !task.eligible) return task;
  if (task.hash && task.hash === lastScannerCompactionHash) {
    return { ...task, eligible: false, skipped: true, reason: "duplicate_hash" };
  }
  if (input.run === true || input.run === "true") {
    const job = await runner.startTask({
      task: task.prompt,
      context: {
        kind: task.sessionKind,
        workspaceDir,
        date: task.date,
        path: task.path,
        hash: task.hash,
      },
      mode: "analysis",
      allowCodeChanges: false,
    });
    lastScannerCompactionHash = task.hash;
    return { ...task, job };
  }
  return task;
}

function slackFollowupStatus(input: SlackHandlerInput = {}) {
  const limit = Number.parseInt(String(input.limit ?? "20"), 10);
  return {
    ok: true,
    outboundActions: slackDomainStore?.listOutboundActions({ limit }) || [],
    threadRecommendations: slackDomainStore?.listThreadRecommendations({ limit }) || [],
    heartbeatFollowups:
      slackDomainStore?.listHeartbeatFollowups({ status: input.status || "", limit }) || [],
    heartbeatSurfaces: slackDomainStore?.listHeartbeatSurfaces({ limit }) || [],
  };
}

function createSlackFollowupSurface(input: SlackHandlerInput = {}) {
  if (!slackDomainStore) return { ok: false, error: "slack_domain_store_disabled" };
  const channelId = input.channel || input.channel_id || "C_FOLLOWUP";
  const threadTs = input.threadTs || input.thread_ts || "channel-root";
  const sessionId = input.sessionId || input.session_id || "";
  const title = input.title || "Follow up on Slack activity";
  const summary = input.summary || title;
  const followup = slackDomainStore.createHeartbeatFollowup({
    kind: input.kind || "followup",
    title,
    summary,
    sourceKind: input.sourceKind || input.source_kind || "thread",
    channelId,
    threadTs,
    sourceRef: input.sourceRef || input.source_ref || `${channelId}:${threadTs}`,
    priority: input.priority || "normal",
    dueAt: input.dueAt || input.due_at || "",
    nextCheckAt: input.nextCheckAt || input.next_check_at || "",
    metadata: input.metadata || {},
  });
  const surface = slackDomainStore.recordHeartbeatSurface({
    followupId: followup.id,
    sessionId,
    title,
    summary,
    requestedSurface: input.requestedSurface || input.requested_surface || "slack_thread",
    deliveredSurface: input.deliveredSurface || input.delivered_surface || "slack_thread",
    channelId,
    threadTs,
    status: input.surfaceStatus || input.surface_status || "sent",
    blockReason: input.blockReason || input.block_reason || "",
    error: input.error || "",
  });
  let recommendation = null;
  if (input.recommendationType || input.recommendation_type) {
    const reserved = slackDomainStore.reserveThreadRecommendation({
      channelId,
      threadTs,
      recommendationType: input.recommendationType || input.recommendation_type,
    });
    recommendation = reserved.id
      ? slackDomainStore.setThreadRecommendationStatus(
          reserved.id,
          input.recommendationStatus || input.recommendation_status || "active",
          input.cardTs || input.card_ts || surface.id,
        )
      : reserved;
  }
  let outbound = null;
  if (input.outboundActionType || input.outbound_action_type) {
    const reserved = slackDomainStore.reserveOutboundAction({
      actionType: input.outboundActionType || input.outbound_action_type,
      target: input.target || channelId,
      reference: input.reference || `${channelId}:${threadTs}:${surface.id}`,
      sessionId,
      summary,
    });
    outbound = reserved.id
      ? slackDomainStore.setOutboundActionStatus(
          reserved.id,
          input.outboundStatus || input.outbound_status || "sent",
        )
      : reserved;
  }
  const finalFollowup =
    input.followupStatus || input.followup_status
      ? slackDomainStore.setHeartbeatFollowupStatus(
          followup.id,
          input.followupStatus || input.followup_status,
        )
      : followup;
  return {
    ok: true,
    followup: finalFollowup,
    surface,
    recommendation,
    outbound,
    status: slackFollowupStatus({ limit: input.limit || 20 }),
  };
}

async function postJson(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, body: await response.json() };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { ok: false, error: "request_failed", detail: String(error?.message || error) },
    };
  }
}

async function getJson(url) {
  try {
    const response = await fetch(url);
    return { ok: response.ok, status: response.status, body: await response.json() };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { ok: false, error: "request_failed", detail: String(error?.message || error) },
    };
  }
}

function resolveSession(parsed: { sessionId?: string }) {
  if (parsed.sessionId) return sessions.get(parsed.sessionId);
  return sessions.latest();
}

interface RememberSlackCommandArgs {
  body?: SlackHandlerInput;
  parsed?: ParsedAvatarCommand | Record<string, unknown>;
  session?: { id?: string; meetUrl?: string } | null;
  responseSummary?: string;
}

function rememberSlackCommand({
  body = {},
  parsed = {},
  session = null,
  responseSummary = "",
}: RememberSlackCommandArgs = {}) {
  const parsedRecord = parsed as Record<string, unknown>;
  const slackContext = workspaceContext.rememberCommand({ body, parsed: parsedRecord, session });
  let domainContext: unknown = null;
  if (slackDomainStore) {
    domainContext = slackDomainStore.recordSlackCommand({
      body: body as SlackEventBody & { command?: string },
      parsed: parsedRecord as { sessionId?: string; action?: string; [key: string]: unknown },
      session,
      responseSummary,
    });
  }
  return { slackContext, domainContext };
}

async function reportFinishedWorkerJob(job: SlackJobLike) {
  if ((job?.context as { source?: string } | undefined)?.source === "slack-triage") {
    await finalizeSlackTriageJob(job);
    return null;
  }
  if (!["completed", "failed"].includes(String(job.status))) return null;
  if (finalizedWorkerJobReports.has(String(job.id))) return finalizedWorkerJobReports.get(String(job.id));
  const meetingReport = await postJson(`${config.meetingAgentUrl}/worker/report`, {
    id: job.id,
    status: job.status,
    task: job.task,
    result: job.result,
    error: job.error,
  });
  const slackPost = await postSlackWorkerResult(job);
  const assistantStatusClear = await clearSlackAssistantStatusForWorkerJob(job);
  const report = {
    ok:
      meetingReport.ok &&
      (!slackPost || slackPost.ok !== false) &&
      assistantStatusClear.ok !== false,
    status: meetingReport.status,
    body: meetingReport.body,
    meetingReport,
    slackPost,
    assistantStatusClear,
  };
  finalizedWorkerJobReports.set(job.id, report);
  return report;
}

function slackRefForWorkerJob(job: SlackJobLike = {}) {
  const slack = (job.context?.slack || {}) as {
    channelId?: string;
    channel?: string;
    threadTs?: string;
    thread_ts?: string;
    [key: string]: unknown;
  };
  const slackAppMention = job.context?.slackAppMention as { threadTs?: string } | undefined;
  const channel = slack.channelId || slack.channel || "";
  const threadTs =
    slack.threadTs || slack.thread_ts || slackAppMention?.threadTs || "";
  if (!channel) return null;
  return { channel, threadTs };
}

function slackWorkerResultText(job: SlackJobLike = {}) {
  if (job.status !== "completed") {
    return "";
  }
  return String(job.result || "").trim();
}

async function postSlackWorkerResult(job: SlackJobLike = {}) {
  const ref = slackRefForWorkerJob(job);
  const text = slackWorkerResultText(job);
  if (!ref || !text) return null;
  if (!config.slackApiMock) {
    return poster.postMessage({
      channel: ref.channel,
      threadTs: ref.threadTs,
      text,
      dedupKey: `slack-worker-result:${job.id}:${ref.channel}:${ref.threadTs || "root"}`,
    });
  }
  return postSlackMessage({
    channel: ref.channel,
    text,
    thread_ts: ref.threadTs,
  });
}

async function clearSlackAssistantStatusForWorkerJob(job: SlackJobLike = {}) {
  const ref = slackRefForWorkerJob(job);
  if (!ref?.channel || !ref?.threadTs)
    return { ok: true, skipped: true, reason: "missing_slack_ref" };
  return scheduleSlackAssistantThreadStatus({
    channelId: ref.channel,
    threadTs: ref.threadTs,
    status: "",
    immediate: true,
  });
}

async function updateSlackAssistantStatusForWorkerJob(job: SlackJobLike = {}) {
  const ref = slackRefForWorkerJob(job);
  if (!ref?.channel || !ref?.threadTs || job.status !== "running") {
    return { ok: true, skipped: true, reason: "missing_or_terminal_slack_ref" };
  }
  const status = job.latestProgressStatus || assistantStatusTextForJob(job) || "Working on it...";
  return scheduleSlackAssistantThreadStatus({
    channelId: ref.channel,
    threadTs: ref.threadTs,
    status,
    immediate: false,
  });
}

function slackImmediateWorkerAckText(responseBody: SlackWorkerResponseBody = {}) {
  if (responseBody?.job) {
    if (responseBody.job.status === "failed") return "我接到了，但后台处理失败了，正在把错误收口。";
    return "";
  }
  return responseBody?.text || "";
}

function shouldKeepAssistantStatusUntilWorkerDone(responseBody: SlackWorkerResponseBody = {}) {
  return Boolean(responseBody?.job && responseBody.job.status === "running");
}

function formatWorkerJobForSlack(job) {
  const statusLabel = job.status === "completed" ? "completed" : job.status;
  const detail =
    job.status === "completed"
      ? job.result || "(no result)"
      : job.error || job.result || "(no detail)";
  return `Worker ${job.id} ${statusLabel}: ${job.task || "(untitled task)"}\n${detail}`;
}

async function pollMeetingWorkerResults({ limit = 10, markDelivered = true } = {}) {
  const response = await postJson(`${config.meetingAgentUrl}/worker/poll-slack`, {
    limit,
    markDelivered,
  });
  const jobs = response.body?.jobs || [];
  const messages = jobs.map(formatWorkerJobForSlack);
  return {
    ok: response.ok,
    status: response.status,
    jobs,
    messages,
    text: messages.length
      ? messages.join("\n\n")
      : "No completed meeting worker jobs ready for Slack.",
    meetingAgent: response.body,
  };
}

async function postMeetingWorkerResultsToSlack({
  limit = 10,
  channel = "",
  threadTs = "",
  markDelivered = true,
} = {}) {
  const response = await postJson(`${config.meetingAgentUrl}/worker/poll-slack`, {
    limit,
    markDelivered: false,
  });
  const jobs = response.body?.jobs || [];
  const posts = [];
  for (const job of jobs) {
    const text = formatWorkerJobForSlack(job);
    const dedupKey = `worker-result:${job.id}:slack:${channel}:${threadTs}`;
    const post = await poster.postMessage({ channel, threadTs, text, dedupKey });
    posts.push({ jobId: job.id, text, post });
    if (post.ok && markDelivered) {
      await postJson(`${config.meetingAgentUrl}/worker/mark-slack-delivered`, {
        jobId: job.id,
        channel,
        threadTs,
        ts: post.ts,
        dedupKey,
        mock: Boolean(post.mock),
      });
    }
  }

  return {
    ok: response.ok && posts.every((entry) => entry.post.ok),
    status: response.status,
    jobs,
    posts,
    text: posts.length
      ? posts.map((entry) => entry.text).join("\n\n")
      : "No completed meeting worker jobs ready for Slack.",
    meetingAgent: response.body,
    poster: { mock: poster.mock },
  };
}

runner = createAgentRunner({
  onJobUpdate: reportFinishedWorkerJob,
  onJobProgress: updateSlackAssistantStatusForWorkerJob,
} as unknown as Parameters<typeof createAgentRunner>[0]);
const meetingCopilotRunner = createMeetingCopilotRunner({
  agentRunner: runner,
} as Parameters<typeof createMeetingCopilotRunner>[0]);

function summarizeSession(
  session: { id?: string; status?: string; meetUrl?: string } | null | undefined,
): string {
  if (!session) return "no active session";
  return `${session.id} ${session.status} ${session.meetUrl || "(no meet url)"}`;
}

interface CutoverDecisionLike {
  mode?: string;
  reason?: string;
  bucket?: string | number;
  canaryPercent?: number;
  primaryStack?: string;
  shadowStack?: string;
  shouldRunNewStack?: boolean;
  shouldRecordShadow?: boolean;
  [key: string]: unknown;
}

function buildAutoRollbackDecision({
  originalDecision,
  meetingAgent,
}: {
  originalDecision: CutoverDecisionLike;
  meetingAgent: { status?: number; body?: { error?: string; detail?: string; [key: string]: unknown } };
}) {
  return {
    mode: "rollback",
    primaryStack: "old",
    shadowStack: "",
    shouldRunNewStack: false,
    shouldRecordShadow: true,
    bucket: originalDecision.bucket,
    canaryPercent: originalDecision.canaryPercent,
    reason: "auto_rollback_new_stack_failed",
    triggeredBy: {
      mode: originalDecision.mode,
      reason: originalDecision.reason,
      status: meetingAgent.status,
      error: meetingAgent.body?.error || meetingAgent.body?.detail || "",
    },
  };
}

type ParsedAvatarCommand = import("../../../packages/core/src/control-plane/avatar-command.js").AvatarCommandResult;

function shadowCommandPlan(parsed: ParsedAvatarCommand) {
  const common = {
    action: parsed.action,
    accepted: true,
    sideEffects: "suppressed",
  };
  if (parsed.action === "join") {
    return {
      ...common,
      accepted: parsed.validMeetUrl,
      meetUrl: parsed.meetUrl,
      avatar: parsed.avatar,
      botName: parsed.botName || config.botName,
      dryRunJoiner: parsed.dryRunJoiner,
      startJoiner: parsed.startJoiner,
      wouldStartMeetingAgent: parsed.validMeetUrl,
    };
  }
  if (parsed.action === "delegate") {
    return {
      ...common,
      accepted: Boolean(parsed.task),
      sessionId: parsed.sessionId,
      task: parsed.task,
      mode: parsed.requestedMode,
      allowCodeChanges: parsed.allowCodeChanges,
      wouldStartWorker: Boolean(parsed.task),
    };
  }
  if (parsed.action === "status" || parsed.action === "stop" || parsed.action === "jobs") {
    return {
      ...common,
      sessionId: parsed.sessionId,
    };
  }
  return {
    ...common,
    accepted: parsed.action === "help",
  };
}

interface ShadowCommandCheck {
  name: string;
  pass: boolean;
  [key: string]: unknown;
}

function shadowCommandChecks({
  parsed,
  newStack,
}: {
  parsed: ParsedAvatarCommand;
  newStack: ReturnType<typeof shadowCommandPlan>;
}): ShadowCommandCheck[] {
  const checks: ShadowCommandCheck[] = [
    { name: "side_effects_suppressed", pass: newStack.sideEffects === "suppressed" },
  ];
  const stack = newStack as ReturnType<typeof shadowCommandPlan> & {
    wouldStartMeetingAgent?: boolean;
    wouldStartWorker?: boolean;
  };
  if (parsed.action === "join") {
    checks.push(
      {
        name: "join_meet_url_valid",
        pass: Boolean(parsed.validMeetUrl),
        meetUrl: parsed.meetUrl,
      },
      {
        name: "join_would_start_new_stack_when_cutover_allows",
        pass: stack.wouldStartMeetingAgent === parsed.validMeetUrl,
      },
    );
  } else if (parsed.action === "delegate") {
    checks.push(
      { name: "delegate_task_present", pass: Boolean(parsed.task), task: parsed.task },
      {
        name: "delegate_worker_suppressed",
        pass:
          stack.wouldStartWorker === Boolean(parsed.task) &&
          stack.sideEffects === "suppressed",
      },
    );
  } else {
    checks.push({
      name: "command_parsed",
      pass: Boolean(parsed.action),
      action: parsed.action,
    });
  }
  return checks;
}

async function handleShadowSlackCommand({
  req,
  body,
}: {
  req: import("node:http").IncomingMessage;
  body: SlackPayloadLike & SlackHandlerInput;
}) {
  const auth = verifyShadowTapRequest({ secret: config.shadowTapSecret, req });
  if (!auth.ok) {
    return {
      status: auth.status,
      body: { ok: false, error: auth.error },
    };
  }

  const normalized = normalizeShadowSlackCommand(body);
  const parsed = parseAvatarCommand(normalized.text);
  const summary = shadowTapSummary(body);
  const cutoverDecision = cutover.decide({
    command: `shadow_tap:${parsed.action}`,
    workspaceId: normalized.team_id,
    channelId: normalized.channel_id,
    userId: normalized.user_id,
    sessionId: String(
      (body.oldStack as { sessionId?: string; meetingId?: string } | null | undefined)?.sessionId ||
        (body.oldStack as { sessionId?: string; meetingId?: string } | null | undefined)
          ?.meetingId ||
        body.eventId ||
        body.event_id ||
        "",
    ),
  });
  const newStack = shadowCommandPlan(parsed);
  const checks = shadowCommandChecks({ parsed, newStack });
  const ok = checks.every((check) => check.pass);
  const event = await appendShadowTapEvent(config.shadowTapReportPath || config.cutoverReportPath, {
    type: "shadow_slack_command",
    ok,
    summary,
    normalized,
    parsed: {
      action: parsed.action,
      meetUrl: parsed.meetUrl,
      validMeetUrl: parsed.validMeetUrl,
      sessionId: parsed.sessionId,
      avatar: parsed.avatar,
      botName: parsed.botName,
      task: parsed.task,
    },
    cutoverDecision,
    oldStack: body.oldStack || null,
    newStack,
    checks,
  });
  return {
    body: {
      ok,
      mode: "shadow_tap_receiver",
      sideEffects: "suppressed",
      event,
    },
  };
}

interface SlackAvatarCommandBody extends SlackHandlerInput {
  text?: string;
  raw?: string;
  user_id?: string;
  user?: string;
  channel_id?: string;
  channel?: string;
  team_id?: string;
  team?: string;
  command?: string;
  trigger_id?: string;
  response_url?: string;
}

interface SlackVerificationResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  source?: string;
  error?: string;
}

async function handleAvatarCommand({
  req,
  body,
  rawBody,
}: {
  req: import("node:http").IncomingMessage;
  body: SlackAvatarCommandBody;
  rawBody: string;
}) {
  const timestampRaw = req.headers["x-slack-request-timestamp"];
  const signatureRaw = req.headers["x-slack-signature"];
  const verification = verifySlackRequest({
    signingSecret: config.slackSigningSecret,
    timestamp: Array.isArray(timestampRaw) ? timestampRaw[0] || "" : timestampRaw || "",
    signature: Array.isArray(signatureRaw) ? signatureRaw[0] || "" : signatureRaw || "",
    rawBody,
  }) as SlackVerificationResult;
  if (!verification.ok) {
    return {
      status: 401,
      body: slackTextResponse(`Slack request verification failed: ${verification.error}`, {
        ok: false,
      }),
    };
  }

  return executeAvatarCommand({ body, verification });
}

async function executeAvatarCommand({
  body,
  verification = { ok: true, skipped: true, source: "internal" },
}: {
  body: SlackAvatarCommandBody;
  verification?: SlackVerificationResult;
}) {
  const parsed = parseAvatarCommand(body.text || body.raw || "");
  if (parsed.action === "help") {
    rememberSlackCommand({ body, parsed });
    return slackTextResponse(avatarCommandUsage());
  }

  if (parsed.action === "join") {
    if (!parsed.validMeetUrl) {
      return {
        status: 400,
        body: slackTextResponse(
          `Usage error: expected a Google Meet URL.\n\n${avatarCommandUsage()}`,
          { ok: false },
        ),
      };
    }
    const session = sessions.create({
      source: "slack",
      meetUrl: parsed.meetUrl,
      avatar: parsed.avatar,
      requestedBy: body.user_id || body.user || "unknown",
    });
    const { slackContext, domainContext } = rememberSlackCommand({ body, parsed, session });
    const cutoverDecision = cutover.decide({
      command: "join",
      workspaceId: body.team_id || "",
      channelId: body.channel_id || "",
      userId: body.user_id || body.user || "",
      sessionId: session.id,
    });

    if (!cutoverDecision.shouldRunNewStack) {
      const status =
        cutoverDecision.mode === "rollback"
          ? "rollback_old_stack_primary"
          : "shadow_old_stack_primary";
      sessions.update(session.id, { status, cutoverDecision });
      const report = await cutover.record({
        type: "join_shadow_decision",
        session: sessions.get(session.id),
        decision: cutoverDecision,
        oldStack: { primary: true, invokedByOpenSourceRepo: false },
        newStack: { shadow: cutoverDecision.shadowStack === "new", sideEffects: "suppressed" },
      });
      const decisionKind = cutoverDecision.mode === "rollback" ? "rollback" : "shadow";
      return slackTextResponse(
        `Cutover ${cutoverDecision.mode}: old stack remains primary for ${session.meetUrl}; new repo recorded a ${decisionKind} decision only.`,
        {
          extra: {
            session: sessions.get(session.id),
            slackContext,
            domainContext,
            cutoverDecision,
            cutoverReport: report,
            slackVerification: verification,
          },
        },
      );
    }

    const meetingAgent = await postJson(`${config.meetingAgentUrl}/sessions`, {
      source: "slack-agent",
      sessionId: session.id,
      meetUrl: session.meetUrl,
      avatar: session.avatar,
      requestedBy: session.requestedBy,
      botName: parsed.botName || config.botName,
      startJoiner: parsed.startJoiner,
      dryRunJoiner: parsed.dryRunJoiner,
    });
    if (!meetingAgent.ok && config.cutoverAutoRollbackOnFailure) {
      const rollbackDecision = buildAutoRollbackDecision({
        originalDecision: cutoverDecision,
        meetingAgent,
      });
      sessions.update(session.id, {
        status: "auto_rollback_old_stack_primary",
        meetingAgentStatus: meetingAgent.status,
        cutoverDecision,
        rollbackDecision,
      });
      const report = await cutover.record({
        type: "join_auto_rollback_decision",
        session: sessions.get(session.id),
        decision: rollbackDecision,
        originalDecision: cutoverDecision,
        oldStack: { primary: true, invokedByOpenSourceRepo: false },
        newStack: {
          primary: false,
          ok: false,
          status: meetingAgent.status,
          error: meetingAgent.body?.error || "meeting_agent_failed",
        },
      });
      return slackTextResponse(
        `Auto rollback: new stack failed for ${session.meetUrl}; old stack remains primary and the rollback decision was recorded.`,
        {
          extra: {
            session: sessions.get(session.id),
            slackContext,
            domainContext,
            meetingAgent: meetingAgent.body,
            cutoverDecision,
            rollbackDecision,
            cutoverReport: report,
            slackVerification: verification,
          },
        },
      );
    }
    sessions.update(session.id, {
      status: meetingAgent.ok ? "meeting_agent_started" : "meeting_agent_failed",
      meetingAgentStatus: meetingAgent.status,
      cutoverDecision,
    });
    const report = await cutover.record({
      type: "join_primary_decision",
      session: sessions.get(session.id),
      decision: cutoverDecision,
      newStack: { primary: true, ok: meetingAgent.ok, status: meetingAgent.status },
    });
    return slackTextResponse(
      `Session ${session.id} created for ${session.meetUrl} (${parsed.dryRunJoiner ? "dry-run joiner" : "real joiner"}).`,
      {
        extra: {
          session: sessions.get(session.id),
          slackContext,
          domainContext,
          meetingAgent: meetingAgent.body,
          cutoverDecision,
          cutoverReport: report,
          slackVerification: verification,
        },
      },
    );
  }

  if (parsed.action === "status") {
    const session = resolveSession(parsed);
    const { slackContext, domainContext } = rememberSlackCommand({ body, parsed, session });
    const joinStatus = await getJson(`${config.meetingAgentUrl}/join/status`);
    return slackTextResponse(
      `Status: ${summarizeSession(session)}\nWorker jobs: ${runner.listJobs().length}`,
      {
        extra: {
          session,
          slackContext,
          domainContext,
          sessions: sessions.list(),
          joinStatus: joinStatus.body,
          jobs: runner.listJobs(),
          slackVerification: verification,
        },
      },
    );
  }

  if (parsed.action === "stop") {
    const session = resolveSession(parsed);
    const { slackContext, domainContext } = rememberSlackCommand({ body, parsed, session });
    const flags = (parsed.flags as { reason?: string } | undefined) || {};
    const reason = flags.reason || `slack_stop:${body.user_id || body.user || "unknown"}`;
    const stopResult = await postJson(`${config.meetingAgentUrl}/join/stop`, { reason });
    if (session) sessions.update(session.id, { status: "stopped", stoppedReason: reason });
    return slackTextResponse(`Stop requested for ${session?.id || "current meeting joiner"}.`, {
      extra: {
        session: session ? sessions.get(session.id) : null,
        slackContext,
        domainContext,
        stopResult: stopResult.body,
        slackVerification: verification,
      },
    });
  }

  if (parsed.action === "delegate") {
    if (!parsed.task) {
      return {
        status: 400,
        body: slackTextResponse(`Usage error: missing task.\n\n${avatarCommandUsage()}`, {
          ok: false,
        }),
      };
    }
    const session = resolveSession(parsed);
    const { slackContext, domainContext } = rememberSlackCommand({ body, parsed, session });
    const richThreadContext = (body.richThreadContext as { mentionText?: string } | null) || null;
    const memoryQuery = richThreadContext?.mentionText || parsed.task;
    const job = await runner.startTask({
      task: parsed.task,
      context: {
        ...workspaceContext.buildAgentContext({
          body,
          parsed: parsed as unknown as Record<string, unknown>,
          session,
          remembered: slackContext,
        }),
        slackAppMention: richThreadContext,
        localSlackMemory: localSlackMemory.buildAgentContext({
          query: [memoryQuery, slackContext?.channelName, body.user_name].filter(Boolean).join(" "),
          limit: 5,
        }),
      },
      mode: parsed.requestedMode,
      allowCodeChanges: parsed.allowCodeChanges,
    });
    const report = await reportFinishedWorkerJob(job);
    if (session)
      sessions.update(session.id, { status: "worker_delegated", lastWorkerJobId: job.id });
    return slackTextResponse(`Delegated to ${job.provider}: ${job.id} (${job.status}).`, {
      extra: {
        session: session ? sessions.get(session.id) : null,
        slackContext,
        domainContext,
        richThreadContext,
        job,
        meetingReport: report?.body || null,
        slackVerification: verification,
      },
    });
  }

  if (parsed.action === "jobs") {
    const session = resolveSession(parsed);
    const { slackContext, domainContext } = rememberSlackCommand({ body, parsed, session });
    const meetingJobs = await getJson(`${config.meetingAgentUrl}/worker/jobs`);
    const readyForSlack = await pollMeetingWorkerResults({ limit: 10, markDelivered: true });
    return slackTextResponse(
      [
        `Worker jobs: local=${runner.listJobs().length}, meeting=${meetingJobs.body?.jobs?.length || 0}`,
        readyForSlack.messages.length ? readyForSlack.text : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      {
        extra: {
          slackContext,
          domainContext,
          jobs: runner.listJobs(),
          meetingJobs: meetingJobs.body,
          readyForSlack,
          slackVerification: verification,
        },
      },
    );
  }

  return {
    status: 400,
    body: slackTextResponse(`Unknown command: ${parsed.action}\n\n${avatarCommandUsage()}`, {
      ok: false,
    }),
  };
}

function parseSlackInteractionPayload(body: SlackPayloadLike = {}) {
  if (typeof body.payload === "string") {
    try {
      return JSON.parse(body.payload);
    } catch {
      return null;
    }
  }
  return body.payload || body;
}

function stripSlackBotMention(text = "") {
  return String(text || "")
    .replace(/<@[^>]+>\s*/g, "")
    .trim();
}

function eventTextToAvatarCommand(event: SlackEventLike = {}) {
  const text = stripSlackBotMention(event.text || "");
  if (!text) return "";
  const first = text.split(/\s+/, 1)[0]?.toLowerCase() || "";
  if (["join", "status", "stop", "delegate", "jobs", "help"].includes(first)) return text;
  const meetUrl = text.match(
    /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#]\S*)?/i,
  )?.[0];
  if (meetUrl) return `join ${meetUrl}`;
  return `delegate ${text}`;
}

function commandBodyFromSlackEvent(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
  return {
    team_id: payload.team_id || payload.team?.id || "",
    team_domain: payload.team?.domain || "",
    channel_id: event.channel || "",
    channel_name: "",
    user_id: event.user || "",
    user_name: "",
    command: event.channel_type === "im" ? "dm" : "app_mention",
    text: eventTextToAvatarCommand(event),
    response_url: "",
    trigger_id: "",
    event_ts: event.ts || event.event_ts || "",
    thread_ts: event.thread_ts || event.ts || "",
  };
}

function slackBotUserId() {
  return process.env.MAB_SLACK_BOT_USER_ID || process.env.SLACK_BOT_USER_ID || "";
}

interface SlackCommandBodyShape {
  team_id?: string;
  team_domain?: string;
  channel_id?: string;
  channel_name?: string;
  user_id?: string;
  user_name?: string;
  command?: string;
  text?: string;
  response_url?: string;
  trigger_id?: string;
  event_ts?: string;
  thread_ts?: string;
  richThreadContext?: Record<string, unknown> | null;
  [key: string]: unknown;
}

function mentionThreadKey(commandBody: SlackCommandBodyShape = {}): string {
  return [
    commandBody.team_id || "workspace",
    commandBody.channel_id || "channel",
    commandBody.thread_ts || commandBody.event_ts || "thread",
  ].join(":");
}

function threadMessagesFixture(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
  const candidates = [
    payload.thread_messages,
    payload.threadMessages,
    payload.replies,
    payload.thread?.messages,
    payload.thread?.replies,
    event.thread_messages,
    event.threadMessages,
    event.replies,
    event.thread?.messages,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }
  return null;
}

async function fetchSlackMentionThreadMessages(
  event: SlackEventLike = {},
  payload: SlackPayloadLike = {},
  commandBody: SlackCommandBodyShape = {},
) {
  const fixture = threadMessagesFixture(event, payload) as SlackMessageLike[] | null;
  if (fixture) {
    return {
      ok: true,
      source: "fixture",
      messages: fixture.slice(0, MAX_APP_MENTION_THREAD_MESSAGES),
    };
  }

  const channel = commandBody.channel_id || event.channel || "";
  const threadTs = commandBody.thread_ts || event.thread_ts || event.ts || "";
  if (!channel || !threadTs) {
    return { ok: true, source: "event_only", messages: [event] };
  }
  if (config.slackApiMock || !config.slackBotToken) {
    return {
      ok: true,
      source: config.slackApiMock ? "mock_event_only" : "event_only",
      messages: [event],
    };
  }

  const result = await callSlackApi({
    botToken: config.slackBotToken,
    method: "conversations.replies",
    payload: {
      channel,
      ts: threadTs,
      limit: MAX_APP_MENTION_THREAD_MESSAGES,
    },
  });
  if (!result.ok) {
    return {
      ok: false,
      source: "slack_web_api",
      error: result.error,
      detail: result,
      messages: [event],
    };
  }
  return {
    ok: true,
    source: "slack_web_api",
    messages: ((result.body?.messages as SlackMessageLike[] | undefined) || [event]).slice(
      0,
      MAX_APP_MENTION_THREAD_MESSAGES,
    ),
  };
}

function durableMentionContext(commandBody: SlackCommandBodyShape = {}): string {
  if (!slackDomainStore) return "";
  const context = slackDomainStore.context({
    workspaceId: commandBody.team_id || "workspace",
    channelId: commandBody.channel_id || "channel",
    threadTs: commandBody.thread_ts || "channel-root",
    limit: 3,
  }) as {
    threadLedger?: { summary?: string; latestTask?: string; [key: string]: unknown } | null;
    channelBrain?: { summary?: string; last_session_id?: string; [key: string]: unknown } | null;
  };
  const parts: string[] = [];
  if (context.threadLedger?.summary || context.threadLedger?.latestTask) {
    parts.push(`Thread ledger: ${JSON.stringify(context.threadLedger)}`);
  }
  if (context.channelBrain?.summary || context.channelBrain?.last_session_id) {
    parts.push(`Channel brain: ${JSON.stringify(context.channelBrain)}`);
  }
  return parts.join("\n");
}

interface SlackThreadContextOptions {
  richThreadContext?: boolean;
  [key: string]: unknown;
}

async function commandBodyFromSlackEventWithContext(
  event: SlackEventLike = {},
  payload: SlackPayloadLike = {},
  options: SlackThreadContextOptions = {},
): Promise<SlackCommandBodyShape> {
  const commandBody = commandBodyFromSlackEvent(event, payload) as SlackCommandBodyShape;
  if (!options.richThreadContext) return commandBody;

  const thread = (await fetchSlackMentionThreadMessages(event, payload, commandBody)) as {
    ok: boolean;
    source?: string;
    messages: SlackMessageLike[];
    error?: string;
  };
  const richThreadContext = buildSlackAppMentionContext({
    event,
    messages: thread.messages,
    botUserId: slackBotUserId(),
    channelId: commandBody.channel_id,
    threadTs: commandBody.thread_ts,
    userId: commandBody.user_id,
    source: thread.source,
    meetingContext: String(
      payload.meeting_context || payload.meetingContext || event.meeting_context || "",
    ),
    durableContext: durableMentionContext(commandBody),
    threadPermalink: String(
      payload.thread_permalink || payload.threadPermalink || event.thread_permalink || "",
    ),
  }) as Record<string, unknown> & { fetchOk?: boolean; fetchError?: string };
  richThreadContext.fetchOk = thread.ok;
  richThreadContext.fetchError = thread.error || "";
  commandBody.richThreadContext = richThreadContext;

  const currentCommand = commandBody.text || "";
  const rawFirst =
    String((richThreadContext as { rawMentionText?: string }).rawMentionText || "")
      .split(/\s+/, 1)[0]
      ?.toLowerCase() || "";
  const explicitCommand = ["delegate", "join", "status", "stop", "jobs", "help"].includes(rawFirst);
  const delegateTask =
    richThreadContext.mentionText ||
    "Respond to this Slack thread using the attached rich context.";
  if (explicitCommand) {
    return commandBody;
  }
  if (!currentCommand || currentCommand.startsWith("delegate ")) {
    commandBody.text = `delegate ${JSON.stringify(delegateTask)}`;
  }
  return commandBody;
}

async function runMentionWithThreadGuard(commandBody, run) {
  const key = mentionThreadKey(commandBody);
  if (activeSlackMentionThreads.has(key)) {
    return {
      status: 409,
      body: {
        ok: true,
        ignored: true,
        reason: "active_thread_in_progress",
        threadKey: key,
      },
    };
  }
  activeSlackMentionThreads.add(key);
  try {
    return await run();
  } finally {
    activeSlackMentionThreads.delete(key);
  }
}

function slackMentionEventKey(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
  const teamId = payload.team_id || payload.team?.id || "workspace";
  const channelId = event.channel || "channel";
  const eventTs = event.ts || event.event_ts || "ts";
  const userId = event.user || "user";
  const text = String(event.text || "").trim();
  return [teamId, channelId, eventTs, userId, text].join(":");
}

function pruneRecentSlackMentionEvents(now = Date.now()) {
  const ttlMs = 10 * 60 * 1000;
  for (const [key, seenAt] of recentSlackMentionEvents.entries()) {
    if (now - seenAt > ttlMs) recentSlackMentionEvents.delete(key);
  }
}

function claimSlackMentionEvent(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
  const now = Date.now();
  pruneRecentSlackMentionEvents(now);
  const key = slackMentionEventKey(event, payload);
  if (recentSlackMentionEvents.has(key)) {
    return { claimed: false, key };
  }
  recentSlackMentionEvents.set(key, now);
  return { claimed: true, key };
}

function shouldIgnoreSlackMessageEvent(event: SlackEventLike = {}) {
  if (!event.text) return true;
  const isBotMessage = Boolean(event.bot_id || event.subtype === "bot_message");
  if (event.subtype && !(config.slackEventAllowBotMessages && event.subtype === "bot_message"))
    return true;
  if (event.bot_id && !config.slackEventAllowBotMessages) return true;
  if (!event.user && !(config.slackEventAllowBotMessages && isBotMessage)) return true;
  return false;
}

function isBotMentionFallbackMessage(event: SlackEventLike = {}) {
  if (event.bot_id || event.subtype) return false;
  if (event.type !== "message" || event.channel_type === "im") return false;
  const text = String(event.text || "");
  if (!text.includes("<@")) return false;
  const configuredBotUserId =
    process.env.MAB_SLACK_BOT_USER_ID || process.env.SLACK_BOT_USER_ID || "";
  if (!configuredBotUserId) return /<@[^>]+>/.test(text);
  return text.includes(`<@${configuredBotUserId}>`);
}

function assistantThreadRefFromEvent(event: SlackEventLike = {}) {
  type ThreadLike = {
    context?: { channel_id?: string; channelId?: string };
    channel_id?: string;
    channelId?: string;
    thread_ts?: string;
    threadTimeStamp?: string;
    user_id?: string;
    userId?: string;
    [key: string]: unknown;
  };
  const thread: ThreadLike =
    (event.assistant_thread as ThreadLike) ||
    (event.assistantThread as ThreadLike) ||
    (event.thread as ThreadLike) ||
    {};
  const context: { channel_id?: string; channelId?: string } =
    (thread.context as { channel_id?: string; channelId?: string }) ||
    (event.context as { channel_id?: string; channelId?: string }) ||
    {};
  return {
    channelId:
      thread.channel_id ||
      thread.channelId ||
      event.channel_id ||
      event.channel ||
      context.channel_id ||
      context.channelId ||
      "",
    threadTs:
      thread.thread_ts ||
      thread.threadTimeStamp ||
      event.thread_ts ||
      event.threadTimeStamp ||
      event.ts ||
      "",
    userId: thread.user_id || thread.userId || event.user || event.user_id || "",
  };
}

async function callSlackAssistantApi({ method, payload }) {
  if (config.slackApiMock) {
    const call = {
      at: new Date().toISOString(),
      method,
      payload,
      mock: true,
    };
    slackApiMockCalls.push(call);
    return {
      ok: true,
      status: 200,
      method,
      body: { ok: true, mock: true },
      mock: true,
    };
  }
  const result = await callSlackApi({
    botToken: config.slackBotToken,
    method,
    payload,
  });
  slackApiMockCalls.push({
    at: new Date().toISOString(),
    method,
    payload,
    mock: false,
    ok: result.ok,
    status: result.status,
    error: result.error || "",
    slackError: result.body?.error || "",
  });
  return result;
}

async function postSlackMessage(payload: SlackPayloadLike & SlackHandlerInput = {}) {
  if (config.slackApiMock) {
    const call = {
      at: new Date().toISOString(),
      method: "chat.postMessage",
      payload,
      mock: true,
    };
    slackApiMockCalls.push(call);
    return {
      ok: true,
      status: 200,
      method: "chat.postMessage",
      body: { ok: true, mock: true, ts: `mock.${Date.now()}` },
      mock: true,
    };
  }
  return callSlackApi({
    botToken: config.slackBotToken,
    method: "chat.postMessage",
    payload,
  });
}

function assistantStatusKey(channelId, threadTs) {
  return `${channelId || ""}:${threadTs || ""}`;
}

function assistantStatusTextForJob(job: SlackJobLike = {}) {
  const latestProgressStatus = (job as { latestProgressStatus?: string }).latestProgressStatus;
  if (latestProgressStatus) return latestProgressStatus;
  const toolName = String(
    (job as { toolName?: string; tool?: string; latestToolName?: string }).toolName ||
      (job as { tool?: string }).tool ||
      (job as { latestToolName?: string }).latestToolName ||
      "",
  );
  const mapped = (assistantToolStatusLabels as Record<string, string>)[toolName] || "";
  if (mapped) return mapped;
  if (job.status === "running") return "Working on it...";
  return "";
}

async function setSlackAssistantThreadStatus({
  channelId,
  threadTs,
  status,
}: {
  channelId?: string;
  threadTs?: string;
  status?: string;
}) {
  if (!channelId || !threadTs) {
    return { ok: false, skipped: true, reason: "missing_assistant_thread_ref" };
  }
  const result = await callSlackAssistantApi({
    method: "assistant.threads.setStatus",
    payload: {
      channel_id: channelId,
      thread_ts: threadTs,
      status: String(status || ""),
      ...(status ? { loading_messages: [String(status)] } : {}),
    },
  });
  if (!result.ok) {
    console.warn("[slack-agent] assistant status update failed", {
      channelId,
      threadTs,
      error: (result as { error?: string }).error,
      slackError: (result.body as { error?: string } | undefined)?.error,
    });
  }
  return result;
}

async function scheduleSlackAssistantThreadStatus({
  channelId,
  threadTs,
  status,
  immediate = false,
}) {
  if (!channelId || !threadTs) {
    return { ok: false, skipped: true, reason: "missing_assistant_thread_ref" };
  }
  const key = assistantStatusKey(channelId, threadTs);
  const state = assistantStatusByThread.get(key) || {
    lastStatus: null,
    lastCallAt: 0,
    pendingTimer: null,
    pendingStatus: null,
  };
  assistantStatusByThread.set(key, state);

  if (status === state.lastStatus) {
    return { ok: true, skipped: true, reason: "duplicate_assistant_status" };
  }

  if (!status || immediate) {
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
    state.pendingStatus = null;
    const result = await setSlackAssistantThreadStatus({ channelId, threadTs, status });
    if (result.ok !== false) {
      state.lastStatus = status;
      state.lastCallAt = Date.now();
    }
    return result;
  }

  const elapsed = Date.now() - state.lastCallAt;
  if (elapsed >= assistantStatusMinIntervalMs || shouldBypassAssistantStatusThrottle(status)) {
    const result = await setSlackAssistantThreadStatus({ channelId, threadTs, status });
    if (result.ok !== false) {
      state.lastStatus = status;
      state.lastCallAt = Date.now();
    }
    return result;
  }

  if (
    !state.pendingStatus ||
    assistantStatusPriority(status) >= assistantStatusPriority(state.pendingStatus)
  ) {
    state.pendingStatus = status;
  }
  if (!state.pendingTimer) {
    state.pendingTimer = setTimeout(() => {
      const pending = state.pendingStatus;
      state.pendingStatus = null;
      state.pendingTimer = null;
      if (pending && pending !== state.lastStatus) {
        setSlackAssistantThreadStatus({ channelId, threadTs, status: pending })
          .then((result) => {
            if (result.ok !== false) {
              state.lastStatus = pending;
              state.lastCallAt = Date.now();
            }
          })
          .catch((error) => {
            console.warn(
              "[slack-agent] assistant status throttle flush failed",
              String(error?.message || error),
            );
          });
      }
    }, assistantStatusMinIntervalMs - elapsed);
  }
  return { ok: true, queued: true };
}

async function setSlackAssistantSuggestedPrompts({ channelId, threadTs }) {
  if (!channelId || !threadTs) {
    return { ok: false, skipped: true, reason: "missing_assistant_thread_ref" };
  }
  const result = await callSlackAssistantApi({
    method: "assistant.threads.setSuggestedPrompts",
    payload: {
      channel_id: channelId,
      thread_ts: threadTs,
      title: "试试这些：",
      prompts: [
        { title: "今天日程", message: "今天有什么会议和日程安排？" },
        { title: "未读消息", message: "帮我看看有什么重要的未读消息？" },
        { title: "让 Codex 做事", message: "请委托 Codex 帮我查代码或处理任务。" },
      ],
    },
  });
  if (!result.ok) {
    console.warn("[slack-agent] assistant suggested prompts failed", {
      channelId,
      threadTs,
      error: (result as { error?: string }).error,
      slackError: (result.body as { error?: string } | undefined)?.error,
    });
  }
  return result;
}

function getMeetingThreadForPayload(payload: SlackPayloadLike = {}) {
  if (!slackDomainStore || !payload.meetingId) return null;
  return slackDomainStore.getMeetingThreadByRemoteId(String(payload.meetingId));
}

function persistMeetingThreadForPayload(
  payload: SlackPayloadLike = {},
  ref: { channelId?: string; threadTs?: string; [key: string]: unknown } = {},
  post: { ts?: string; [key: string]: unknown } = {},
) {
  if (!slackDomainStore || !payload.meetingId || !ref.channelId) return null;
  return slackDomainStore.insertMeetingThread({
    dedupeKey: `remote:${payload.meetingId}`,
    remoteMeetingId: String(payload.meetingId),
    channelId: String(ref.channelId),
    threadTs: String(ref.threadTs || post.ts || ""),
  });
}

function slackRefForMeetingWebhook(payload: SlackPayloadLike = {}) {
  const meetingThread = getMeetingThreadForPayload(payload);
  return resolveMeetingSlackRef({
    payload: payload as unknown as Parameters<typeof resolveMeetingSlackRef>[0]["payload"],
    meetingThread: meetingThread as Parameters<typeof resolveMeetingSlackRef>[0]["meetingThread"],
  });
}

async function handleMeetingWebhookJoined(payload: SlackPayloadLike = {}) {
  const ref = slackRefForMeetingWebhook(payload);
  if (!ref.channelId) {
    return {
      ok: true,
      skipped: true,
      event: payload.event,
      reason: "missing_slack_ref_no_dm_opener",
      meetingId: payload.meetingId,
    };
  }
  const message = buildMeetingJoinedPost(payload);
  const post = await poster.postMessage({
    channel: ref.channelId,
    threadTs: ref.threadTs,
    text: message.text,
    blocks: message.blocks,
    dedupKey: `meeting:${payload.meetingId}:joined:${ref.channelId}:${ref.threadTs || "root"}`,
  });
  const status = await scheduleSlackAssistantThreadStatus({
    channelId: ref.channelId,
    threadTs: ref.threadTs || post.ts || "",
    status: meetingRecordingStatus(),
    immediate: true,
  });
  const persisted = persistMeetingThreadForPayload(payload, ref, post);
  return {
    ok: post.ok !== false,
    event: payload.event,
    meetingId: payload.meetingId,
    slackRef: ref,
    post,
    assistantStatus: status,
    meetingThread: persisted,
  };
}

async function handleMeetingWebhookProcessing(payload: SlackPayloadLike = {}) {
  const ref = slackRefForMeetingWebhook(payload);
  if (!ref.channelId) {
    return {
      ok: true,
      skipped: true,
      event: payload.event,
      reason: "missing_slack_ref",
      meetingId: payload.meetingId,
    };
  }
  const status = await scheduleSlackAssistantThreadStatus({
    channelId: ref.channelId,
    threadTs: ref.threadTs,
    status: meetingProcessingStatus(),
    immediate: true,
  });
  return {
    ok: status.ok !== false,
    event: payload.event,
    meetingId: payload.meetingId,
    slackRef: ref,
    assistantStatus: status,
  };
}

function reserveMeetingWebhookResult(payload: SlackPayloadLike = {}) {
  if (!payload.meetingId) return { reserved: false, reason: "missing_meeting_id" };
  if (!slackDomainStore) return { reserved: true, inMemory: true };
  const cleanup = slackDomainStore.cleanupStalePendingMeetingResultDeliveries(
    MEETING_RESULT_DELIVERY_RESERVATION_TTL_MS,
  );
  const reservation = slackDomainStore.reserveMeetingResultDelivery(String(payload.meetingId || ''));
  return { ...reservation, cleanup };
}

async function handleMeetingWebhookResult(payload: SlackPayloadLike = {}) {
  const reservation = reserveMeetingWebhookResult(payload);
  if (!reservation.reserved) {
    const r = reservation as { reason?: string; delivery?: unknown; cleanup?: unknown };
    return {
      ok: true,
      skipped: true,
      duplicate: true,
      event: payload.event,
      reason: r.reason || "delivery_already_reserved",
      meetingId: payload.meetingId,
      delivery: r.delivery || null,
      cleanup: r.cleanup || null,
    };
  }

  const copilotStop = meetingCopilotRunner.stop(payload.meetingId, "meeting_result");
  const ref = slackRefForMeetingWebhook(payload);
  let post = null;
  let published = null;
  try {
    if (payload.status === "failed") {
      if (ref.channelId) {
        const message = buildMeetingFailurePost(payload);
        post = await poster.postMessage({
          channel: ref.channelId,
          threadTs: ref.threadTs,
          text: message.text,
          dedupKey: `meeting:${payload.meetingId}:failed:${ref.channelId}:${ref.threadTs || "root"}`,
        });
      }
      if (slackDomainStore) slackDomainStore.confirmMeetingResultDelivery(String(payload.meetingId || ''));
      return {
        ok: post ? post.ok !== false : true,
        event: payload.event,
        meetingId: payload.meetingId,
        status: "failed",
        slackRef: ref,
        post,
        copilotStop,
        delivery: slackDomainStore?.getMeetingResultDelivery(String(payload.meetingId || '')) || null,
      };
    }

    if (!payload.summary) {
      if (slackDomainStore) slackDomainStore.failMeetingResultDelivery(String(payload.meetingId || ''));
      return {
        ok: false,
        event: payload.event,
        meetingId: payload.meetingId,
        error: "summary_required",
        copilotStop,
        delivery: slackDomainStore?.getMeetingResultDelivery(String(payload.meetingId || '')) || null,
      };
    }

    const payloadAsResult = payload as unknown as Parameters<typeof buildMeetingResultPost>[0];
    const message = buildMeetingResultPost(payloadAsResult);
    if (ref.channelId) {
      published = await canvasPublisher.publish({
        artifact: buildMeetingCanvasArtifact(payloadAsResult) as unknown as Parameters<typeof canvasPublisher.publish>[0]["artifact"],
        artifactId: `meeting-${payload.meetingId}`,
        title: message.summary.title || String(payload.title || ""),
        summaryMarkdown: message.text,
        channel: ref.channelId,
        threadTs: ref.threadTs,
        destination: "meeting-webhook",
        dedupKey: `meeting:${payload.meetingId}:summary:${ref.channelId}:${ref.threadTs || "root"}`,
      });
      post = published.slack || null;
    }
    if (slackDomainStore) slackDomainStore.confirmMeetingResultDelivery(String(payload.meetingId));
    await scheduleSlackAssistantThreadStatus({
      channelId: ref.channelId,
      threadTs: ref.threadTs,
      status: "",
      immediate: true,
    });
    return {
      ok: post ? post.ok !== false : true,
      event: payload.event,
      meetingId: payload.meetingId,
      status: payload.status || "done",
      slackRef: ref,
      post,
      published,
      copilotStop,
      delivery: slackDomainStore?.getMeetingResultDelivery(String(payload.meetingId || '')) || null,
    };
  } catch (error) {
    if (slackDomainStore) slackDomainStore.failMeetingResultDelivery(String(payload.meetingId || ''));
    return {
      ok: false,
      event: payload.event,
      meetingId: payload.meetingId,
      error: "meeting_result_delivery_failed",
      detail: String((error as { message?: string })?.message || error),
      post,
      published,
      copilotStop,
      delivery: slackDomainStore?.getMeetingResultDelivery(String(payload.meetingId || '')) || null,
    };
  }
}

async function handleMeetingWebhookPayload(
  rawPayload: Record<string, unknown> = {},
) {
  const payload = normalizeMeetingWebhookPayload(
    rawPayload as Parameters<typeof normalizeMeetingWebhookPayload>[0],
  );
  if (!payload.event) return { ok: false, error: "missing_webhook_event" };
  const payloadAsSlack = payload as unknown as SlackPayloadLike;
  if (payload.event === "meeting.joined") return await handleMeetingWebhookJoined(payloadAsSlack);
  if (payload.event === "meeting.processing")
    return await handleMeetingWebhookProcessing(payloadAsSlack);
  if (payload.event === "meeting.result") return await handleMeetingWebhookResult(payloadAsSlack);
  if (payload.event === "meeting.digest") {
    return await meetingCopilotRunner.enqueue(
      payload as unknown as Parameters<typeof meetingCopilotRunner.enqueue>[0],
    );
  }
  return { ok: true, skipped: true, event: payload.event, reason: "unknown_meeting_webhook_event" };
}

function compactSlackMessageEvent(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
  return {
    teamId: payload.team_id || payload.team?.id || "",
    channelId: event.channel || "",
    channelType: event.channel_type || "",
    userId: event.user || event.bot_id || "",
    text: String(event.text || "").trim(),
    ts: event.ts || event.event_ts || "",
    threadTs: event.thread_ts || "",
  };
}

function renderSlackActivityDigest(channelId, messages = []) {
  const lines = ["=== Slack Activity ===", "", `#${channelId}`];
  for (const msg of messages) {
    const thread = msg.threadTs ? ` thread=${msg.threadTs}` : "";
    lines.push(`- ${msg.ts || new Date().toISOString()} <@${msg.userId}>${thread}: ${msg.text}`);
  }
  return `${lines.join("\n")}\n`;
}

function updateBufferChannelStats(channelId, count) {
  slackInbound.eventBuffer.channels[channelId] = {
    pending: count,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function scheduleSlackSocketReconnect(delayMs = 1500) {
  if (slackSocketReconnectTimer) return;
  slackSocketReconnectTimer = setTimeout(() => {
    slackSocketReconnectTimer = null;
    startSlackSocketMode().catch((error) => {
      slackInbound.socketMode.lastError = String(error?.message || error);
      scheduleSlackSocketReconnect(delayMs);
    });
  }, delayMs);
  slackSocketReconnectTimer.unref?.();
}

function isTerminalJob(job) {
  return ["completed", "failed", "timeout"].includes(job?.status);
}

function lastMessageThreadTs(messages = []) {
  const latest = messages[messages.length - 1] || {};
  return latest.threadTs || latest.ts || "";
}

function triageActionRows(actions = []) {
  return actions.map((action) => ({
    tool: action.type,
    channel: action.channelId,
    brief: action.title,
  }));
}

interface SlackTriageActionInput {
  action?: {
    type?: string;
    channelId?: string;
    threadTs?: string;
    title?: string;
    brief?: string;
    workspaceId?: string;
    [key: string]: unknown;
  };
  pendingAction?: { id?: number | string; [key: string]: unknown };
  runId?: number | string;
}

async function postSlackTriageActionCard({
  action,
  pendingAction,
  runId,
}: SlackTriageActionInput = {}) {
  if (!config.slackTriagePostActions || !pendingAction?.id || !action?.channelId) {
    return { ok: false, skipped: true, reason: "triage_action_post_disabled_or_missing_channel" };
  }
  const text = buildSlackTriageActionText({ action, pendingAction });
  const blocks = buildSlackTriageActionBlocks({ action, pendingAction });
  const post = await poster.postMessage({
    channel: action.channelId,
    threadTs: action.threadTs,
    text,
    blocks,
    dedupKey: `slack-triage-action:${runId}:${pendingAction.id}`,
  });
  if (post.ok && slackDomainStore) {
    slackDomainStore.setPendingActionCardTs(pendingAction.id, post.ts || "");
    slackDomainStore.recordThreadLedgerAction({
      workspaceId: action.workspaceId || "workspace",
      channelId: action.channelId,
      threadTs: action.threadTs,
      actionType: action.type,
      actionStatus: "pending",
    });
    slackDomainStore.recordThreadLedgerOutbound({
      workspaceId: action.workspaceId || "workspace",
      channelId: action.channelId,
      threadTs: action.threadTs,
      summary: `Triage suggested ${action.type}: ${action.title}`,
    });
  }
  return post;
}

async function finalizeSlackTriageJob(job: SlackJobLike) {
  if (!job?.id) return null;
  if (finalizedTriageJobs.has(job.id)) return triageJobResults.get(job.id) || null;
  finalizedTriageJobs.add(job.id);
  if (!slackDomainStore) return null;

  const context = (job.context || {}) as {
    channelId?: string;
    messages?: unknown[];
    threadTs?: string;
    triageRunId?: number | string;
    sessionId?: string;
    digest?: string;
    [key: string]: unknown;
  };
  const channelId = String(context.channelId || "");
  const messages = (Array.isArray(context.messages) ? context.messages : []) as Array<{
    teamId?: string;
    [key: string]: unknown;
  }>;
  const threadTs = String(context.threadTs || lastMessageThreadTs(messages) || "");
  const fallback = config.slackTriageHeuristicFallback
    ? suggestSlackTriageFallback({
        channelId,
        messages: messages as unknown as Parameters<typeof suggestSlackTriageFallback>[0]["messages"],
      })
    : { summary: `Slack triage finished for ${channelId}.`, actions: [] };
  const decision = parseSlackTriageDecision(String(job.result || job.error || ""), {
    ...fallback,
    channelId,
    threadTs,
  });
  const ok = job.status === "completed";
  const actions = ok ? decision.actions : [];
  const runId = Number.parseInt(String(context.triageRunId ?? "0"), 10);
  const runPatch = {
    id: runId,
    sessionId: context.sessionId || job.id,
    status: ok ? "success" : "failed",
    summary: ok ? decision.summary : `Triage failed: ${job.error || job.result || job.status}`,
    error: ok ? "" : String(job.error || job.result || job.status || "triage_failed"),
    digest: context.digest || "",
    channels: channelId ? [channelId] : [],
    steps: 1,
    mutations: actions.length,
    failures: ok ? 0 : 1,
    rawOutput: job.result || job.error || "",
  };
  const updatedRun = runId
    ? slackDomainStore.updateTriageRun({
        run: runPatch,
        actions: triageActionRows(actions),
        toolCalls: [
          {
            tool: "agent_runner",
            action: "slack_triage",
            args: { provider: job.provider, jobId: job.id, parseOk: decision.parseOk },
            success: ok,
            brief: ok ? "AgentRunner triage completed" : "AgentRunner triage failed",
            result: job.result || job.error || "",
          },
        ],
      })
    : slackDomainStore.recordTriageRun({
        run: runPatch,
        actions: triageActionRows(actions),
        toolCalls: [],
      });

  const contextWorkspaceId = String((context as { workspaceId?: string }).workspaceId || "workspace");
  if (ok && decision.summary) {
    slackDomainStore.upsertChannelBrainSummary({
      workspaceId: contextWorkspaceId,
      channelId,
      summary: decision.summary,
    });
  }

  const pendingActions = [];
  for (const action of actions.filter((entry) => entry.requiresConfirmation)) {
    const pendingAction = slackDomainStore.insertPendingAction({
      channelId: action.channelId || channelId,
      threadTs: action.threadTs || threadTs,
      actionType: action.type,
      params: {
        source: "slack-triage",
        runId: updatedRun?.id || runId,
        jobId: job.id,
        title: action.title,
        message: action.message,
        reason: action.reason,
        confidence: action.confidence,
      },
    });
    const post = await postSlackTriageActionCard({
      action: {
        ...action,
        workspaceId: contextWorkspaceId,
        channelId: action.channelId || channelId,
        threadTs: action.threadTs || threadTs,
      },
      pendingAction,
      runId: updatedRun?.id || runId,
    });
    pendingActions.push({ action, pendingAction, post });
  }

  const finalization = { run: updatedRun, decision, pendingActions };
  persistSlackTriageProjection(updatedRun, {
    actions: triageActionRows(actions),
    toolCalls: [
      {
        tool: "agent_runner",
        action: "slack_triage",
        args: { provider: job.provider, jobId: job.id, parseOk: decision.parseOk },
        success: ok,
        brief: ok ? "AgentRunner triage completed" : "AgentRunner triage failed",
      },
    ],
  });
  triageJobResults.set(job.id, finalization);
  return finalization;
}

interface StartSlackTriageArgs {
  channelId?: string;
  messages?: Array<{ teamId?: string; [key: string]: unknown }>;
  digest?: string;
}

async function startSlackTriage({
  channelId,
  messages = [],
  digest = "",
}: StartSlackTriageArgs = {}) {
  const workspaceId = messages[0]?.teamId || "workspace";
  const threadTs = lastMessageThreadTs(messages);
  const triageSessionId = `triage:${channelId}:${Date.now()}`;
  const localMemoryContext = localSlackMemory.buildAgentContext({ query: digest, limit: 5 });
  const domainContext =
    slackDomainStore?.context({
      workspaceId,
      channelId,
      threadTs: threadTs || "channel-root",
      limit: 8,
    }) || null;
  const previousTriageContext = buildPreviousTriagePromptContext({
    workspaceId,
    channelId,
    limit: 20,
  });
  const run =
    slackDomainStore?.recordTriageRun({
      run: {
        sessionId: triageSessionId,
        status: "pending",
        summary: `Triage pending for ${messages.length} Slack message(s) in ${channelId}`,
        digest,
        channels: [channelId],
        steps: 0,
      },
      actions: [],
      toolCalls: [],
    }) || null;
  const prompt = buildSlackTriagePrompt({
    channelId,
    messages: messages as unknown as Parameters<typeof buildSlackTriagePrompt>[0]["messages"],
    digest,
    channelBrain: (domainContext as { channelBrain?: unknown } | null)?.channelBrain,
    localMemory: localMemoryContext,
    previousTriage: previousTriageContext,
  });
  const job = await runner.startTask({
    task: prompt,
    context: {
      source: "slack-triage",
      sessionId: triageSessionId,
      channelId,
      workspaceId,
      threadTs: threadTs || "channel-root",
      messageCount: messages.length,
      messages,
      digest,
      triageRunId: run?.id || 0,
      localSlackMemory: localMemoryContext,
      domainContext,
      previousTriage: previousTriageContext,
      expectedOutput: "JSON triage decision with summary and actions[]",
    },
    mode: "analysis",
    allowCodeChanges: false,
  });
  slackInbound.eventBuffer.lastTriageJobId = job.id;
  const finalization = isTerminalJob(job) ? await finalizeSlackTriageJob(job) : null;
  return { run, job, finalization };
}

function buildPreviousTriagePromptContext({
  workspaceId = "workspace",
  channelId = "",
  limit = 20,
} = {}) {
  const storeRows = slackDomainStore?.listTriageContexts?.(limit) || [];
  const projectedRows = loadTriageContextProjection(slackWorkspaceDir);
  const contexts = [...storeRows, ...projectedRows]
    .map(normalizeTriageContext)
    .filter(
      (context) =>
        !channelId || context.channels.length === 0 || context.channels.includes(channelId),
    )
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);
  const text = formatTriageContexts(contexts);
  return {
    workspaceId,
    channelId,
    count: contexts.length,
    text,
  };
}

function persistSlackTriageProjection(run, { actions = [], toolCalls = [] } = {}) {
  if (!run) return null;
  return persistTriageContextProjection({
    workspaceDir: slackWorkspaceDir,
    context: {
      ...run,
      actions,
      tool_calls: toolCalls,
    },
  });
}

async function flushSlackMessageBuffer(channelId) {
  const buffer = slackMessageBuffers.get(channelId);
  if (!buffer || !buffer.messages.length) return null;
  if (buffer.timer) clearTimeout(buffer.timer);
  slackMessageBuffers.delete(channelId);
  updateBufferChannelStats(channelId, 0);

  const messages = [...buffer.messages].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const digest = renderSlackActivityDigest(channelId, messages);
  slackInbound.eventBuffer.flushes += 1;
  slackInbound.eventBuffer.lastFlushAt = new Date().toISOString();
  slackInbound.eventBuffer.lastFlushChannel = channelId;
  slackInbound.eventBuffer.lastFlushCount = messages.length;

  const syntheticBody = {
    team_id: messages[0]?.teamId || "",
    channel_id: channelId,
    channel_name: channelId,
    user_id: "slack-event-buffer",
    user_name: "slack-event-buffer",
    command: "socket_message_buffer",
    text: digest,
  };
  const syntheticParsed = { action: "slack_activity", task: digest };
  workspaceContext.rememberCommand({
    body: syntheticBody,
    parsed: syntheticParsed,
  });
  slackDomainStore?.recordSlackCommand({
    body: {
      ...syntheticBody,
    },
    parsed: syntheticParsed,
    responseSummary: `Buffered Slack digest with ${messages.length} message(s).`,
  });

  let triage = null;
  if (config.slackEventTriage) {
    triage = await startSlackTriage({ channelId, messages, digest });
  } else {
    slackDomainStore?.recordTriageRun({
      run: {
        sessionId: `buffer:${channelId}:${slackInbound.eventBuffer.flushes}`,
        status: "recorded",
        summary: `Buffered ${messages.length} Slack message(s) for ${channelId}`,
        digest,
        channels: [channelId],
        steps: 0,
      },
      actions: [],
      toolCalls: [],
    });
  }
  return { channelId, messages, digest, triage };
}

function bufferSlackMessageEvent(event: SlackEventLike = {}, payload: SlackPayloadLike = {}) {
  if (!config.slackEventBuffer || shouldIgnoreSlackMessageEvent(event)) {
    return { buffered: false, ignored: true };
  }
  const msg = compactSlackMessageEvent(event, payload);
  if (!msg.channelId || !msg.text) return { buffered: false, ignored: true };
  slackDomainStore?.recordSlackMessageEvent(event, payload);

  let buffer = slackMessageBuffers.get(msg.channelId);
  if (!buffer) {
    buffer = { messages: [], timer: null };
    slackMessageBuffers.set(msg.channelId, buffer);
  }
  buffer.messages.push(msg);
  slackInbound.eventBuffer.bufferedMessages += 1;
  slackInbound.eventBuffer.lastBufferedAt = new Date().toISOString();
  updateBufferChannelStats(msg.channelId, buffer.messages.length);

  if (buffer.timer) clearTimeout(buffer.timer);
  if (buffer.messages.length >= config.slackEventMaxBatch) {
    flushSlackMessageBuffer(msg.channelId).catch((error) => {
      slackInbound.eventBuffer.lastError = String(error?.message || error);
    });
  } else {
    buffer.timer = setTimeout(() => {
      flushSlackMessageBuffer(msg.channelId).catch((error) => {
        slackInbound.eventBuffer.lastError = String(error?.message || error);
      });
    }, config.slackEventDebounceMs);
    buffer.timer.unref?.();
  }

  return { buffered: true, channelId: msg.channelId, pending: buffer.messages.length };
}

interface SlackInteractionAction {
  value?: string;
  selected_option?: { value?: string };
  [key: string]: unknown;
}

interface SlackInteractionPayload {
  actions?: SlackInteractionAction[];
  team?: { id?: string; domain?: string };
  team_id?: string;
  channel?: { id?: string; name?: string };
  channel_id?: string;
  user?: { id?: string; username?: string; name?: string };
  user_id?: string;
  response_url?: string;
  trigger_id?: string;
  message?: { thread_ts?: string; ts?: string };
  [key: string]: unknown;
}

function commandBodyFromInteraction(payload: SlackInteractionPayload = {}) {
  const action: SlackInteractionAction = payload.actions?.[0] || {};
  let value: string = String(action.value || action.selected_option?.value || "");
  if (value && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as {
        commandText?: string;
        command?: string;
        text?: string;
      };
      value = parsed.commandText || parsed.command || parsed.text || value;
    } catch {
      // Keep the original value when it is not JSON.
    }
  }
  return {
    team_id: payload.team?.id || payload.team_id || "",
    team_domain: payload.team?.domain || "",
    channel_id: payload.channel?.id || payload.channel_id || "",
    channel_name: payload.channel?.name || "",
    user_id: payload.user?.id || payload.user_id || "",
    user_name: payload.user?.username || payload.user?.name || "",
    command: "interactive",
    text: String(value || "").trim(),
    response_url: payload.response_url || "",
    trigger_id: payload.trigger_id || "",
    thread_ts: payload.message?.thread_ts || payload.message?.ts || "",
  };
}

async function handlePendingActionInteraction(payload: SlackInteractionPayload = {}) {
  const pending = parsePendingActionInteraction(payload);
  if (!pending?.id || !slackDomainStore) return null;
  const existing = slackDomainStore.getPendingAction(pending.id);
  if (!existing) {
    return slackTextResponse(`Pending action ${pending.id} was not found.`, { ok: false });
  }
  const result = {
    source: "slack_interaction",
    actionId: pending.actionId,
    userId: pending.userId,
    assigneeUserId: pending.assigneeUserId,
    snoozeMinutes: pending.snoozeMinutes,
    channelId: pending.channelId,
    threadTs: pending.threadTs,
    at: new Date().toISOString(),
  };
  const updated = slackDomainStore.setPendingActionStatus(
    pending.id,
    String(pending.status || ""),
    String(pending.userId || ""),
    JSON.stringify({ ...result }),
  );
  const existingRow = existing as {
    channel_id?: string;
    thread_ts?: string;
    action_type?: string;
  };
  slackDomainStore.recordThreadLedgerAction({
    channelId: existingRow.channel_id,
    threadTs: existingRow.thread_ts,
    actionType: existingRow.action_type,
    actionStatus: String(pending.status || ""),
  });
  const suffix =
    pending.status === "assigned" && pending.assigneeUserId
      ? ` to <@${pending.assigneeUserId}>`
      : "";
  return slackTextResponse(`Pending action ${pending.id} ${pending.status}${suffix}.`, {
    ok: true,
    extra: {
      pendingAction: updated,
      interaction: result,
    },
  });
}

async function handleSlackEventsApi({ req, body, rawBody, verificationOverride = null }) {
  const verification =
    verificationOverride ||
    verifySlackRequest({
      signingSecret: config.slackSigningSecret,
      timestamp: req.headers["x-slack-request-timestamp"] || "",
      signature: req.headers["x-slack-signature"] || "",
      rawBody,
    });
  if (!verification.ok) {
    return { status: 401, body: { ok: false, error: verification.error } };
  }

  if (body.type === "url_verification" && body.challenge) {
    return { body: { challenge: body.challenge } };
  }

  if (body.type !== "event_callback") {
    return { body: { ok: true, ignored: true, type: body.type || "" } };
  }

  const event = body.event || {};
  if (event.type === "assistant_thread_started") {
    const ref = assistantThreadRefFromEvent(event);
    const prompts = await setSlackAssistantSuggestedPrompts(ref);
    return {
      body: {
        ok: prompts.ok !== false,
        handled: true,
        mode: "assistant_thread_started",
        assistantThread: ref,
        suggestedPrompts: {
          ok: prompts.ok,
          error:
            (prompts as { error?: string }).error ||
            (prompts as { body?: { error?: string } }).body?.error ||
            "",
        },
      },
    };
  }
  if (event.type === "assistant_thread_context_changed") {
    return {
      body: {
        ok: true,
        handled: true,
        mode: "assistant_thread_context_changed",
        assistantThread: assistantThreadRefFromEvent(event),
      },
    };
  }
  const allowedBotMessageForBuffer =
    config.slackEventAllowBotMessages &&
    event.type === "message" &&
    event.channel_type !== "im" &&
    Boolean(event.bot_id || event.subtype === "bot_message");
  if ((event.bot_id || event.subtype) && !allowedBotMessageForBuffer) {
    return { body: { ok: true, ignored: true, reason: "bot_or_subtype" } };
  }
  if (isBotMentionFallbackMessage(event)) {
    const mentionClaim = claimSlackMentionEvent(event, body);
    if (!mentionClaim.claimed) {
      return {
        body: {
          ok: true,
          ignored: true,
          reason: "duplicate_mention_event",
          eventKey: mentionClaim.key,
        },
      };
    }
    const commandBody = await commandBodyFromSlackEventWithContext(event, body, {
      richThreadContext: true,
    });
    if (!commandBody.text) {
      return { body: { ok: true, ignored: true, reason: "empty_mention_fallback_text" } };
    }
    let keepAssistantStatusForWorker = false;
    await scheduleSlackAssistantThreadStatus({
      channelId: commandBody.channel_id,
      threadTs: commandBody.thread_ts,
      status: "Thinking...",
      immediate: true,
    });
    try {
      const result = await runMentionWithThreadGuard(commandBody, async () =>
        executeAvatarCommand({
          body: commandBody,
          verification: { ...verification, source: "events_api_message_mention" },
        }),
      );
      if (result.body?.ignored) {
        return { status: result.status || 200, body: result.body };
      }
      const responseBody = result.body || result;
      keepAssistantStatusForWorker = shouldKeepAssistantStatusUntilWorkerDone(responseBody);
      const responseText = slackImmediateWorkerAckText(responseBody);
      if (commandBody.channel_id && responseText) {
        await poster.postMessage({
          channel: commandBody.channel_id,
          threadTs: commandBody.thread_ts,
          text: responseText,
          dedupKey: `events-api-message-mention:${body.event_id || commandBody.event_ts}:${commandBody.channel_id}`,
        });
      }
      return {
        status: result.status || 200,
        body: {
          ok: responseBody?.ok !== false,
          handled: true,
          mode: "message_mention",
          response: responseBody,
        },
      };
    } finally {
      if (!keepAssistantStatusForWorker) {
        await scheduleSlackAssistantThreadStatus({
          channelId: commandBody.channel_id,
          threadTs: commandBody.thread_ts,
          status: "",
          immediate: true,
        });
      }
    }
  }
  if (event.type === "message" && event.channel_type !== "im") {
    const buffered = bufferSlackMessageEvent(event, body);
    return { body: { ok: true, handled: buffered.buffered, mode: "event_buffer", ...buffered } };
  }
  if (event.type !== "app_mention" && !(event.type === "message" && event.channel_type === "im")) {
    return { body: { ok: true, ignored: true, eventType: event.type || "" } };
  }
  if (event.type === "app_mention") {
    const mentionClaim = claimSlackMentionEvent(event, body);
    if (!mentionClaim.claimed) {
      return {
        body: {
          ok: true,
          ignored: true,
          reason: "duplicate_mention_event",
          eventKey: mentionClaim.key,
        },
      };
    }
  }

  const commandBody = await commandBodyFromSlackEventWithContext(event, body, {
    richThreadContext: event.type === "app_mention",
  });
  if (!commandBody.text) {
    return { body: { ok: true, ignored: true, reason: "empty_event_text" } };
  }
  const shouldShowAssistantStatus =
    event.type === "app_mention" || (event.type === "message" && event.channel_type === "im");
  if (shouldShowAssistantStatus) {
    await scheduleSlackAssistantThreadStatus({
      channelId: commandBody.channel_id,
      threadTs: commandBody.thread_ts,
      status: "Thinking...",
      immediate: true,
    });
  }
  let keepAssistantStatusForWorker = false;
  try {
    const runCommand = () =>
      executeAvatarCommand({
        body: commandBody,
        verification: { ...verification, source: "events_api" },
      });
    const result =
      event.type === "app_mention"
        ? await runMentionWithThreadGuard(commandBody, runCommand)
        : await runCommand();
    if (result.body?.ignored) {
      return { status: result.status || 200, body: result.body };
    }
    const responseBody = result.body || result;
    keepAssistantStatusForWorker = shouldKeepAssistantStatusUntilWorkerDone(responseBody);
    const responseText = slackImmediateWorkerAckText(responseBody);
    if (commandBody.channel_id && responseText) {
      await poster.postMessage({
        channel: commandBody.channel_id,
        threadTs: commandBody.thread_ts,
        text: responseText,
        dedupKey: `events-api:${body.event_id || commandBody.event_ts}:${commandBody.channel_id}`,
      });
    }
    return {
      status: result.status || 200,
      body: {
        ok: responseBody?.ok !== false,
        handled: true,
        mode:
          event.type === "message" && event.channel_type === "im" ? "dm_command" : "app_mention",
        response: responseBody,
      },
    };
  } finally {
    if (shouldShowAssistantStatus && !keepAssistantStatusForWorker) {
      await scheduleSlackAssistantThreadStatus({
        channelId: commandBody.channel_id,
        threadTs: commandBody.thread_ts,
        status: "",
        immediate: true,
      });
    }
  }
}

async function handleSlackInteraction({ req, body, rawBody }) {
  const verification = verifySlackRequest({
    signingSecret: config.slackSigningSecret,
    timestamp: req.headers["x-slack-request-timestamp"] || "",
    signature: req.headers["x-slack-signature"] || "",
    rawBody,
  });
  if (!verification.ok) {
    return {
      status: 401,
      body: slackTextResponse(`Slack request verification failed: ${verification.error}`, {
        ok: false,
      }),
    };
  }
  const payload = parseSlackInteractionPayload(body);
  if (!payload) {
    return {
      status: 400,
      body: slackTextResponse("Invalid Slack interaction payload.", { ok: false }),
    };
  }
  const pendingActionResponse = await handlePendingActionInteraction(payload);
  if (pendingActionResponse) {
    return { status: pendingActionResponse.ok === false ? 404 : 200, body: pendingActionResponse };
  }
  const commandBody = commandBodyFromInteraction(payload);
  if (!commandBody.text) {
    return slackTextResponse(
      "Action received. This interactive control has no meeting-avatar command attached yet.",
    );
  }
  return executeAvatarCommand({
    body: commandBody,
    verification: { ...verification, source: "interaction" },
  });
}

async function slackApiWithToken(token, method, payload = {}) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

interface SocketAck {
  envelope_id: string;
  payload?: unknown;
}

function sendSocketAck(ws: WebSocket, envelopeId: string, payload: unknown = undefined): void {
  if (!envelopeId || ws.readyState !== WebSocket.OPEN) return;
  const ack: SocketAck = { envelope_id: envelopeId };
  if (payload !== undefined) ack.payload = payload;
  ws.send(JSON.stringify(ack));
}

interface SocketEnvelopeMessage {
  type?: string;
  envelope_id?: string;
  payload?: SlackPayloadLike & SlackHandlerInput;
  [key: string]: unknown;
}

async function handleSocketEnvelope(ws: WebSocket, message: SocketEnvelopeMessage) {
  slackInbound.socketMode.lastEventAt = new Date().toISOString();
  slackInbound.socketMode.eventsHandled += 1;
  if (message.type === "hello") return;
  if (!message.envelope_id) return;

  if (message.type === "slash_commands") {
    slackInbound.socketMode.slashCommandsHandled += 1;
    const result = await executeAvatarCommand({
      body: (message.payload as SlackAvatarCommandBody) || {},
      verification: { ok: true, skipped: true, source: "socket_mode" },
    });
    const resultRecord = result as { body?: unknown };
    sendSocketAck(ws, message.envelope_id, resultRecord.body ?? result);
    return;
  }

  if (message.type === "interactive") {
    slackInbound.socketMode.interactionsHandled += 1;
    const payload = (message.payload as SlackInteractionPayload) || {};
    const pendingActionResponse = await handlePendingActionInteraction(payload);
    if (pendingActionResponse) {
      sendSocketAck(ws, message.envelope_id, pendingActionResponse);
      return;
    }
    const commandBody = commandBodyFromInteraction(payload);
    if (!commandBody.text) {
      sendSocketAck(ws, message.envelope_id, slackTextResponse("Action received."));
      return;
    }
    const result = await executeAvatarCommand({
      body: commandBody as SlackAvatarCommandBody,
      verification: { ok: true, skipped: true, source: "socket_mode_interaction" },
    });
    const resultRecord = result as { body?: unknown };
    sendSocketAck(ws, message.envelope_id, resultRecord.body ?? result);
    return;
  }

  if (message.type === "events_api") {
    sendSocketAck(ws, message.envelope_id);
    const payload = message.payload || {};
    if (payload.type === "event_callback") {
      await handleSlackEventsApi({
        req: { headers: {} },
        body: payload,
        rawBody: JSON.stringify(payload),
        verificationOverride: { ok: true, skipped: true, source: "socket_mode_events_api" },
      });
    }
    return;
  }

  sendSocketAck(ws, message.envelope_id);
}

async function startSlackSocketMode() {
  if (!config.slackSocketMode) return;
  if (!config.slackAppToken) {
    slackInbound.socketMode.lastError = "SLACK_APP_TOKEN missing";
    console.warn("[slack-agent] socket mode requested but SLACK_APP_TOKEN is missing");
    return;
  }
  if (slackInbound.socketMode.connecting || slackInbound.socketMode.connected) return;
  slackInbound.socketMode.connecting = true;
  try {
    const opened = await slackApiWithToken(config.slackAppToken, "apps.connections.open");
    const socketUrl = opened.body?.url || "";
    if (!opened.body?.ok || !socketUrl)
      throw new Error(opened.body?.error || `apps.connections.open failed (${opened.status})`);
    const ws = new WebSocket(socketUrl);
    ws.addEventListener("open", () => {
      slackInbound.socketMode.connected = true;
      slackInbound.socketMode.connecting = false;
      slackInbound.socketMode.lastConnectedAt = new Date().toISOString();
      slackInbound.socketMode.lastError = "";
      if (slackSocketReconnectTimer) {
        clearTimeout(slackSocketReconnectTimer);
        slackSocketReconnectTimer = null;
      }
      console.log("[slack-agent] Socket Mode connected");
    });
    ws.addEventListener("message", (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        slackInbound.socketMode.lastError = `invalid_socket_json:${String(error?.message || error)}`;
        return;
      }
      handleSocketEnvelope(ws, message).catch((error) => {
        slackInbound.socketMode.lastError = String(error?.message || error);
        if (message?.envelope_id)
          sendSocketAck(
            ws,
            message.envelope_id,
            slackTextResponse(`Socket handler failed: ${slackInbound.socketMode.lastError}`, {
              ok: false,
            }),
          );
      });
    });
    ws.addEventListener("close", () => {
      slackInbound.socketMode.connected = false;
      slackInbound.socketMode.connecting = false;
      slackInbound.socketMode.lastClosedAt = new Date().toISOString();
      slackInbound.socketMode.reconnects += 1;
      scheduleSlackSocketReconnect(1500);
    });
    ws.addEventListener("error", (event: Event) => {
      slackInbound.socketMode.lastError = String(
        (event as Event & { message?: string }).message || "socket_error",
      );
    });
  } catch (error) {
    slackInbound.socketMode.connecting = false;
    slackInbound.socketMode.connected = false;
    slackInbound.socketMode.lastError = String((error as { message?: string })?.message || error);
    scheduleSlackSocketReconnect(1500);
  }
}

const service = createJsonServer({
  name: "slack-agent",
  port: config.slackPort,
  routes: {
    "GET /healthz": () => ({
      ok: true,
      service: "slack-agent",
      state: {
        provider: sessions.provider,
        sessionPath: sessions.path,
        sessionCollection: sessions.collection,
        contextProvider: workspaceContext.provider,
        contextPath: workspaceContext.path,
        contextCollection: workspaceContext.collection,
        domainStore: slackDomainStore?.stats?.() || { enabled: false },
        localSlackMemory: localSlackMemory.summary(),
        canvasPublisher: canvasPublisher.provider,
        canvasDir: canvasPublisher.outDir,
        slackWorkspaceDir,
        slackWorkspaceBootstrap,
        slackInbound,
        meetingCopilot: meetingCopilotRunner.status(),
        digestWebhookSecretConfigured: Boolean(config.digestWebhookSecret),
      },
    }),
    "POST /slack/workspace/bootstrap": ({ body }) => {
      const b = (body || {}) as SlackHandlerInput;
      const result = ensureSlackWorkspaceFiles({
        workspaceDir: String(b.workspace_dir || b.workspaceDir || slackWorkspaceDir),
      });
      return { status: result.ok ? 200 : 400, body: result };
    },
    "POST /slack/validate": async ({ body }) => {
      const b = (body || {}) as SlackHandlerInput & {
        meeting_agent_url?: string;
        meetingAgentUrl?: string;
        webhook_listen?: string;
        webhookListen?: string;
        require_slack_tokens?: boolean;
        requireSlackTokens?: boolean;
      };
      const result = await validateSlackAgentRuntime({
        meetingAgentUrl: String(b.meeting_agent_url || b.meetingAgentUrl || config.meetingAgentUrl),
        webhookListen: String(
          b.webhook_listen || b.webhookListen || process.env.MAB_MEET_WEBHOOK_LISTEN || "",
        ),
        slackBotToken: config.slackBotToken,
        slackAppToken: config.slackAppToken,
        slackSigningSecret: config.slackSigningSecret,
        requireSlackTokens: b.require_slack_tokens === true || b.requireSlackTokens === true,
      });
      const manifest =
        parseSlackAppManifest(body.manifest || body.app_manifest || null) ||
        loadConfiguredSlackManifest();
      const manifestValidation = manifest
        ? validateSlackAppManifest(manifest, { expected: expectedSlackManifest })
        : { ok: true, skipped: true, reason: "manifest_not_supplied" };
      const bodyResult = { ...result, manifestValidation };
      return { status: result.ok && manifestValidation.ok ? 200 : 400, body: bodyResult };
    },
    "GET /slack/app/manifest": () => slackInstallModel(),
    "POST /slack/app/manifest/validate": ({ body = {} }) => {
      const manifest = parseSlackAppManifest(body.manifest || body.app_manifest || body);
      const validation = validateSlackAppManifest(manifest, { expected: expectedSlackManifest });
      return {
        status: validation.ok ? 200 : 400,
        body: { ok: validation.ok, validation, expected: expectedSlackManifest },
      };
    },
    "GET /slack/install": () => slackInstallModel(),
    "GET /slack/oauth": async ({ url }) => {
      const code = url.searchParams.get("code") || "";
      if (!code) return slackInstallModel();
      const result = await exchangeSlackOAuthCode({
        code,
        clientId: config.slackClientId,
        clientSecret: config.slackClientSecret,
        redirectUri:
          config.slackRedirectUri || `${config.publicBaseUrl.replace(/\/+$/, "")}/slack/oauth`,
      });
      return {
        status: result.ok ? 200 : 400,
        body: {
          ok: result.ok,
          oauth: maskSlackOAuthResult(result),
          note: result.ok
            ? "Store the returned bot/user tokens in your secret manager; this route intentionally does not persist secrets."
            : "OAuth exchange failed or Slack client credentials are not configured.",
        },
      };
    },
    "GET /webhooks/meeting-digest": () => ({ ok: true, webhooks: meetingDigestWebhooks }),
    "GET /webhooks/meeting-copilot/status": () => meetingCopilotRunner.status(),
    "POST /webhooks/meeting-digest": async ({ req, rawBody, body }) => {
      const sigHeader = req.headers["x-webhook-signature"];
      const signature = Array.isArray(sigHeader) ? sigHeader[0] || "" : sigHeader || "";
      const validSignature = verifyDigestWebhookSignature(
        rawBody,
        signature,
        config.digestWebhookSecret,
      );
      if (!validSignature)
        return { status: 401, body: { ok: false, error: "invalid_webhook_signature" } };
      const b = body as Record<string, unknown> & {
        event?: string;
        meeting_id?: number | string;
        meetingId?: number | string;
        title?: string;
      };
      const delivery = await handleMeetingWebhookPayload(b);
      const event = {
        id: `meeting_digest_${meetingDigestWebhooks.length + 1}`,
        receivedAt: new Date().toISOString(),
        event: String(b.event || ""),
        meetingId: String(b.meeting_id || b.meetingId || ""),
        title: String(b.title || ""),
        payload: b,
        signature: signature ? "verified" : "absent",
        delivery,
      };
      meetingDigestWebhooks.push(event);
      const accepted = b.event === "meeting.result" || b.event === "meeting.digest";
      return {
        status: accepted ? 202 : 200,
        body: {
          ok: delivery.ok !== false,
          accepted,
          received: event,
          delivery,
        },
      };
    },
    "GET /context": () => ({ ok: true, contexts: workspaceContext.list() }),
    "GET /slack/domain/status": () => ({
      ok: true,
      domain: slackDomainStore?.stats?.() || { enabled: false },
    }),
    "GET /slack/domain/context": ({ url }) => {
      if (!slackDomainStore) return { ok: true, domain: { enabled: false } };
      return {
        ok: true,
        context: slackDomainStore.context({
          workspaceId:
            url.searchParams.get("workspace") || url.searchParams.get("team") || "workspace",
          channelId: url.searchParams.get("channel") || "channel",
          threadTs:
            url.searchParams.get("thread") || url.searchParams.get("thread_ts") || "channel-root",
          limit: Number.parseInt(url.searchParams.get("limit") || "5", 10),
        }),
      };
    },
    "POST /slack/domain/refresh": async ({ body }) => {
      const result = await refreshSlackDomainCache(body as SlackHandlerInput);
      return { status: result.ok ? 200 : 400, body: result };
    },
    "GET /memory": ({ url }) => ({
      ok: true,
      summary: localSlackMemory.summary(),
      results: config.slackMemoryEnabled
        ? localSlackMemory.search(
            url.searchParams.get("q") || "",
            Number.parseInt(url.searchParams.get("limit") || "8", 10),
          )
        : [],
    }),
    "GET /tools/parity": () => legacyTools.report(),
    "GET /slack/tools/parity": () => legacyTools.report(),
    "POST /tools/call": async ({ body }) => {
      const b = body as { tool?: string; name?: string; args?: Record<string, unknown>; input?: Record<string, unknown> };
      const tool = String(b.tool || b.name || "");
      const result = await legacyTools.execute(tool, b.args || b.input || {});
      return { status: result.ok ? 200 : 400, body: result };
    },
    "POST /slack/tools/call": async ({ body }) => {
      const b = body as { tool?: string; name?: string; args?: Record<string, unknown>; input?: Record<string, unknown> };
      const tool = String(b.tool || b.name || "");
      const result = await legacyTools.execute(tool, b.args || b.input || {});
      return { status: result.ok ? 200 : 400, body: result };
    },
    "GET /slack/inbound/status": () => ({ ok: true, inbound: slackInbound }),
    "GET /slack/assistant/status": () => ({
      ok: true,
      mock: config.slackApiMock,
      calls: slackApiMockCalls,
      threads: [...assistantStatusByThread.entries()].map(([key, state]) => ({
        key,
        lastStatus: state.lastStatus || "",
        hasPendingTimer: Boolean(state.pendingTimer),
        pendingStatus: state.pendingStatus || "",
        lastCallAt: state.lastCallAt || 0,
      })),
    }),
    "GET /slack/triage/status": ({ url }) => ({
      ok: true,
      triage: {
        enabled: config.slackEventTriage,
        postActions: config.slackTriagePostActions,
        heuristicFallback: config.slackTriageHeuristicFallback,
        lastTriageJobId: slackInbound.eventBuffer.lastTriageJobId,
        runs:
          slackDomainStore?.listTriageRuns(
            Number.parseInt(url.searchParams.get("limit") || "10", 10),
          ) || [],
        pendingActions:
          slackDomainStore?.listPendingActions(
            Number.parseInt(url.searchParams.get("limit") || "10", 10),
          ) || [],
      },
    }),
    "GET /slack/followups/status": ({ url }) =>
      slackFollowupStatus({
        status: url.searchParams.get("status") || "",
        limit: url.searchParams.get("limit") || "20",
      }),
    "POST /slack/followups/create": async ({ body }) => {
      const result = createSlackFollowupSurface(body as SlackHandlerInput);
      return { status: result.ok ? 200 : 400, body: result };
    },
    "POST /slack/triage/run": async ({ body }) => {
      const b = body as SlackHandlerInput & {
        digest?: string;
        messages?: Array<Record<string, unknown>>;
        team?: string;
      };
      const channelId = String(b.channel || b.channel_id || "C_TRIAGE");
      const messages: Array<{ teamId?: string; [key: string]: unknown }> =
        Array.isArray(b.messages) && b.messages.length
          ? (b.messages as Array<{ teamId?: string; [key: string]: unknown }>)
          : [
              {
                teamId: String(b.team || b.team_id || "T_TRIAGE"),
                channelId,
                userId: String(b.user || b.user_id || "U_TRIAGE"),
                text: String(b.text || b.digest || ""),
                ts: String(b.ts || new Date().toISOString()),
                threadTs: String(b.threadTs || b.thread_ts || ""),
              },
            ];
      const digest = String(b.digest || "") || renderSlackActivityDigest(channelId, messages);
      const triage = await startSlackTriage({ channelId, messages, digest });
      return {
        ok: true,
        triage,
        status: triage.finalization,
        inbound: slackInbound,
      };
    },
    "POST /slack/inbound/flush": async ({ body }) => {
      const b = body as SlackHandlerInput;
      const channel = String(b.channel || b.channel_id || "");
      const channels = channel ? [channel] : [...slackMessageBuffers.keys()];
      const flushed: Array<{ channelId: string; count: number; digest: string }> = [];
      for (const channelId of channels) {
        const result = await flushSlackMessageBuffer(channelId);
        if (result)
          flushed.push({
            channelId,
            count: (result as { messages?: unknown[] }).messages?.length || 0,
            digest: String((result as { digest?: string }).digest || ""),
          });
      }
      return { ok: true, flushed, inbound: slackInbound };
    },
    "POST /slack/scanner/sweep": async ({ body }) => {
      const result = await sweepSlackScanner(body as SlackHandlerInput);
      return { status: result.ok ? 200 : 400, body: result };
    },
    "POST /slack/scanner/compact": async ({ body }) => {
      const result = await compactSlackDailyNotes(body as SlackHandlerInput);
      return { status: result.ok ? 200 : 400, body: result };
    },
    "GET /canvas/published": () => ({ ok: true, published: canvasPublisher.listPublished() }),
    "GET /shadow/report": async () => ({
      ok: true,
      reportPath: config.shadowTapReportPath || config.cutoverReportPath,
      events: await readShadowTapReport(config.shadowTapReportPath || config.cutoverReportPath),
    }),
    "GET /cutover/report": async () => ({
      ok: true,
      mode: cutover.mode,
      canaryPercent: cutover.canaryPercent,
      autoRollbackOnFailure: config.cutoverAutoRollbackOnFailure,
      reportPath: cutover.reportPath,
      events: await cutover.readReport(),
    }),
    "GET /sessions": () => ({ ok: true, sessions: sessions.list() }),
    "POST /shadow/slack-command": handleShadowSlackCommand,
    "POST /commands/avatar": handleAvatarCommand,
    "POST /slack/commands/avatar": handleAvatarCommand,
    "POST /slack/interactions": handleSlackInteraction,
    "POST /slack/actions": handleSlackInteraction,
    "POST /slack/events": handleSlackEventsApi,
    "POST /jobs/delegate": async ({ body }) => {
      const b = body as SlackHandlerInput & {
        task?: string;
        context?: Record<string, unknown>;
        mode?: string;
        allowCodeChanges?: boolean;
      };
      const job = await runner.startTask({
        task: String(b.task || ""),
        context: b.context || {},
        mode: String(b.mode || "analysis"),
        allowCodeChanges: Boolean(b.allowCodeChanges),
      });
      const report = await reportFinishedWorkerJob(job);
      return { ok: true, job, meetingReport: (report as { body?: unknown } | null)?.body || null };
    },
    "GET /jobs": () => ({ ok: true, jobs: runner.listJobs() }),
    "POST /jobs/poll-meeting": async ({ body }) => {
      const b = body as SlackHandlerInput & {
        postToSlack?: boolean;
        markDelivered?: boolean;
      };
      const limit = Number.parseInt(String(b.limit ?? "10"), 10);
      const postToSlack = b.postToSlack === true || Boolean(b.channel);
      const result = postToSlack
        ? await postMeetingWorkerResultsToSlack({
            limit,
            channel: String(b.channel || ""),
            threadTs: String(b.threadTs || b.thread_ts || ""),
            markDelivered: b.markDelivered !== false,
          })
        : await pollMeetingWorkerResults({
            limit,
            markDelivered: b.markDelivered !== false,
          });
      return { ok: result.ok, ...result };
    },
    "POST /post-meeting/publish": async ({ body }) => {
      const b = body as SlackHandlerInput & {
        artifact?: CanvasArtifact & { id?: string };
        artifactId?: string;
        summaryMarkdown?: string;
        summaryPath?: string;
        destination?: string;
      };
      let artifact: (CanvasArtifact & { id?: string }) | null = b.artifact || null;
      if (!artifact && b.artifactId) {
        const response = (await getJson(
          `${config.meetingAgentUrl}/meetings/artifact?id=${encodeURIComponent(b.artifactId)}`,
        )) as { body?: { artifact?: CanvasArtifact & { id?: string } } };
        artifact = response.body?.artifact || null;
      }
      if (!artifact) {
        return { status: 400, body: { ok: false, error: "artifact_required" } };
      }
      const result = await canvasPublisher.publish({
        artifact,
        artifactId: String(b.artifactId || artifact.id || ""),
        title: b.title,
        summaryMarkdown: b.summaryMarkdown ? String(b.summaryMarkdown) : undefined,
        summaryPath: b.summaryPath ? String(b.summaryPath) : undefined,
        channel: String(b.channel || config.canvasSlackChannel || ""),
        threadTs: String(b.threadTs || b.thread_ts || config.canvasSlackThreadTs || ""),
        destination: String(b.destination || "post-meeting"),
        dedupKey: b.dedupKey ? String(b.dedupKey) : undefined,
      });
      return { status: result.ok ? 200 : 400, body: { ok: result.ok, published: result } };
    },
    "POST /canvas/publish": async ({ body }) => {
      const b = body as SlackHandlerInput & {
        artifact?: CanvasArtifact & { id?: string };
        artifactId?: string;
        summaryMarkdown?: string;
        summaryPath?: string;
        destination?: string;
      };
      let artifact: (CanvasArtifact & { id?: string }) | null = b.artifact || null;
      if (!artifact && b.artifactId) {
        const response = (await getJson(
          `${config.meetingAgentUrl}/meetings/artifact?id=${encodeURIComponent(b.artifactId)}`,
        )) as { body?: { artifact?: CanvasArtifact & { id?: string } } };
        artifact = response.body?.artifact || null;
      }
      if (!artifact) {
        return { status: 400, body: { ok: false, error: "artifact_required" } };
      }
      const result = await canvasPublisher.publish({
        artifact,
        artifactId: String(b.artifactId || artifact.id || ""),
        title: b.title,
        summaryMarkdown: b.summaryMarkdown ? String(b.summaryMarkdown) : undefined,
        summaryPath: b.summaryPath ? String(b.summaryPath) : undefined,
        channel: String(b.channel || config.canvasSlackChannel || ""),
        threadTs: String(b.threadTs || b.thread_ts || config.canvasSlackThreadTs || ""),
        destination: String(b.destination || "canvas"),
        dedupKey: b.dedupKey ? String(b.dedupKey) : undefined,
      });
      return { status: result.ok ? 200 : 400, body: { ok: result.ok, published: result } };
    },
  },
});

await service.listen();
await startSlackSocketMode();
