import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  LOCAL_VAD_THRESHOLD,
  createVoiceStreamId,
  localVadSnapshot,
  localVadConfiguredMessage,
  micArmedMessage,
  micBlockedMessage,
  micDisarmedMessage,
  micMutedMessage,
  permissionStateForError,
  parseVoiceSocketPayload,
  syntheticVoiceChunkMessage,
  voiceChunkAckObservedMessage,
  voiceCaptureDisarmedMessages,
  voiceChunkMessage,
  voiceCaptureOpenedMessages,
  voiceCaptureSnapshot,
  voiceDevicesRefreshedMessage,
  voiceEngineControl,
  voiceMutedMessages,
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

  assert.deepEqual(
    voiceCaptureOpenedMessages({
      sessionId: "session-1",
      voiceStreamId: "web_voice_1",
      openedAt: "2026-06-11T00:00:01.000Z",
      muted: true,
      deviceId: "mic-1",
      deviceLabel: "Desk Mic",
      availableDeviceCount: 2,
    }),
    {
      voiceMessage: {
        type: "operator_voice_stream_opened",
        sessionId: "session-1",
        voiceStreamId: "web_voice_1",
        voiceStreamGeneration: 1,
        openedAt: "2026-06-11T00:00:01.000Z",
      },
      operatorEvents: [
        {
          type: "engine_control",
          sessionId: "session-1",
          control: {
            type: "set_voice_armed",
            reason: "operator_web_start_mic",
            detail: { source: "operator_web", armed: true },
          },
        },
        {
          type: "operator_mic_armed",
          capture: {
            armed: true,
            muted: true,
            mode: "microphone_pcm16",
            status: "capturing",
            permissionState: "granted",
            deviceId: "mic-1",
            deviceLabel: "Desk Mic",
            availableDeviceCount: 2,
          },
        },
      ],
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

test("operator voice events build synthetic chunks and ack observations", () => {
  assert.deepEqual(
    syntheticVoiceChunkMessage({
      sessionId: "session-1",
      sequence: 2,
      voiceStreamId: "web_voice_fake",
      voiceStreamGeneration: 3,
      monotonicMs: 12,
      sentAt: "2026-06-11T00:00:02.000Z",
      source: "fixture_pcm16",
    }),
    {
      type: "voice_chunk",
      source: "fixture_pcm16",
      sessionId: "session-1",
      sequence: 2,
      voiceStreamId: "web_voice_fake",
      voiceStreamGeneration: 3,
      monotonicMs: 12,
      sentAt: "2026-06-11T00:00:02.000Z",
      sampleRate: 24000,
      channels: 1,
      durationMs: 20,
      energy: 0.16,
      dataBase64: "AAAAAA==",
    },
  );

  assert.deepEqual(
    voiceChunkAckObservedMessage(
      {
        type: "operator_voice_chunk_ack",
        sequence: 2,
        sentAt: "2026-06-11T00:00:02.000Z",
      },
      Date.parse("2026-06-11T00:00:02.025Z"),
    ),
    {
      type: "operator_voice_chunk_ack_observed",
      ack: {
        type: "operator_voice_chunk_ack",
        sequence: 2,
        sentAt: "2026-06-11T00:00:02.000Z",
        ackAt: "2026-06-11T00:00:02.025Z",
        ackRttMs: 25,
        ackClock: "client_send_to_ack_wall",
      },
    },
  );

  assert.deepEqual(parseVoiceSocketPayload('{"type":"operator_voice_chunk_ack"}'), {
    type: "operator_voice_chunk_ack",
  });
  assert.equal(parseVoiceSocketPayload("not-json"), null);
});

test("operator voice events build mic status payload contracts", () => {
  assert.deepEqual(
    micBlockedMessage({
      error: Object.assign(new Error("permission denied"), { name: "NotAllowedError" }),
      muted: true,
      deviceId: "mic-1",
      availableDeviceCount: 3,
    }),
    {
      type: "operator_mic_blocked",
      error: "permission denied",
      capture: {
        armed: false,
        muted: true,
        mode: "microphone_pcm16",
        status: "blocked",
        error: "permission denied",
        permissionState: "denied",
        deviceId: "mic-1",
        availableDeviceCount: 3,
      },
    },
  );

  assert.deepEqual(
    micArmedMessage({
      muted: false,
      deviceId: "mic-1",
      deviceLabel: "Desk Mic",
      availableDeviceCount: 2,
    }),
    {
      type: "operator_mic_armed",
      capture: {
        armed: true,
        muted: false,
        mode: "microphone_pcm16",
        status: "capturing",
        permissionState: "granted",
        deviceId: "mic-1",
        deviceLabel: "Desk Mic",
        availableDeviceCount: 2,
      },
    },
  );

  assert.deepEqual(
    micMutedMessage({
      muted: true,
      micOn: false,
      deviceId: "",
      availableDeviceCount: 0,
    }),
    {
      type: "operator_mic_muted",
      capture: {
        armed: false,
        muted: true,
        mode: "microphone_pcm16",
        status: "idle",
        deviceId: null,
        availableDeviceCount: 0,
      },
    },
  );

  assert.deepEqual(
    voiceMutedMessages({
      sessionId: "session-1",
      reason: "operator_web_toggle_mute",
      muted: true,
      micOn: false,
      deviceId: "",
      availableDeviceCount: 0,
    }),
    {
      operatorEvents: [
        {
          type: "engine_control",
          sessionId: "session-1",
          control: {
            type: "set_voice_muted",
            reason: "operator_web_toggle_mute",
            detail: { source: "operator_web", muted: true },
          },
        },
        {
          type: "operator_mic_muted",
          capture: {
            armed: false,
            muted: true,
            mode: "microphone_pcm16",
            status: "idle",
            deviceId: null,
            availableDeviceCount: 0,
          },
        },
      ],
    },
  );

  assert.deepEqual(
    micDisarmedMessage({
      muted: true,
      deviceId: "mic-1",
      availableDeviceCount: 1,
    }),
    {
      type: "operator_mic_disarmed",
      capture: {
        armed: false,
        muted: true,
        mode: "microphone_pcm16",
        status: "idle",
        deviceId: "mic-1",
        availableDeviceCount: 1,
      },
    },
  );

  assert.deepEqual(
    voiceCaptureDisarmedMessages({
      sessionId: "session-1",
      muted: true,
      deviceId: "mic-1",
      availableDeviceCount: 1,
    }),
    {
      operatorEvents: [
        {
          type: "operator_mic_disarmed",
          capture: {
            armed: false,
            muted: true,
            mode: "microphone_pcm16",
            status: "idle",
            deviceId: "mic-1",
            availableDeviceCount: 1,
          },
        },
        {
          type: "engine_control",
          sessionId: "session-1",
          control: {
            type: "set_voice_armed",
            reason: "operator_web_stop_mic",
            detail: { source: "operator_web", armed: false },
          },
        },
      ],
    },
  );
});

test("operator voice events build VAD and device status payload contracts", () => {
  const configured = localVadConfiguredMessage({
    enabled: true,
    active: true,
    lastEnergy: 0.08,
    micOn: true,
    deviceId: "mic-1",
  });
  assert.equal(configured.type, "operator_local_vad_configured");
  assert.deepEqual(configured.capture, {
    status: "capturing",
    deviceId: "mic-1",
  });
  assert.equal(configured.localVad.enabled, true);
  assert.equal(configured.localVad.role, "telemetry");
  assert.equal(configured.localVad.active, true);
  assert.equal(configured.localVad.threshold, LOCAL_VAD_THRESHOLD);
  assert.equal(configured.localVad.lastEnergy, 0.08);
  assert.equal(typeof configured.localVad.lastUpdatedAt, "string");

  const refreshed = voiceDevicesRefreshedMessage({
    availableDeviceCount: 2,
    enabled: false,
    active: true,
    lastEnergy: 0.5,
    micOn: false,
    deviceId: "",
  });
  assert.equal(refreshed.type, "operator_voice_devices_refreshed");
  assert.equal(refreshed.availableDeviceCount, 2);
  assert.deepEqual(refreshed.capture, {
    status: "idle",
    deviceId: null,
  });
  assert.equal(refreshed.localVad.enabled, false);
  assert.equal(refreshed.localVad.role, "disabled");
  assert.equal(refreshed.localVad.active, false);
});
