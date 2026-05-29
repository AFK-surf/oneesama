import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import test from "node:test";

import {
  buildChecks,
  resolveDiagnosticsPath,
  waitForNewerDiagnostics,
} from "../src/cli/meet-live-acceptance.ts";

function runtimeDiagnostics(realtimeOverrides = {}) {
  const realtime = {
    connected: true,
    feedback: {
      status: "ready",
      blockers: [],
    },
    connection: {
      dataChannelOpen: true,
      peerConnectionState: "connected",
      currentRealtimeInputSource: "recappi_process_audio_tap",
      lastRealtimeInputReplaceReason: "recappi-process-audio",
      openaiSessionId: "sess_live_ok",
      captionTurnsObserved: 2,
      captionTurnsInjected: 0,
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
  };
  return {
    sessionId: "live_acceptance_test",
    events: [
      {
        ts: "2026-05-28T10:05:00.000Z",
        type: "runtime_state_refresh",
        detail: { realtime },
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
      captionTurnsInjected: 0,
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
      captionTurnsInjected: 0,
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
