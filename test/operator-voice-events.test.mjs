import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  LOCAL_VAD_THRESHOLD,
  localVadSnapshot,
  permissionStateForError,
  voiceCaptureSnapshot,
  voiceEngineControl,
  voiceStreamOpenedMessage,
} from "../packages/core/src/operator/web/voiceEvents.ts";

test("operator voice events build capture and control payload contracts", () => {
  assert.equal(permissionStateForError({ name: "NotAllowedError" }), "denied");
  assert.equal(permissionStateForError({ name: "OverconstrainedError" }), "unavailable");
  assert.equal(permissionStateForError(new Error("other")), "unknown");

  assert.deepEqual(
    voiceCaptureSnapshot({
      armed: true,
      muted: false,
      status: "capturing",
      permissionState: "granted",
      deviceId: "mic-1",
      deviceLabel: "Desk Mic",
      availableDeviceCount: 2,
    }),
    {
      armed: true,
      muted: false,
      mode: "microphone_pcm16",
      status: "capturing",
      permissionState: "granted",
      deviceId: "mic-1",
      deviceLabel: "Desk Mic",
      availableDeviceCount: 2,
    },
  );

  assert.deepEqual(
    voiceEngineControl("session-1", "set_voice_muted", "operator_web_toggle_mute", {
      muted: true,
    }),
    {
      type: "engine_control",
      sessionId: "session-1",
      control: {
        type: "set_voice_muted",
        reason: "operator_web_toggle_mute",
        detail: { source: "operator_web", muted: true },
      },
    },
  );
});

test("operator voice events build VAD and stream-open payload contracts", () => {
  assert.deepEqual(
    localVadSnapshot({
      enabled: false,
      active: true,
      lastEnergy: 0.5,
      nowIso: "2026-06-11T00:00:00.000Z",
    }),
    {
      enabled: false,
      role: "disabled",
      active: false,
      threshold: LOCAL_VAD_THRESHOLD,
      lastEnergy: 0.5,
      lastUpdatedAt: "2026-06-11T00:00:00.000Z",
    },
  );

  assert.deepEqual(
    voiceStreamOpenedMessage("session-1", "web_voice_1", "2026-06-11T00:00:01.000Z"),
    {
      type: "operator_voice_stream_opened",
      sessionId: "session-1",
      voiceStreamId: "web_voice_1",
      voiceStreamGeneration: 1,
      openedAt: "2026-06-11T00:00:01.000Z",
    },
  );
});
