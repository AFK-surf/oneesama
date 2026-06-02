import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fetchJson, type UpstreamError } from "../../../packages/core/src/http-fetch-json.js";
import { getRuntimeConfig } from "../../../packages/core/src/env.js";
import { resolveSpeakerIdentity } from "../../../packages/core/src/realtime/speaker-identity.js";

interface MeetingAgentToolInput {
  [key: string]: any;
}
const config = getRuntimeConfig();
const workspaceCredentialFile = process.env.MAB_WORKSPACE_TOOLS_ENV_FILE || "";
const currentUser = {
  name: config.currentUserName,
  englishName: config.currentUserEnglishName,
  email: config.currentUserEmail,
  linear: config.currentUserLinear,
  github: config.currentUserGithub,
  role: config.currentUserRole,
};

const workspaceMemory = new Map();
let workspaceCredsCache = null;
const googleTokenCache = { value: "", expiresAt: 0 };
const realtimeMeetingSessionKinds = new Set([
  "meeting-copilot",
  "meeting-calibrate",
  "meeting-summary",
  "meeting-demo-surface",
  "meeting-demo-execution",
  "meeting-app-control",
]);
const realtimeNonMeetingSessionKinds = new Set([
  "secretary-lookup",
  "slack-triage",
  "slack-case",
  "memory-compact",
]);

export function isLocalVideoPath(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false;
  return /\.(mp4|webm|mov|m4v)$/i.test(raw);
}

export function stageVideoAssetUrl(filePath = "") {
  const resolved = resolve(String(filePath || ""));
  return `${config.meetingAgentUrl}/stage-media/video?path=${encodeURIComponent(resolved)}`;
}

export function normalizeSessionKind(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replaceAll(" ", "-");
}

export function workerContext(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function workerMeetingSessionId(context: Record<string, unknown>) {
  return String(
    context.meeting_session_id ||
      context.meetingSessionId ||
      context.meetingSessionID ||
      context.session_id ||
      context.sessionId ||
      "",
  ).trim();
}

export function isRealtimeMeetingScopedContext(context: Record<string, unknown>) {
  const kind = normalizeSessionKind(String(context.session_kind || context.sessionKind || ""));
  if (kind) {
    if (realtimeMeetingSessionKinds.has(kind)) return true;
    if (realtimeNonMeetingSessionKinds.has(kind)) return false;
  }
  const source = String(context.source || "")
    .trim()
    .toLowerCase();
  if (!source) return false;
  if (
    source.includes("persona_delegate") ||
    source.includes("triage") ||
    source.includes("secretary")
  ) {
    return false;
  }
  return source.startsWith("meeting-") || source.startsWith("meeting_");
}

export function realtimeSuppressChannelForContext(
  context: Record<string, unknown>,
  sessionId = "",
) {
  if (!isRealtimeMeetingScopedContext(context)) return "realtime_non_meeting_suppressed";
  const targetSessionId = workerMeetingSessionId(context);
  if (sessionId && targetSessionId && targetSessionId !== sessionId) {
    return "realtime_session_mismatch_suppressed";
  }
  return "";
}

export function videoContentType(filePath = "") {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  return "video/mp4";
}

export function readEnvVarFromFile(filePath, key) {
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

export function getWorkspaceCreds() {
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

export function loadSlackAgentPersonalityContext() {
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

export function toolFailure(error: unknown, fallback = "workspace_tool_failed") {
  const err = (error || {}) as UpstreamError;
  return {
    ok: false,
    error: err?.message || fallback,
    status: err?.status,
    detail: err?.payload?.error || err?.payload?.detail || err?.payload?.message || "",
  };
}

export function buildJinaReaderUrl(rawUrl: unknown): string {
  const url = String(rawUrl || "").trim();
  return `https://r.jina.ai/${url}`;
}

export async function handleFetchUrl(body: MeetingAgentToolInput = {}) {
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

export async function getGoogleAccessToken() {
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

export async function callLinearGraphql<T = Record<string, unknown>>(
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

export async function handleSearchTeamMembers(body: MeetingAgentToolInput = {}) {
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

export async function handleLinearQuery(body: MeetingAgentToolInput = {}) {
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

export async function handleLinearUserIssues(body: MeetingAgentToolInput = {}) {
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

export async function handleSlackSearch(body: MeetingAgentToolInput = {}) {
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

export async function handleNotionSearch(body: MeetingAgentToolInput = {}) {
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

export async function handleGithubSearch(body: MeetingAgentToolInput = {}) {
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

export async function handleGoogleCalendar(body: MeetingAgentToolInput = {}) {
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

export async function handleCalendarAttendees(body: MeetingAgentToolInput = {}) {
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

export async function handleWorkspaceTool(toolName: string, body: MeetingAgentToolInput = {}) {
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
