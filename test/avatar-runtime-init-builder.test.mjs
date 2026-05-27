import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildAvatarRuntimeInitScripts,
  inferConversationTransportFromRealtimeMode,
  summarizeRuntimeInitScripts,
} from "../packages/core/src/avatar-runtime/runtime-init-builder.ts";

test("runtime init builder infers conversation transport from realtime mode", () => {
  assert.equal(inferConversationTransportFromRealtimeMode("mock"), "mock");
  assert.equal(inferConversationTransportFromRealtimeMode("webrtc-mock"), "webrtc_mock");
  assert.equal(inferConversationTransportFromRealtimeMode("webrtc"), "raw_webrtc");
  assert.equal(inferConversationTransportFromRealtimeMode("agents-sdk"), "agents_sdk");
  assert.equal(inferConversationTransportFromRealtimeMode("agents-sdk-mock"), "agents_sdk");
});

test("runtime init composer keeps representative Meet init script contents stable", () => {
  const scripts = buildAvatarRuntimeInitScripts({
    sessionId: "runtime-golden-session",
    botName: "Hiyori",
    surfaceKind: "google_meet",
    conversationTransport: "agents_sdk",
    avatar: {
      avatarRenderer: "live2d",
      modelUrl: "https://example.test/hiyori.model3.json",
      modelFallbackUrls: ["https://example.test/fallback.model3.json"],
      layout: "center",
      botName: "Hiyori",
      deferRendererUntilExplicitStart: true,
      canvasWidth: 1280,
      canvasHeight: 720,
      captureFps: 24,
    },
    realtime: {
      mode: "agents-sdk-mock",
      agentRuntime: "agents-sdk",
      sessionId: "runtime-golden-session",
      botName: "Hiyori",
      autoRespondToWorkerResults: true,
      instructions: "Stable golden instructions.",
      tools: [{ type: "function", name: "now", description: "Return time" }],
      session: { model: "gpt-realtime-2", voice: "marin" },
      currentUser: { name: "Peng Xiao" },
      sendSessionUpdateOnConnect: true,
      includeParticipantAudio: true,
      forwardMeetAudioToRealtime: true,
      captureMeetAudioForTranscript: true,
      workerDelegateUrl: "https://example.test/worker/delegate",
      workerStatusUrl: "https://example.test/worker/status",
      autoConnect: false,
      tokenUrl: "https://example.test/realtime/client-secret",
      openaiRealtimeBaseUrl: "https://api.openai.com",
      sdpUrl: "https://api.openai.com/v1/realtime/calls",
    },
    localDialog: {
      enabled: true,
      botName: "Hiyori",
      sessionId: "runtime-golden-session",
      turnUrl: "https://example.test/dialog/turn",
      ttsMode: "tone",
      ttsUrl: "https://example.test/tts/synthesize",
      sttProvider: "mock",
      ttsProvider: "mock",
      ttsGain: 0.025,
    },
    screenShare: {
      enabled: true,
      autoStart: false,
      mode: "synthetic",
      title: "Meeting Avatar Bot",
      subtitle: "Agent screen share",
      width: 1280,
      height: 720,
      fps: 24,
    },
    workerResult: {
      workerPollUrl: "https://example.test/worker/status",
      enabled: true,
      minCreatedAt: "2026-05-27T00:00:00.000Z",
      sessionId: "runtime-golden-session",
    },
  });
  const actual = Object.fromEntries(
    scripts.map((script) => [
      script.category,
      {
        contentLength: script.content.length,
        sha256: createHash("sha256").update(script.content).digest("hex"),
      },
    ]),
  );

  assert.deepEqual(actual, {
    avatar: {
      contentLength: 65041,
      sha256: "80acdb97ff62938fccd9ba995aab26d2c45d673e0cf5205bbc56a20fdfbb7bd2",
    },
    realtime: {
      contentLength: 3984873,
      sha256: "3a3f3eed5e0212a7e690ccfa9efac0ffd0d83b240603148a42d8dd040342372b",
    },
    local_dialog: {
      contentLength: 9749,
      sha256: "2aae444441c1475fec83b7537625256bf5056f33a868c262d513855b141572fc",
    },
    screen_share: {
      contentLength: 16003,
      sha256: "664dcc82c42aa0076781ef90b10670c44857b6df1abd19bbfb9b47df5b8e5551",
    },
    worker_result: {
      contentLength: 3724,
      sha256: "6120a480bd5ff0d12235b78c0c7d06808a7d5afc4f6632ff85eb57735712b2a5",
    },
  });

  const realtimeEvent = scripts.find((script) => script.category === "realtime").event;
  assert.equal(realtimeEvent.detail.realtimeBridgeMode, "agents-sdk-mock");
  assert.equal(realtimeEvent.detail.mockTransport, true);
});

