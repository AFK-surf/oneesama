/* eslint-disable max-lines */
import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  aggregateLanAcceptanceSloReports,
  attachLanAcceptanceSlo,
  scoreLanAcceptanceSlo,
} from "../scripts/lan-operator-acceptance-slo.mjs";

const baseTime = Date.parse("2026-06-05T00:00:00.000Z");

function at(ms) {
  return new Date(baseTime + ms).toISOString();
}

function kwwkPhaseEvidence() {
  return {
    observe: {
      status: "observed",
      summary: "light",
      detail: { stateSource: "oneesama_app_control_helper" },
    },
    plan: {
      status: "planned",
      summary: "press_key",
      detail: { provider: "model_first_local_fixture", modelUsed: true },
    },
    execute: {
      status: "executed",
      summary: "1/1 actions succeeded",
      detail: {
        actionCount: 1,
        successCount: 1,
        actionKinds: ["type_text"],
        executionSurface: "kwwk_computer_use_core",
        cursorPolicy: "kwwk_core_background_action_no_pointer",
        pointerAction: false,
        cursorEventCount: 0,
      },
    },
  };
}

function verifiedKwwkSample(totalMs) {
  return {
    totalMs,
    phaseEvidence: kwwkPhaseEvidence(),
    mutation: { verified: true },
    verification: { schema: "oneesama.kwwk-cu-verification.v1", ok: true, status: "passed" },
  };
}

function inFlightProgress() {
  return {
    schemaVersion: 1,
    source: "host_helper_in_flight_stream",
    beforeResponseCount: 3,
    phasesBeforeResponse: ["observe", "plan", "execute"],
    phaseCountBeforeResponse: 3,
  };
}

function hardCancelEvidence() {
  return { ok: true, processTerminated: true, responseBeforeCancel: false, exitSignal: "SIGTERM" };
}

function kwwkPhaseBlockers() {
  const entries = [
    {
      phase: "observe",
      blocker: "kwwk_cu_target_app_required",
      evidence: { observationMode: "light" },
    },
    {
      phase: "plan",
      blocker: "model_plan_operations_required",
      evidence: { plannerProvider: "model_first_local_fixture" },
    },
    {
      phase: "execute",
      blocker: "element_not_found",
      evidence: { executionError: "element_not_found" },
    },
    {
      phase: "verify",
      blocker: "failed_verification",
      evidence: {
        verificationSchema: "oneesama.kwwk-cu-verification.v1",
        verificationBlocker: "failed_verification",
        failedCheckCount: 1,
      },
    },
  ].map((entry) => Object.assign(entry, { source: "host_kwwk_helper_probe", ok: true }));
  return {
    schema: "oneesama.kwwk_phase_blocker_matrix.v1",
    source: "host_kwwk_helper_probe",
    entries,
  };
}

function visualAcceptanceReport(input = {}) {
  const visualPatch = input.visual || {};
  const compositionPatch = visualPatch.composition || {};
  const frameAgeMs = "frameAgeMs" in visualPatch ? visualPatch.frameAgeMs : 12;
  const frameRate = "frameRate" in visualPatch ? visualPatch.frameRate : 30;
  const composition = {
    mode: "operator_side",
    localComposedTrack: true,
    localComposedStreamId: "stream_fixture",
    trackId: "track_fixture",
    trackKind: "video",
    trackReadyState: "live",
    trackMuted: false,
    width: 1280,
    height: 720,
    targetFps: 30,
    renderedFrameCount: 24,
    lastRenderedFrameAt: at(300),
    lastRenderedFrameAgeMs: 9,
    layoutRevision: 1,
    sourceRects: {
      "host-app": { x: 0.04, y: 0.08, width: 0.64, height: 0.78 },
      avatar: { x: 0.58, y: 0.42, width: 0.28, height: 0.38 },
    },
    focusedSourceId: "avatar",
    overlayCount: 1,
    ...compositionPatch,
  };
  const layoutUpdate = {
    schema: "oneesama.operator_visual_layout_update.v1",
    sourceId: "avatar",
    action: "move_resize",
    beforeRect: { x: 0.72, y: 0.54, width: 0.22, height: 0.34 },
    afterRect: { x: 0.58, y: 0.42, width: 0.28, height: 0.38 },
    rectDelta: { x: 0.14, y: 0.12, width: 0.06, height: 0.04 },
    moved: true,
    resized: true,
    revisionBefore: 0,
    revisionAfter: 1,
    focusedSourceIdAfter: "avatar",
    composedTrack: {
      liveBefore: true,
      liveAfter: true,
      trackIdBefore: "track_fixture",
      trackIdAfter: "track_fixture",
      trackKindBefore: "video",
      trackKindAfter: "video",
      trackIdStable: true,
    },
    sourceTracks: {
      hostAppBefore: "host_track_fixture",
      hostAppAfter: "host_track_fixture",
      hostAppStable: true,
      avatarBefore: "avatar_track_fixture",
      avatarAfter: "avatar_track_fixture",
      avatarStable: true,
    },
  };
  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_host_visual_stream",
    ok: true,
    timings: { connectedMs: 700, ...input.timings },
    visual: {
      frameAgeMs,
      frameRate,
      sources: [
        {
          id: "host-app",
          state: "live",
          trackReadyState: "live",
          width: 1280,
          height: 720,
          frameRate: 30,
          frameAgeMs: 12,
          captureStatus: "live",
        },
        {
          id: "avatar",
          state: "live",
          trackReadyState: "live",
          width: 640,
          height: 360,
          frameRate: 30,
          frameAgeMs: 12,
        },
      ],
      hostSourceMode: visualPatch.hostSourceMode || "diagnostic_canvas",
      hostCaptureStatus: visualPatch.hostCaptureStatus || "live",
      hostCaptureError: visualPatch.hostCaptureError || "",
      hostDisplayCaptureRequired: Boolean(visualPatch.hostDisplayCaptureRequired),
      avatarSourceMode: "avatar_renderer",
      avatarRenderer: "fallback",
      overlayVisible: true,
      operatorScreenBackflow: false,
      layoutUpdate,
      ...visualPatch,
      composition,
    },
    lanEvidence: input.lanEvidence || undefined,
  };
}

