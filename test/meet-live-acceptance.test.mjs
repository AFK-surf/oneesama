import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { test } from "vite-plus/test";

import {
  buildChecks,
  resolveDiagnosticsPath,
  waitForNewerDiagnostics,
} from "../src/cli/meet-live-acceptance.ts";

function runtimeDiagnostics(realtimeOverrides = {}) {
  const defaultConnection = {
    dataChannelOpen: true,
    peerConnectionState: "connected",
    currentRealtimeInputSource: "recappi_process_audio_tap",
    lastRealtimeInputReplaceReason: "recappi-process-audio",
    openaiSessionId: "sess_live_ok",
    captionTurnsObserved: 2,
    blockedUserTextEvents: 0,
    meetAudioEnergy: {
      silenceMs: 300000,
    },
    recappiAudioInput: {
      connected: true,
      chunks: 1200,
      samplesReceived: 1228800,
      noiseSuppressedChunks: 50,
    },
    remoteAudioRoutedToAvatarBus: true,
    primaryMeetAudioSenderUsingAvatarBus: true,
    primaryMeetAudioSenderStats: {
      usingAvatarBus: true,
      trackReadyState: "live",
      bytesSent: 8192,
      bytesDelta: 4096,
      packetsSent: 24,
      packetsDelta: 12,
    },
  };
  const realtime = {
    realtimeRuntimePlacement: "sidecar",
    realtimePageRole: "sidecar",
    sdkOwner: "sidecar",
    connected: true,
    feedback: {
      status: "ready",
      blockers: [],
    },
    responsesRequested: 0,
    inboundTail: [
      {
        ts: "2026-05-28T10:00:01.000Z",
        event: { type: "input_audio_buffer.committed" },
      },
      {
        ts: "2026-05-28T10:00:11.000Z",
        event: { type: "input_audio_buffer.committed" },
      },
    ],
    transcripts: {
      input: [],
      output: [
        { ts: "2026-05-28T10:00:02.000Z", responseId: "response_1", text: "在呢。" },
        { ts: "2026-05-28T10:00:12.000Z", responseId: "response_2", text: "我是会议语音助手。" },
      ],
    },
    errors: [],
    ...realtimeOverrides,
    connection: {
      ...defaultConnection,
      ...realtimeOverrides.connection,
    },
  };
  return {
    sessionId: "live_acceptance_test",
    events: [
      {
        ts: "2026-05-28T10:05:00.000Z",
        type: "runtime_state_refresh",
        detail: {
          meetPage: {
            realtimeSurface: {
              runtimePlacement: "sidecar",
              pageRole: "meet-surface",
              sdkOwner: "sidecar",
              sdkSuppressedOnMeetSurface: true,
              hasSDKGlobal: false,
              bundleGlobal: "",
            },
          },
          avatarAudio: {
            ok: true,
            routedPcmChunks: 12,
            routedPcmSamples: 5760,
            outputEnergy: {
              observed: true,
              maxRms: 0.08,
            },
          },
          realtime,
        },
      },
    ],
  };
}

test("meet live acceptance passes a clean Realtime diagnostics snapshot", () => {
  const result = buildChecks(runtimeDiagnostics(), {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    requireSilenceMs: 300000,
    forbidden: [/sky[- ]?blue/i, /瑞利散射/i],
    expectedInput: [],
    expectedOutput: [/在呢/i, /会议语音助手/i],
  });

  assert.deepEqual(
    result.checks.filter((check) => !check.ok),
    [],
  );
});

test("meet live acceptance rejects spontaneous stale-topic output without raw audio turns", () => {
  const diagnostics = runtimeDiagnostics({
    connection: {
      dataChannelOpen: true,
      peerConnectionState: "connected",
      currentRealtimeInputSource: "recappi_process_audio_tap",
      lastRealtimeInputReplaceReason: "recappi-process-audio",
      openaiSessionId: "",
      captionTurnsObserved: 2,
      blockedUserTextEvents: 0,
      meetAudioEnergy: { silenceMs: 1000 },
      recappiAudioInput: {
        connected: true,
        chunks: 1200,
        samplesReceived: 1228800,
        noiseSuppressedChunks: 50,
      },
    },
    responsesRequested: 0,
    inboundTail: [],
    transcripts: {
      input: [],
      output: [{ ts: "2026-05-28T10:00:02.000Z", text: "The sky-blue answer uses 瑞利散射." }],
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    requireSilenceMs: 300000,
    forbidden: [/sky[- ]?blue/i, /瑞利散射/i],
    expectedInput: [],
    expectedOutput: [/在呢/i],
  });
  const failures = result.checks.filter((check) => !check.ok).map((check) => check.name);

  assert.deepEqual(
    failures.toSorted(),
    [
      "no_forbidden_old_topics_in_output",
      "one_response_per_raw_audio_turn",
      "openai_session_id_recorded",
      "outputs_have_raw_audio_turns",
      "required_silence_window_observed",
      "expected_output_topics_observed",
    ].toSorted(),
  );
});

test("meet live acceptance rejects Meet pages with Agents SDK globals", () => {
  const diagnostics = runtimeDiagnostics();
  diagnostics.events[0].detail.meetPage.realtimeSurface.hasSDKGlobal = true;
  diagnostics.events[0].detail.meetPage.realtimeSurface.bundleGlobal = "OpenAIAgentsRealtime";

  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
  });

  assert.ok(
    result.checks.some((check) => check.name === "meet_surface_has_no_agents_sdk" && !check.ok),
  );
});

