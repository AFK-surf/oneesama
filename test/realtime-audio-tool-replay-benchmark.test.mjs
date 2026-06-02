import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  audioReplayRuntimeEvidenceProfile,
  browserTransportRuntimeOptions,
  parseAudioReplayArgs,
  scoreAudioReplay,
  transcriptFromBrowserBridgeState,
  validateAudioReplayRuntime,
} from "../scripts/realtime-audio-tool-replay-benchmark.mjs";

const shareCase = {
  expectedToolNames: ["list_shareable_windows", "share_existing_app_window"],
};

test("audio replay report metadata says sidecar-audio is dry-run audio tool evidence", () => {
  assert.deepEqual(audioReplayRuntimeEvidenceProfile("sidecar-audio"), {
    evidenceMode: "sidecar_audio_tool_replay",
    acceptanceGateScope: "sidecar_audio_tool_replay",
    toolExecutionMode: "dry_run_local_tools",
    realAppExecution: false,
    note: "This benchmark proves sidecar audio turn formation, transcript evidence, and matching tool telemetry. Local app/window tools run in dry-run mode; use the strict real-room app-control gate for real app execution evidence.",
  });
});

test("audio replay diagnostic modes cannot claim real app execution", () => {
  const profile = audioReplayRuntimeEvidenceProfile("browser-transport");

  assert.equal(profile.acceptanceGateScope, "diagnostic_only");
  assert.equal(profile.toolExecutionMode, "dry_run_local_tools");
  assert.equal(profile.realAppExecution, false);
});

test("audio replay benchmark has a default Recappi sample for npm script runs", () => {
  const args = parseAudioReplayArgs(["--runtime", "sidecar-audio"]);

  assert.equal(
    args.audio,
    "runtime/meeting-artifacts/runner-dual_audio_truebot_1200/recappi-audio.wav",
  );
});

test("audio replay fails hard when share transcript gets assistant text but no tool", () => {
  const score = scoreAudioReplay(shareCase, {
    calls: [],
    transcript: "分享一下 Chrome 浏览器窗口。",
    assistantText: "还在共享处理中，请稍等一下。",
  });

  assert.equal(score.ok, false);
  assert.equal(score.reason, "audio_replay_share_intent_with_assistant_text_without_tool");
  assert.equal(score.fakeExecution, true);
  assert.equal(score.transcriptShareIntent, true);
});

test("audio replay distinguishes missing transcript from tool-selection failure", () => {
  const score = scoreAudioReplay(shareCase, {
    calls: [],
    transcript: "",
    assistantText: "",
  });

  assert.equal(score.ok, false);
  assert.equal(score.reason, "audio_replay_no_transcript");
  assert.equal(score.fakeExecution, false);
});

test("audio replay flags browser transport runtime event loss before transcript failures", () => {
  const score = scoreAudioReplay(shareCase, {
    calls: [],
    transcript: "",
    assistantText: "",
    eventTypes: { "agents_sdk.history_updated": 1 },
    browserBridgeRuntime: {
      pageUrl: "https://meet.google.com/nth-tkfo-hqi",
      sdkConnected: true,
      openaiSessionId: "",
      inboundCount: 1,
      lastInboundEventType: "agents_sdk.history_updated",
    },
  });

  assert.equal(score.ok, false);
  assert.equal(score.reason, "browser_transport_sdk_events_missing");
  assert.equal(score.fakeExecution, false);
});

test("audio replay requires transcript evidence before accepting matching tool calls", () => {
  const score = scoreAudioReplay(shareCase, {
    calls: ["share_existing_app_window"],
    transcript: "",
    assistantText: "",
  });

  assert.equal(score.ok, false);
  assert.equal(score.reason, "audio_replay_no_transcript");
  assert.equal(score.fakeExecution, false);
  assert.equal(score.transcriptShareIntent, false);
});