function openaiLiveAcceptanceReport(input = {}) {
  return {
    ...input,
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_openai_realtime_live",
    ok: input.ok ?? true,
    functionalOk: input.functionalOk ?? true,
    diagnosticOnly: input.diagnosticOnly ?? false,
    skipped: input.skipped ?? false,
    acceptanceSatisfied: input.acceptanceSatisfied ?? true,
    conversationEngine: {
      kind: "openai_realtime",
      transport: "openai_realtime",
      engineId: "openai_realtime",
      status: "connected",
      providerAdapterKind: "openai_realtime",
      providerEventCounts: {
        "session.created": 1,
        "response.output_text.done": 1,
      },
      providerEventTotal: 2,
      providerTextEventCount: 1,
      rawProviderEventsAvailable: true,
      canonicalEventCounts: {
        engine_connected: 1,
        transcript_completed: 1,
        assistant_text_completed: 1,
      },
      latestCanonicalEvent: "assistant_text_completed",
      ...input.conversationEngine,
    },
    provider: {
      name: "openai",
      realtimeModel: "gpt-realtime-2",
      rawPayloadStored: false,
      ...input.provider,
    },
    timeline: input.timeline || [],
    turns: input.turns || [],
  };
}

function openaiVoiceLiveAcceptanceReport(input = {}) {
  return {
    ...input,
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_openai_realtime_voice_live",
    ok: input.ok ?? true,
    functionalOk: input.functionalOk ?? true,
    diagnosticOnly: input.diagnosticOnly ?? false,
    skipped: input.skipped ?? false,
    acceptanceSatisfied: input.acceptanceSatisfied ?? true,
    conversationEngine: {
      kind: "openai_realtime",
      transport: "openai_realtime",
      engineId: "openai_realtime",
      status: "connected",
      providerAdapterKind: "openai_realtime",
      providerEventCounts: {
        "session.created": 1,
        "input_audio_buffer.speech_started": 1,
        "input_audio_buffer.speech_stopped": 1,
        "conversation.item.input_audio_transcription.completed": 1,
        "response.output_text.done": 1,
      },
      providerEventTotal: 5,
      providerAudioInputEventCount: 3,
      providerTextEventCount: 1,
      rawProviderEventsAvailable: true,
      canonicalEventCounts: {
        engine_connected: 1,
        speech_started: 1,
        transcript_completed: 1,
        assistant_text_completed: 1,
      },
      latestCanonicalEvent: "assistant_text_completed",
      ...input.conversationEngine,
    },
    provider: {
      name: "openai",
      realtimeModel: "gpt-realtime-2",
      inputAudioFormat: "pcm16",
      inputAudioTranscriptionModel: "whisper-1",
      turnDetection: "server_vad",
      rawPayloadStored: false,
      ...input.provider,
    },
    audio: {
      transport: "websocket_pcm",
      captureMode: "fixture_replay_pcm16",
      chunksReceivedDelta: 24,
      forwardedChunksDelta: 24,
      hostReceiveLagMs: 12,
      voiceAckRttMs: 18,
      speechFixture: {
        mode: "macos_say",
        sampleRate: 24000,
        channels: 1,
        chunkCount: 24,
        speechChunkCount: 18,
      },
      ...input.audio,
    },
    args: {
      minVoiceChunks: 12,
      ...input.args,
    },
    timeline: input.timeline || [],
    turns: input.turns || [],
  };
}

function openaiToolLiveAcceptanceReport(input = {}) {
  return {
    ...input,
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_openai_realtime_tool_live",
    ok: input.ok ?? true,
    functionalOk: input.functionalOk ?? true,
    diagnosticOnly: input.diagnosticOnly ?? false,
    skipped: input.skipped ?? false,
    acceptanceSatisfied: input.acceptanceSatisfied ?? true,
    conversationEngine: {
      kind: "openai_realtime",
      transport: "openai_realtime",
      engineId: "openai_realtime",
      status: "connected",
      providerAdapterKind: "openai_realtime",
      providerEventCounts: {
        "session.created": 1,
        "response.output_item.added": 1,
        "response.function_call_arguments.done": 1,
        "response.output_text.done": 1,
      },
      providerEventTotal: 4,
      providerToolCallEventCount: 2,
      providerTextEventCount: 1,
      rawProviderEventsAvailable: true,
      canonicalEventCounts: {
        engine_connected: 1,
        transcript_completed: 1,
        tool_call_started: 1,
        tool_call_completed: 1,
        tool_result_accepted: 1,
        assistant_text_completed: 1,
      },
      latestCanonicalEvent: "assistant_text_completed",
      ...input.conversationEngine,
    },
    provider: {
      name: "openai",
      realtimeModel: "gpt-realtime-2",
      toolsExposed: ["kwwk_computer_use"],
      toolChoice: "auto",
      rawPayloadStored: false,
      ...input.provider,
    },
    tool: {
      expectedTool: "kwwk_computer_use",
      actualTool: "kwwk_computer_use",
      callId: "call_live_tool",
      itemId: "item_live_tool",
      arguments: {
        instruction: "switch to the first browser tab",
        applicationName: "Chrome",
        windowTitle: "LAN tool routing fixture",
      },
      argumentSafety: {
        naturalLanguageInstruction: true,
        safeTargetHint: true,
        exposesRawOperations: false,
        exposesCoordinates: false,
        ok: true,
      },
      functionOutputDelivered: true,
      functionOutput: { ok: true, jobId: "lan_openai_tool_live_job" },
      ...input.tool,
    },
    timeline: input.timeline || [],
    turns: input.turns || [],
  };
}

test("LAN acceptance SLO scoring passes a fast voice-loop report", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_voice_loop",
    ok: true,
    conversationEngine: {
      speechStartMs: 120,
      canonicalEventCounts: {
        speech_started: 1,
        assistant_text_completed: 1,
      },
    },
    audio: {
      transport: "websocket_pcm",
      turnDetectionOwner: "conversation_engine",
      localVadEnabled: false,
      localVadRole: "disabled",
      forwardedChunks: 6,
      forwardedChunksDelta: 6,
      hostReceiveLagMs: 12,
      voiceAckRttMs: 18,
      voiceStreamId: "voice_stream_fast",
      voiceStreamGeneration: 1,
      voiceStreamOpenCount: 1,
      staleChunksRejected: 0,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_fast_voice",
        durationMs: null,
        ok: true,
      },
      {
        at: at(120),
        event: "speech_started",
        turnId: "turn_fast_voice",
        durationMs: 120,
        ok: true,
      },
      {
        at: at(180),
        event: "transcript_delta",
        turnId: "turn_fast_voice",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(310),
        event: "assistant_text_delta",
        turnId: "turn_fast_voice",
        durationMs: 310,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_fast_voice",
        milestones: { heard: true, speechStarted: true, transcript: true, output: true },
      },
    ],
  });

  assert.equal(report.functionalOk, true);
  assert.equal(report.slo.ok, true);
  assert.equal(report.ok, true);
  assert.equal(report.perceivedUx.firstFeedbackStageId, "turn_heard_to_speech_started_ms");
  assert.equal(report.perceivedUx.firstFeedbackMs, 120);
  assert.notEqual(report.perceivedUx.slowestStage.id, "lan_voice_external_lan_surface_observed");
  assert.deepEqual(report.slo.failures, []);
});

