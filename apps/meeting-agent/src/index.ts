import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fetchJson, type UpstreamError } from "../../../packages/core/src/http-fetch-json.js";
import { createJsonServer } from "../../../packages/core/src/http-json.js";
import { getRuntimeConfig } from "../../../packages/core/src/env.js";
import { createPersistentSessionStore } from "../../../packages/core/src/session-store.js";
import { createGoogleMeetJoiner } from "../../../packages/core/src/meeting/google-meet-joiner.js";
import { createAgentRunner } from "../../../packages/core/src/agent-runner/agent-runner.js";
import { mintRealtimeClientSecret } from "../../../packages/core/src/realtime/realtime-token.js";
import {
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  realtimeToolSchemas,
} from "../../../packages/core/src/realtime/realtime-contract.js";
import { resolveSpeakerIdentity } from "../../../packages/core/src/realtime/speaker-identity.js";
import { createWorkerReportStore } from "../../../packages/core/src/realtime/worker-report-store.js";
import { createTtsProvider } from "../../../packages/core/src/dialog/tts-provider.js";
import { createMeetingArtifactPipeline } from "../../../packages/core/src/meeting/post-meeting-artifacts.js";
import { sendDigestWebhook } from "../../../packages/core/src/meeting/digest-webhook.js";
import {
  createMeetdRuntime,
  createMeetdRuntimeStore,
  meetdMeetingResponse,
} from "../../../packages/core/src/meeting/meetd-runtime-store.js";

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
const ttsProvider = createTtsProvider();
const artifacts = createMeetingArtifactPipeline({
  rootDir: config.meetingArtifactsDir,
  asrProvider: config.asrProvider,
});
const meetdStore = createMeetdRuntimeStore({ sessions });
const meetdRuntime = createMeetdRuntime({ store: meetdStore });
const workspaceMemory = new Map();
const workspaceCredentialFile = process.env.MAB_WORKSPACE_TOOLS_ENV_FILE || "";
let workspaceCredsCache = null;
const googleTokenCache = { value: "", expiresAt: 0 };

function isLocalVideoPath(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false;
  return /\.(mp4|webm|mov|m4v)$/i.test(raw);
}

function stageVideoAssetUrl(filePath = "") {
  const resolved = resolve(String(filePath || ""));
  return `${config.meetingAgentUrl}/stage-media/video?path=${encodeURIComponent(resolved)}`;
}

function videoContentType(filePath = "") {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  return "video/mp4";
}

function readEnvVarFromFile(filePath, key) {
  try {
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith(`${key}=`)) continue;
      return line
        .slice(key.length + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
    }
  } catch {
    return "";
  }
  return "";
}

function getWorkspaceCreds() {
  if (workspaceCredsCache) return workspaceCredsCache;
  const fromEnvOrFile = (key) =>
    process.env[key] || readEnvVarFromFile(workspaceCredentialFile, key);
  workspaceCredsCache = {
    linearApiKey: fromEnvOrFile("LINEAR_API_KEY"),
    slackBotToken: fromEnvOrFile("SLACK_BOT_TOKEN"),
    googleClientId: fromEnvOrFile("GOOGLE_CLIENT_ID"),
    googleClientSecret: fromEnvOrFile("GOOGLE_CLIENT_SECRET"),
    googleRefreshToken: fromEnvOrFile("GOOGLE_REFRESH_TOKEN"),
    notionToken: fromEnvOrFile("NOTION_TOKEN"),
    githubToken: fromEnvOrFile("GH_TOKEN") || fromEnvOrFile("GITHUB_TOKEN"),
  };
  return workspaceCredsCache;
}

function loadSlackAgentPersonalityContext() {
  if (config.realtimePersonalityContext) return config.realtimePersonalityContext;
  if (!config.slackMemoryEnabled) return "";
  const memoryPath = join(config.slackMemoryDir, "workspace", "MEMORY.md");
  if (!existsSync(memoryPath)) return "";
  const raw = readFileSync(memoryPath, "utf8");
  const headings = [
    "## Team Conventions",
    "## Triage Behavior",
    "## Company Identity",
    "## Cross-Platform Identity Notes",
    "## Bot Self-Growth",
    "## Conversation Hygiene",
  ];
  const sections = [];
  for (const heading of headings) {
    const start = raw.indexOf(heading);
    if (start < 0) continue;
    const next = raw.indexOf("\n## ", start + heading.length);
    sections.push(raw.slice(start, next >= 0 ? next : raw.length).trim());
  }
  return sections.join("\n\n").slice(0, 4000);
}

