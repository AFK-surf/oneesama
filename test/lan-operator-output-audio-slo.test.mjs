import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createDiagnosticConversationEngine } from "../packages/core/src/operator/lan-operator-conversation-engine.ts";
import { attachLanAcceptanceSlo } from "../scripts/lan-operator-acceptance-slo.mjs";

const baseTime = Date.parse("2026-06-05T00:00:00.000Z");
function at(ms) {
  return new Date(baseTime + ms).toISOString();
}

function reachability() {
  return {
    schema: "oneesama.lan_operator_reachability.v1",
    bindHost: "127.0.0.1",
    bindMode: "loopback",
    port: 18913,
    localOnlyMode: true,
    trustedLanOperatorMode: true,
    lanModeExplicitlyEnabled: true,
    loopbackUrl: "http://127.0.0.1:18913/",
    advertisedUrl: "http://127.0.0.1:18913/",
    lanAddressCount: 0,
  };
}

test("Diagnostic Conversation Engine emits assistant audio canonical events", () => {
  const engine = createDiagnosticConversationEngine({ assistantEveryChunks: 1 });
  const output = engine.receiveVoiceChunk({
    sessionId: "audio-session",
    sequence: 1,
    sampleRate: 24000,
    channels: 1,
    durationMs: 20,
    energy: 0.4,
    source: "synthetic_pcm16",
  });
  const events = output.events || [];

  assert.deepEqual(events.map((event) => event.type).slice(-3), [
    "assistant_audio_started",
    "assistant_audio_chunk",
    "assistant_audio_stopped",
  ]);
  const chunk = events.find((event) => event.type === "assistant_audio_chunk");
  assert.ok(Buffer.from(chunk.audioBase64, "base64").length > 0);
  assert.equal(chunk.detail.sampleRate, 24000);
  assert.equal(chunk.detail.channels, 1);
});

test("LAN voice-loop SLO requires assistant audio playback evidence for real reports", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_voice_loop",
    ok: true,
    host: { reachability: reachability() },
    debugReport: {
      summaries: { surfaceContext: { lanReachability: reachability() } },
      debug: {
        output: {
          assistantAudio: {
            enabled: true,
            status: "stopped",
            chunksReceived: 1,
            chunksPlayed: 1,
            bytesReceived: 3840,
            rms: 0.1,
          },
        },
      },
    },
    conversationEngine: {
      speechStartMs: 90,
      canonicalEventCounts: { speech_started: 1, assistant_text_completed: 1 },
    },
    audio: {
      transport: "websocket_pcm",
      turnDetectionOwner: "conversation_engine",
      localVadRole: "disabled",
      localVadEnabled: false,
      forwardedChunksDelta: 6,
      hostReceiveLagMs: 3,
      voiceAckRttMs: 4,
      voiceStreamId: "voice_stream_audio",
      voiceStreamGeneration: 1,
      voiceStreamOpenCount: 1,
      staleChunksRejected: 0,
    },
    output: {
      assistantAudio: {
        enabled: true,
        status: "stopped",
        chunksReceivedDelta: 1,
        chunksPlayedDelta: 1,
        bytesReceivedDelta: 3840,
        rms: 0.1,
      },
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_audio",
        durationMs: null,
        ok: true,
      },
      { at: at(90), event: "speech_started", turnId: "turn_audio", durationMs: 90, ok: true },
      { at: at(130), event: "transcript_delta", turnId: "turn_audio", durationMs: 130, ok: true },
      {
        at: at(180),
        event: "assistant_text_delta",
        turnId: "turn_audio",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(185),
        event: "assistant_audio_started",
        turnId: "turn_audio",
        durationMs: 185,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_audio",
        milestones: { heard: true, speechStarted: true, transcript: true, output: true },
      },
    ],
  });
  const entry = report.slo.entries.find((item) => item.id === "assistant_audio_playback_observed");

  assert.equal(entry.required, true);
  assert.equal(entry.actual, 1);
  assert.equal(report.ok, true);
});