test("LAN voice-loop SLO requires input energy evidence in real-mic mode", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.local_voice_acceptance.v1",
    gate: "local_voice",
    ok: true,
    conversationEngine: {
      speechStartMs: 120,
      canonicalEventCounts: {
        speech_started: 1,
        assistant_text_completed: 1,
      },
    },
    audio: {
      transport: "websocket_pcm",
      turnDetectionOwner: "conversation_engine",
      localVadEnabled: false,
      localVadRole: "disabled",
      forwardedChunks: 6,
      forwardedChunksDelta: 6,
      hostReceiveLagMs: 12,
      voiceAckRttMs: 18,
      voiceStreamId: "voice_stream_real_mic",
      voiceStreamGeneration: 1,
      voiceStreamOpenCount: 1,
      staleChunksRejected: 0,
      realMicrophoneRequired: true,
      realMicrophoneEvidenceOk: false,
      inputEnergyThreshold: 0.02,
      maxInputEnergy: 0.001,
      inputEnergySamplesAboveThreshold: 0,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_real_mic",
        durationMs: null,
        ok: true,
      },
      { at: at(120), event: "speech_started", turnId: "turn_real_mic", durationMs: 120, ok: true },
      {
        at: at(180),
        event: "transcript_delta",
        turnId: "turn_real_mic",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(310),
        event: "assistant_text_delta",
        turnId: "turn_real_mic",
        durationMs: 310,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_real_mic",
        milestones: { heard: true, speechStarted: true, transcript: true, output: true },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "operator_voice_real_microphone_energy_observed",
    ),
    JSON.stringify(report.slo),
  );
});

test("LAN voice-loop SLO uses turn milestones after rolling timeline drops early voice rows", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.local_voice_acceptance.v1",
    gate: "local_voice",
    ok: true,
    conversationEngine: {
      speechStartMs: null,
      canonicalEventCounts: {
        speech_started: 1,
        assistant_text_completed: 1,
      },
    },
    audio: {
      transport: "websocket_pcm",
      turnDetectionOwner: "conversation_engine",
      localVadEnabled: false,
      localVadRole: "disabled",
      forwardedChunks: 250,
      forwardedChunksDelta: 250,
      hostReceiveLagMs: 12,
      voiceAckRttMs: 18,
      voiceStreamId: "voice_stream_rolled",
      voiceStreamGeneration: 1,
      voiceStreamOpenCount: 1,
      staleChunksRejected: 0,
      realMicrophoneRequired: true,
      realMicrophoneEvidenceOk: true,
      inputEnergyThreshold: 0.02,
      maxInputEnergy: 0.024,
      inputEnergySamplesAboveThreshold: 1,
    },
    timeline: [
      {
        at: at(180),
        event: "transcript_delta",
        turnId: "turn_rolled",
        durationMs: 0,
        ok: true,
      },
      {
        at: at(310),
        event: "assistant_text_delta",
        turnId: "turn_rolled",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(320),
        event: "assistant_audio_started",
        turnId: "turn_rolled",
        durationMs: 140,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_rolled",
        startedAt: at(0),
        lastEventAt: at(320),
        durationMs: 320,
        milestones: { heard: true, speechStarted: true, transcript: true, output: true },
        milestoneAts: {
          heard: at(0),
          speechStarted: at(120),
          transcript: at(180),
          output: at(310),
        },
        milestoneDurationsMs: {
          heard: null,
          speechStarted: 120,
          transcript: 180,
          output: 310,
        },
      },
    ],
  });

  assert.equal(report.functionalOk, true);
  assert.equal(report.slo.ok, true);
  assert.equal(report.ok, true);
  assert.deepEqual(report.slo.failures, []);
});

test("LAN voice-loop SLO fails when Local VAD is required for forwarding", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_voice_loop",
    ok: true,
    conversationEngine: {
      speechStartMs: 120,
      canonicalEventCounts: {
        speech_started: 1,
        assistant_text_completed: 1,
      },
    },
    audio: {
      transport: "websocket_pcm",
      turnDetectionOwner: "conversation_engine",
      localVadEnabled: true,
      localVadRole: "telemetry",
      forwardedChunks: 6,
      forwardedChunksDelta: 6,
      hostReceiveLagMs: 12,
      voiceAckRttMs: 18,
      voiceStreamId: "voice_stream_vad",
      voiceStreamGeneration: 1,
      voiceStreamOpenCount: 1,
      staleChunksRejected: 0,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_vad_required",
        durationMs: null,
        ok: true,
      },
      {
        at: at(120),
        event: "speech_started",
        turnId: "turn_vad_required",
        durationMs: 120,
        ok: true,
      },
      {
        at: at(180),
        event: "transcript_delta",
        turnId: "turn_vad_required",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(310),
        event: "assistant_text_delta",
        turnId: "turn_vad_required",
        durationMs: 310,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_vad_required",
        milestones: { heard: true, speechStarted: true, transcript: true, output: true },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "operator_voice_local_vad_not_required"),
    JSON.stringify(report.slo),
  );
});

