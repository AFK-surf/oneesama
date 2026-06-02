import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import {
  handleWorkspaceTool,
  isLocalVideoPath,
  loadSlackAgentPersonalityContext,
  realtimeSuppressChannelForContext,
  realtimeSuppressReasonForChannel,
  stageVideoAssetUrl,
  videoContentType,
  workerContext,
} from "./workspace-tools.js";
import { createJsonServer } from "../../../packages/core/src/http-json.js";
import { getRuntimeConfig } from "../../../packages/core/src/env.js";
import { createPersistentSessionStore } from "../../../packages/core/src/session-store.js";
import { createGoogleMeetJoiner } from "../../../packages/core/src/meeting/google-meet-joiner.js";
import { createAgentRunner } from "../../../packages/core/src/agent-runner/agent-runner.js";
import { mintRealtimeClientSecret } from "../../../packages/core/src/realtime/realtime-token.js";
import { buildRealtimeInstructions } from "../../../packages/core/src/realtime/realtime-contract.js";
import { createWorkerReportStore } from "../../../packages/core/src/realtime/worker-report-store.js";
import { createTtsProvider } from "../../../packages/core/src/dialog/tts-provider.js";
import { createMeetingArtifactPipeline } from "../../../packages/core/src/meeting/post-meeting-artifacts.js";
import { sendDigestWebhook } from "../../../packages/core/src/meeting/digest-webhook.js";
import {
  createMeetdRuntime,
  createMeetdRuntimeStore,
  meetdMeetingResponse,
} from "../../../packages/core/src/meeting/meetd-runtime-store.js";
import { validateRealtimeRuntimePlacementForJoin } from "./realtime-placement-guard.js";
import {
  buildMeetingAgentRealtimeSessionConfig,
  meetingAgentRealtimeToolsForRequest,
} from "./realtime-config-tools.js";
import { realtimeToolRouteRejected } from "./internal-control-guard.js";
import { createInternalControlGuard, createTSAppControlToolHandler } from "./app-control-routes.js";
import type { MeetingAgentInput } from "./meeting-agent-types.js";

const config = getRuntimeConfig();
const sqlitePath = config.stateSqlitePath || `${config.dataDir}/meeting-avatar-bot.sqlite3`;
const sessions = createPersistentSessionStore(`${config.dataDir}/meeting-sessions.json`, {
  provider: config.stateProvider,
  sqlitePath,
  collection: "meeting_sessions",
});
const joiner = createGoogleMeetJoiner();
const reports = createWorkerReportStore({
  filePath: `${config.dataDir}/worker-reports.json`,
  provider: config.stateProvider,
  sqlitePath,
  collection: "worker_reports",
});
const withInternalControlGuard = createInternalControlGuard(config);
const handleTSAppControlTool = createTSAppControlToolHandler({ config, reports });
const ttsProvider = createTtsProvider();
const artifacts = createMeetingArtifactPipeline({
  rootDir: config.meetingArtifactsDir,
  asrProvider: config.asrProvider,
});
const meetdStore = createMeetdRuntimeStore({ sessions });
const meetdRuntime = createMeetdRuntime({ store: meetdStore });

function defaultRealtimeBridgeModeForRuntime(runtime: unknown) {
  const normalized = String(runtime || "")
    .trim()
    .toLowerCase();
  if (["agents-sdk", "openai-agents", "openai-agents-sdk"].includes(normalized)) {
    return "agents-sdk";
  }
  return "mock";
}

