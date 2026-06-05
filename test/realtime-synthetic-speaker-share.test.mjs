import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  applyLocalFixtureToolShareSmokeDefaults,
  compactSyntheticResult,
  envForLocalFixtureSyntheticAudioSuiteCase,
  evaluateSyntheticAudioSuiteCase,
  localFixtureSyntheticAudioSuiteCases,
  realMeetUIInteractionJoinFields,
} from "../scripts/real-meet-synthetic-speaker-helpers.mjs";
import {
  extractWorkerJobIdFromSyntheticSummary,
  syntheticSpeakerInstallAvatarFromEnv,
} from "../scripts/real-meet-synthetic-speaker-smoke.mjs";

const DEFAULT_ENV_KEYS = [
  "MAB_SYNTHETIC_SPEAKER_TEXT",
  "MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS",
  "MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL",
  "MAB_REALTIME_SYNTHETIC_SPEECH_START_DELAY_MS",
  "MAB_REALTIME_SYNTHETIC_SPEECH_LOOP",
  "MAB_REALTIME_SYNTHETIC_DISABLE_AUTO_RESPONSE",
  "MAB_MEET_UI_INTERACTION_MODE",
  "MEET_UI_INTERACTION_MODE",
  "MAB_UI_INTERACTION_MODE",
  "MAB_MEET_JOIN_LANE",
];