test("audio replay preserves runtime failures before transcript failures", () => {
  const score = scoreAudioReplay(shareCase, {
    calls: ["share_existing_app_window"],
    transcript: "",
    assistantText: "",
    bridgeRuntime: {
      runtimePlacement: "sidecar",
      sdkConnected: true,
      meetSurface: {
        hasSDKGlobal: true,
        sdkSuppressedOnMeetSurface: false,
      },
    },
  });

  assert.equal(score.ok, false);
  assert.equal(score.reason, "meet_surface_sdk_global_present");
  assert.equal(score.fakeExecution, false);
});

test("audio replay checks browser bridge runtime Meet surface evidence", () => {
  const score = scoreAudioReplay(shareCase, {
    calls: ["share_existing_app_window"],
    transcript: "分享 Chrome 窗口",
    assistantText: "",
    browserBridgeRuntime: {
      runtimePlacement: "sidecar",
      diagnosticOnly: false,
      sdkConnected: true,
      meetSurface: {
        hasSDKGlobal: true,
        sdkSuppressedOnMeetSurface: false,
      },
    },
  });

  assert.equal(score.ok, false);
  assert.equal(score.reason, "meet_surface_sdk_global_present");
  assert.equal(score.fakeExecution, false);
});

test("audio replay requires sidecar SDK connection even when a tool call is present", () => {
  const score = scoreAudioReplay(shareCase, {
    calls: ["share_existing_app_window"],
    transcript: "分享 Chrome 窗口",
    assistantText: "",
    browserBridgeRuntime: {
      runtimePlacement: "sidecar",
      diagnosticOnly: false,
      sdkConnected: false,
      meetSurface: {
        hasSDKGlobal: false,
        sdkSuppressedOnMeetSurface: true,
      },
    },
  });

  assert.equal(score.ok, false);
  assert.equal(score.reason, "sidecar_sdk_not_connected");
  assert.equal(score.fakeExecution, false);
});

test("audio replay rejects real Meet page URLs for non-sidecar runtimes", () => {
  assert.throws(
    () =>
      validateAudioReplayRuntime({
        runtime: "browser-transport",
        browserPageUrl: "https://meet.google.com/abc-defg-hij",
      }),
    /requires --runtime sidecar-audio/,
  );
  assert.doesNotThrow(() =>
    validateAudioReplayRuntime({
      runtime: "sidecar-audio",
      browserPageUrl: "https://meet.google.com/abc-defg-hij",
    }),
  );
});

test("audio replay non-sidecar browser transport is explicit diagnostic inline opt-in", () => {
  assert.deepEqual(browserTransportRuntimeOptions("sidecar-audio"), {
    useSidecar: true,
    realtimeRuntimePlacement: "sidecar",
    realtimePageRole: "sidecar",
    allowInlineAgentsSDKDiagnostic: false,
    diagnosticOnly: false,
  });
  assert.deepEqual(browserTransportRuntimeOptions("browser-transport"), {
    useSidecar: false,
    realtimeRuntimePlacement: "inline",
    realtimePageRole: "generic",
    allowInlineAgentsSDKDiagnostic: true,
    diagnosticOnly: true,
  });
});

test("audio replay passes when expected share tool is called", () => {
  const score = scoreAudioReplay(shareCase, {
    calls: ["list_shareable_windows"],
    transcript: "请共享一下浏览器窗口。",
    assistantText: "",
  });

  assert.equal(score.ok, true);
  assert.equal(score.reason, "expected_tool_called");
  assert.equal(score.fakeExecution, false);
});

test("browser bridge transcript only includes user audio and user history", () => {
  const transcript = transcriptFromBrowserBridgeState({
    inbound: [
      {
        event: {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "分享 Chrome 窗口",
        },
      },
      {
        event: {
          type: "response.function_call_arguments.delta",
          delta: '{"applicationName":"Google Chrome"}',
        },
      },
      {
        event: {
          type: "response.output_text.delta",
          delta: "还在处理中",
        },
      },
    ],
    historyTail: [
      { role: "assistant", text: "还在处理中" },
      { role: "user", text: "共享浏览器" },
    ],
    latestFunctionalTurn: { userText: "请分享浏览器窗口" },
  });

  assert.equal(transcript, "分享 Chrome 窗口 共享浏览器 请分享浏览器窗口");
});