/**
 * Permissive shape for the meeting-agent HTTP body. The agent accepts a wide
 * mix of camelCase/snake_case fields across many tool routes; we list the
 * known ones with optional types and keep an index signature for forward
 * compatibility.
 */
export interface MeetingAgentInput {
  url?: string;
  useJina?: boolean;
  use_jina?: boolean;
  maxChars?: number | string;
  max_chars?: number | string;
  maxAttempts?: number | string;
  max_attempts?: number | string;
  maxResults?: number | string;
  max_results?: number | string;
  query?: string;
  limit?: number | string;
  count?: number | string;
  user?: string;
  data?: unknown;
  channel?: string;
  message?: string;
  meet_url?: string;
  meetUrl?: string;
  meetingId?: string;
  meeting_id?: string;
  jobId?: string;
  job_id?: string;
  id?: string;
  key?: string;
  kind?: string;
  mode?: string;
  model?: string;
  event?: unknown;
  format?: string;
  reasoning?: unknown;
  reasoningEffort?: string;
  reasoning_effort?: string;
  output_modalities?: string[];
  outputModalities?: string[];
  voice?: string;
  audio?: unknown;
  avatar?: unknown;
  context?: unknown;
  task?: string;
  text?: string;
  utterance?: string;
  reason?: string;
  preview?: boolean;
  dryRun?: boolean;
  dry_run_joiner?: boolean;
  dryRunJoiner?: boolean;
  recordMeeting?: boolean;
  installLocalDialogBridge?: boolean;
  installRealtimeBridge?: boolean;
  installScreenShareBridge?: boolean;
  installWorkerResultBridge?: boolean;
  realtimeBridgeMode?: string;
  realtimeFallbackToLocalMic?: boolean;
  realtimeInstructions?: string;
  realtimeSdpUrl?: string;
  realtimeTokenUrl?: string;
  meetAudioBackend?: string;
  forwardMeetAudioToRealtime?: boolean;
  includeParticipantAudio?: boolean;
  autoConnectRealtime?: boolean;
  autoStartScreenShare?: boolean;
  botName?: string;
  captureCaptions?: boolean;
  captionLanguage?: string;
  disableLive2D?: boolean;
  collectFixtureState?: boolean;
  allowNonGoogleMeet?: boolean;
  artifactsDir?: string;
  localDialogTurnUrl?: string;
  localDialogSttProvider?: string;
  localDialogTtsProvider?: string;
  localDialogTtsMode?: string;
  localDialogTtsUrl?: string;
  localDialogTtsGain?: number;
  localDialogAcceptanceUtterance?: string;
  dedupKey?: string;
  markDelivered?: boolean;
  minCreatedAt?: string;
  mock?: boolean;
  muted?: boolean;
  now?: string;
  onlyLinks?: boolean;
  only_links?: boolean;
  path?: string;
  durationMs?: number;
  frequency?: number;
  gain?: number;
  height?: number;
  instructions?: string;
  at?: string;
  allowCodeChanges?: boolean;
  chat_transcript?: string;
  chatTranscript?: string;
  result?: string | Record<string, unknown>;
  error?: string;
  status?: string;
  [key: string]: unknown;
}

function toolFailure(error: unknown, fallback = "workspace_tool_failed") {
  const err = (error || {}) as UpstreamError;
  return {
    ok: false,
    error: err?.message || fallback,
    status: err?.status,
    detail: err?.payload?.error || err?.payload?.detail || err?.payload?.message || "",
  };
}

function buildJinaReaderUrl(rawUrl: unknown): string {
  const url = String(rawUrl || "").trim();
  return `https://r.jina.ai/${url}`;
}