function withSyntheticShareEnvCleared(fn) {
  const previous = new Map(DEFAULT_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of DEFAULT_ENV_KEYS) delete process.env[key];
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("local fixture tool-share defaults use clear English synthetic speech", () => {
  withSyntheticShareEnvCleared(() => {
    applyLocalFixtureToolShareSmokeDefaults();

    assert.match(process.env.MAB_SYNTHETIC_SPEAKER_TEXT, /Share Chrome window/);
    assert.doesNotMatch(process.env.MAB_SYNTHETIC_SPEAKER_TEXT, /[\u3400-\u9fff]/);
    assert.equal(
      process.env.MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS,
      "list_shareable_windows,share_existing_app_window",
    );
    assert.equal(process.env.MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL, "1");
    assert.equal(process.env.MAB_REALTIME_SYNTHETIC_SPEECH_LOOP, "1");
  });
});

test("real Meet join fields default to macOS humanized input for live validation", () => {
  withSyntheticShareEnvCleared(() => {
    const fields = realMeetUIInteractionJoinFields("macos_test_humanized");
    if (process.platform !== "darwin") {
      assert.deepEqual(fields, {});
      return;
    }
    assert.equal(fields.meetUIInteractionMode, "humanized");
    assert.equal(fields.meet_ui_interaction_mode, "humanized");
    assert.equal(fields.meetJoinLane, "macos_test_humanized");
    assert.equal(fields.meet_join_lane, "macos_test_humanized");
  });
});

test("real Meet join fields keep explicit interaction overrides", () => {
  withSyntheticShareEnvCleared(() => {
    process.env.MAB_MEET_UI_INTERACTION_MODE = "synthetic";
    process.env.MAB_MEET_JOIN_LANE = "manual_lane";
    const fields = realMeetUIInteractionJoinFields("macos_test_humanized");
    assert.equal(fields.meetUIInteractionMode, "synthetic");
    assert.equal(fields.meetJoinLane, "manual_lane");
  });
});

test("real Meet synthetic speaker defaults to avatar/video admission lane", () => {
  assert.equal(syntheticSpeakerInstallAvatarFromEnv({}), true);
  assert.equal(
    syntheticSpeakerInstallAvatarFromEnv({ MAB_SYNTHETIC_SPEAKER_INSTALL_AVATAR: "0" }),
    false,
  );
});

test("synthetic share compact result keeps transcript and functional-turn evidence", () => {
  const summary = compactSyntheticResult(
    {
      ok: true,
      acceptanceSatisfied: true,
      sessionId: "synthetic_share_test",
      final: {
        compact: {
          toolCalls: { all: ["share_existing_app_window"] },
          inputTranscriptTail: [
            {
              text: "Please share the Chrome browser window into the meeting.",
              itemId: "item_1",
            },
          ],
          outputTranscriptTail: [{ text: "Sharing Chrome now.", itemId: "item_2" }],
          latestFunctionalTurn: {
            observed: true,
            intent: "share",
            toolCalled: true,
          },
        },
        gates: { expectedToolCalled: true },
      },
    },
    {
      syntheticSpeakerText: "Please share the Chrome browser window into the meeting.",
      expectedToolNames: ["share_existing_app_window"],
    },
  );

  assert.deepEqual(summary.inputTranscriptTail, [
    {
      text: "Please share the Chrome browser window into the meeting.",
      itemId: "item_1",
    },
  ]);
  assert.equal(summary.latestFunctionalTurn.intent, "share");
  assert.deepEqual(summary.outputTranscriptTail, [
    { text: "Sharing Chrome now.", itemId: "item_2" },
  ]);
});

test("synthetic audio suite covers share, KWWK, delegate, and negative spoken cases", () => {
  const cases = localFixtureSyntheticAudioSuiteCases();
  const categories = new Set(cases.map((entry) => entry.category));

  assert.ok(cases.length >= 8, "suite should not collapse back to a single share smoke");
  assert.ok(categories.has("primary"));
  assert.ok(categories.has("asr-probe"));
  assert.ok(categories.has("share"));
  assert.ok(categories.has("kwwk"));
  assert.ok(categories.has("meet-tool"));
  assert.ok(categories.has("delegate"));
  assert.ok(categories.has("negative"));
  assert.ok(cases.some((entry) => /[\u3400-\u9fff]/.test(entry.text)));
  assert.ok(
    cases.some((entry) => (entry.requiredToolNames || []).includes("kwwk_computer_use")),
    "suite must keep the tab-switch KWWK regression covered",
  );
  assert.ok(
    cases.some((entry) => (entry.forbiddenToolNames || []).includes("kwwk_computer_use")),
    "suite must check that non-CU turns do not trigger KWWK",
  );
  const primary = cases.find((entry) => entry.id === "gomoku_sync_build_and_play_en");
  assert.equal(primary.primaryAcceptance, true);
  assert.equal(primary.requiresWorkerArtifact, true);
  assert.equal(primary.requiresAppUrl, true);
  assert.equal(primary.requiresTwoClientSync, true);
  assert.equal(primary.requiresBotAndUserMoves, true);
  assert.equal(primary.requiresEnglishOutput, true);
  assert.equal(primary.disableAutomaticResponse, true);
  assert.equal(primary.allowToolOnlyResponse, true);
  assert.equal(primary.carrierToneMs, 3000);
  assert.ok(primary.forbiddenOutputTextPatterns.includes("what’s on your mind"));
  assert.ok(primary.forbiddenToolNames.includes("stop_video_stage"));
  assert.ok(primary.forbiddenToolNames.includes("read_meet_chat"));
  assert.equal(primary.dryRunLocalTools, false);
});

test("synthetic audio suite env encodes tool requirements and dry-run worker isolation", () => {
  const delegateCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "delegate_complex_work_en",
  );
  const negativeCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "negative_status_no_cu_en",
  );

  const delegateEnv = envForLocalFixtureSyntheticAudioSuiteCase(delegateCase);
  assert.equal(delegateEnv.MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS, "delegate_to_worker");
  assert.equal(delegateEnv.MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL, "1");
  assert.equal(delegateEnv.MAB_REALTIME_SYNTHETIC_DRY_RUN_LOCAL_TOOLS, "1");
  assert.match(delegateEnv.MAB_REALTIME_SYNTHETIC_TRANSCRIPT_TEXT, /report/);

  const negativeEnv = envForLocalFixtureSyntheticAudioSuiteCase(negativeCase);
  assert.equal(negativeEnv.MAB_REALTIME_SYNTHETIC_EXPECTED_TOOLS, "");
  assert.equal(negativeEnv.MAB_REALTIME_SYNTHETIC_REQUIRE_TOOL, "0");
  assert.equal(negativeEnv.MAB_REALTIME_SYNTHETIC_DRY_RUN_LOCAL_TOOLS, "");
});

