import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  LOCAL_VAD_THRESHOLD,
  createVoiceStreamId,
  localVadSnapshot,
  permissionStateForError,
  voiceChunkMessage,
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

test("operator voice events build deterministic stream ids and PCM chunk payloads", () => {
  assert.equal(createVoiceStreamId(1234), "web_voice_ya");

  const chunk = voiceChunkMessage({
    sessionId: "session-1",
    sequence: 7,
    voiceStreamId: "web_voice_ya",
    monotonicMs: 123.4,
    sentAt: "2026-06-11T00:00:02.000Z",
    sampleRate: 4,
    energy: 0.25,
    samples: new Float32Array([0, 1, -1, 0.5]),
  });

  assert.equal(chunk.type, "voice_chunk");
  assert.equal(chunk.source, "operator_web_pcm16");
  assert.equal(chunk.sessionId, "session-1");
  assert.equal(chunk.sequence, 7);
  assert.equal(chunk.voiceStreamId, "web_voice_ya");
  assert.equal(chunk.voiceStreamGeneration, 1);
  assert.equal(chunk.sampleRate, 4);
  assert.equal(chunk.channels, 1);
  assert.equal(chunk.durationMs, 1000);
  assert.equal(chunk.energy, 0.25);
  assert.equal(typeof chunk.dataBase64, "string");
  assert.ok(chunk.dataBase64.length > 0);
});