test("LAN voice-loop SLO can require external LAN surface evidence", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_voice_loop",
    ok: true,
    conversationEngine: {
      speechStartMs: 120,
      canonicalEventCounts: { speech_started: 1, assistant_text_completed: 1 },
    },
    audio: {
      transport: "websocket_pcm",
      turnDetectionOwner: "conversation_engine",
      localVadEnabled: false,
      localVadRole: "disabled",
      forwardedChunksDelta: 6,
      hostReceiveLagMs: 12,
      voiceAckRttMs: 18,
      voiceStreamId: "voice_stream_external",
      voiceStreamGeneration: 1,
      voiceStreamOpenCount: 1,
      staleChunksRejected: 0,
    },
    lanEvidence: {
      externalSurfaceMode: true,
      nonLoopbackSurfaceHost: true,
      peerEvidence: { operatorNonLoopbackPeerCount: 1, operatorPrivateLanPeerCount: 1 },
      voicePublisherMode: "preexisting_lan_operator_surface",
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_external_voice",
        durationMs: null,
        ok: true,
      },
      {
        at: at(120),
        event: "speech_started",
        turnId: "turn_external_voice",
        durationMs: 120,
        ok: true,
      },
      {
        at: at(180),
        event: "transcript_delta",
        turnId: "turn_external_voice",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(310),
        event: "assistant_text_delta",
        turnId: "turn_external_voice",
        durationMs: 310,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_external_voice",
        milestones: { heard: true, speechStarted: true, transcript: true, output: true },
      },
    ],
  });

  const entry = report.slo.entries.find(
    (item) => item.id === "lan_voice_external_lan_surface_observed",
  );
  assert.equal(report.ok, true);
  assert.equal(entry.required, true);
  assert.equal(entry.actual, 1);
  assert.equal(
    report.slo.entries.find((item) => item.id === "lan_voice_external_operator_peer_observed")
      .actual,
    1,
  );
});

test("LAN voice-loop SLO fails external mode without non-loopback surface evidence", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_voice_loop",
    ok: true,
    conversationEngine: {
      speechStartMs: 120,
      canonicalEventCounts: { speech_started: 1, assistant_text_completed: 1 },
    },
    audio: {
      transport: "websocket_pcm",
      turnDetectionOwner: "conversation_engine",
      localVadEnabled: false,
      localVadRole: "disabled",
      forwardedChunksDelta: 6,
      hostReceiveLagMs: 12,
      voiceAckRttMs: 18,
      voiceStreamId: "voice_stream_loopback",
      voiceStreamGeneration: 1,
      voiceStreamOpenCount: 1,
      staleChunksRejected: 0,
    },
    lanEvidence: {
      externalSurfaceMode: true,
      nonLoopbackSurfaceHost: false,
      voicePublisherMode: "preexisting_lan_operator_surface",
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_loopback_voice",
        durationMs: null,
        ok: true,
      },
      {
        at: at(120),
        event: "speech_started",
        turnId: "turn_loopback_voice",
        durationMs: 120,
        ok: true,
      },
      {
        at: at(180),
        event: "transcript_delta",
        turnId: "turn_loopback_voice",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(310),
        event: "assistant_text_delta",
        turnId: "turn_loopback_voice",
        durationMs: 310,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_loopback_voice",
        milestones: { heard: true, speechStarted: true, transcript: true, output: true },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "lan_voice_external_lan_surface_observed"),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring passes live OpenAI Realtime provider evidence", () => {
  const report = attachLanAcceptanceSlo(openaiLiveAcceptanceReport());

  assert.equal(report.ok, true);
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "openai_realtime_live_transport_selected")
      .actual,
    1,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "openai_realtime_session_created_observed")
      .actual,
    1,
  );
  assert.equal(
    report.slo.entries.find(
      (entry) => entry.id === "openai_realtime_provider_text_response_observed",
    ).actual,
    1,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "openai_realtime_canonical_events_observed")
      .actual,
    3,
  );
});

test("LAN OpenAI Realtime SLO fails optional missing-key skipped evidence", () => {
  const report = attachLanAcceptanceSlo(
    openaiLiveAcceptanceReport({
      ok: false,
      functionalOk: false,
      skipped: true,
      acceptanceSatisfied: false,
      blocker: "openai_realtime_api_key_missing",
      conversationEngine: {
        status: "skipped",
        providerAdapterKind: "",
        providerEventCounts: {},
        providerEventTotal: 0,
        providerTextEventCount: 0,
        rawProviderEventsAvailable: false,
        canonicalEventCounts: {},
        latestCanonicalEvent: "",
      },
    }),
  );

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "openai_realtime_live_transport_selected"),
    JSON.stringify(report.slo),
  );
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "openai_realtime_session_created_observed",
    ),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring passes live OpenAI Realtime voice evidence", () => {
  const report = attachLanAcceptanceSlo(openaiVoiceLiveAcceptanceReport());

  assert.equal(report.ok, true);
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "openai_realtime_voice_chunks_forwarded")
      .actual,
    24,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "openai_realtime_provider_audio_input_observed")
      .actual,
    3,
  );
  assert.equal(
    report.slo.entries.find(
      (entry) => entry.id === "openai_realtime_provider_text_response_observed",
    ).actual,
    1,
  );
  assert.equal(
    report.slo.entries.find(
      (entry) => entry.id === "openai_realtime_voice_canonical_events_observed",
    ).actual,
    5,
  );
});

test("LAN acceptance SLO scoring passes live OpenAI Realtime KWWK tool evidence", () => {
  const report = attachLanAcceptanceSlo(openaiToolLiveAcceptanceReport());

  assert.equal(report.ok, true);
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "openai_realtime_provider_tool_call_observed")
      .actual,
    2,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "openai_realtime_kwwk_tool_selected").actual,
    1,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "openai_realtime_tool_arguments_safe").actual,
    1,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "openai_realtime_tool_result_delivered").actual,
    1,
  );
  assert.equal(
    report.slo.entries.find(
      (entry) => entry.id === "openai_realtime_tool_canonical_events_observed",
    ).actual,
    7,
  );
});

test("LAN OpenAI Realtime tool SLO fails when provider tool-call evidence is missing", () => {
  const report = attachLanAcceptanceSlo(
    openaiToolLiveAcceptanceReport({
      conversationEngine: {
        providerEventCounts: {
          "session.created": 1,
          "response.output_text.done": 1,
        },
        providerEventTotal: 2,
        providerToolCallEventCount: 0,
        canonicalEventCounts: {
          engine_connected: 1,
          transcript_completed: 1,
          assistant_text_completed: 1,
        },
        latestCanonicalEvent: "assistant_text_completed",
      },
      tool: {
        actualTool: "",
        argumentSafety: {
          naturalLanguageInstruction: false,
          safeTargetHint: false,
          exposesRawOperations: false,
          exposesCoordinates: false,
          ok: false,
        },
        functionOutputDelivered: false,
      },
    }),
  );

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "openai_realtime_provider_tool_call_observed",
    ),
    JSON.stringify(report.slo),
  );
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "openai_realtime_tool_arguments_safe"),
    JSON.stringify(report.slo),
  );
});