test("primary Gomoku case provides deterministic transcript side-channel", () => {
  const gomokuCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "gomoku_sync_build_and_play_en",
  );
  const env = envForLocalFixtureSyntheticAudioSuiteCase(gomokuCase);

  assert.match(env.MAB_SYNTHETIC_SPEAKER_TEXT, /carrier tone/);
  assert.equal(env.MAB_SYNTHETIC_SPEAKER_TONE_MS, "3000");
  assert.equal(env.MAB_REALTIME_SYNTHETIC_DISABLE_AUTO_RESPONSE, "1");
  assert.match(env.MAB_REALTIME_SYNTHETIC_TRANSCRIPT_TEXT, /Gomoku web game/);
  assert.notEqual(env.MAB_REALTIME_SYNTHETIC_TRANSCRIPT_TEXT, env.MAB_SYNTHETIC_SPEAKER_TEXT);
  assert.equal(env.MAB_REALTIME_SYNTHETIC_DRY_RUN_LOCAL_TOOLS, "");
});

test("primary Gomoku case allows tool-only Realtime response when automatic VAD responses are disabled", () => {
  const gomokuCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "gomoku_sync_build_and_play_en",
  );
  const summary = {
    ok: true,
    acceptanceSatisfied: true,
    gates: {
      meetEnergyOk: true,
      speechStarted: true,
      responseSeen: false,
      outputRouted: false,
    },
    toolCalls: { all: ["delegate_to_worker"], worker: ["delegate_to_worker"] },
    workerArtifact: {
      built: true,
      appUrl: "http://127.0.0.1:49152",
      reachable: true,
      files: ["index.html"],
    },
    syncProbe: {
      twoClientSyncPass: true,
      botMoveSource: "app_bot_engine",
      screenshots: ["/tmp/player-a-after-sync.png", "/tmp/player-b-after-sync.png"],
    },
    moveLog: [
      { actor: "user", move: [7, 7, "black"], source: "user_input" },
      { actor: "bot", move: [8, 8, "white"], source: "app_bot_engine" },
    ],
    outputTranscriptTail: [],
    textTurnFallback: null,
  };

  const evaluation = evaluateSyntheticAudioSuiteCase(summary, gomokuCase);

  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.speechAndResponseObserved, true);
});

test("primary Gomoku case rejects unsolicited startup chatter", () => {
  const gomokuCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "gomoku_sync_build_and_play_en",
  );
  const summary = {
    ok: true,
    acceptanceSatisfied: true,
    gates: {
      meetEnergyOk: true,
      speechStarted: true,
      responseSeen: true,
      outputRouted: true,
    },
    toolCalls: { all: ["delegate_to_worker"], worker: ["delegate_to_worker"] },
    workerArtifact: {
      built: true,
      appUrl: "http://127.0.0.1:49152",
      reachable: true,
      files: ["index.html"],
    },
    syncProbe: {
      twoClientSyncPass: true,
      botMoveSource: "app_bot_engine",
      screenshots: ["/tmp/player-a-after-sync.png", "/tmp/player-b-after-sync.png"],
    },
    moveLog: [
      { actor: "user", move: [7, 7, "black"], source: "user_input" },
      { actor: "bot", move: [8, 8, "white"], source: "app_bot_engine" },
    ],
    outputTranscriptTail: [{ text: "Hi there! Nice to hear you. What’s on your mind today?" }],
    textTurnFallback: null,
  };

  const evaluation = evaluateSyntheticAudioSuiteCase(summary, gomokuCase);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.forbiddenOutputTextAbsent, false);
});

test("synthetic audio suite evaluation requires required tools and rejects forbidden tools", () => {
  const testCase = {
    expectedToolNames: ["kwwk_computer_use"],
    requiredToolNames: ["kwwk_computer_use"],
    forbiddenToolNames: ["share_existing_app_window"],
  };
  const baseSummary = {
    ok: true,
    acceptanceSatisfied: true,
    gates: {
      meetEnergyOk: true,
      speechStarted: true,
      responseSeen: true,
      outputRouted: true,
    },
    toolCalls: { all: ["kwwk_computer_use"] },
    textTurnFallback: null,
  };

  assert.equal(evaluateSyntheticAudioSuiteCase(baseSummary, testCase).ok, true);
  assert.deepEqual(
    evaluateSyntheticAudioSuiteCase(
      { ...baseSummary, toolCalls: { all: ["share_existing_app_window"] } },
      testCase,
    ).missingRequiredToolNames,
    ["kwwk_computer_use"],
  );
  assert.deepEqual(
    evaluateSyntheticAudioSuiteCase(
      { ...baseSummary, toolCalls: { all: ["kwwk_computer_use", "share_existing_app_window"] } },
      testCase,
    ).forbiddenToolNamesCalled,
    ["share_existing_app_window"],
  );
  assert.equal(
    evaluateSyntheticAudioSuiteCase({ ...baseSummary, textTurnFallback: { ok: true } }, testCase)
      .ok,
    false,
  );
});

