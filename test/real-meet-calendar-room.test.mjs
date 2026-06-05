import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { test } from "vite-plus/test";

import {
  buildCalendarMeetEventBody,
  calendarMeetCreationRequested,
  calendarRoomConfigSummary,
  createTemporaryCalendarMeet,
  googleCalendarRoomConfigFromEnv,
  parseEnvFileText,
} from "../scripts/real-meet-calendar-room.mjs";

test("calendar room config reads Google credentials from an env file without exposing secrets", async () => {
  const tmpDir = await mkdtemp(pathJoin(tmpdir(), "oneesama-calendar-room-test-"));
  try {
    const envPath = pathJoin(tmpDir, "workspace.env");
    await writeFile(
      envPath,
      [
        "GOOGLE_CLIENT_ID=client-id",
        "GOOGLE_CLIENT_SECRET='client-secret'",
        'GOOGLE_REFRESH_TOKEN="refresh-token"',
      ].join("\n"),
    );
    const config = await googleCalendarRoomConfigFromEnv({
      MAB_WORKSPACE_TOOLS_ENV_FILE: envPath,
      MAB_REAL_MEET_CALENDAR_ATTENDEES: "Speaker@Example.com,speaker@example.com",
      MAB_REAL_MEET_CALENDAR_DURATION_MINUTES: "45",
    });

    assert.equal(config.ok, true);
    assert.equal(config.clientId, "client-id");
    assert.equal(config.clientSecret, "client-secret");
    assert.equal(config.refreshToken, "refresh-token");
    assert.deepEqual(config.attendees, ["speaker@example.com"]);

    const summary = calendarRoomConfigSummary(config);
    assert.equal(summary.clientIdConfigured, true);
    assert.equal(summary.refreshTokenConfigured, true);
    assert.equal("clientId" in summary, false);
    assert.equal("refreshToken" in summary, false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("calendar room creation request accepts CLI and env switches", () => {
  assert.equal(calendarMeetCreationRequested({ args: ["node", "script"] }), false);
  assert.equal(
    calendarMeetCreationRequested({ args: ["node", "script", "--create-calendar-meet"] }),
    true,
  );
  assert.equal(
    calendarMeetCreationRequested({ args: [], env: { MAB_REAL_MEET_AUTO_CALENDAR: "1" } }),
    true,
  );
});

test("calendar event body requests a Google Meet conference and attendees", () => {
  const body = buildCalendarMeetEventBody(
    {
      summary: "Sidecar acceptance",
      durationMinutes: 30,
      attendees: ["speaker@example.com"],
    },
    { now: new Date("2026-06-04T00:00:00.000Z"), requestId: "fixed" },
  );

  assert.equal(body.summary, "Sidecar acceptance");
  assert.equal(body.start.dateTime, "2026-06-04T00:01:00.000Z");
  assert.equal(body.end.dateTime, "2026-06-04T00:31:00.000Z");
  assert.deepEqual(body.attendees, [{ email: "speaker@example.com" }]);
  assert.equal(body.conferenceData.createRequest.requestId, "oneesama-fixed");
  assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
});

test("temporary calendar Meet creation posts the event and deletes it on cleanup", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || "GET",
      body: String(options.body || ""),
    });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), {
        status: 200,
      });
    }
    if (options.method === "POST") {
      return new Response(
        JSON.stringify({
          id: "event-1",
          hangoutLink: "https://meet.google.com/abc-defg-hij",
          htmlLink: "https://calendar.google.com/event?eid=event-1",
        }),
        { status: 200 },
      );
    }
    if (options.method === "DELETE") {
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  const result = await createTemporaryCalendarMeet({
    env: {
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_REFRESH_TOKEN: "refresh-token",
      MAB_REAL_MEET_CALENDAR_ATTENDEES: "speaker@example.com",
    },
    fetchImpl,
    now: new Date("2026-06-04T00:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.meetUrl, "https://meet.google.com/abc-defg-hij");
  assert.equal(result.config.attendeeCount, 1);
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].url, /conferenceDataVersion=1/);
  assert.match(calls[1].body, /hangoutsMeet/);

  const cleanup = await result.cleanup("test_done");
  assert.equal(cleanup.ok, true);
  assert.equal(calls.at(-1).method, "DELETE");
  assert.match(calls.at(-1).url, /event-1/);
});

test("parseEnvFileText ignores comments and strips simple quotes", () => {
  assert.deepEqual(parseEnvFileText("# nope\nA=1\nB='two'\nC=\"three\""), {
    A: "1",
    B: "two",
    C: "three",
  });
});