test("LAN OpenAI Realtime voice SLO fails when audio-input provider evidence is missing", () => {
  const report = attachLanAcceptanceSlo(
    openaiVoiceLiveAcceptanceReport({
      conversationEngine: {
        providerEventCounts: {
          "session.created": 1,
          "response.output_text.done": 1,
        },
        providerEventTotal: 2,
        providerAudioInputEventCount: 0,
        canonicalEventCounts: {
          engine_connected: 1,
          assistant_text_completed: 1,
        },
        latestCanonicalEvent: "assistant_text_completed",
      },
    }),
  );

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "openai_realtime_provider_audio_input_observed",
    ),
    JSON.stringify(report.slo),
  );
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "openai_realtime_voice_canonical_events_observed",
    ),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring passes operator-side visual composition evidence", () => {
  const report = attachLanAcceptanceSlo(visualAcceptanceReport());

  assert.equal(report.ok, true);
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "host_visual_required_sources_live").actual,
    2,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "operator_composed_track_live").actual,
    1,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "operator_visual_layout_update_observed")
      .actual,
    1,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "operator_visual_composition_evidence_observed")
      .actual,
    8,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "host_visual_avatar_renderer_source_observed")
      .actual,
    1,
  );
  const externalLanEntry = report.slo.entries.find(
    (entry) => entry.id === "host_visual_external_lan_surface_observed",
  );
  assert.equal(externalLanEntry.required, false);
  assert.equal(externalLanEntry.actual, 0);
  const displayCaptureEntry = report.slo.entries.find(
    (entry) => entry.id === "host_visual_display_capture_source_observed",
  );
  assert.equal(displayCaptureEntry.required, false);
  assert.equal(displayCaptureEntry.actual, 0);
});

test("LAN host visual SLO can require external LAN surface evidence", () => {
  const report = attachLanAcceptanceSlo(
    visualAcceptanceReport({
      lanEvidence: {
        externalSurfaceMode: true,
        nonLoopbackSurfaceHost: true,
        peerEvidence: { operatorNonLoopbackPeerCount: 1, operatorPrivateLanPeerCount: 1 },
        publisherMode: "preexisting_host_publishers",
      },
    }),
  );

  const entry = report.slo.entries.find(
    (item) => item.id === "host_visual_external_lan_surface_observed",
  );
  assert.equal(entry.required, true);
  assert.equal(entry.actual, 1);
  assert.equal(
    report.slo.entries.find((item) => item.id === "host_visual_external_operator_peer_observed")
      .actual,
    1,
  );
  assert.equal(entry.ok, true);
  assert.equal(report.ok, true);
});

test("LAN host visual SLO fails external mode without non-loopback surface evidence", () => {
  const report = attachLanAcceptanceSlo(
    visualAcceptanceReport({
      lanEvidence: {
        externalSurfaceMode: true,
        nonLoopbackSurfaceHost: false,
        publisherMode: "preexisting_host_publishers",
      },
    }),
  );

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "host_visual_external_lan_surface_observed",
    ),
    JSON.stringify(report.slo),
  );
});

test("LAN host visual SLO can require display-capture host source evidence", () => {
  const report = attachLanAcceptanceSlo(
    visualAcceptanceReport({
      visual: {
        hostSourceMode: "display_capture",
        hostDisplayCaptureRequired: true,
      },
    }),
  );

  const entry = report.slo.entries.find(
    (item) => item.id === "host_visual_display_capture_source_observed",
  );
  assert.equal(entry.required, true);
  assert.equal(entry.actual, 1);
  assert.equal(entry.ok, true);
  assert.equal(report.ok, true);
});

test("LAN host visual SLO fails display-capture required report backed by diagnostic canvas", () => {
  const report = attachLanAcceptanceSlo(
    visualAcceptanceReport({
      visual: {
        hostSourceMode: "diagnostic_canvas",
        hostDisplayCaptureRequired: true,
      },
    }),
  );

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "host_visual_display_capture_source_observed",
    ),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring fails missing host visual frame-rate evidence", () => {
  const report = scoreLanAcceptanceSlo(visualAcceptanceReport({ visual: { frameRate: null } }));

  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some((failure) => failure.id === "host_visual_frame_rate_fps"),
    JSON.stringify(report),
  );
});

test("LAN acceptance SLO scoring fails slow KWWK visible feedback", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_kwwk_action",
    ok: true,
    kwwk: { totalMs: 2400 },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_slow_kwwk",
        durationMs: null,
        ok: true,
      },
      { at: at(90), event: "speech_started", turnId: "turn_slow_kwwk", durationMs: 90, ok: true },
      {
        at: at(130),
        event: "transcript_completed",
        turnId: "turn_slow_kwwk",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(180),
        event: "tool_call_started",
        turnId: "turn_slow_kwwk",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(200),
        event: "tool_result_accepted",
        turnId: "turn_slow_kwwk",
        durationMs: 200,
        ok: true,
      },
      { at: at(900), event: "kwwk_observing", turnId: "turn_slow_kwwk", durationMs: 900, ok: true },
    ],
    turns: [
      {
        turnId: "turn_slow_kwwk",
        milestones: {
          heard: true,
          speechStarted: true,
          transcript: true,
          tool: true,
          kwwk: true,
        },
      },
    ],
  });

  assert.equal(report.functionalOk, true);
  assert.equal(report.slo.ok, false);
  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "kwwk_visible_feedback_after_tool_ms"),
    JSON.stringify(report.slo),
  );
});