test("meet live acceptance rejects non-sidecar SDK ownership", () => {
  const diagnostics = runtimeDiagnostics({
    realtimeRuntimePlacement: "inline",
    realtimePageRole: "meet-surface",
    sdkOwner: "meet-page",
  });

  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
  });

  assert.ok(result.checks.some((check) => check.name === "sidecar_sdk_owner" && !check.ok));
});

test("meet live acceptance rejects host-forwarded Meet PCM as real-room Realtime input", () => {
  const diagnostics = runtimeDiagnostics({
    connection: {
      dataChannelOpen: true,
      peerConnectionState: "connected",
      currentRealtimeInputSource: "host_meet_audio_pcm",
      lastRealtimeInputReplaceReason: "host-meet-audio-pcm",
      openaiSessionId: "sess_live_ok",
      captionTurnsObserved: 2,
      blockedUserTextEvents: 0,
      meetAudioEnergy: { silenceMs: 300000 },
      hostMeetAudioInput: {
        connected: true,
        chunks: 120,
        samplesReceived: 122880,
        samplesQueued: 122880,
      },
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 300000,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
  });
  const failures = result.checks.filter((check) => !check.ok);

  assert.deepEqual(
    failures.map((check) => check.name).toSorted(),
    ["live_realtime_input_flowing", "live_realtime_input_source"].toSorted(),
  );
  assert.ok(
    failures.some(
      (check) =>
        check.name === "live_realtime_input_flowing" &&
        check.detail?.reason === "host_meet_audio_pcm_is_diagnostic_only" &&
        check.detail?.diagnosticFlowing === true,
    ),
  );
});

test("meet live acceptance rejects output that never reaches the Meet fake mic sender", () => {
  const diagnostics = runtimeDiagnostics({
    connection: {
      remoteAudioRoutedToAvatarBus: true,
      primaryMeetAudioSenderUsingAvatarBus: true,
      primaryMeetAudioSenderStats: {
        usingAvatarBus: true,
        trackReadyState: "ended",
        bytesSent: 0,
        bytesDelta: 0,
        packetsSent: 0,
        packetsDelta: 0,
      },
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
  });

  assert.ok(
    result.checks.some(
      (check) =>
        check.name === "meet_fake_mic_sender_live" &&
        !check.ok &&
        check.detail?.required === true &&
        check.detail?.remoteAudioRoutedToAvatarBus === true &&
        check.detail?.primaryMeetAudioSenderUsingAvatarBus === true &&
        check.detail?.trackReadyState === "ended" &&
        check.detail?.bytesSent === 0,
    ),
  );
});

test("meet live acceptance rejects stale fake mic sender stats without fresh bytes", () => {
  const diagnostics = runtimeDiagnostics({
    connection: {
      remoteAudioRoutedToAvatarBus: true,
      primaryMeetAudioSenderUsingAvatarBus: true,
      primaryMeetAudioSenderStats: {
        usingAvatarBus: true,
        trackReadyState: "live",
        bytesSent: 8192,
        bytesDelta: 0,
        packetsSent: 24,
        packetsDelta: 0,
      },
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
  });

  assert.ok(
    result.checks.some(
      (check) =>
        check.name === "meet_fake_mic_sender_live" &&
        !check.ok &&
        check.detail?.trackReadyState === "live" &&
        check.detail?.bytesSent === 8192 &&
        check.detail?.bytesDelta === 0 &&
        check.detail?.packetsDelta === 0 &&
        check.detail?.senderFresh === false,
    ),
  );
});

test("meet live acceptance rejects reused OpenAI sessions across joins", () => {
  const current = runtimeDiagnostics();
  const previous = runtimeDiagnostics();
  const result = buildChecks(
    current,
    {
      diagnosticsPath: "unused",
      previousDiagnosticsPath: "previous",
      requireSilenceMs: 0,
      forbidden: [],
      expectedInput: [],
      expectedOutput: [],
    },
    previous,
  );
  const failures = result.checks.filter((check) => !check.ok).map((check) => check.name);

  assert.deepEqual(failures, ["openai_session_id_is_fresh"]);
});

test("meet live acceptance accepts fresh OpenAI sessions across joins", () => {
  const current = runtimeDiagnostics();
  const previous = runtimeDiagnostics({
    connection: {
      dataChannelOpen: true,
      peerConnectionState: "connected",
      currentRealtimeInputSource: "recappi_process_audio_tap",
      lastRealtimeInputReplaceReason: "recappi-process-audio",
      openaiSessionId: "sess_previous",
      captionTurnsObserved: 2,
      blockedUserTextEvents: 0,
      meetAudioEnergy: { silenceMs: 300000 },
      recappiAudioInput: {
        connected: true,
        chunks: 1200,
        samplesReceived: 1228800,
        noiseSuppressedChunks: 50,
      },
    },
  });
  const result = buildChecks(
    current,
    {
      diagnosticsPath: "unused",
      previousDiagnosticsPath: "previous",
      requireSilenceMs: 0,
      forbidden: [],
      expectedInput: [],
      expectedOutput: [],
    },
    previous,
  );

  assert.deepEqual(
    result.checks.filter((check) => !check.ok),
    [],
  );
});

test("meet live acceptance rejects functional fake execution", () => {
  const diagnostics = runtimeDiagnostics({
    feedback: {
      status: "tool_blocked",
      blockers: ["assistant_text_without_expected_functional_tool"],
      checks: {
        latestFunctionalTurnFakeExecution: true,
        latestFunctionalTurn: {
          observed: true,
          intent: "share",
          userText: "分享一下 Chrome 浏览器窗口。",
          assistantText: "还在共享处理中，请稍等一下。",
          expectedToolNames: ["list_shareable_windows", "share_existing_app_window"],
          toolNames: [],
          toolCalled: false,
          fakeExecution: true,
        },
      },
      failureMatrix: {
        toolTurns: {
          status: "blocked",
          reason: "assistant_text_without_expected_functional_tool",
          signals: {},
        },
      },
    },
    contextHealth: {
      latestFunctionalTurn: {
        observed: true,
        intent: "share",
        toolCalled: false,
        fakeExecution: true,
      },
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
  });

  assert.ok(
    result.checks.some((check) => check.name === "no_functional_tool_fake_execution" && !check.ok),
  );
});

test("meet live acceptance validates expected input text and tool telemetry", () => {
  const diagnostics = runtimeDiagnostics({
    inboundTail: [
      {
        ts: "2026-05-28T10:00:00.000Z",
        event: { type: "input_audio_buffer.committed" },
      },
      {
        ts: "2026-05-28T10:00:00.500Z",
        event: { type: "input_audio_buffer.committed" },
      },
      {
        ts: "2026-05-28T10:00:01.000Z",
        event: {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "分享一下 Chrome 浏览器窗口。",
        },
      },
    ],
    contextHealth: {
      latestFunctionalTurn: {
        observed: true,
        intent: "share",
        userText: "分享一下 Chrome 浏览器窗口。",
        expectedToolNames: ["list_shareable_windows", "share_existing_app_window"],
        toolNames: ["share_existing_app_window"],
        toolCalled: true,
        fakeExecution: false,
      },
      lastHistoryTail: [
        { type: "message", role: "user", text: "分享一下 Chrome 浏览器窗口。" },
        { type: "function_call", name: "share_existing_app_window" },
      ],
    },
    meetTools: {
      calls: [{ name: "share_existing_app_window" }],
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [/分享.*Chrome.*窗口/i],
    expectedOutput: [],
    expectedTools: ["share_existing_app_window"],
  });

  assert.deepEqual(
    result.checks.filter((check) => !check.ok),
    [],
  );
});

test("meet live acceptance validates expected app-control terminal success", () => {
  const diagnostics = runtimeDiagnostics({
    workspaceTools: {
      calls: [
        {
          name: "kwwk_computer_use",
          callId: "call_app_control",
          result: {
            ok: true,
            status: "completed",
            jobId: "job_app_control",
          },
        },
      ],
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
    expectedTools: ["kwwk_computer_use"],
  });

  assert.deepEqual(
    result.checks.filter((check) => !check.ok),
    [],
  );
});

test("meet live acceptance accepts expected app-control compact blocker", () => {
  const diagnostics = runtimeDiagnostics({
    workspaceTools: {
      calls: [
        {
          name: "kwwk_computer_use",
          callId: "call_app_control",
          result: {
            ok: false,
            status: "blocked",
            blocker: "permission_required",
            jobId: "job_app_control",
          },
        },
      ],
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
    expectedTools: ["kwwk_computer_use"],
  });

  assert.deepEqual(
    result.checks.filter((check) => !check.ok),
    [],
  );
});

test("meet live acceptance rejects app-control compact blocker with contradictory ok true", () => {
  const diagnostics = runtimeDiagnostics({
    workspaceTools: {
      calls: [
        {
          name: "kwwk_computer_use",
          callId: "call_app_control",
          result: {
            ok: true,
            status: "blocked",
            blocker: "permission_required",
            jobId: "job_app_control",
          },
        },
      ],
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
    expectedTools: ["kwwk_computer_use"],
  });

  assert.ok(
    result.checks.some(
      (check) =>
        check.name === "expected_app_control_terminal_result" &&
        !check.ok &&
        check.detail?.records?.some(
          (record) =>
            record.status === "blocked" && record.ok === true && record.compactBlocker === false,
        ),
    ),
  );
});

test("meet live acceptance rejects expected app-control blocked without compact blocker", () => {
  const diagnostics = runtimeDiagnostics({
    feedback: {
      status: "tool_blocked",
      blockers: ["app_control_job_blocked"],
      failureMatrix: {
        toolTurns: {
          status: "blocked",
          reason: "app_control_job_blocked",
          signals: { blocked: 1 },
        },
      },
    },
    workspaceTools: {
      calls: [
        {
          name: "kwwk_computer_use",
          callId: "call_app_control",
          result: {
            ok: false,
            status: "blocked",
            jobId: "job_app_control",
          },
        },
      ],
    },
    turnPolicy: {
      appControlJobs: {
        job_app_control: {
          jobId: "job_app_control",
          status: "blocked",
          reason: "app_control_blocked",
        },
      },
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
    expectedTools: ["kwwk_computer_use"],
  });

  assert.ok(
    result.checks.some(
      (check) =>
        check.name === "expected_app_control_terminal_result" &&
        !check.ok &&
        check.detail?.blockedByFeedback === true &&
        check.detail?.toolTurnsReason === "app_control_job_blocked",
    ),
  );
});

test("meet live acceptance rejects expected app-control pending job", () => {
  const diagnostics = runtimeDiagnostics({
    feedback: {
      status: "waiting_for_turn",
      blockers: ["app_control_job_pending"],
      failureMatrix: {
        toolTurns: {
          status: "waiting",
          reason: "app_control_job_pending",
          signals: { pending: 1 },
        },
      },
    },
    workspaceTools: {
      calls: [
        {
          name: "kwwk_computer_use",
          callId: "call_app_control",
          result: {
            ok: true,
            status: "queued",
            jobId: "job_app_control",
          },
        },
      ],
    },
    turnPolicy: {
      appControlJobs: {
        job_app_control: {
          jobId: "job_app_control",
          status: "running",
        },
      },
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
    expectedTools: ["kwwk_computer_use"],
  });

  assert.ok(
    result.checks.some(
      (check) =>
        check.name === "expected_app_control_terminal_result" &&
        !check.ok &&
        check.detail?.pendingOrStaleRecord === true,
    ),
  );
});

test("meet live acceptance rejects stale app-control job even with older success", () => {
  const diagnostics = runtimeDiagnostics({
    feedback: {
      status: "tool_blocked",
      blockers: ["app_control_job_stale"],
      failureMatrix: {
        toolTurns: {
          status: "blocked",
          reason: "app_control_job_stale",
          signals: { stale: 1, completed: 1 },
        },
      },
    },
    workspaceTools: {
      calls: [
        {
          name: "kwwk_computer_use",
          callId: "call_app_control_old",
          result: {
            ok: true,
            status: "completed",
            jobId: "job_app_control_old",
          },
        },
      ],
    },
    turnPolicy: {
      appControlJobs: {
        job_app_control_old: {
          jobId: "job_app_control_old",
          status: "completed",
        },
        job_app_control_stale: {
          jobId: "job_app_control_stale",
          status: "stale",
        },
      },
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [],
    expectedTools: ["kwwk_computer_use"],
  });

  assert.ok(
    result.checks.some(
      (check) =>
        check.name === "expected_app_control_terminal_result" &&
        !check.ok &&
        check.detail?.success === true &&
        check.detail?.pendingOrStaleFeedback === true &&
        check.detail?.pendingOrStaleRecord === true &&
        check.detail?.unresolvedJob === true,
    ),
  );
});

test("meet live acceptance rejects expected input without real tool telemetry", () => {
  const diagnostics = runtimeDiagnostics({
    inboundTail: [
      {
        ts: "2026-05-28T10:00:01.000Z",
        event: {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "分享一下 Chrome 浏览器窗口。",
        },
      },
    ],
    contextHealth: {
      latestFunctionalTurn: {
        observed: true,
        intent: "share",
        userText: "分享一下 Chrome 浏览器窗口。",
        assistantText: "还在共享处理中，请稍等一下。",
        expectedToolNames: ["list_shareable_windows", "share_existing_app_window"],
        toolNames: [],
        toolCalled: false,
        fakeExecution: true,
      },
      lastHistoryTail: [{ type: "message", role: "user", text: "分享一下 Chrome 浏览器窗口。" }],
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [/分享.*Chrome.*窗口/i],
    expectedOutput: [],
    expectedTools: ["share_existing_app_window"],
  });
  const failures = new Set(result.checks.filter((check) => !check.ok).map((check) => check.name));

  assert.ok(failures.has("expected_realtime_tool_called"));
  assert.ok(failures.has("no_functional_tool_fake_execution"));
  assert.ok(!failures.has("expected_input_text_observed"));
});

test("meet live acceptance rejects missing expected input text", () => {
  const result = buildChecks(runtimeDiagnostics(), {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [/分享.*Chrome.*窗口/i],
    expectedOutput: [],
    expectedTools: [],
  });
  const failures = new Set(result.checks.filter((check) => !check.ok).map((check) => check.name));

  assert.ok(failures.has("expected_input_text_observed"));
});

test("meet live acceptance resolves latest and previous diagnostics artifacts", async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), "meet-live-acceptance-"));
  try {
    const older = pathJoin(dir, "older-diagnostics.json");
    const newer = pathJoin(dir, "newer-diagnostics.json");
    await writeFile(older, "{}\n");
    await writeFile(newer, "{}\n");
    await utimes(older, new Date("2026-05-28T09:00:00Z"), new Date("2026-05-28T09:00:00Z"));
    await utimes(newer, new Date("2026-05-28T10:00:00Z"), new Date("2026-05-28T10:00:00Z"));

    assert.equal(await resolveDiagnosticsPath("latest", dir), newer);
    assert.equal(await resolveDiagnosticsPath("previous", dir), older);
    assert.equal(await resolveDiagnosticsPath("previous", dir, newer), older);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("meet live acceptance waits for a newer diagnostics artifact", async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), "meet-live-acceptance-"));
  try {
    const baseline = pathJoin(dir, "baseline-diagnostics.json");
    const next = pathJoin(dir, "next-diagnostics.json");
    await writeFile(baseline, "{}\n");
    await utimes(baseline, new Date("2026-05-28T09:00:00Z"), new Date("2026-05-28T09:00:00Z"));
    const pending = waitForNewerDiagnostics({
      diagnosticsDir: dir,
      waitNewerThan: String(new Date("2026-05-28T09:00:00Z").getTime()),
      waitTimeoutMs: 1000,
      pollMs: 50,
    });
    await writeFile(next, "{}\n");
    await utimes(next, new Date("2026-05-28T10:00:00Z"), new Date("2026-05-28T10:00:00Z"));

    assert.equal(await pending, next);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("meet live acceptance counts duplicate output segments by response id", () => {
  const diagnostics = runtimeDiagnostics({
    inboundTail: [
      {
        ts: "2026-05-28T10:00:01.000Z",
        event: { type: "input_audio_buffer.committed" },
      },
    ],
    transcripts: {
      input: [],
      output: [
        { ts: "2026-05-28T10:00:02.000Z", responseId: "response_1", text: "在呢。" },
        { ts: "2026-05-28T10:00:02.100Z", responseId: "response_1", text: "我听到了。" },
      ],
    },
  });
  const result = buildChecks(diagnostics, {
    diagnosticsPath: "unused",
    previousDiagnosticsPath: "",
    diagnosticsDir: "",
    requireSilenceMs: 0,
    forbidden: [],
    expectedInput: [],
    expectedOutput: [/在呢/i],
  });

  assert.equal(result.counts.rawAudioInputTurns, 1);
  assert.equal(result.counts.outputTurns, 1);
  assert.deepEqual(
    result.checks.filter((check) => !check.ok),
    [],
  );
});
