import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  PUSH_TO_TALK_FAILED_REASON,
  PUSH_TO_TALK_FINISH_REASON,
  PUSH_TO_TALK_START_REASON,
  beginPushToTalk,
  failPushToTalk,
  finishPushToTalk,
} from "../packages/core/src/operator/web/voicePushToTalk.ts";

test("operator voice push-to-talk begins by unmuting and starting an idle mic", () => {
  assert.deepEqual(
    beginPushToTalk({
      active: false,
      muted: true,
      micOn: false,
    }),
    {
      shouldActivate: true,
      shouldStartMic: true,
      previousMuted: true,
      startedMic: true,
      mute: {
        muted: false,
        reason: PUSH_TO_TALK_START_REASON,
      },
    },
  );
});

test("operator voice push-to-talk begins without restarting an active mic", () => {
  assert.deepEqual(
    beginPushToTalk({
      active: false,
      muted: false,
      micOn: true,
    }),
    {
      shouldActivate: true,
      shouldStartMic: false,
      previousMuted: false,
      startedMic: false,
      mute: {
        muted: false,
        reason: PUSH_TO_TALK_START_REASON,
      },
    },
  );
});

test("operator voice push-to-talk ignores duplicate begin and restores failed starts", () => {
  assert.deepEqual(
    beginPushToTalk({
      active: true,
      muted: true,
      micOn: false,
    }),
    {
      shouldActivate: false,
      shouldStartMic: false,
      previousMuted: true,
      startedMic: false,
      mute: null,
    },
  );

  assert.deepEqual(failPushToTalk(true), {
    muted: true,
    reason: PUSH_TO_TALK_FAILED_REASON,
  });
});

test("operator voice push-to-talk finishes by restoring the right mute state", () => {
  assert.deepEqual(
    finishPushToTalk({
      active: false,
      previousMuted: false,
      startedMic: false,
    }),
    {
      shouldDeactivate: false,
      mute: null,
    },
  );

  assert.deepEqual(
    finishPushToTalk({
      active: true,
      previousMuted: false,
      startedMic: false,
    }),
    {
      shouldDeactivate: true,
      mute: {
        muted: false,
        reason: PUSH_TO_TALK_FINISH_REASON,
      },
    },
  );

  assert.deepEqual(
    finishPushToTalk({
      active: true,
      previousMuted: false,
      startedMic: true,
    }),
    {
      shouldDeactivate: true,
      mute: {
        muted: true,
        reason: PUSH_TO_TALK_FINISH_REASON,
      },
    },
  );
});