test("LAN KWWK action SLO requires real microphone evidence in spoken mode", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.local_voice_acceptance.v1",
    gate: "local_kwwk_action",
    ok: true,
    kwwk: {
      cold: verifiedKwwkSample(1800),
      warm: verifiedKwwkSample(620),
      hardCancel: hardCancelEvidence(),
      phaseBlockers: kwwkPhaseBlockers(),
      inFlightProgress: inFlightProgress(),
      totalMs: 1800,
    },
    spokenInput: {
      realMicrophoneRequired: true,
      realMicrophoneEvidenceOk: false,
      inputEnergyThreshold: 0.02,
      maxInputEnergy: 0.001,
      inputEnergySamplesAboveThreshold: 0,
    },
    output: {
      compactFollowUpDelivered: true,
      compactFollowUpText: "Done. I verified the host app update.",
      compactFollowUpMaxChars: 240,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_spoken_kwwk",
        durationMs: null,
        ok: true,
      },
      { at: at(90), event: "speech_started", turnId: "turn_spoken_kwwk", durationMs: 90, ok: true },
      {
        at: at(130),
        event: "transcript_completed",
        turnId: "turn_spoken_kwwk",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(180),
        event: "tool_call_started",
        turnId: "turn_spoken_kwwk",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(200),
        event: "tool_result_accepted",
        turnId: "turn_spoken_kwwk",
        durationMs: 200,
        ok: true,
      },
      {
        at: at(240),
        event: "kwwk_observing",
        turnId: "turn_spoken_kwwk",
        durationMs: 240,
        ok: true,
      },
      {
        at: at(620),
        event: "kwwk_completed",
        turnId: "turn_spoken_kwwk",
        durationMs: 620,
        ok: true,
      },
      {
        at: at(760),
        event: "assistant_text_completed",
        turnId: "turn_spoken_kwwk",
        durationMs: 760,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_spoken_kwwk",
        milestones: {
          heard: true,
          speechStarted: true,
          transcript: true,
          tool: true,
          kwwk: true,
          output: true,
        },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some(
      (failure) => failure.id === "spoken_app_control_real_microphone_observed",
    ),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring requires cold and warm KWWK action timings", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_kwwk_action",
    ok: true,
    kwwk: {
      cold: verifiedKwwkSample(1800),
      warm: verifiedKwwkSample(620),
      hardCancel: hardCancelEvidence(),
      phaseBlockers: kwwkPhaseBlockers(),
      inFlightProgress: inFlightProgress(),
      totalMs: 1800,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_kwwk_split",
        durationMs: null,
        ok: true,
      },
      { at: at(90), event: "speech_started", turnId: "turn_kwwk_split", durationMs: 90, ok: true },
      {
        at: at(130),
        event: "transcript_completed",
        turnId: "turn_kwwk_split",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(180),
        event: "tool_call_started",
        turnId: "turn_kwwk_split",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(200),
        event: "tool_result_accepted",
        turnId: "turn_kwwk_split",
        durationMs: 200,
        ok: true,
      },
      {
        at: at(240),
        event: "kwwk_observing",
        turnId: "turn_kwwk_split",
        durationMs: 240,
        ok: true,
      },
      {
        at: at(620),
        event: "kwwk_completed",
        turnId: "turn_kwwk_split",
        durationMs: 620,
        ok: true,
      },
      {
        at: at(760),
        event: "assistant_text_completed",
        turnId: "turn_kwwk_split",
        durationMs: 760,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_kwwk_split",
        milestones: {
          heard: true,
          speechStarted: true,
          transcript: true,
          tool: true,
          kwwk: true,
          output: true,
        },
      },
    ],
    output: {
      compactFollowUpDelivered: true,
      compactFollowUpText: "Done. I verified the host app update.",
      compactFollowUpMaxChars: 240,
    },
  });
  const cold = report.slo.entries.find(
    (entry) => entry.id === "cold_simple_app_action_verified_ms",
  );
  const warm = report.slo.entries.find(
    (entry) => entry.id === "warm_simple_app_action_verified_ms",
  );
  const phases = report.slo.entries.find((entry) => entry.id === "kwwk_phase_evidence_observed"),
    realState = report.slo.entries.find((entry) => entry.id === "real_kwwk_job_state_observed");
  const verification = report.slo.entries.find(
    (entry) => entry.id === "kwwk_verification_evidence_observed",
  );
  const mutation = report.slo.entries.find((entry) => entry.id === "kwwk_app_mutation_verified");
  const hardCancel = report.slo.entries.find((entry) => entry.id === "kwwk_hard_cancel_observed");
  const blockers = report.slo.entries.find(
    (entry) => entry.id === "kwwk_phase_blocker_matrix_observed",
  );
  const finalResponse = report.slo.entries.find(
    (entry) => entry.id === "operator_final_response_after_verified_action_ms",
  );
  const compactFollowUp = report.slo.entries.find(
    (entry) => entry.id === "kwwk_compact_followup_observed",
  );

  assert.equal(report.ok, true);
  assert.equal(cold.actual, 1800);
  assert.equal(warm.actual, 620);
  assert.equal(phases.actual, 6);
  assert.equal(realState.actual, 2);
  assert.equal(verification.actual, 2);
  assert.equal(mutation.actual, 2);
  assert.equal(mutation.threshold, 1);
  assert.equal(hardCancel.actual, 1);
  assert.equal(blockers.actual, 4);
  assert.equal(finalResponse.actual, 140);
  assert.equal(compactFollowUp.actual, 1);
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "kwwk_in_flight_phase_progress_observed")
      .actual,
    3,
  );
});