async function handleFetchUrl(body: MeetingAgentInput = {}) {
  const url = String(body.url || "").trim();
  if (!url) return { status: 400, body: { ok: false, error: "url required" } };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_url", url } };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { status: 400, body: { ok: false, error: "unsupported_url_protocol", url } };
  }

  const useJina = body.useJina !== false && body.use_jina !== false;
  const targetUrl = useJina ? buildJinaReaderUrl(url) : url;
  const maxChars = Math.max(1000, Math.min(Number(body.maxChars || body.max_chars || 8000), 20000));
  try {
    const response = await fetch(targetUrl, {
      headers: {
        accept: "text/plain, text/markdown, */*",
        "user-agent": "meeting-avatar-bot/1.0",
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(20_000) : undefined,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      url,
      reader: useJina ? "jina" : "direct",
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
    };
  } catch (error) {
    return {
      status: 502,
      body: {
        ok: false,
        url,
        reader: useJina ? "jina" : "direct",
        error: error?.message || "fetch_url_failed",
      },
    };
  }
}

async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (googleTokenCache.value && googleTokenCache.expiresAt > now + 60)
    return googleTokenCache.value;
  const creds = getWorkspaceCreds();
  if (!creds.googleClientId || !creds.googleRefreshToken) {
    throw new Error("google_credentials_missing");
  }
  const body = new URLSearchParams({
    client_id: creds.googleClientId,
    client_secret: creds.googleClientSecret || "",
    refresh_token: creds.googleRefreshToken,
    grant_type: "refresh_token",
  });
  const data: Record<string, any> = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  googleTokenCache.value = data.access_token || "";
  googleTokenCache.expiresAt = now + Number(data.expires_in || 3600);
  return googleTokenCache.value;
}

async function callLinearGraphql<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const creds = getWorkspaceCreds();
  if (!creds.linearApiKey) throw new Error("LINEAR_API_KEY missing");
  return fetchJson("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: creds.linearApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
}

async function handleSearchTeamMembers(body: MeetingAgentInput = {}) {
  const query = String(body.query || "").trim();
  if (!query) return { status: 400, body: { ok: false, error: "query is required" } };
  try {
    const data: Record<string, any> = await callLinearGraphql(`
      query Users { users(first: 100) { nodes { id name displayName email active } } }
    `);
    const nodes = data?.data?.users?.nodes || [];
    const candidates = nodes
      .filter((node) => node.active)
      .map((node) => ({
        linear_assignee: String(node.email || node.displayName || node.name || "").split("@")[0],
        name: node.name,
        display_name: node.displayName,
        email: node.email,
        active: node.active,
      }));
    return { ok: true, query, candidates, count: candidates.length };
  } catch (error) {
    return { status: error.status || 500, body: toolFailure(error, "linear_users_upstream") };
  }
}

async function handleLinearQuery(body: MeetingAgentInput = {}) {
  const query = String(body.query || "").trim();
  const limit = Math.min(Number(body.limit || 5), 10);
  if (!query) return { status: 400, body: { ok: false, error: "query is required" } };
  try {
    const data: Record<string, any> = await callLinearGraphql(
      `
      query Search($q: String!, $first: Int!) {
        searchIssues(term: $q, first: $first) {
          nodes {
            id identifier title
            state { name }
            assignee { name }
            priority url updatedAt
          }
        }
      }
    `,
      { q: query, first: limit },
    );
    const nodes = data?.data?.searchIssues?.nodes || [];
    return {
      ok: true,
      results: nodes.map((node) => ({
        id: node.identifier,
        title: node.title,
        state: node.state?.name,
        assignee: node.assignee?.name,
        priority: node.priority,
        url: node.url,
        updatedAt: node.updatedAt,
      })),
      count: nodes.length,
    };
  } catch (error) {
    return { status: error.status || 500, body: toolFailure(error, "linear_upstream") };
  }
}