test("primary Gomoku case cannot pass on delegate tool evidence alone", () => {
  const gomokuCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "gomoku_sync_build_and_play_en",
  );
  const summary = {
    ok: true,
    acceptanceSatisfied: true,
    gates: {
      meetEnergyOk: true,
      speechStarted: true,
      responseSeen: true,
      outputRouted: true,
    },
    toolCalls: { all: ["delegate_to_worker"], worker: ["delegate_to_worker"] },
    textTurnFallback: null,
  };

  const evaluation = evaluateSyntheticAudioSuiteCase(summary, gomokuCase);
  assert.equal(evaluation.requiredToolsSatisfied, true);
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.workerArtifactRequired, true);
  assert.equal(evaluation.appBuilt, false);
  assert.equal(evaluation.appUrlReachable, false);
  assert.equal(evaluation.twoClientSyncPass, false);
  assert.equal(evaluation.botMoveObserved, false);
  assert.equal(evaluation.userMoveObserved, false);
});

test("primary Gomoku case passes only with app, sync, and play evidence", () => {
  const gomokuCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "gomoku_sync_build_and_play_en",
  );
  const summary = {
    ok: true,
    acceptanceSatisfied: true,
    gates: {
      meetEnergyOk: true,
      speechStarted: true,
      responseSeen: true,
      outputRouted: true,
    },
    toolCalls: { all: ["delegate_to_worker"], worker: ["delegate_to_worker"] },
    workerArtifact: {
      built: true,
      appUrl: "http://127.0.0.1:49152",
      reachable: true,
      files: ["index.html", "server.ts"],
    },
    syncProbe: {
      twoClientSyncPass: true,
      botMoveSource: "app_bot_engine",
      screenshots: ["/tmp/player-a-after-sync.png", "/tmp/player-b-after-sync.png"],
    },
    moveLog: [
      { actor: "user", move: [7, 7, "black"], source: "harness_user" },
      { actor: "bot", move: [8, 8, "white"], source: "app_bot_engine" },
    ],
    outputTranscriptTail: [{ text: "The app is ready." }],
    textTurnFallback: null,
  };

  assert.equal(evaluateSyntheticAudioSuiteCase(summary, gomokuCase).ok, true);
});

test("primary Gomoku case rejects non-English output", () => {
  const gomokuCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "gomoku_sync_build_and_play_en",
  );
  const summary = {
    ok: true,
    acceptanceSatisfied: true,
    gates: {
      meetEnergyOk: true,
      speechStarted: true,
      responseSeen: true,
      outputRouted: true,
    },
    toolCalls: { all: ["delegate_to_worker"], worker: ["delegate_to_worker"] },
    workerArtifact: {
      built: true,
      appUrl: "http://127.0.0.1:49152",
      reachable: true,
      files: ["index.html"],
    },
    syncProbe: {
      twoClientSyncPass: true,
      botMoveSource: "app_bot_engine",
      screenshots: ["/tmp/player-a-after-sync.png", "/tmp/player-b-after-sync.png"],
    },
    moveLog: [
      { actor: "user", move: [7, 7, "black"], source: "user_input" },
      { actor: "bot", move: [8, 8, "white"], source: "app_bot_engine" },
    ],
    outputTranscriptTail: [{ text: "我叫 Meeting Avatar Bot。" }],
    textTurnFallback: null,
  };

  const evaluation = evaluateSyntheticAudioSuiteCase(summary, gomokuCase);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.englishOutputOnly, false);
});

