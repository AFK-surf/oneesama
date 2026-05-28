import { readFileSync } from "node:fs";
import { createJsonServer } from "../../../packages/core/src/http-json.js";
import { getRuntimeConfig } from "../../../packages/core/src/env.js";
import { createPersistentSessionStore } from "../../../packages/core/src/session-store.js";
import { createAgentRunner } from "../../../packages/core/src/agent-runner/agent-runner.js";
import { slackTextResponse } from "../../../packages/core/src/control-plane/avatar-command.js";
import { createCutoverController } from "../../../packages/core/src/cutover/cutover-controller.js";
import { readShadowTapReport } from "../../../packages/core/src/shadow/shadow-tap.js";
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
  ensureSlackWorkspaceFiles,
  validateSlackAgentRuntime,
} from "../../../packages/core/src/slack/workspace-bootstrap.js";
import {
  createOneeSamaSlackManifest,
  exchangeSlackOAuthCode,
  maskSlackOAuthResult,
  parseSlackAppManifest,
  validateSlackAppManifest,
} from "../../../packages/core/src/slack/slack-app-manifest.js";
import { createMeetingCopilotRunner } from "../../../packages/core/src/slack/meeting-copilot-runner.js";
import { verifyDigestWebhookSignature } from "../../../packages/core/src/meeting/digest-webhook.js";
import { createSlackCommandHandlers } from "./commands.js";
import { createSlackEventHandlers } from "./events.js";
import { createSlackScannerHandlers } from "./scanner.js";
import { createSlackWorkerResultHandlers } from "./worker-results.js";
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
type ParsedAvatarCommand = import("../../../packages/core/src/control-plane/avatar-command.js").AvatarCommandResult;
type SlackAvatarCommandBody = SlackHandlerInput;
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
let workerResultHandlers: any;
const reportFinishedWorkerJob = (job: SlackJobLike) => workerResultHandlers.reportFinishedWorkerJob(job);
const updateSlackAssistantStatusForWorkerJob = (job: SlackJobLike) =>
  workerResultHandlers.updateSlackAssistantStatusForWorkerJob(job);
const pollMeetingWorkerResults = (input = {}) => workerResultHandlers.pollMeetingWorkerResults(input);
const postMeetingWorkerResultsToSlack = (input = {}) => workerResultHandlers.postMeetingWorkerResultsToSlack(input);
const slackImmediateWorkerAckText = (body: SlackWorkerResponseBody = {}) =>
  workerResultHandlers.slackImmediateWorkerAckText(body);
const shouldKeepAssistantStatusUntilWorkerDone = (body: SlackWorkerResponseBody = {}) =>
  workerResultHandlers.shouldKeepAssistantStatusUntilWorkerDone(body);
runner = createAgentRunner({
  onJobUpdate: reportFinishedWorkerJob,
  onJobProgress: updateSlackAssistantStatusForWorkerJob,
} as unknown as Parameters<typeof createAgentRunner>[0]);
const meetingCopilotRunner = createMeetingCopilotRunner({
  agentRunner: runner,
} as Parameters<typeof createMeetingCopilotRunner>[0]);
const { executeAvatarCommand, handleAvatarCommand, handleShadowSlackCommand } =
  createSlackCommandHandlers({
    config,
    sessions,
    cutover,
    runner,
    workspaceContext,
    localSlackMemory,
    rememberSlackCommand,
    postJson,
    getJson,
    resolveSession,
    reportFinishedWorkerJob,
    pollMeetingWorkerResults,
  });
const {
  bufferSlackMessageEvent,
  commandBodyFromInteraction,
  finalizeSlackTriageJob,
  flushSlackMessageBuffer,
  handlePendingActionInteraction,
  handleMeetingWebhookPayload,
  handleSlackEventsApi,
  handleSlackInteraction,
  postSlackMessage,
  renderSlackActivityDigest,
  scheduleSlackAssistantThreadStatus,
  scheduleSlackSocketReconnect,
  assistantStatusTextForJob,
  startSlackTriage,
} = createSlackEventHandlers({
  config,
  slackDomainStore,
  finalizedTriageJobs,
  triageJobResults,
  localSlackMemory,
  slackWorkspaceDir,
  slackInbound,
  callSlackApi,
  runner,
  poster,
  slackMessageBuffers,
  workspaceContext,
  activeSlackMentionThreads,
  assistantStatusByThread,
  recentSlackMentionEvents,
  assistantStatusMinIntervalMs,
  assistantToolStatusLabels,
  executeAvatarCommand,
  slackApiMockCalls,
  shouldBypassAssistantStatusThrottle,
  assistantStatusPriority,
  canvasPublisher,
  meetingCopilotRunner,
  startSlackSocketMode,
  shouldKeepAssistantStatusUntilWorkerDone,
  slackImmediateWorkerAckText,
});
workerResultHandlers = createSlackWorkerResultHandlers({
  config,
  finalizedWorkerJobReports,
  poster,
  slackDomainStore,
  postJson,
  getJson,
  finalizeSlackTriageJob,
  postSlackMessage,
  scheduleSlackAssistantThreadStatus,
  assistantStatusTextForJob,
});
const {
  compactSlackDailyNotes,
  createSlackFollowupSurface,
  refreshSlackDomainCache,
  slackInstallModel,
  slackFollowupStatus,
  sweepSlackScanner,
} = createSlackScannerHandlers({
  config,
  slackDomainStore,
  runner,
  slackInbound,
  expectedSlackManifest,
  loadConfiguredSlackManifest,
  slackWorkspaceDir,
  bufferSlackMessageEvent,
  flushSlackMessageBuffer,
  scannerState: { lastScannerCompactionHash },
});
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
    const payload = (message.payload as Record<string, unknown>) || {};
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