async function handleLinearUserIssues(body: MeetingAgentInput = {}) {
  const user = String(body.user || "").trim();
  if (!user) return { status: 400, body: { ok: false, error: "user required" } };
  const usersToTry = [user];
  if (!user.includes("@") && config.workspaceEmailDomain) {
    usersToTry.push(`${user}@${config.workspaceEmailDomain}`);
  }
  const seen = new Set();
  const results = [];
  try {
    for (const email of usersToTry) {
      const data: Record<string, any> = await callLinearGraphql(
        `
        query MyIssues($email: String!) {
          issues(
            first: 20
            filter: {
              assignee: { or: [{email: {eqIgnoreCase: $email}}, {displayName: {eqIgnoreCase: $email}}, {name: {eqIgnoreCase: $email}}] }
              state: { type: { nin: ["completed", "canceled"] } }
            }
            orderBy: updatedAt
          ) {
            nodes {
              id identifier title
              state { name type }
              priority url updatedAt
              project { name }
            }
          }
        }
      `,
        { email },
      );
      for (const node of data?.data?.issues?.nodes || []) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        results.push({
          id: node.identifier,
          title: node.title,
          state: node.state?.name,
          state_type: node.state?.type,
          priority: node.priority,
          project: node.project?.name,
          url: node.url,
          updatedAt: node.updatedAt,
        });
      }
    }
    return { ok: true, user_query: user, results, count: results.length };
  } catch (error) {
    return { status: error.status || 500, body: toolFailure(error, "linear_user_issues_upstream") };
  }
}

async function handleSlackSearch(body: MeetingAgentInput = {}) {
  const creds = getWorkspaceCreds();
  if (!creds.slackBotToken)
    return { status: 500, body: { ok: false, error: "SLACK_BOT_TOKEN missing" } };
  const query = String(body.query || "").trim();
  if (!query) return { status: 400, body: { ok: false, error: "query is required" } };
  const count = Math.min(Number(body.count || 5), 10);
  try {
    const params = new URLSearchParams({
      query,
      count: String(count),
      sort: "timestamp",
      sort_dir: "desc",
    });
    const data: Record<string, any> = await fetchJson(
      `https://slack.com/api/search.messages?${params}`,
      {
        headers: { authorization: `Bearer ${creds.slackBotToken}` },
      },
    );
    if (data.ok === false)
      return { status: 502, body: { ok: false, error: data.error || "slack_search_failed" } };
    const matches = data?.messages?.matches || [];
    return {
      ok: true,
      results: matches.slice(0, count).map((item) => ({
        channel: item.channel?.name || item.channel?.id || "",
        user: item.user_name || item.username || "",
        text: item.text || "",
        permalink: item.permalink || "",
        ts: item.ts || "",
      })),
      count: matches.length,
    };
  } catch (error) {
    return { status: error.status || 500, body: toolFailure(error, "slack_search_upstream") };
  }
}

async function handleNotionSearch(body: MeetingAgentInput = {}) {
  const creds = getWorkspaceCreds();
  if (!creds.notionToken)
    return { status: 500, body: { ok: false, error: "NOTION_TOKEN missing" } };
  const query = String(body.query || "").trim();
  if (!query) return { status: 400, body: { ok: false, error: "query is required" } };
  try {
    const data: Record<string, any> = await fetchJson("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.notionToken}`,
        "notion-version": "2022-06-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, page_size: 5 }),
    });
    return {
      ok: true,
      results: ((data.results as Record<string, any>[]) || []).map((item) => {
        const titleProp = Object.values(
          (item.properties as Record<
            string,
            { type?: string; title?: { plain_text?: string }[] }
          >) || {},
        ).find((prop) => prop?.type === "title");
        const titleItems = Array.isArray(titleProp?.title) ? titleProp!.title : [];
        const title = titleItems.length
          ? titleItems.map((part) => part.plain_text || "").join("")
          : item.url || "";
        return { id: item.id, title, url: item.url, object: item.object };
      }),
      count: (data.results || []).length,
    };
  } catch (error) {
    return { status: error.status || 500, body: toolFailure(error, "notion_upstream") };
  }
}