test("primary Gomoku case rejects unrelated foreground or meeting tool noise", () => {
  const gomokuCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "gomoku_sync_build_and_play_en",
  );
  const summary = {
    ok: true,
    acceptanceSatisfied: true,
    gates: {
      meetEnergyOk: true,
      speechStarted: true,
      responseSeen: true,
      outputRouted: true,
    },
    toolCalls: {
      all: ["stop_video_stage", "delegate_to_worker"],
      meet: ["stop_video_stage"],
      worker: ["delegate_to_worker"],
    },
    workerArtifact: {
      built: true,
      appUrl: "http://127.0.0.1:49152",
      reachable: true,
      files: ["index.html"],
    },
    syncProbe: {
      twoClientSyncPass: true,
      botMoveSource: "app_bot_engine",
      screenshots: ["/tmp/player-a-after-sync.png", "/tmp/player-b-after-sync.png"],
    },
    moveLog: [
      { actor: "user", move: [7, 7, "black"], source: "user_input" },
      { actor: "bot", move: [8, 8, "white"], source: "app_bot_engine" },
    ],
    textTurnFallback: null,
  };

  const evaluation = evaluateSyntheticAudioSuiteCase(summary, gomokuCase);

  assert.equal(evaluation.ok, false);
  assert.deepEqual(evaluation.forbiddenToolNamesCalled, ["stop_video_stage"]);
});

test("primary Gomoku case requires visual page evidence", () => {
  const gomokuCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "gomoku_sync_build_and_play_en",
  );
  const summary = {
    ok: true,
    acceptanceSatisfied: true,
    gates: {
      meetEnergyOk: true,
      speechStarted: true,
      responseSeen: true,
      outputRouted: true,
    },
    toolCalls: { all: ["delegate_to_worker"], worker: ["delegate_to_worker"] },
    workerArtifact: {
      built: true,
      appUrl: "http://127.0.0.1:49152",
      reachable: true,
      files: ["index.html"],
    },
    syncProbe: { twoClientSyncPass: true, botMoveSource: "app_bot_engine" },
    moveLog: [
      { actor: "user", move: [7, 7, "black"], source: "user_input" },
      { actor: "bot", move: [8, 8, "white"], source: "app_bot_engine" },
    ],
    textTurnFallback: null,
  };

  const evaluation = evaluateSyntheticAudioSuiteCase(summary, gomokuCase);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.screenshotsObserved, false);
});

test("primary Gomoku case rejects harness-forged bot moves", () => {
  const gomokuCase = localFixtureSyntheticAudioSuiteCases().find(
    (entry) => entry.id === "gomoku_sync_build_and_play_en",
  );
  const summary = {
    ok: true,
    acceptanceSatisfied: true,
    gates: {
      meetEnergyOk: true,
      speechStarted: true,
      responseSeen: true,
      outputRouted: true,
    },
    toolCalls: { all: ["delegate_to_worker"], worker: ["delegate_to_worker"] },
    workerArtifact: {
      built: true,
      appUrl: "http://127.0.0.1:49152",
      reachable: true,
      files: ["index.html"],
    },
    syncProbe: {
      twoClientSyncPass: true,
      screenshots: ["/tmp/player-a-after-sync.png", "/tmp/player-b-after-sync.png"],
    },
    moveLog: [
      { actor: "user", move: [7, 7, "black"], source: "harness_user" },
      { actor: "bot", move: [8, 8, "white"], source: "harness_direct_playMove" },
    ],
    textTurnFallback: null,
  };

  const evaluation = evaluateSyntheticAudioSuiteCase(summary, gomokuCase);

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.botMoveSourceObserved, false);
});

test("Gomoku worker artifact waits on delegate job, not worker_status history", () => {
  const jobId = extractWorkerJobIdFromSyntheticSummary({
    workerToolCalls: [
      {
        name: "worker_status",
        result: {
          jobs: [
            {
              id: "job_d4419713",
              status: "completed",
              result: '{"visible_text":"old unrelated result"}',
            },
          ],
        },
      },
      {
        name: "delegate_to_worker",
        result: {
          job: {
            id: "job_5746fe4d",
            status: "running",
          },
        },
      },
    ],
  });

  assert.equal(jobId, "job_5746fe4d");
});