function realtimeEventPayload(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function realtimeDeliverySuppressed(delivery: unknown) {
  const record = recordValue(delivery);
  const nested = recordValue(record.delivery);
  return record.suppressed === true || nested.suppressed === true;
}

function realtimeDeliverySuppressionReason(delivery: unknown) {
  const record = recordValue(delivery);
  const nested = recordValue(record.delivery);
  return String(
    record.reason ||
      nested.reason ||
      realtimeSuppressReasonForChannel(String(record.channel || "")) ||
      "worker_result_suppressed",
  );
}

function suppressedRealtimeDelivery(channel: string) {
  return {
    ok: false,
    suppressed: true,
    channel,
    reason: realtimeSuppressReasonForChannel(channel),
  };
}

function validateHostRealtimeEvent(event: Record<string, unknown>) {
  const type = String(event.type || "").trim();
  if (!type) return { ok: false, error: "realtime_event_type_required" };
  if (type === "response.cancel" || type === "input_audio_buffer.clear") return { ok: true };
  return { ok: false, error: "realtime_event_type_not_allowed" };
}

function reportFinishedWorkerJob(job) {
  if (!["completed", "failed", "timeout"].includes(job.status)) return null;
  return reports.create({
    id: job.id,
    status: job.status,
    provider: job.provider,
    mode: job.mode,
    task: job.task,
    context: job.context,
    allowCodeChanges: job.allowCodeChanges,
    result: job.result,
    error: job.error,
  });
}

const runner = createAgentRunner({
  onJobUpdate: reportFinishedWorkerJob,
});
const realtimePersonalityContext = loadSlackAgentPersonalityContext();
const currentUser = {
  name: config.currentUserName || "Operator",
  englishName: config.currentUserEnglishName || "Operator",
  email: config.currentUserEmail || "operator@example.com",
  linear: config.currentUserLinear || "operator",
  github: config.currentUserGithub || "operator",
  role: config.currentUserRole || "meeting operator",
};

const assetMimeTypes = {
  ".json": "application/json; charset=utf-8",
  ".moc3": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function serveAvatarAsset(url) {
  if (!config.avatarAssetRoot) {
    return { status: 404, body: { ok: false, error: "MAB_AVATAR_ASSET_ROOT is not configured" } };
  }
  const root = resolve(config.avatarAssetRoot);
  const assetPath = decodeURIComponent(url.pathname.replace(/^\/avatar-assets\/?/, ""));
  const filePath = resolve(join(root, normalize(assetPath)));
  if (relative(root, filePath).startsWith("..")) {
    return { status: 403, body: { ok: false, error: "avatar_asset_path_escape" } };
  }
  if (!existsSync(filePath)) {
    return { status: 404, body: { ok: false, error: "avatar_asset_not_found", assetPath } };
  }
  return {
    raw: readFileSync(filePath),
    contentType: assetMimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
  };
}

async function waitForRunnerJob(jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let job = null;
  while (Date.now() < deadline) {
    job = runner.getJob(jobId);
    if (job && ["completed", "failed", "timeout"].includes(job.status)) return job;
    await new Promise((settle) => setTimeout(settle, 150));
  }
  job = runner.getJob(jobId);
  return job
    ? { ...job, status: "timeout", error: "dialog turn timed out waiting for provider result" }
    : null;
}

function parseMeetdCompatPath(url: URL): { id: string; action: string } {
  const rest = decodeURIComponent(url.pathname.replace(/^\/meetings\/?/, ""));
  const parts = rest.split("/").filter(Boolean);
  return {
    id: parts[0] || "",
    action: parts.slice(1).join("/"),
  };
}

function meetdCaptionClock(timestamp: unknown): string {
  const date = new Date(timestamp as string | number);
  if (Number.isNaN(date.getTime())) return String(timestamp || "");
  return date.toISOString().slice(11, 19);
}

function handleMeetdCreateMeeting(body: MeetingAgentInput = {}) {
  const result = meetdStore.scheduleMeeting(body as Record<string, unknown>);
  if (!result.ok) return { status: result.status || 400, body: { ok: false, error: result.error } };
  return {
    meeting_id: result.meeting_id,
    idempotent: result.idempotent || "",
    created: Boolean(result.created),
  };
}

function handleMeetdListMeetings(url: URL) {
  const status = String(url.searchParams.get("status") || "").trim();
  const meetings = meetdStore.listByStatus(status).map(meetdMeetingResponse);
  return { ok: true, meetings };
}

function handleMeetdGetCaptions(session, url) {
  const source = String(url.searchParams.get("source") || "live_caption")
    .trim()
    .toLowerCase();
  if (!["live", "live_caption", "asr", "all"].includes(source)) {
    return { status: 400, body: { ok: false, error: `invalid caption source ${source}` } };
  }
  const normalizedSource = source === "live" ? "live_caption" : source;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);
  const allCaptions = (session.meetdCaptions || []).filter((caption) => {
    return normalizedSource === "all" || caption.source === normalizedSource;
  });
  const returned = allCaptions.slice(-limit);
  const speakers = [...new Set(allCaptions.map((caption) => caption.speaker).filter(Boolean))];
  return {
    ok: true,
    meeting_id: Number(session.meetdCompatId),
    status: session.status || "pending",
    title: session.title || "Untitled meeting",
    source: normalizedSource,
    total_captions: allCaptions.length,
    returned_captions: returned.length,
    speakers,
    captions: returned.map((caption) => ({
      speaker: caption.speaker,
      text: caption.text,
      timestamp: meetdCaptionClock(caption.timestamp),
    })),
  };
}

function readMeetdArtifact(session, artifactName) {
  const normalizedName = String(artifactName || "").toLowerCase();
  if (normalizedName === "transcript" || normalizedName === "transcript.txt") {
    if (session.transcriptText) {
      return { raw: session.transcriptText, contentType: "text/plain; charset=utf-8" };
    }
    const candidate =
      session.transcriptPath ||
      (session.artifactsDir ? join(session.artifactsDir, "transcript.txt") : "");
    if (candidate && existsSync(candidate)) {
      return { raw: readFileSync(candidate), contentType: "text/plain; charset=utf-8" };
    }
  }
  if (normalizedName === "audio" || normalizedName === "audio.wav") {
    const candidate =
      session.audioPath || (session.artifactsDir ? join(session.artifactsDir, "audio.wav") : "");
    if (candidate && existsSync(candidate))
      return { raw: readFileSync(candidate), contentType: "audio/wav" };
  }
  return { status: 404, body: { ok: false, error: "artifact not found" } };
}

interface MeetdSessionShape {
  id?: string;
  meetdCompatId?: string | number;
  title?: string;
  status?: string;
  meetdResult?: unknown;
  artifactsDir?: string;
  transcriptPath?: string;
  transcriptText?: string;
  audioPath?: string;
  meetdCaptions?: Array<{ source?: string; speaker?: string; text?: string; timestamp?: unknown }>;
  webhookState?: string;
  webhookError?: string;
  webhookAttemptCount?: number;
  webhookLastAttemptAt?: string;
  webhookLastEvent?: string;
  [key: string]: unknown;
}

interface MeetdWebhookOverrides extends MeetingAgentInput {
  event?: string;
  summary?: string;
  slack_ref?: unknown;
  slackRef?: unknown;
}

function buildMeetdWebhookPayload(
  session: MeetdSessionShape,
  overrides: MeetdWebhookOverrides = {},
) {
  const meetingId = Number(session.meetdCompatId || 0);
  const meetdResult = session.meetdResult;
  return {
    event: overrides.event || "meeting.result",
    meeting_id: meetingId,
    title: session.title || "Untitled meeting",
    status: session.status || "done",
    summary:
      (typeof meetdResult === "object" && meetdResult !== null
        ? (meetdResult as { summary?: string }).summary
        : (meetdResult as string | undefined)) || overrides.summary,
    artifacts: {
      transcript_path:
        session.transcriptPath ||
        (session.artifactsDir ? join(session.artifactsDir, "transcript.txt") : ""),
      audio_path:
        session.audioPath || (session.artifactsDir ? join(session.artifactsDir, "audio.wav") : ""),
    },
    transcript: overrides.transcript || "",
    chat_transcript: overrides.chat_transcript || overrides.chatTranscript || "",
    time_from: overrides.time_from || overrides.timeFrom || "",
    time_to: overrides.time_to || overrides.timeTo || "",
    slack_ref: overrides.slack_ref || overrides.slackRef || undefined,
  };
}

interface MeetdWebhookBody extends MeetingAgentInput {
  webhook_url?: string;
  webhookUrl?: string;
  webhook_secret?: string;
  webhookSecret?: string;
  retryDelayMs?: number | string;
  retry_delay_ms?: number | string;
}

async function deliverMeetdWebhook(
  session: MeetdSessionShape,
  payload: ReturnType<typeof buildMeetdWebhookPayload>,
  body: MeetdWebhookBody = {},
) {
  const url = body.webhook_url || body.webhookUrl || config.digestWebhookUrl;
  if (!url) return { ok: true, skipped: true, error: "webhook_url_not_configured", attempts: 0 };
  const result = await sendDigestWebhook({
    url,
    secret: body.webhook_secret || body.webhookSecret || config.digestWebhookSecret,
    payload,
    maxAttempts: Number(
      body.maxAttempts || body.max_attempts || config.digestWebhookMaxAttempts || 5,
    ),
    retryDelayMs: Number(
      body.retryDelayMs || body.retry_delay_ms || config.digestWebhookRetryDelayMs || 1000,
    ),
  });
  if (session.id) {
    sessions.update(session.id, {
      webhookState: result.ok ? "delivered" : "failed",
      webhookError: result.error || "",
      webhookAttemptCount: result.attempts,
      webhookLastAttemptAt: new Date().toISOString(),
      webhookLastEvent: payload.event,
    });
  }
  return result;
}

async function handleMeetdPostAction(
  session: MeetdSessionShape,
  action: string,
  body: MeetdWebhookBody = {},
) {
  if (action === "cancel") {
    if ((session.status || "pending") !== "pending") {
      return {
        status: 409,
        body: { ok: false, error: `cannot cancel meeting in ${session.status} state` },
      };
    }
    sessions.update(session.id || "", {
      status: "cancelled",
      error: body.reason || "cancelled via API",
    });
    return { status: "cancelled" };
  }
  if (action === "redeliver") {
    if (!["done", "failed"].includes(String(session.status))) {
      return {
        status: 409,
        body: {
          ok: false,
          error: `meeting ${session.meetdCompatId} is in ${session.status} state, cannot redeliver`,
        },
      };
    }
    const webhook = await deliverMeetdWebhook(
      session,
      buildMeetdWebhookPayload(session, body as MeetdWebhookOverrides),
      body,
    );
    if (!webhook.ok)
      return { status: 502, body: { ok: false, status: "redeliver_failed", webhook } };
    sessions.update(session.id || "", { lastRedeliveredAt: new Date().toISOString() });
    return { status: "redelivered", webhook };
  }
  if (action === "resummarize") {
    if (!["done", "failed"].includes(String(session.status))) {
      return {
        status: 409,
        body: {
          ok: false,
          error: `meeting ${session.meetdCompatId} is in ${session.status} state, cannot resummarize`,
        },
      };
    }
    sessions.update(session.id || "", { lastResummarizeRequestedAt: new Date().toISOString() });
    return { status: "resummarizing" };
  }
  if (action === "chat") {
    const text = String(body.text || body.message || "").trim();
    if (!text) return { status: 400, body: { ok: false, error: "text is required" } };
    const status = (await joiner.status()) as {
      active?: { sessionId?: string } | null;
    } | null;
    if (status?.active?.sessionId !== session.id) {
      return {
        status: 404,
        body: { ok: false, error: "no active joiner for this meeting", success: false },
      };
    }
    const result = (await joiner.sendMeetChat({ text })) as {
      ok?: boolean;
      [key: string]: unknown;
    };
    return { status: result.ok ? 200 : 400, body: { success: Boolean(result.ok), ...result } };
  }
  if (action === "digest") {
    const payload = buildMeetdWebhookPayload(session, {
      ...body,
      event: "meeting.digest",
      transcript: String(body.transcript || ""),
      chatTranscript: String(body.chat_transcript || body.chatTranscript || ""),
      timeFrom: String(body.time_from || body.timeFrom || ""),
      timeTo: String(body.time_to || body.timeTo || ""),
    });
    const webhook = await deliverMeetdWebhook(session, payload, body);
    if (!webhook.ok) return { status: 502, body: { ok: false, status: "digest_failed", webhook } };
    return { status: "digest_delivered", webhook };
  }
  return { status: 404, body: { ok: false, error: "unknown meeting action" } };
}

const service = createJsonServer({
  name: "meeting-agent",
  port: config.meetingPort,
  host: config.meetingHost,
  routes: {
    "GET /health": () => ({ body: { status: "ok" } }),
    "GET /healthz": () => ({
      ok: true,
      service: "meeting-agent",
      state: {
        provider: sessions.provider,
        sessionPath: sessions.path,
        sessionCollection: sessions.collection,
        workerReportProvider: reports.provider,
        workerReportPath: reports.path,
        workerReportCollection: reports.collection,
        meetingArtifactsDir: artifacts.rootDir,
        asrProvider: artifacts.provider,
        digestWebhookConfigured: Boolean(config.digestWebhookUrl),
        recordMeeting: config.recordMeeting,
        meetAudioBackend: config.meetAudioBackend,
        captureCaptions: config.captureCaptions,
        captionLanguage: config.captionLanguage,
        avatarAssetRoot: config.avatarAssetRoot,
        meetdRuntime: {
          pending: meetdStore.listByStatus("pending").length,
          joining: meetdStore.listByStatus("joining").length,
          active: meetdStore.listByStatus("active").length,
          processing: meetdStore.listByStatus("processing").length,
        },
      },
    }),
    "POST /meetings": async ({ body }) => {
      const result = handleMeetdCreateMeeting(body);
      return result?.status ? result : { body: result };
    },
    "GET /meetings": ({ url }) => handleMeetdListMeetings(url),
    "GET /meetings/runtime/status": () => ({
      ok: true,
      counts: {
        pending: meetdStore.listByStatus("pending").length,
        joining: meetdStore.listByStatus("joining").length,
        active: meetdStore.listByStatus("active").length,
        processing: meetdStore.listByStatus("processing").length,
        done: meetdStore.listByStatus("done").length,
        failed: meetdStore.listByStatus("failed").length,
        cancelled: meetdStore.listByStatus("cancelled").length,
      },
      meetings: meetdStore.list().map(meetdMeetingResponse),
    }),
    "POST /meetings/runtime/tick": async ({ body }) => {
      const tickBody = body as MeetingAgentInput;
      const nowValue = tickBody.now || tickBody.at;
      const result = meetdRuntime.tick({
        now: typeof nowValue === "string" ? new Date(nowValue) : new Date(),
        staleMs: Number(tickBody.stale_ms ?? tickBody.staleMs ?? 30 * 60 * 1000),
        dryRunJoiner: Boolean(tickBody.dry_run_joiner ?? tickBody.dryRunJoiner),
      });
      return { body: result };
    },
    "GET /meetings/*": ({ url }) => {
      const { id, action } = parseMeetdCompatPath(url);
      const session = meetdStore.findMeeting(id);
      if (!session) return { status: 404, body: { ok: false, error: "meeting not found" } };
      let result = null;
      if (!action) result = meetdMeetingResponse(session);
      else if (action === "captions") result = handleMeetdGetCaptions(session, url);
      else if (action.startsWith("artifacts/"))
        result = readMeetdArtifact(session, action.replace(/^artifacts\//, ""));
      else result = { status: 404, body: { ok: false, error: "unknown meeting endpoint" } };
      return result?.raw !== undefined || Number.isInteger(result?.status)
        ? result
        : { body: result };
    },
    "POST /meetings/*": async ({ url, body }) => {
      const { id, action } = parseMeetdCompatPath(url);
      const session = meetdStore.findMeeting(id);
      if (!session) return { status: 404, body: { ok: false, error: "meeting not found" } };
      const result = await handleMeetdPostAction(
        session as MeetdSessionShape,
        action,
        body as MeetdWebhookBody,
      );
      return Number.isInteger(result?.status) ? result : { body: result };
    },
    "GET /avatar-assets/*": ({ url }) => serveAvatarAsset(url),
    "GET /meetings/artifacts": () => ({
      ok: true,
      artifactsDir: artifacts.rootDir,
      artifacts: artifacts.listArtifacts(),
    }),
    "GET /meetings/artifact": ({ url }) => {
      const artifact = artifacts.getArtifact(url.searchParams.get("id") || "");
      return { status: artifact ? 200 : 404, body: { ok: Boolean(artifact), artifact } };
    },
    "GET /meetings/artifact/chat": ({ url }) => {
      const chat = artifacts.getArtifactChat(url.searchParams.get("id") || "");
      return { status: chat ? 200 : 404, body: { ok: Boolean(chat), chat } };
    },
    "POST /meetings/post-process": async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await artifacts.postProcessMeeting({
        ...(body as Record<string, unknown>),
        source: String(b.source || "meeting-agent"),
      } as Parameters<typeof artifacts.postProcessMeeting>[0]);
      return { status: result.ok ? 200 : 400, body: result };
    },
    "POST /recordings/ingest": async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await artifacts.postProcessMeeting({
        ...(body as Record<string, unknown>),
        source: String(b.source || "recording-ingest"),
      } as Parameters<typeof artifacts.postProcessMeeting>[0]);
      return { status: result.ok ? 200 : 400, body: result };
    },
    "GET /realtime/config": withInternalControlGuard(() => {
      const tools = meetingAgentRealtimeToolsForRequest();
      return {
        ok: true,
        model: config.openaiRealtimeModel,
        reasoningEffort: config.openaiRealtimeReasoningEffort,
        voice: config.openaiRealtimeVoice,
        turnDetection: config.openaiRealtimeTurnDetection,
        sessionSchema: config.openaiRealtimeSessionSchema,
        instructions: buildRealtimeInstructions({
          botName: config.botName,
          personalityContext: realtimePersonalityContext,
          currentUser,
        }),
        tools,
        session: buildMeetingAgentRealtimeSessionConfig({ botName: config.botName }, config),
      };
    }),
    "POST /tools/*": withInternalControlGuard(async ({ url, body }) => {
      const toolName = decodeURIComponent(url.pathname.replace(/^\/tools\/?/, ""));
      const rejected = realtimeToolRouteRejected(toolName, meetingAgentRealtimeToolsForRequest());
      if (rejected) return rejected;
      if (toolName === "kwwk_computer_use" || toolName === "control_shared_app_window") {
        const b = { ...(body as MeetingAgentInput) };
        if (toolName === "kwwk_computer_use") b.executionMode = "direct";
        const status = await joiner.status().catch(() => null);
        const result = await handleTSAppControlTool(b, status);
        return {
          status: 200,
          body: result,
        };
      }
      const result = await handleWorkspaceTool(toolName, body);
      return result?.status ? result : { body: result };
    }),
    "POST /realtime/client-secret": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await mintRealtimeClientSecret({
        botName: String(b.botName || config.botName),
        model: String(b.model || config.openaiRealtimeModel),
        voice: String(b.voice || config.openaiRealtimeVoice),
        reasoningEffort: b.reasoningEffort,
        reasoning: b.reasoning,
        turnDetection: b.turnDetection,
        sessionSchema: b.sessionSchema as string | undefined,
        outputModalities: (b.outputModalities || b.output_modalities) as string[] | undefined,
        audio: b.audio,
        instructions: b.instructions,
        tools: meetingAgentRealtimeToolsForRequest(b.tools as unknown[] | undefined),
        toolChoice: b.toolChoice as string | undefined,
        safetyIdentifier: String(b.safetyIdentifier || b.requestedBy || "meeting-avatar-bot-local"),
      });
      return { status: result.ok ? 200 : result.dryRun ? 200 : 502, body: result };
    }),
    "GET /sessions": () => ({ ok: true, sessions: sessions.list() }),
    "POST /sessions": async ({ body }) => {
      const b = body as MeetingAgentInput & { startJoiner?: boolean };
      const session = sessions.create({
        source: String(b.source || "slack-agent"),
        meetUrl: String(b.meetUrl || ""),
        avatar: String(b.avatar || "hiyori"),
        requestedBy: String(b.requestedBy || b.sessionId || "unknown"),
      });
      let joinResult = null;
      if (b.startJoiner || b.dryRunJoiner) {
        const installRealtimeBridge = b.installRealtimeBridge !== false;
        const realtimeRuntimePlacement = validateRealtimeRuntimePlacementForJoin(
          b.realtimeRuntimePlacement || config.openaiRealtimeRuntimePlacement || "",
          installRealtimeBridge,
        );
        if (!realtimeRuntimePlacement.ok) {
          return {
            status: realtimeRuntimePlacement.status || 400,
            body: realtimeRuntimePlacement,
          };
        }
        joinResult = await joiner.join({
          sessionId: session.id,
          meetUrl: session.meetUrl,
          botName: String(b.botName || ""),
          dryRun: b.dryRunJoiner !== false,
          allowNonGoogleMeet: Boolean(b.allowNonGoogleMeet),
          collectFixtureState: Boolean(b.collectFixtureState),
          disableLive2D: Boolean(b.disableLive2D),
          workerPollUrl: String(
            b.workerPollUrl || `${config.meetingAgentUrl}/worker/poll-realtime`,
          ),
          workerResultMinCreatedAt: b.workerResultMinCreatedAt as string | undefined,
          installRealtimeBridge: b.installRealtimeBridge !== false,
          installWorkerResultBridge: b.installWorkerResultBridge !== false,
          workerDelegateUrl: b.workerDelegateUrl as string | undefined,
          workerStatusUrl: b.workerStatusUrl as string | undefined,
          realtimeBridgeMode: String(
            b.realtimeBridgeMode ||
              defaultRealtimeBridgeModeForRuntime(
                b.realtimeAgentRuntime || config.openaiRealtimeAgentRuntime,
              ),
          ),
          realtimeAgentRuntime: String(b.realtimeAgentRuntime || config.openaiRealtimeAgentRuntime),
          realtimeRuntimePlacement: realtimeRuntimePlacement.realtimeRuntimePlacement,
          autoConnectRealtime: Boolean(b.autoConnectRealtime),
          includeParticipantAudio: Boolean(b.includeParticipantAudio),
          forwardMeetAudioToRealtime: b.forwardMeetAudioToRealtime !== false,
          realtimeTokenUrl: String(
            b.realtimeTokenUrl || `${config.meetingAgentUrl}/realtime/client-secret`,
          ),
          realtimeSdpUrl: b.realtimeSdpUrl as string | undefined,
          installLocalDialogBridge: Boolean(b.installLocalDialogBridge),
          localDialogTurnUrl: b.localDialogTurnUrl as string | undefined,
          localDialogTtsMode: b.localDialogTtsMode as string | undefined,
          localDialogTtsUrl: b.localDialogTtsUrl as string | undefined,
          localDialogSttProvider: b.localDialogSttProvider as string | undefined,
          localDialogTtsProvider: b.localDialogTtsProvider as string | undefined,
          localDialogTtsGain: b.localDialogTtsGain as number | undefined,
          localDialogAcceptanceUtterance: b.localDialogAcceptanceUtterance as string | undefined,
          installScreenShareBridge: Boolean(b.installScreenShareBridge),
          autoStartScreenShare: Boolean(b.autoStartScreenShare),
          screenShareMode: b.screenShareMode as string | undefined,
          screenShareTitle: b.screenShareTitle as string | undefined,
          screenShareSubtitle: b.screenShareSubtitle as string | undefined,
          screenShareWidth: b.screenShareWidth as number | undefined,
          screenShareHeight: b.screenShareHeight as number | undefined,
          screenShareFps: b.screenShareFps as number | undefined,
          recordMeeting: Boolean(b.recordMeeting ?? config.recordMeeting),
          captureCaptions: Boolean(b.captureCaptions ?? config.captureCaptions),
          captionLanguage: b.captionLanguage as string | undefined,
          artifactsDir: b.artifactsDir as string | undefined,
          meetAudioBackend: b.meetAudioBackend as string | undefined,
        });
      }
      sessions.update(session.id, {
        controlPlaneSessionId: String(b.sessionId || ""),
        status: joinResult ? "joiner_started" : "runtime_planned",
        joinResult,
      });
      return {
        ok: true,
        session: sessions.get(session.id),
        plannedRuntime: {
          joiner: "GoogleMeetJoiner",
          realtimeBridge: "RealtimeProviderBridge",
          avatarRenderer: "Live2DAvatarRenderer",
          agentRunner: config.agentRunner,
          workerReporting: "SlackAgent + provider result injection",
        },
      };
    },
    "POST /join/google-meet": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput & {
        sessionId?: string;
        workerPollUrl?: string;
        workerResultMinCreatedAt?: string;
        workerDelegateUrl?: string;
        workerStatusUrl?: string;
        screenShareMode?: string;
        screenShareTitle?: string;
        screenShareSubtitle?: string;
        screenShareWidth?: number;
        screenShareHeight?: number;
        screenShareFps?: number;
      };
      const installRealtimeBridge = b.installRealtimeBridge !== false;
      const realtimeRuntimePlacement = validateRealtimeRuntimePlacementForJoin(
        b.realtimeRuntimePlacement || config.openaiRealtimeRuntimePlacement || "",
        installRealtimeBridge,
      );
      if (!realtimeRuntimePlacement.ok) {
        return {
          status: realtimeRuntimePlacement.status || 400,
          body: realtimeRuntimePlacement,
        };
      }
      const result = await joiner.join({
        sessionId: String(b.sessionId || ""),
        meetUrl: String(b.meetUrl || ""),
        botName: String(b.botName || ""),
        dryRun: b.dryRun !== false,
        allowNonGoogleMeet: Boolean(b.allowNonGoogleMeet),
        collectFixtureState: Boolean(b.collectFixtureState),
        disableLive2D: Boolean(b.disableLive2D),
        workerPollUrl: b.workerPollUrl || `${config.meetingAgentUrl}/worker/poll-realtime`,
        workerResultMinCreatedAt: b.workerResultMinCreatedAt,
        installRealtimeBridge: b.installRealtimeBridge !== false,
        installWorkerResultBridge: b.installWorkerResultBridge !== false,
        workerDelegateUrl: b.workerDelegateUrl,
        workerStatusUrl: b.workerStatusUrl,
        realtimeInstructions:
          (b.realtimeInstructions as string | undefined) ||
          buildRealtimeInstructions({
            botName: String(b.botName || config.botName),
            personalityContext: realtimePersonalityContext,
            currentUser,
          }),
        realtimeBridgeMode:
          b.realtimeBridgeMode ||
          defaultRealtimeBridgeModeForRuntime(
            b.realtimeAgentRuntime || config.openaiRealtimeAgentRuntime,
          ),
        realtimeAgentRuntime: b.realtimeAgentRuntime || config.openaiRealtimeAgentRuntime,
        realtimeRuntimePlacement: realtimeRuntimePlacement.realtimeRuntimePlacement,
        autoConnectRealtime: Boolean(b.autoConnectRealtime),
        includeParticipantAudio: Boolean(b.includeParticipantAudio),
        forwardMeetAudioToRealtime: b.forwardMeetAudioToRealtime !== false,
        realtimeTokenUrl: b.realtimeTokenUrl || `${config.meetingAgentUrl}/realtime/client-secret`,
        realtimeSdpUrl: b.realtimeSdpUrl,
        installLocalDialogBridge: Boolean(b.installLocalDialogBridge),
        localDialogTurnUrl: b.localDialogTurnUrl,
        localDialogTtsMode: b.localDialogTtsMode,
        localDialogTtsUrl: b.localDialogTtsUrl,
        localDialogSttProvider: b.localDialogSttProvider,
        localDialogTtsProvider: b.localDialogTtsProvider,
        localDialogTtsGain: b.localDialogTtsGain,
        localDialogAcceptanceUtterance: b.localDialogAcceptanceUtterance,
        installScreenShareBridge: Boolean(b.installScreenShareBridge),
        autoStartScreenShare: Boolean(b.autoStartScreenShare),
        screenShareMode: b.screenShareMode,
        screenShareTitle: b.screenShareTitle,
        screenShareSubtitle: b.screenShareSubtitle,
        screenShareWidth: b.screenShareWidth,
        screenShareHeight: b.screenShareHeight,
        screenShareFps: b.screenShareFps,
        recordMeeting: Boolean(b.recordMeeting ?? config.recordMeeting),
        captureCaptions: Boolean(b.captureCaptions ?? config.captureCaptions),
        captionLanguage: b.captionLanguage,
        artifactsDir: b.artifactsDir,
        meetAudioBackend: b.meetAudioBackend,
      });
      return { ok: true, result };
    }),
    "GET /dialog/providers": () => ({
      ok: true,
      stt: {
        provider: config.sttProvider,
        note: "event provider is the default seam; browser/native STT providers can dispatch meeting-avatar-local-utterance.",
      },
      tts: {
        provider: ttsProvider.provider,
        route: "/tts/synthesize",
      },
      agentRunner: config.agentRunner,
    }),
    "POST /tts/synthesize": async ({ body }) => {
      const b = body as MeetingAgentInput & {
        voice?: string;
        format?: string;
        durationMs?: number;
        frequency?: number;
        gain?: number;
        context?: Record<string, unknown>;
      };
      const result = await ttsProvider.synthesize({
        text: String(b.text || ""),
        voice: b.voice,
        format: b.format,
        durationMs: b.durationMs,
        frequency: b.frequency,
        gain: b.gain,
        context: (b.context as Record<string, unknown>) || {},
      });
      return { status: result.ok ? 200 : 400, body: result };
    },
    "GET /join/status": withInternalControlGuard(() => joiner.status()),
    "POST /join/stop": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await joiner.stop(String(b.reason || "api_stop"));
      return { ok: true, result };
    }),
    "GET /screen-share/apps": withInternalControlGuard(async () => {
      const result = await joiner.listShareableApps();
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "POST /screen-share/apps": withInternalControlGuard(async () => {
      const result = await joiner.listShareableApps();
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "POST /screen-share/app": withInternalControlGuard(async ({ body }) => {
      const result = await joiner.presentAppShare(
        body as Parameters<typeof joiner.presentAppShare>[0],
      );
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "POST /screen-share/start": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput & {
        title?: string;
        screenShareTitle?: string;
        subtitle?: string;
        screenShareSubtitle?: string;
      };
      const result = await joiner.startScreenShare({
        title: b.title || b.screenShareTitle,
        subtitle: b.subtitle || b.screenShareSubtitle,
        preview: Boolean(b.preview),
      });
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "POST /screen-share/present": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput & {
        title?: string;
        screenShareTitle?: string;
        subtitle?: string;
        screenShareSubtitle?: string;
        screenShareMode?: string;
        waitMs?: number;
      };
      const result = await joiner.presentScreenShare({
        title: b.title || b.screenShareTitle,
        subtitle: b.subtitle || b.screenShareSubtitle,
        preview: Boolean(b.preview),
        mode: b.mode || b.screenShareMode,
        waitMs: b.waitMs,
      });
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "POST /screen-share/video": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput & {
        videoUrl?: string;
        title?: string;
        screenShareTitle?: string;
        subtitle?: string;
        screenShareSubtitle?: string;
        stageTitle?: string;
        screenShareMode?: string;
        screenShareWidth?: number;
        screenShareHeight?: number;
        waitMs?: number;
      };
      const rawVideoUrl = String(b.videoUrl || b.url || b.path || "");
      const videoUrl = isLocalVideoPath(rawVideoUrl)
        ? stageVideoAssetUrl(rawVideoUrl)
        : rawVideoUrl;
      const result = await joiner.presentVideoStage({
        videoUrl,
        title: b.title || b.screenShareTitle || "Onee Sama video stage",
        subtitle: b.subtitle || b.screenShareSubtitle || "Shared by Onee Sama",
        stageTitle: b.stageTitle || "Meeting Avatar Bot",
        width: Number(b.width || b.screenShareWidth || 1280),
        height: Number(b.height || b.screenShareHeight || 720),
        mode: b.mode || b.screenShareMode || "synthetic",
        muted: b.muted !== false,
        waitMs: b.waitMs,
      });
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "GET /stage-media/video": ({ url }) => {
      const filePath = resolve(String(url.searchParams.get("path") || ""));
      const allowedRoots = [
        resolve("tmp"),
        resolve(config.dataDir),
        resolve(config.meetingArtifactsDir),
        "/tmp",
      ];
      const allowed = allowedRoots.some((root) => {
        const rel = relative(root, filePath);
        return rel && !rel.startsWith("..") && !rel.startsWith("/");
      });
      if (!allowed)
        return { status: 403, body: { ok: false, error: "stage_video_path_forbidden" } };
      if (!existsSync(filePath))
        return { status: 404, body: { ok: false, error: "stage_video_not_found" } };
      return {
        raw: readFileSync(filePath),
        contentType: videoContentType(filePath),
      };
    },
    "POST /screen-share/stop": withInternalControlGuard(async () => {
      const result = await joiner.stopScreenShare();
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "POST /realtime/event": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      const event = realtimeEventPayload(b.event || b);
      const validation = validateHostRealtimeEvent(event);
      if (!validation.ok) return { status: 400, body: validation };
      const result = await joiner.sendRealtimeEvent(event);
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "POST /realtime/text-turn": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await joiner.requestRealtimeTextTurn({
        text: String(b.text || ""),
        instructions: String(b.instructions || ""),
      });
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "POST /meet/chat": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await joiner.sendMeetChat({
        text: String(b.text || b.message || ""),
      });
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "GET /meet/chat": withInternalControlGuard(async ({ url }) => {
      const result = await joiner.readMeetChat({
        limit: Number(url.searchParams.get("limit") || 10),
        onlyLinks: ["1", "true", "yes"].includes(
          String(url.searchParams.get("onlyLinks") || "").toLowerCase(),
        ),
      });
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "POST /meet/chat/read": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await joiner.readMeetChat({
        limit: Number(b.limit || b.count || 10),
        onlyLinks: Boolean(b.onlyLinks || b.only_links),
      });
      return { status: result.ok ? 200 : 400, body: result };
    }),
    "POST /worker/report": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput & { result?: unknown; task?: string };
      const resultText =
        typeof b.result === "string" ? b.result : b.result ? JSON.stringify(b.result) : "";
      const context = workerContext(b.context);
      const job = reports.create({
        id: String(b.id || b.jobId || ""),
        status: String(b.status || "completed"),
        provider: String(b.provider || ""),
        mode: String(b.mode || ""),
        task: String(b.task || ""),
        context,
        result: resultText,
        error: String(b.error || ""),
      });
      const status = (await joiner.status()) as { active?: { sessionId?: string } | null };
      const activeSessionId = String(status.active?.sessionId || "");
      const suppressChannel = activeSessionId
        ? realtimeSuppressChannelForContext(context, activeSessionId)
        : "";
      const realtimeDelivery = suppressChannel
        ? suppressedRealtimeDelivery(suppressChannel)
        : await joiner.injectWorkerResult(job);
      if (realtimeDeliverySuppressed(realtimeDelivery)) {
        reports.update(job.id, {
          deliveredToRealtime: false,
          realtimeSuppressed: true,
          realtimeDeliveryAttempt: null,
          realtimeDelivery: {
            channel: String(realtimeDelivery.channel || ""),
            suppressed: true,
            reason: realtimeDeliverySuppressionReason(realtimeDelivery),
            suppressedAt: new Date().toISOString(),
          },
        });
      } else if (realtimeDelivery.ok) {
        reports.update(job.id, {
          deliveredToRealtime: true,
          realtimeSuppressed: false,
          realtimeDelivery: {
            channel: realtimeDelivery.channel || "",
            deliveredAt: new Date().toISOString(),
          },
        });
      }
      return { ok: true, job: reports.get(job.id) || job, realtimeDelivery };
    }),
    "POST /worker/delegate": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      const job = await runner.startTask({
        task: String(b.task || ""),
        context: (b.context as Record<string, unknown>) || {},
        mode: String(b.mode || "analysis"),
        allowCodeChanges: Boolean(b.allowCodeChanges),
      });
      const report = reportFinishedWorkerJob(job);
      return { ok: true, job, report };
    }),
    "POST /dialog/turn": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput & { timeoutMs?: number };
      const utterance = String(b.utterance || b.text || "").trim();
      if (!utterance) return { status: 400, body: { ok: false, error: "utterance_required" } };
      const job = await runner.startTask({
        task: utterance,
        context: {
          ...(b.context as Record<string, unknown>),
          sessionId: String(b.sessionId || ""),
          source: "meeting-local-dialog",
        },
        mode: String(b.mode || "dialog"),
        allowCodeChanges: Boolean(b.allowCodeChanges),
      });
      const completed = await waitForRunnerJob(job.id, Number(b.timeoutMs || 30_000));
      const report = completed ? reportFinishedWorkerJob(completed) : null;
      return {
        body: {
          ok: Boolean(completed),
          provider: completed?.provider || job.provider || config.agentRunner,
          status: completed?.status || "timeout",
          responseText: completed?.result || "",
          job: completed || job,
          report,
        },
      };
    }),
    "POST /worker/status": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      const jobId = String(b.jobId || b.id || "");
      const job = jobId ? runner.getJob(jobId) || reports.get(jobId) : null;
      return {
        ok: true,
        job,
        jobs: job ? [job] : reports.list(),
      };
    }),
    "GET /worker/jobs": withInternalControlGuard(() => ({ ok: true, jobs: reports.list() })),
    "POST /worker/poll-realtime": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      return {
        ok: true,
        jobs: reports.pollReadyForRealtime({
          limit: Number.parseInt(String(b.limit ?? "1"), 10),
          markDelivered: b.markDelivered !== false,
          minCreatedAt: String(b.minCreatedAt || ""),
          sessionId: String(b.sessionId || b.session_id || ""),
        }),
      };
    }),
    "POST /worker/mark-realtime-delivered": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      const jobId = String(b.jobId || b.job_id || b.id || "");
      const existing = jobId ? reports.get(jobId) : null;
      const expectedToken = String(
        (existing?.realtimeDeliveryAttempt as { token?: string } | undefined)?.token || "",
      );
      const deliveryToken = String(b.deliveryToken || b.delivery_token || b.token || "");
      if (!existing || !expectedToken || deliveryToken !== expectedToken) {
        return {
          status: 409,
          body: {
            ok: false,
            job: existing || null,
            error: "realtime_delivery_attempt_token_required",
          },
        };
      }
      const job = reports.markRealtimeDelivered(jobId, {
        channel: String(b.channel || ""),
        deliveryToken,
      });
      return { status: job ? 200 : 404, body: { ok: Boolean(job), job } };
    }),
    "POST /worker/poll-slack": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput;
      return {
        ok: true,
        jobs: reports.pollReadyForSlack({
          limit: Number.parseInt(String(b.limit ?? "10"), 10),
          markDelivered: b.markDelivered !== false,
        }),
      };
    }),
    "POST /worker/mark-slack-delivered": withInternalControlGuard(async ({ body }) => {
      const b = body as MeetingAgentInput & { ts?: string };
      const jobId = String(b.jobId || b.id || "");
      const job = jobId
        ? reports.update(jobId, {
            deliveredToSlack: true,
            slackDelivery: {
              channel: String(b.channel || ""),
              threadTs: String(b.threadTs || ""),
              ts: String(b.ts || ""),
              dedupKey: String(b.dedupKey || ""),
              mock: Boolean(b.mock),
              deliveredAt: new Date().toISOString(),
            },
          })
        : null;
      return { status: job ? 200 : 404, body: { ok: Boolean(job), job } };
    }),
  },
});

await service.listen();