async function handleGithubSearch(body: MeetingAgentInput = {}) {
  const creds = getWorkspaceCreds();
  if (!creds.githubToken) return { status: 500, body: { ok: false, error: "GH_TOKEN missing" } };
  const query = String(body.query || "").trim();
  if (!query) return { status: 400, body: { ok: false, error: "query is required" } };
  const kind = ["issues", "repos", "code"].includes(body.kind) ? body.kind : "issues";
  const endpoint = {
    issues: "https://api.github.com/search/issues",
    repos: "https://api.github.com/search/repositories",
    code: "https://api.github.com/search/code",
  }[kind];
  try {
    const data: Record<string, any> = await fetchJson(
      `${endpoint}?q=${encodeURIComponent(query)}&per_page=5`,
      {
        headers: {
          authorization: `Bearer ${creds.githubToken}`,
          accept: "application/vnd.github+json",
        },
      },
    );
    return {
      ok: true,
      results: (data.items || []).slice(0, 5).map((item) => ({
        title: item.title || item.name,
        url: item.html_url,
        state: item.state,
        repo: String(item.repository_url || "")
          .split("/repos/")
          .pop(),
        user: item.user?.login,
      })),
      count: data.total_count || (data.items || []).length,
    };
  } catch (error) {
    return { status: error.status || 500, body: toolFailure(error, "github_upstream") };
  }
}

async function handleGoogleCalendar(body: MeetingAgentInput = {}) {
  const maxResults = Math.min(Number(body.max_results || 10), 20);
  const tz = "Asia/Shanghai";
  const timeMin = String(body.time_min || new Date().toISOString());
  const timeMax = String(
    body.time_max || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  );
  try {
    const token = await getGoogleAccessToken();
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      maxResults: String(maxResults),
      singleEvents: "true",
      orderBy: "startTime",
      timeZone: tz,
    });
    const data: Record<string, any> = await fetchJson(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    return {
      ok: true,
      results: ((data.items as Record<string, any>[]) || []).map((event) => ({
        id: event.id,
        summary: event.summary,
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        hangoutLink: event.hangoutLink,
        attendees: ((event.attendees as Record<string, any>[]) || []).map((attendee) => ({
          email: attendee.email,
          name: attendee.displayName,
        })),
      })),
      count: ((data.items as unknown[]) || []).length,
    };
  } catch (error) {
    const err = error as UpstreamError;
    return { status: err?.status || 500, body: toolFailure(error, "calendar_upstream") };
  }
}

async function handleCalendarAttendees(body: MeetingAgentInput = {}) {
  const meetUrl = String(body.meet_url || body.meetUrl || "").trim();
  if (!meetUrl) return { status: 400, body: { ok: false, error: "meet_url required" } };
  const match = (await handleGoogleCalendar({
    time_min: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    time_max: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    max_results: 50,
  })) as {
    ok?: boolean;
    status?: number;
    results?: Array<{
      hangoutLink?: string;
      summary?: string;
      start?: unknown;
      attendees?: unknown[];
      [key: string]: unknown;
    }>;
  };
  if (match.status) return match;
  const meetId = meetUrl.replace(/\/$/, "");
  const suffix = meetId.split("/").pop()?.split("?")[0] || "";
  const event = (match.results || []).find((item) =>
    String(item.hangoutLink || "").includes(suffix),
  );
  if (!event) return { ok: true, found: false, attendees: [] };
  return {
    ok: true,
    found: true,
    event_summary: event.summary,
    start: event.start,
    attendees: event.attendees || [],
  };
}

