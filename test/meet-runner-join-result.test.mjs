import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  deriveStartedStatus,
  hasJoinAcceptedEvidence,
  joinFailureDetails,
  joinFailureMessage,
  recoverAcceptedJoinAfterError,
} from "../meet-runner/src/join-result.ts";
import { deriveRuntimeSessionStatus } from "../meet-runner/src/session-status.ts";
import { shouldRetryMeetNavigationAfterProductRedirect } from "../packages/core/src/meeting/google-meet-joiner-base.ts";

test("meet-runner join result status treats admitted and in-meeting evidence as accepted", () => {
  assert.equal(deriveStartedStatus({ admission: { state: "admitted" } }), "joined");
  assert.equal(deriveStartedStatus({ meetPage: { inMeeting: true } }), "joined");
  assert.equal(deriveStartedStatus({ meetPage: { inMeeting: true, preJoin: true } }), "starting");
  assert.equal(deriveStartedStatus({ meetPage: { waitingForAdmit: true } }), "waiting");
  assert.equal(
    deriveStartedStatus({ clickedJoinSelector: "dom:meet-join-button" }),
    "join_requested",
  );
  assert.equal(deriveStartedStatus({}), "starting");

  assert.equal(hasJoinAcceptedEvidence({ admission: { state: "admitted" } }), true);
  assert.equal(hasJoinAcceptedEvidence({ captions: { ok: true } }), true);
  assert.equal(hasJoinAcceptedEvidence({ error: "boom" }), false);
});

test("meet-runner recovers post-join errors when runtime status already shows accepted join", async () => {
  const recovered = await recoverAcceptedJoinAfterError(new Error("serialize failed"), {
    status: async () => ({
      ok: true,
      active: {
        sessionId: "session_joined",
        meetPage: { inMeeting: true },
        clickedJoinSelector: "dom:meet-join-button",
      },
    }),
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.sessionId, "session_joined");
  assert.equal(recovered.recovered_after_error, "serialize failed");
});

test("meet-runner preserves real join failures without accepted runtime evidence", async () => {
  await assert.rejects(
    recoverAcceptedJoinAfterError(new Error("cannot_join_meeting"), {
      status: async () => ({
        ok: true,
        active: { meetPage: { cannotJoin: true } },
      }),
    }),
    /cannot_join_meeting/,
  );
  assert.equal(joinFailureMessage({ error: "cannot_join_meeting" }), "cannot_join_meeting");
  assert.equal(joinFailureMessage({}), "google meet join failed");
});

test("meet-runner preserves WebDriver hard-block diagnostics in terminal join failures", () => {
  const details = joinFailureDetails({
    ok: false,
    error: "cannot_join_meeting",
    diagnosticsPath: "/tmp/meeting-avatar-bot/session-hard-blocked-diagnostics.json",
    webDriver: {
      status: "hard_blocked",
      message: "You can't join this video call / Return to home screen",
    },
  });

  assert.equal(details.error, "cannot_join_meeting");
  assert.equal(details.reason, "hard_blocked");
  assert.equal(details.message, "You can't join this video call / Return to home screen");
  assert.equal(
    details.diagnostics_path,
    "/tmp/meeting-avatar-bot/session-hard-blocked-diagnostics.json",
  );
});

test("meet-runner runtime status detects kicked or removed meeting page", () => {
  const state = {
    id: "session_kicked",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    status: "joined",
    title: "Meet",
    updated_at: "2026-05-25T00:00:00.000Z",
    started: true,
  };

  assert.equal(
    deriveRuntimeSessionStatus(state, {
      meetPage: {
        url: "https://workspace.google.com/products/meet/",
        inMeeting: false,
      },
      captions: { count: 12 },
    }),
    "removed_from_meeting",
  );
  assert.equal(
    deriveRuntimeSessionStatus(state, {
      meetPage: { url: state.meeting_url, inMeeting: true },
    }),
    "joined",
  );
  assert.equal(
    deriveRuntimeSessionStatus(
      { ...state, status: "starting" },
      {
        meetPage: { url: state.meeting_url, inMeeting: true, preJoin: true },
      },
    ),
    "starting",
  );
});

test("google meet joiner retries when guest navigation lands on Workspace Meet product page", () => {
  assert.equal(
    shouldRetryMeetNavigationAfterProductRedirect(
      "https://meet.google.com/abc-defg-hij",
      "https://workspace.google.com/products/meet/",
    ),
    true,
  );
  assert.equal(
    shouldRetryMeetNavigationAfterProductRedirect(
      "https://meet.google.com/abc-defg-hij",
      "https://workspace.google.com/intl/ja/products/meet/",
    ),
    true,
  );
  assert.equal(
    shouldRetryMeetNavigationAfterProductRedirect(
      "https://meet.google.com/abc-defg-hij",
      "https://meet.google.com/abc-defg-hij?authuser=0",
    ),
    false,
  );
  assert.equal(
    shouldRetryMeetNavigationAfterProductRedirect(
      "http://127.0.0.1:3000/fixture",
      "https://workspace.google.com/products/meet/",
    ),
    false,
  );
});
