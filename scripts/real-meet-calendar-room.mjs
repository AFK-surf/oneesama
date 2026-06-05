#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

function envFlagValue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function firstValue(values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseEnvFileText(text = "") {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    if (!key) continue;
    values[key] = line
      .slice(index + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

async function readEnvFile(filePath) {
  const path = String(filePath || "").trim();
  if (!path) return {};
  try {
    return parseEnvFileText(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

export function calendarMeetCreationRequested({ args = process.argv, env = process.env } = {}) {
  return (
    Array.from(args || []).includes("--create-calendar-meet") ||
    envFlagValue(env.MAB_REAL_MEET_CREATE_CALENDAR) ||
    envFlagValue(env.MAB_REAL_MEET_AUTO_CALENDAR)
  );
}

function credentialSource(env) {
  return firstValue([
    env.MAB_WORKSPACE_TOOLS_ENV_FILE,
    env.MAB_GOOGLE_CREDENTIAL_FILE,
    env.ONEESAMA_GOOGLE_CREDENTIAL_FILE,
  ]);
}

export async function googleCalendarRoomConfigFromEnv(env = process.env) {
  const fileValues = await readEnvFile(credentialSource(env));
  const value = (...names) => {
    for (const name of names) {
      const direct = String(env[name] || "").trim();
      if (direct) return direct;
      const fromFile = String(fileValues[name] || "").trim();
      if (fromFile) return fromFile;
    }
    return "";
  };
  const attendees = [
    ...csv(value("MAB_REAL_MEET_CALENDAR_ATTENDEES", "ONEESAMA_REAL_MEET_CALENDAR_ATTENDEES")),
    ...csv(value("MAB_SYNTHETIC_SPEAKER_INVITE_EMAIL", "MAB_HOST_ADMISSION_INVITE_EMAIL")),
  ];
  const uniqueAttendees = Array.from(new Set(attendees.map((entry) => entry.toLowerCase())));
  const clientId = value("GOOGLE_CLIENT_ID", "ONEESAMA_GOOGLE_CALENDAR_CLIENT_ID");
  const clientSecret = value("GOOGLE_CLIENT_SECRET", "ONEESAMA_GOOGLE_CALENDAR_CLIENT_SECRET");
  const refreshToken = value("GOOGLE_REFRESH_TOKEN", "ONEESAMA_GOOGLE_CALENDAR_REFRESH_TOKEN");
  const calendarId = value("MAB_REAL_MEET_CALENDAR_ID", "ONEESAMA_GOOGLE_CALENDAR_ID") || "primary";
  const tokenUrl =
    value("MAB_GOOGLE_TOKEN_URL", "ONEESAMA_GOOGLE_TOKEN_URL") ||
    "https://oauth2.googleapis.com/token";
  const calendarApiBaseUrl =
    value("MAB_GOOGLE_CALENDAR_API_BASE_URL", "ONEESAMA_GOOGLE_CALENDAR_API_BASE_URL") ||
    "https://www.googleapis.com/calendar/v3";
  const durationMinutes = Math.max(
    5,
    Math.min(Number.parseInt(value("MAB_REAL_MEET_CALENDAR_DURATION_MINUTES"), 10) || 30, 180),
  );
  const missingEnv = [];
  if (!clientId) missingEnv.push("GOOGLE_CLIENT_ID");
  if (!refreshToken) missingEnv.push("GOOGLE_REFRESH_TOKEN");
  return {
    ok: missingEnv.length === 0,
    missingEnv,
    credentialFileConfigured: Boolean(credentialSource(env)),
    credentialSource: credentialSource(env) ? "env-file" : "env",
    clientIdConfigured: Boolean(clientId),
    clientSecretConfigured: Boolean(clientSecret),
    refreshTokenConfigured: Boolean(refreshToken),
    clientId,
    clientSecret,
    refreshToken,
    tokenUrl,
    calendarApiBaseUrl,
    calendarId,
    durationMinutes,
    summary: value("MAB_REAL_MEET_CALENDAR_SUMMARY") || "Oneesama realtime sidecar acceptance",
    attendees: uniqueAttendees,
    sendUpdates:
      value("MAB_REAL_MEET_CALENDAR_SEND_UPDATES") || (uniqueAttendees.length ? "all" : "none"),
    cleanup: !/^(0|false|no|off)$/i.test(
      value("MAB_REAL_MEET_CALENDAR_CLEANUP", "ONEESAMA_REAL_MEET_CALENDAR_CLEANUP") || "1",
    ),
  };
}

export function calendarRoomConfigSummary(config = {}) {
  return {
    ok: config.ok === true,
    missingEnv: config.missingEnv || [],
    credentialFileConfigured: config.credentialFileConfigured === true,
    credentialSource: config.credentialSource || "",
    clientIdConfigured: config.clientIdConfigured === true,
    clientSecretConfigured: config.clientSecretConfigured === true,
    refreshTokenConfigured: config.refreshTokenConfigured === true,
    calendarId: config.calendarId || "",
    durationMinutes: Number(config.durationMinutes || 0),
    attendeeCount: Array.isArray(config.attendees)
      ? config.attendees.length
      : Number(config.attendeeCount || 0),
    sendUpdates: config.sendUpdates || "",
    cleanup: config.cleanup !== false,
  };
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 800) };
    }
  }
  if (!response.ok) {
    const reason = body?.error?.message || body?.error || text || response.statusText;
    const error = new Error(`HTTP ${response.status}: ${reason}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body || {};
}

export async function getGoogleCalendarAccessToken(config, { fetchImpl = fetch } = {}) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret || "",
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });
  const data = await fetchJson(fetchImpl, config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = String(data.access_token || "").trim();
  if (!token) throw new Error("google_access_token_missing");
  return token;
}

export function buildCalendarMeetEventBody(
  config,
  { now = new Date(), requestId = randomUUID() } = {},
) {
  const start = new Date(now.getTime() + 60_000);
  const end = new Date(start.getTime() + config.durationMinutes * 60_000);
  return {
    summary: config.summary,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    attendees: config.attendees.map((email) => ({ email })),
    guestsCanInviteOthers: true,
    guestsCanSeeOtherGuests: true,
    conferenceData: {
      createRequest: {
        requestId: `oneesama-${requestId}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };
}

function eventUrl(config, eventId = "") {
  const base = String(config.calendarApiBaseUrl || "").replace(/\/+$/, "");
  const calendar = encodeURIComponent(config.calendarId || "primary");
  const event = eventId ? `/${encodeURIComponent(eventId)}` : "";
  return `${base}/calendars/${calendar}/events${event}`;
}

export async function createTemporaryCalendarMeet({
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const config = await googleCalendarRoomConfigFromEnv(env);
  const safeConfig = calendarRoomConfigSummary(config);
  if (!config.ok) {
    return {
      ok: false,
      blocker: "google_calendar_credentials_missing",
      requiredFix:
        "Set GOOGLE_CLIENT_ID and GOOGLE_REFRESH_TOKEN, or point MAB_WORKSPACE_TOOLS_ENV_FILE / MAB_GOOGLE_CREDENTIAL_FILE at a file containing them.",
      config: safeConfig,
    };
  }
  try {
    const token = await getGoogleCalendarAccessToken(config, { fetchImpl });
    const params = new URLSearchParams({
      conferenceDataVersion: "1",
      sendUpdates: config.sendUpdates,
    });
    const event = await fetchJson(fetchImpl, `${eventUrl(config)}?${params.toString()}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildCalendarMeetEventBody(config, { now })),
    });
    const meetUrl = String(
      event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || "",
    ).trim();
    if (!meetUrl) {
      return {
        ok: false,
        blocker: "calendar_event_missing_meet_url",
        requiredFix: "Google Calendar created an event but did not return a Meet hangoutLink.",
        config: safeConfig,
        eventId: event.id || "",
      };
    }
    let cleaned = false;
    const cleanup = async (reason = "calendar_meet_cleanup") => {
      if (cleaned || !config.cleanup || !event.id) {
        return { ok: true, skipped: cleaned || !config.cleanup || !event.id, reason };
      }
      cleaned = true;
      await fetchJson(
        fetchImpl,
        `${eventUrl(config, event.id)}?${new URLSearchParams({ sendUpdates: config.sendUpdates })}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      return { ok: true, eventId: event.id, reason };
    };
    return {
      ok: true,
      meetUrl,
      source: "google-calendar-auto-room",
      eventId: event.id || "",
      htmlLink: event.htmlLink || "",
      config: safeConfig,
      cleanup,
    };
  } catch (error) {
    return {
      ok: false,
      blocker: "google_calendar_meet_create_failed",
      requiredFix:
        "Check Google Calendar OAuth credentials and Meet conference creation permission.",
      error: String(error?.message || error),
      status: error?.status || 0,
      config: safeConfig,
    };
  }
}