test("LAN acceptance SLO scoring fails when KWWK in-flight progress is missing", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_kwwk_action",
    ok: true,
    kwwk: {
      cold: verifiedKwwkSample(1800),
      warm: verifiedKwwkSample(620),
      hardCancel: hardCancelEvidence(),
      totalMs: 1800,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_missing_stream",
        durationMs: null,
        ok: true,
      },
      {
        at: at(90),
        event: "speech_started",
        turnId: "turn_missing_stream",
        durationMs: 90,
        ok: true,
      },
      {
        at: at(130),
        event: "transcript_completed",
        turnId: "turn_missing_stream",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(180),
        event: "tool_call_started",
        turnId: "turn_missing_stream",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(200),
        event: "tool_result_accepted",
        turnId: "turn_missing_stream",
        durationMs: 200,
        ok: true,
      },
      {
        at: at(240),
        event: "kwwk_observing",
        turnId: "turn_missing_stream",
        durationMs: 240,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_missing_stream",
        milestones: { heard: true, speechStarted: true, transcript: true, tool: true, kwwk: true },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "kwwk_in_flight_phase_progress_observed"),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring fails when KWWK cursor/action feedback is missing", () => {
  const noFeedback = {
    ...kwwkPhaseEvidence(),
    execute: { status: "executed", summary: "unknown", detail: {} },
  };
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_kwwk_action",
    ok: true,
    kwwk: {
      cold: { ...verifiedKwwkSample(1800), phaseEvidence: noFeedback },
      warm: { ...verifiedKwwkSample(620), phaseEvidence: noFeedback },
      hardCancel: hardCancelEvidence(),
      inFlightProgress: inFlightProgress(),
      totalMs: 1800,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_missing_feedback",
        durationMs: null,
        ok: true,
      },
      {
        at: at(90),
        event: "speech_started",
        turnId: "turn_missing_feedback",
        durationMs: 90,
        ok: true,
      },
      {
        at: at(130),
        event: "transcript_completed",
        turnId: "turn_missing_feedback",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(180),
        event: "tool_call_started",
        turnId: "turn_missing_feedback",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(200),
        event: "tool_result_accepted",
        turnId: "turn_missing_feedback",
        durationMs: 200,
        ok: true,
      },
      {
        at: at(240),
        event: "kwwk_observing",
        turnId: "turn_missing_feedback",
        durationMs: 240,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_missing_feedback",
        milestones: { heard: true, speechStarted: true, transcript: true, tool: true, kwwk: true },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "kwwk_cursor_action_feedback_observed"),
    JSON.stringify(report.slo),
  );
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "real_kwwk_job_state_observed"),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring fails when KWWK hard-cancel evidence is missing", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_kwwk_action",
    ok: true,
    kwwk: {
      cold: verifiedKwwkSample(1800),
      warm: verifiedKwwkSample(620),
      inFlightProgress: inFlightProgress(),
      totalMs: 1800,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_missing_hard_cancel",
        durationMs: null,
        ok: true,
      },
      {
        at: at(90),
        event: "speech_started",
        turnId: "turn_missing_hard_cancel",
        durationMs: 90,
        ok: true,
      },
      {
        at: at(130),
        event: "transcript_completed",
        turnId: "turn_missing_hard_cancel",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(180),
        event: "tool_call_started",
        turnId: "turn_missing_hard_cancel",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(200),
        event: "tool_result_accepted",
        turnId: "turn_missing_hard_cancel",
        durationMs: 200,
        ok: true,
      },
      {
        at: at(240),
        event: "kwwk_observing",
        turnId: "turn_missing_hard_cancel",
        durationMs: 240,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_missing_hard_cancel",
        milestones: { heard: true, speechStarted: true, transcript: true, tool: true, kwwk: true },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "kwwk_hard_cancel_observed"),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring fails when warm KWWK action timing is missing", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_kwwk_action",
    ok: true,
    kwwk: {
      cold: verifiedKwwkSample(1800),
      hardCancel: hardCancelEvidence(),
      inFlightProgress: inFlightProgress(),
      totalMs: 1800,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_missing_warm",
        durationMs: null,
        ok: true,
      },
      {
        at: at(90),
        event: "speech_started",
        turnId: "turn_missing_warm",
        durationMs: 90,
        ok: true,
      },
      {
        at: at(130),
        event: "transcript_completed",
        turnId: "turn_missing_warm",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(180),
        event: "tool_call_started",
        turnId: "turn_missing_warm",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(200),
        event: "tool_result_accepted",
        turnId: "turn_missing_warm",
        durationMs: 200,
        ok: true,
      },
      {
        at: at(240),
        event: "kwwk_observing",
        turnId: "turn_missing_warm",
        durationMs: 240,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_missing_warm",
        milestones: { heard: true, speechStarted: true, transcript: true, tool: true, kwwk: true },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "warm_simple_app_action_verified_ms"),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring fails when KWWK verification evidence is missing", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_kwwk_action",
    ok: true,
    kwwk: {
      cold: { totalMs: 1800, phaseEvidence: kwwkPhaseEvidence() },
      warm: { totalMs: 620, phaseEvidence: kwwkPhaseEvidence() },
      hardCancel: hardCancelEvidence(),
      inFlightProgress: inFlightProgress(),
      totalMs: 1800,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_missing_verify",
        durationMs: null,
        ok: true,
      },
      {
        at: at(90),
        event: "speech_started",
        turnId: "turn_missing_verify",
        durationMs: 90,
        ok: true,
      },
      {
        at: at(130),
        event: "transcript_completed",
        turnId: "turn_missing_verify",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(180),
        event: "tool_call_started",
        turnId: "turn_missing_verify",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(200),
        event: "tool_result_accepted",
        turnId: "turn_missing_verify",
        durationMs: 200,
        ok: true,
      },
      {
        at: at(240),
        event: "kwwk_observing",
        turnId: "turn_missing_verify",
        durationMs: 240,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_missing_verify",
        milestones: { heard: true, speechStarted: true, transcript: true, tool: true, kwwk: true },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "kwwk_verification_evidence_observed"),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring fails when KWWK app mutation evidence is missing", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_kwwk_action",
    ok: true,
    kwwk: {
      cold: { ...verifiedKwwkSample(1800), mutation: { verified: false } },
      warm: { ...verifiedKwwkSample(620), mutation: { verified: false } },
      hardCancel: hardCancelEvidence(),
      inFlightProgress: inFlightProgress(),
      totalMs: 1800,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_missing_mutation",
        durationMs: null,
        ok: true,
      },
      {
        at: at(90),
        event: "speech_started",
        turnId: "turn_missing_mutation",
        durationMs: 90,
        ok: true,
      },
      {
        at: at(130),
        event: "transcript_completed",
        turnId: "turn_missing_mutation",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(180),
        event: "tool_call_started",
        turnId: "turn_missing_mutation",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(200),
        event: "tool_result_accepted",
        turnId: "turn_missing_mutation",
        durationMs: 200,
        ok: true,
      },
      {
        at: at(240),
        event: "kwwk_observing",
        turnId: "turn_missing_mutation",
        durationMs: 240,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_missing_mutation",
        milestones: { heard: true, speechStarted: true, transcript: true, tool: true, kwwk: true },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "kwwk_app_mutation_verified"),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring fails when KWWK phase evidence is missing", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_kwwk_action",
    ok: true,
    kwwk: {
      cold: { totalMs: 1800, verification: { ok: true, status: "passed" } },
      warm: { totalMs: 620, verification: { ok: true, status: "passed" } },
      hardCancel: hardCancelEvidence(),
      inFlightProgress: inFlightProgress(),
      totalMs: 1800,
    },
    timeline: [
      {
        at: at(0),
        event: "operator_voice_chunk_received",
        turnId: "turn_missing_phase",
        durationMs: null,
        ok: true,
      },
      {
        at: at(90),
        event: "speech_started",
        turnId: "turn_missing_phase",
        durationMs: 90,
        ok: true,
      },
      {
        at: at(130),
        event: "transcript_completed",
        turnId: "turn_missing_phase",
        durationMs: 130,
        ok: true,
      },
      {
        at: at(180),
        event: "tool_call_started",
        turnId: "turn_missing_phase",
        durationMs: 180,
        ok: true,
      },
      {
        at: at(200),
        event: "tool_result_accepted",
        turnId: "turn_missing_phase",
        durationMs: 200,
        ok: true,
      },
      {
        at: at(240),
        event: "kwwk_observing",
        turnId: "turn_missing_phase",
        durationMs: 240,
        ok: true,
      },
    ],
    turns: [
      {
        turnId: "turn_missing_phase",
        milestones: { heard: true, speechStarted: true, transcript: true, tool: true, kwwk: true },
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "kwwk_phase_evidence_observed"),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring fails missing per-turn correlation evidence", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_tool_routing",
    ok: true,
    timeline: [
      { at: at(0), event: "speech_started", durationMs: 0, ok: true },
      { at: at(120), event: "tool_call_started", durationMs: 120, ok: true },
    ],
    turns: [],
  });

  assert.equal(report.functionalOk, true);
  assert.equal(report.slo.ok, false);
  assert.equal(report.ok, false);
  assert.ok(
    report.slo.failures.some((failure) => failure.id === "turn_tool_milestones_observed"),
    JSON.stringify(report.slo),
  );
});