async function handleWorkspaceTool(toolName: string, body: MeetingAgentInput = {}) {
  if (toolName === "current_user_identity") {
    return {
      ok: true,
      current_user: {
        name: currentUser.name,
        english_name: currentUser.englishName,
        preferred_address: currentUser.name,
        email: currentUser.email,
        linear: currentUser.linear,
        github: currentUser.github,
        role: currentUser.role,
      },
      answer_hint_zh: `当前和你说话的人是 ${currentUser.name}（英文账号 ${currentUser.englishName}）。他的 Linear 是 ${currentUser.linear}，GitHub 是 ${currentUser.github}。`,
    };
  }
  if (toolName === "resolve_speaker_identity") {
    const displayName = String(body.display_name || body.displayName || body.name || "").trim();
    if (!displayName) return { status: 400, body: { ok: false, error: "display_name required" } };
    const identity = resolveSpeakerIdentity(displayName, currentUser);
    return {
      ok: Boolean(identity),
      display_name: displayName,
      source: String(body.source || "unknown"),
      identity,
      answer_hint_zh: identity?.resolved
        ? `当前说话者可按 ${identity.preferredName || identity.canonicalName} 理解。`
        : "无法可靠匹配工作区身份；请简短确认对方是谁，不要猜测。",
    };
  }
  if (toolName === "search_team_members") return handleSearchTeamMembers(body);
  if (toolName === "linear_query") return handleLinearQuery(body);
  if (toolName === "linear_user_issues") return handleLinearUserIssues(body);
  if (toolName === "slack_search") return handleSlackSearch(body);
  if (toolName === "notion_search") return handleNotionSearch(body);
  if (toolName === "github_search") return handleGithubSearch(body);
  if (toolName === "google_calendar") return handleGoogleCalendar(body);
  if (toolName === "calendar_attendees") return handleCalendarAttendees(body);
  if (toolName === "fetch_url") return handleFetchUrl(body);
  if (toolName === "memory_write") {
    const key = String(body.key || "").trim();
    if (!key) return { status: 400, body: { ok: false, error: "key required" } };
    workspaceMemory.set(key, (body as { value?: unknown }).value);
    return { ok: true, key, value: (body as { value?: unknown }).value };
  }
  if (toolName === "memory_read") {
    const key = String(body.key || "").trim();
    if (key) return { ok: true, key, value: workspaceMemory.get(key) };
    return { ok: true, memory: Object.fromEntries(workspaceMemory.entries()) };
  }
  if (toolName === "now")
    return {
      ok: true,
      timezone: "Asia/Shanghai",
      now: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }),
    };
  return { status: 404, body: { ok: false, error: "unknown_workspace_tool", toolName } };
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
    await new Promise((resolve) => setTimeout(resolve, 150));
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
    "GET /realtime/config": () => ({
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
      tools: realtimeToolSchemas,
      session: buildRealtimeSessionConfig({ botName: config.botName }, config),
    }),
    "POST /tools/*": async ({ url, body }) => {
      const toolName = decodeURIComponent(url.pathname.replace(/^\/tools\/?/, ""));
      const result = await handleWorkspaceTool(toolName, body);
      return result?.status ? result : { body: result };
    },
    "POST /realtime/client-secret": async ({ body }) => {
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
        tools: b.tools as unknown[] | undefined,
        toolChoice: b.toolChoice as string | undefined,
        safetyIdentifier: String(b.safetyIdentifier || b.requestedBy || "meeting-avatar-bot-local"),
      });
      return { status: result.ok ? 200 : result.dryRun ? 200 : 502, body: result };
    },
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
          realtimeBridgeMode: String(b.realtimeBridgeMode || "mock"),
          autoConnectRealtime: Boolean(b.autoConnectRealtime),
          includeParticipantAudio: Boolean(b.includeParticipantAudio),
          forwardMeetAudioToRealtime: b.forwardMeetAudioToRealtime !== false,
          realtimeFallbackToLocalMic: Boolean(b.realtimeFallbackToLocalMic),
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
    "POST /join/google-meet": async ({ body }) => {
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
        realtimeBridgeMode: b.realtimeBridgeMode || "mock",
        autoConnectRealtime: Boolean(b.autoConnectRealtime),
        includeParticipantAudio: Boolean(b.includeParticipantAudio),
        forwardMeetAudioToRealtime: b.forwardMeetAudioToRealtime !== false,
        realtimeFallbackToLocalMic: Boolean(b.realtimeFallbackToLocalMic),
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
    },
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
    "GET /join/status": () => joiner.status(),
    "POST /join/stop": async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await joiner.stop(String(b.reason || "api_stop"));
      return { ok: true, result };
    },
    "POST /screen-share/start": async ({ body }) => {
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
    },
    "POST /screen-share/present": async ({ body }) => {
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
    },
    "POST /screen-share/video": async ({ body }) => {
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
    },
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
    "POST /screen-share/stop": async () => {
      const result = await joiner.stopScreenShare();
      return { status: result.ok ? 200 : 400, body: result };
    },
    "POST /realtime/event": async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await joiner.sendRealtimeEvent(b.event || b);
      return { status: result.ok ? 200 : 400, body: result };
    },
    "POST /realtime/text-turn": async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await joiner.requestRealtimeTextTurn({
        text: String(b.text || ""),
        instructions: String(b.instructions || ""),
      });
      return { status: result.ok ? 200 : 400, body: result };
    },
    "POST /meet/chat": async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await joiner.sendMeetChat({
        text: String(b.text || b.message || ""),
      });
      return { status: result.ok ? 200 : 400, body: result };
    },
    "GET /meet/chat": async ({ url }) => {
      const result = await joiner.readMeetChat({
        limit: Number(url.searchParams.get("limit") || 10),
        onlyLinks: ["1", "true", "yes"].includes(
          String(url.searchParams.get("onlyLinks") || "").toLowerCase(),
        ),
      });
      return { status: result.ok ? 200 : 400, body: result };
    },
    "POST /meet/chat/read": async ({ body }) => {
      const b = body as MeetingAgentInput;
      const result = await joiner.readMeetChat({
        limit: Number(b.limit || b.count || 10),
        onlyLinks: Boolean(b.onlyLinks || b.only_links),
      });
      return { status: result.ok ? 200 : 400, body: result };
    },
    "POST /worker/report": async ({ body }) => {
      const b = body as MeetingAgentInput & { result?: unknown; task?: string };
      const resultText =
        typeof b.result === "string" ? b.result : b.result ? JSON.stringify(b.result) : "";
      const job = reports.create({
        id: String(b.id || b.jobId || ""),
        status: String(b.status || "completed"),
        task: String(b.task || ""),
        result: resultText,
        error: String(b.error || ""),
      });
      const realtimeDelivery = await joiner.injectWorkerResult(job);
      if (realtimeDelivery.ok) {
        reports.update(job.id, {
          deliveredToRealtime: true,
          realtimeDelivery: {
            channel: realtimeDelivery.channel || "",
            deliveredAt: new Date().toISOString(),
          },
        });
      }
      return { ok: true, job: reports.get(job.id) || job, realtimeDelivery };
    },
    "POST /worker/delegate": async ({ body }) => {
      const b = body as MeetingAgentInput;
      const job = await runner.startTask({
        task: String(b.task || ""),
        context: (b.context as Record<string, unknown>) || {},
        mode: String(b.mode || "analysis"),
        allowCodeChanges: Boolean(b.allowCodeChanges),
      });
      const report = reportFinishedWorkerJob(job);
      return { ok: true, job, report };
    },
    "POST /dialog/turn": async ({ body }) => {
      const b = body as MeetingAgentInput & { timeoutMs?: number };
      const utterance = String(b.utterance || b.text || "").trim();
      if (!utterance) return { status: 400, body: { ok: false, error: "utterance_required" } };
      const job = await runner.startTask({
        task: utterance,
        context: {
          ...((b.context as Record<string, unknown>) || {}),
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
    },
    "POST /worker/status": async ({ body }) => {
      const b = body as MeetingAgentInput;
      const jobId = String(b.jobId || b.id || "");
      const job = jobId ? runner.getJob(jobId) || reports.get(jobId) : null;
      return {
        ok: true,
        job,
        jobs: job ? [job] : reports.list(),
      };
    },
    "GET /worker/jobs": () => ({ ok: true, jobs: reports.list() }),
    "POST /worker/poll-realtime": async ({ body }) => {
      const b = body as MeetingAgentInput;
      return {
        ok: true,
        jobs: reports.pollReadyForRealtime({
          limit: Number.parseInt(String(b.limit ?? "1"), 10),
          markDelivered: b.markDelivered !== false,
          minCreatedAt: String(b.minCreatedAt || ""),
        }),
      };
    },
    "POST /worker/poll-slack": async ({ body }) => {
      const b = body as MeetingAgentInput;
      return {
        ok: true,
        jobs: reports.pollReadyForSlack({
          limit: Number.parseInt(String(b.limit ?? "10"), 10),
          markDelivered: b.markDelivered !== false,
        }),
      };
    },
    "POST /worker/mark-slack-delivered": async ({ body }) => {
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
    },
  },
});

await service.listen();
