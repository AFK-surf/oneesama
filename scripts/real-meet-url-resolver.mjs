import { readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";

const MEET_URL_PATTERN =
  /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#][^\s"'<>]*)?/i;

export function argValue(args, name) {
  const entries = Array.from(args || []);
  const inlinePrefix = `${name}=`;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = String(entries[index] || "");
    if (entry.startsWith(inlinePrefix)) return entry.slice(inlinePrefix.length);
    if (entry !== name) continue;
    const value = entries[index + 1];
    if (value && !String(value).startsWith("--")) return value;
  }
  return "";
}

function realMeetUrlDiscoveryEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.MAB_REAL_MEET_URL_DISCOVERY || "").trim());
}

export function normalizeRealMeetUrl(value) {
  const match = String(value || "").match(MEET_URL_PATTERN);
  return match ? match[0].replace(/[),.;]+$/, "") : "";
}

export function extractRealMeetUrlFromJoinStatus(status = {}) {
  const active =
    status?.active && typeof status.active === "object"
      ? status.active
      : status?.runtime?.active && typeof status.runtime.active === "object"
        ? status.runtime.active
        : {};
  const candidates = [
    active.meeting_url,
    active.meetingUrl,
    active.meet_url,
    active.meetUrl,
    active.metadata?.meeting_url,
    active.metadata?.meetingUrl,
    active.metadata?.meet_url,
    active.metadata?.meetUrl,
    status.meeting_url,
    status.meetingUrl,
    status.meet_url,
    status.meetUrl,
  ];
  return normalizeRealMeetUrl(
    candidates.find((candidate) => normalizeRealMeetUrl(candidate)) || "",
  );
}

function activeBrowserRecordPath(env = process.env) {
  return (
    String(env.MAB_ACTIVE_MEET_BROWSER_PATH || "").trim() ||
    pathJoin(String(env.MAB_DATA_DIR || "/tmp/meeting-avatar-bot-data"), "active-meet-browser.json")
  );
}

function processIsAlive(pid) {
  const numeric = Number(pid || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

export function extractRealMeetUrlFromActiveBrowserRecord(record = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "";
  if (!processIsAlive(record.pid)) return "";
  return normalizeRealMeetUrl(record.meetUrl || record.meet_url || record.meeting_url || "");
}

async function resolveRealMeetUrlFromActiveBrowserRecord(env = process.env) {
  const recordPath = activeBrowserRecordPath(env);
  try {
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const rawMeetUrl = record.meetUrl || record.meet_url || record.meeting_url || "";
    const normalizedMeetUrl = normalizeRealMeetUrl(rawMeetUrl);
    const browserAlive = processIsAlive(record.pid);
    const meetUrl = extractRealMeetUrlFromActiveBrowserRecord(record);
    return {
      meetUrl,
      source: meetUrl ? "active-browser-record" : "",
      checkedSource: recordPath,
      error: meetUrl
        ? ""
        : !browserAlive
          ? "active_browser_record_process_absent"
          : normalizedMeetUrl
            ? "active_browser_record_meet_url_unusable"
            : "active_browser_record_meet_url_missing",
    };
  } catch (error) {
    return {
      meetUrl: "",
      source: "",
      checkedSource: recordPath,
      error: String(error?.message || error),
    };
  }
}

async function defaultFetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function resolveRealMeetUrl(options = {}) {
  const args = options.args || process.argv;
  const env = options.env || process.env;
  const explicit = normalizeRealMeetUrl(
    argValue(args, "--real-meet-url") ||
      argValue(args, "--meet-url") ||
      env.MAB_REAL_MEET_URL ||
      "",
  );
  if (explicit) {
    return {
      meetUrl: explicit,
      source: env.MAB_REAL_MEET_URL ? "env:MAB_REAL_MEET_URL" : "argv",
      checkedSources: [],
    };
  }
  const checkedSources = [];
  if (!realMeetUrlDiscoveryEnabled(env)) {
    return { meetUrl: "", source: "", checkedSources };
  }
  const meetingAgentUrl = (env.MAB_MEETING_AGENT_URL || "http://127.0.0.1:8781").replace(
    /\/+$/,
    "",
  );
  const statusUrl = `${meetingAgentUrl}/join/status`;
  try {
    const status = await (options.fetchJson || defaultFetchJson)(statusUrl);
    checkedSources.push(statusUrl);
    const discovered = extractRealMeetUrlFromJoinStatus(status);
    if (discovered) {
      return { meetUrl: discovered, source: "meeting-agent:/join/status", checkedSources };
    }
  } catch (error) {
    checkedSources.push(statusUrl);
    const fallback = await resolveRealMeetUrlFromActiveBrowserRecord(env);
    checkedSources.push(fallback.checkedSource);
    if (fallback.meetUrl) {
      return {
        meetUrl: fallback.meetUrl,
        source: fallback.source,
        checkedSources,
        discoveryError: String(error?.message || error),
      };
    }
    return {
      meetUrl: "",
      source: "",
      checkedSources,
      discoveryError: String(error?.message || error),
      activeBrowserRecordError: fallback.error || "",
    };
  }
  const fallback = await resolveRealMeetUrlFromActiveBrowserRecord(env);
  checkedSources.push(fallback.checkedSource);
  if (fallback.meetUrl) {
    return { meetUrl: fallback.meetUrl, source: fallback.source, checkedSources };
  }
  return {
    meetUrl: "",
    source: "",
    checkedSources,
    activeBrowserRecordError: fallback.error || "",
  };
}