test("LAN acceptance SLO scoring requires debug failure matrix evidence", () => {
  const report = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_debug_panel",
    ok: true,
    debugPanel: {
      embedded: true,
      openedFromSurface: true,
      sectionChecks: {
        timeline: true,
        turnTimeline: true,
        tool: true,
        kwwk: true,
        failureMatrix: true,
      },
      turnTimelineRowCount: 12,
      filterEvidence: {
        query: "verification",
        visibleSectionCount: 2,
        matchedRowCount: 3,
        hiddenRowCount: 8,
        kwwkVisible: true,
        conversationVisible: true,
        visibleText: "verification_target_missing",
      },
      artifactBundle: {
        latest: {
          entries: [
            "debug_report",
            "timeline_rows",
            "turns",
            "summaries",
            "failure_matrix",
            "slo",
            "large_artifacts",
          ].map((id) => ({ id })),
        },
      },
    },
    artifacts: {
      reportCopyCount: 1,
      reportDownloadCount: 0,
      largeArtifacts: [{ href: "artifact://trace.json", policy: "linked_only" }],
    },
    failureMatrix: { expectedCount: 7, observedCount: 7, timelineRowCount: 7 },
    conversationEngine: {
      diagnosticCanonicalParity: { observedCount: 8, providerRawEventLeakCount: 0 },
    },
    turns: [
      {
        turnId: "turn_debug_good",
        milestones: {
          heard: true,
          speechStarted: true,
          transcript: true,
          tool: true,
          kwwk: true,
          verification: true,
          output: true,
        },
      },
    ],
    primaryBlocker: {
      layer: "output_audio",
      event: "assistant_audio_failed",
      blocker: "output_device_failed",
    },
    meetHudTelemetry: {
      schema: "oneesama.lan_operator_hud_telemetry.v1",
      source: "lan_operator_debug_state",
      signals: [
        { key: "tool", label: "工具", value: "verification_target_missing", level: "blocked" },
        { key: "err", label: "错误", value: "1", level: "blocked" },
      ],
    },
  });
  const missing = attachLanAcceptanceSlo({
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "lan_debug_panel",
    ok: true,
    debugPanel: { sectionChecks: { timeline: true, tool: false } },
    artifacts: {
      reportCopyCount: 0,
      reportDownloadCount: 0,
      largeArtifacts: [{ href: "artifact://bad", contentBase64: "AAAA" }],
    },
    failureMatrix: { expectedCount: 7, observedCount: 6, timelineRowCount: 6 },
  });
  assert.equal(report.ok, true);
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "debug_failure_layers_observed").actual,
    7,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "debug_panel_embedded_in_surface").actual,
    1,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "debug_good_turn_milestones_observed").actual,
    7,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "debug_per_turn_timeline_rows_observed").actual,
    12,
  );
  assert.equal(
    report.slo.entries.find((entry) => entry.id === "debug_primary_blocker_observed").actual,
    1,
  );
  assert.equal(missing.ok, false);
  for (const id of [
    "debug_panel_sections_visible",
    "debug_panel_embedded_in_surface",
    "debug_panel_opened_from_surface",
    "debug_panel_filter_observed",
    "debug_failure_layers_observed",
    "diagnostic_canonical_event_parity_observed",
    "debug_good_turn_milestones_observed",
    "debug_per_turn_timeline_rows_observed",
    "debug_primary_blocker_observed",
    "debug_report_copy_or_download_observed",
    "debug_large_artifact_inline_violations",
    "debug_artifact_bundle_manifest_observed",
  ]) {
    assert.ok(
      missing.slo.failures.some((failure) => failure.id === id),
      JSON.stringify(missing.slo),
    );
  }
});
test("LAN SLO suite aggregates p50 and p95 across samples", () => {
  const fastVisual = attachLanAcceptanceSlo(
    visualAcceptanceReport({
      timings: { connectedMs: 700 },
      visual: { frameAgeMs: 20, frameRate: 30 },
    }),
  );
  const slowVisual = attachLanAcceptanceSlo(
    visualAcceptanceReport({
      timings: { connectedMs: 2400 },
      visual: { frameAgeMs: 20, frameRate: 8 },
    }),
  );

  const suite = aggregateLanAcceptanceSloReports([fastVisual, slowVisual]);
  const visualGate = suite.gates.local_host_visual;
  const connected = visualGate.entries.find((entry) => entry.id === "webrtc_connected_ms");
  const fps = visualGate.entries.find((entry) => entry.id === "host_visual_frame_rate_fps");

  assert.equal(suite.ok, false);
  assert.equal(connected.statistic, "p95");
  assert.equal(connected.p95, 2400);
  assert.equal(connected.ok, false);
  assert.equal(fps.statistic, "p50");
  assert.equal(fps.p50, 8);
  assert.equal(fps.ok, false);
  assert.equal(suite.perceivedUx.firstFeedbackP95Ms, 2400);
});