test("runtime init composer emits categories in install order", () => {
  const scripts = buildAvatarRuntimeInitScripts({
    sessionId: "runtime-init-test",
    botName: "Hiyori",
    surfaceKind: "local_browser",
    conversationTransport: "mock",
    avatar: {
      avatarRenderer: "live2d",
      modelUrl: "https://example.test/hiyori.model3.json",
    },
    realtime: {
      agentRuntime: "mock",
      apiBaseUrl: "https://example.test/realtime",
    },
    localDialog: {
      enabled: true,
      endpoint: "https://example.test/dialog",
    },
    screenShare: {
      enabled: true,
      title: "Runtime init test",
    },
    workerResult: {
      enabled: true,
      endpoint: "https://example.test/worker-result",
    },
  });

  assert.deepEqual(
    scripts.map((script) => script.category),
    ["avatar", "realtime", "local_dialog", "screen_share", "worker_result"],
  );
  assert.deepEqual(summarizeRuntimeInitScripts(scripts).categories, [
    "avatar",
    "realtime",
    "local_dialog",
    "screen_share",
    "worker_result",
  ]);
});

test("runtime init events summarize scripts without exposing raw script content", () => {
  const scripts = buildAvatarRuntimeInitScripts({
    sessionId: "runtime-init-redaction-test",
    botName: "Hiyori",
    surfaceKind: "google_meet",
    conversationTransport: "raw_webrtc",
    avatar: {
      avatarRenderer: "live2d",
      modelUrl: "https://example.test/hiyori.model3.json",
    },
    realtime: {
      apiBaseUrl: "https://example.test/realtime",
    },
    localDialog: {
      endpoint: "https://example.test/dialog",
    },
    workerResult: {
      enabled: true,
      endpoint: "https://example.test/worker-result",
    },
  });

  for (const script of scripts) {
    assert.equal(script.event.event, "runtime_init_script_built");
    assert.equal(script.event.detail.category, script.category);
    assert.equal(script.event.detail.contentLength, script.content.length);
    assert.equal(Object.hasOwn(script.event.detail, "content"), false);
    assert.doesNotMatch(script.event.summary, /window\.|MAB_/);
    assert.doesNotMatch(JSON.stringify(script.event.detail), /window\.|MAB_/);
    assert.notEqual(script.event.summary, script.content);
  }

  const contentByCategory = Object.fromEntries(
    scripts.map((script) => [script.category, script.content]),
  );

  assert.match(contentByCategory.avatar, /window\.MAB_AVATAR_CONFIG = /);
  assert.match(contentByCategory.realtime, /window\.MAB_REALTIME_BRIDGE_CONFIG = /);
  assert.match(contentByCategory.local_dialog, /window\.MAB_LOCAL_DIALOG_CONFIG = /);
  assert.match(contentByCategory.screen_share, /window\.MAB_SCREEN_SHARE = state/);
  assert.match(contentByCategory.worker_result, /window\.MAB_WORKER_RESULT_CONFIG = /);
});
