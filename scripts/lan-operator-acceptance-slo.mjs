/* eslint-disable max-lines */
import { openaiRealtimeGateEntries } from "./lan-operator-openai-slo.mjs";
import { diagnosticCanonicalParityCount } from "./lan-operator-canonical-parity-slo.mjs";
import { canonicalToolBoundaryCount } from "./lan-operator-tool-boundary-slo.mjs";
import { kwwkPhaseBlockerMatrixCount } from "./lan-operator-kwwk-slo.mjs";
import {
  lanOperatorReachabilityCount,
  lanOperatorReachabilityRequired,
} from "./lan-operator-reachability-slo.mjs";
import {
  assistantAudioPlaybackCount,
  assistantAudioPlaybackRequired,
} from "./lan-operator-output-audio-slo.mjs";
import { LOCAL_OPERATOR_GATES, normalizeLocalOperatorGate } from "./local-operator-gates.mjs";

const SCHEMA_VERSION = 1;

const THRESHOLDS = Object.freeze({
  conversationSpeechStartMs: 800,
  assistantFirstTextMs: 1200,
  operatorVoiceHostReceiveLagMs: 250,
  operatorVoiceAckRttMs: 250,
  webrtcConnectedMs: 2000,
  hostVisualFrameAgeMs: 250,
  hostVisualFrameRateFps: 15,
  compositionFrameAgeMs: 250,
  toolCallEmittedMs: 1500,
  kwwkVisibleFeedbackAfterToolMs: 300,
  coldSimpleAppActionVerifiedMs: 5000,
  warmSimpleAppActionVerifiedMs: 2500,
  operatorFinalResponseAfterVerifiedActionMs: 800,
});
const PRIMARY_BLOCKER_LAYERS = new Set([
  "transport",
  "audio_input",
  "conversation_engine",
  "tool_routing",
  "kwwk_planner",
  "kwwk_execution",
  "verification",
  "output_audio",
]);

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timelineRows(report) {
  return Array.isArray(report?.timeline) ? report.timeline : [];
}

function reportTurnSummaries(report) {
  return Array.isArray(report?.turns)
    ? report.turns
    : Array.isArray(report?.debugReport?.debug?.timeline?.turns)
      ? report.debugReport.debug.timeline.turns
      : [];
}

function turnRows(report) {
  const rows = timelineRows(report);
  const grouped = new Map();
  for (const row of rows) {
    const turnId = String(row?.turnId || "__unscoped_turn");
    if (!grouped.has(turnId)) grouped.set(turnId, []);
    grouped.get(turnId).push(row);
  }
  return [...grouped.values()].filter((group) => group.length > 0);
}

function firstRow(report, event) {
  return timelineRows(report).find((row) => row.event === event) || null;
}

function firstDuration(report, events) {
  for (const event of events) {
    const duration = numberOrNull(firstRow(report, event)?.durationMs);
    if (duration != null) return duration;
  }
  for (const turn of reportTurnSummaries(report)) {
    const duration = firstTurnMilestoneDuration(turn, events);
    if (duration != null) return duration;
  }
  return null;
}

function eventMilestone(event) {
  if (event === "operator_voice_chunk_received") return "heard";
  if (event === "speech_started") return "speechStarted";
  if (event === "transcript_delta" || event === "transcript_completed") return "transcript";
  if (event === "assistant_text_delta" || event === "assistant_text_completed") return "output";
  if (String(event || "").startsWith("assistant_audio")) return "output";
  if (String(event || "").startsWith("tool_")) return "tool";
  if (String(event || "").startsWith("kwwk_")) {
    return event === "kwwk_verifying" ? "verification" : "kwwk";
  }
  return null;
}

function firstTurnMilestoneAt(turn, events) {
  for (const event of events) {
    const milestone = eventMilestone(event);
    if (!milestone) continue;
    const at = Date.parse(String(turn?.milestoneAts?.[milestone] || ""));
    if (Number.isFinite(at)) return at;
  }
  return null;
}

function firstTurnMilestoneDuration(turn, events) {
  for (const event of events) {
    const milestone = eventMilestone(event);
    if (!milestone) continue;
    const duration = numberOrNull(turn?.milestoneDurationsMs?.[milestone]);
    if (duration != null) return duration;
    const at = Date.parse(String(turn?.milestoneAts?.[milestone] || ""));
    const startedAt = Date.parse(String(turn?.startedAt || ""));
    if (Number.isFinite(at) && Number.isFinite(startedAt)) return Math.max(0, at - startedAt);
  }
  return null;
}

function deltaWithinTurn(report, fromEvents, toEvents) {
  for (const rows of turnRows(report)) {
    const fromIndex = rows.findIndex((row) => fromEvents.includes(row.event));
    if (fromIndex < 0) continue;
    const fromTime = Date.parse(String(rows[fromIndex]?.at || ""));
    if (!Number.isFinite(fromTime)) continue;
    const toRow = rows.slice(fromIndex + 1).find((row) => toEvents.includes(row.event));
    const toTime = Date.parse(String(toRow?.at || ""));
    if (!Number.isFinite(toTime)) continue;
    return Math.max(0, toTime - fromTime);
  }
  for (const turn of reportTurnSummaries(report)) {
    const fromTime = firstTurnMilestoneAt(turn, fromEvents);
    const toTime = firstTurnMilestoneAt(turn, toEvents);
    if (fromTime != null && toTime != null) return Math.max(0, toTime - fromTime);
  }
  return null;
}

function minDeltaWithinTurn(report, fromEvents, toEvents) {
  const deltas = [];
  for (const rows of turnRows(report)) {
    for (let index = 0; index < rows.length; index += 1) {
      if (!fromEvents.includes(rows[index]?.event)) continue;
      const fromTime = Date.parse(String(rows[index]?.at || ""));
      if (!Number.isFinite(fromTime)) continue;
      const toRow = rows.slice(index + 1).find((row) => toEvents.includes(row.event));
      const toTime = Date.parse(String(toRow?.at || ""));
      if (!Number.isFinite(toTime)) continue;
      deltas.push(Math.max(0, toTime - fromTime));
    }
  }
  return deltas.length > 0 ? Math.min(...deltas) : null;
}

function requiredTurnMilestoneCount(report, milestones) {
  for (const turn of reportTurnSummaries(report)) {
    if (milestones.every((milestone) => turn?.milestones?.[milestone] === true)) {
      return milestones.length;
    }
  }
  return 0;
}

function verificationEvidenceCount(report) {
  const items = [report?.kwwk?.cold?.verification, report?.kwwk?.warm?.verification].filter(
    Boolean,
  );
  if (items.length > 0) {
    return items.filter((item) => item?.ok === true || item?.status === "passed").length;
  }
  const verification = report?.kwwk?.verification;
  if (verification?.ok === true || verification?.status === "passed") return 1;
  return timelineRows(report).some((row) => row.event === "kwwk_verifying") ? 1 : 0;
}

function hasPhaseEvidence(phaseEvidence, phase) {
  const evidence = phaseEvidence?.[phase];
  return Boolean(
    evidence?.status ||
    evidence?.summary ||
    evidence?.durationMs != null ||
    (evidence?.detail && Object.keys(evidence.detail).length > 0),
  );
}

function phaseEvidenceCount(report) {
  const phases = ["observe", "plan", "execute"];
  const samples = [report?.kwwk?.cold?.phaseEvidence, report?.kwwk?.warm?.phaseEvidence].filter(
    Boolean,
  );
  if (samples.length > 0) {
    return samples.reduce(
      (total, phaseEvidence) =>
        total + phases.filter((phase) => hasPhaseEvidence(phaseEvidence, phase)).length,
      0,
    );
  }
  const phaseEvidence = report?.kwwk?.phaseEvidence;
  if (phaseEvidence) return phases.filter((phase) => hasPhaseEvidence(phaseEvidence, phase)).length;
  return timelineRows(report).filter((row) =>
    ["kwwk_observing", "kwwk_planning", "kwwk_executing"].includes(row.event),
  ).length;
}

function realKwwkJobStateCount(report) {
  const samples = [report?.kwwk?.cold, report?.kwwk?.warm].filter(Boolean);
  const candidates = samples.length ? samples : [report?.kwwk].filter(Boolean);
  return candidates.filter((sample) => {
    const phase = sample?.phaseEvidence || {},
      observe = phase.observe?.detail || {},
      plan = phase.plan?.detail || {},
      execute = phase.execute?.detail || {},
      verification = sample?.verification || {};
    return (
      observe.stateSource === "oneesama_app_control_helper" &&
      plan.modelUsed === true &&
      execute.executionSurface === "kwwk_computer_use_core" &&
      verification.schema === "oneesama.kwwk-cu-verification.v1" &&
      mutationVerifiedCount({ kwwk: sample }) >= 1
    );
  }).length;
}

function mutationVerifiedCount(report) {
  const samples = [report?.kwwk?.cold?.mutation, report?.kwwk?.warm?.mutation].filter(Boolean);
  if (samples.length > 0) return samples.filter((mutation) => mutation?.verified === true).length;
  const mutation = report?.kwwk?.mutation;
  if (mutation?.verified === true) return 1;
  return 0;
}

function kwwkInFlightPhaseCount(report) {
  const progress = report?.kwwk?.inFlightProgress;
  if (Array.isArray(progress?.phasesBeforeResponse)) {
    return progress.phasesBeforeResponse.filter((phase) =>
      ["observe", "plan", "execute"].includes(String(phase)),
    ).length;
  }
  const events = [
    ...(Array.isArray(progress?.cold) ? progress.cold : []),
    ...(Array.isArray(progress?.warm) ? progress.warm : []),
  ];
  return new Set(
    events
      .filter((event) => event?.emittedBeforeResponse === true)
      .map((event) => String(event.phase || ""))
      .filter((phase) => ["observe", "plan", "execute"].includes(phase)),
  ).size;
}

function kwwkHardCancelCount(report) {
  const hardCancel = report?.kwwk?.hardCancel;
  return hardCancel?.ok === true &&
    hardCancel?.processTerminated === true &&
    hardCancel?.responseBeforeCancel === false
    ? 1
    : 0;
}

function kwwkCursorActionFeedbackCount(report) {
  const kwwk = report?.kwwk || {};
  const executeDetail =
    kwwk?.phaseEvidence?.execute?.detail ||
    kwwk?.warm?.phaseEvidence?.execute?.detail ||
    kwwk?.cold?.phaseEvidence?.execute?.detail ||
    {};
  const actionKinds = [
    ...(Array.isArray(kwwk.actions) ? kwwk.actions : []),
    ...(Array.isArray(executeDetail.actionKinds) ? executeDetail.actionKinds : []),
    kwwk.latestActionKind,
  ].filter(Boolean);
  const actionCount = Number(
    kwwk.actionCount || executeDetail.actionCount || actionKinds.length || 0,
  );
  const cursorEventCount = Number(kwwk.cursorEventCount || executeDetail.cursorEventCount || 0);
  // A pointer action (click/drag/scroll/move) MUST produce real rendered cursor
  // evidence — it can no longer pass on a cursorPolicy label alone or on
  // pointerAction===false. A genuine non-pointer/background action (e.g.
  // type_text) does not require cursor feedback.
  const pointerAction =
    executeDetail.pointerAction === true ||
    actionKinds.some((kind) => /click|drag|scroll|mouse|move|pointer|cursor/i.test(String(kind)));
  if (actionCount < 1 || actionKinds.length < 1) return 0;
  if (pointerAction) return cursorEventCount >= 1 ? 1 : 0;
  return executeDetail.pointerAction === false ? 1 : 0;
}

function kwwkCompactFollowUpCount(report) {
  const output = report?.output || {};
  const text = String(output.compactFollowUpText || output.assistantText?.completedText || "");
  return output.compactFollowUpDelivered === true &&
    text.length > 0 &&
    text.length <= Number(output.compactFollowUpMaxChars || 240)
    ? 1
    : 0;
}

function spokenKwwkRealMicrophoneEvidenceCount(report) {
  const spokenInput = report?.spokenInput || {};
  const threshold = Number(spokenInput.inputEnergyThreshold || 0);
  return spokenInput.realMicrophoneRequired === true &&
    spokenInput.realMicrophoneEvidenceOk === true &&
    Number(spokenInput.maxInputEnergy || 0) >= threshold &&
    Number(spokenInput.inputEnergySamplesAboveThreshold || 0) >= 1
    ? 1
    : 0;
}

function localVadDisabledVoiceLoopCount(report) {
  const audio = report?.audio || {};
  const counts = report?.conversationEngine?.canonicalEventCounts || {};
  return audio.transport === "websocket_pcm" &&
    audio.turnDetectionOwner === "conversation_engine" &&
    audio.localVadRole === "disabled" &&
    audio.localVadEnabled === false &&
    Number(audio.forwardedChunksDelta ?? audio.forwardedChunks ?? 0) >= 1 &&
    Number(counts.speech_started || 0) >= 1 &&
    Number(counts.assistant_text_completed || 0) >= 1
    ? 1
    : 0;
}

function voiceExternalLanSurfaceEvidenceCount(report) {
  const evidence = report?.lanEvidence || {};
  return evidence.externalSurfaceMode === true &&
    evidence.nonLoopbackSurfaceHost === true &&
    evidence.voicePublisherMode === "preexisting_lan_operator_surface"
    ? 1
    : 0;
}

function lanPeerEvidence(report) {
  return (
    report?.lanEvidence?.peerEvidence ||
    report?.debugReport?.summaries?.surfaceContext?.lanPeerEvidence ||
    report?.debugReport?.debug?.surfaceContext?.lanPeerEvidence ||
    report?.runtimeStatus?.debug?.surfaceContext?.lanPeerEvidence ||
    {}
  );
}

function externalOperatorPeerEvidenceCount(report) {
  const evidence = report?.lanEvidence || {};
  const peers = lanPeerEvidence(report);
  const nonLoopbackCount = Math.max(
    Number(evidence.operatorNonLoopbackPeerCount || 0),
    Number(peers.operatorNonLoopbackPeerCount || 0),
  );
  const privateLanCount = Math.max(
    Number(evidence.operatorPrivateLanPeerCount || 0),
    Number(peers.operatorPrivateLanPeerCount || 0),
  );
  return evidence.externalSurfaceMode === true &&
    evidence.nonLoopbackSurfaceHost === true &&
    nonLoopbackCount >= 1 &&
    privateLanCount >= 1
    ? 1
    : 0;
}

function voiceFreshStreamEvidenceCount(report) {
  const audio = report?.audio || {};
  return audio.voiceStreamId &&
    Number(audio.voiceStreamGeneration || 0) >= 1 &&
    Number(audio.voiceStreamOpenCount || 0) >= 1 &&
    Number(audio.staleChunksRejected || 0) === 0
    ? 1
    : 0;
}

function realMicrophoneEnergyEvidenceCount(report) {
  const audio = report?.audio || {};
  const threshold = Number(audio.inputEnergyThreshold || 0);
  return audio.realMicrophoneRequired === true &&
    audio.realMicrophoneEvidenceOk === true &&
    Number(audio.maxInputEnergy || 0) >= threshold &&
    Number(audio.inputEnergySamplesAboveThreshold || 0) >= 1
    ? 1
    : 0;
}

function debugSectionVisibleCount(report) {
  const checks = report?.debugPanel?.sectionChecks || {};
  return Object.values(checks).filter((value) => value === true).length;
}

function debugSectionExpectedCount(report) {
  const checks = report?.debugPanel?.sectionChecks || {};
  return Math.max(1, Object.keys(checks).length);
}

function debugPanelEmbeddedCount(report) {
  return report?.debugPanel?.embedded === true ||
    report?.debugPanel?.sectionChecks?.debugPanelEmbedded === true
    ? 1
    : 0;
}

function debugPanelOpenedCount(report) {
  return report?.debugPanel?.openedFromSurface === true ||
    report?.debugPanel?.sectionChecks?.debugPanelOpenedFromSurface === true
    ? 1
    : 0;
}

function debugPanelFilterEvidenceCount(report) {
  const evidence = report?.debugPanel?.filterEvidence || report?.filterEvidence || {};
  const query = String(evidence.query || "")
    .trim()
    .toLowerCase();
  const visibleText = String(evidence.visibleText || "").toLowerCase();
  return query &&
    Number(evidence.visibleSectionCount || 0) >= 1 &&
    Number(evidence.matchedRowCount || 0) >= 1 &&
    Number(evidence.hiddenRowCount || 0) >= 1 &&
    evidence.kwwkVisible === true &&
    visibleText.includes(query)
    ? 1
    : 0;
}

function debugFailureMatrix(report) {
  return report?.failureMatrix || report?.debugPanel?.failureMatrix || null;
}

function debugReportCopyOrDownloadCount(report) {
  const artifacts =
    report?.artifacts ||
    report?.debugPanel?.artifacts ||
    report?.debugReport?.debug?.artifacts ||
    {};
  return Number(artifacts.reportCopyCount || 0) + Number(artifacts.reportDownloadCount || 0);
}

function debugLargeArtifactLinks(report) {
  const artifacts =
    report?.artifacts ||
    report?.debugPanel?.artifacts ||
    report?.debugReport?.debug?.artifacts ||
    {};
  const links =
    artifacts.largeArtifacts ||
    report?.debugReport?.summaries?.artifactPolicy?.links ||
    report?.debugPanel?.artifactPolicy?.links ||
    [];
  return Array.isArray(links) ? links : [];
}

function debugLargeArtifactInlineViolationCount(report) {
  return debugLargeArtifactLinks(report).filter(
    (artifact) => artifact?.content || artifact?.contentBase64 || artifact?.inlinePayload,
  ).length;
}

function debugArtifactBundleManifest(report) {
  const artifacts =
    report?.artifacts ||
    report?.debugPanel?.artifacts ||
    report?.debugReport?.debug?.artifacts ||
    {};
  return (
    report?.debugPanel?.artifactBundle ||
    report?.artifactBundle ||
    report?.debugReport?.summaries?.artifactBundle ||
    artifacts.bundles?.at?.(-1) ||
    null
  );
}

function debugArtifactBundleManifestCount(report) {
  const manifest = debugArtifactBundleManifest(report);
  const latest = manifest?.latest || manifest;
  const entries = Array.isArray(latest?.entries) ? latest.entries : [];
  const ids = new Set(entries.map((item) => String(item?.id || "")));
  const required = [
    "debug_report",
    "timeline_rows",
    "turns",
    "summaries",
    "failure_matrix",
    "slo",
    "large_artifacts",
  ];
  return latest && required.every((id) => ids.has(id)) ? 1 : 0;
}

function validPrimaryBlocker(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    PRIMARY_BLOCKER_LAYERS.has(String(value.layer || "")) &&
    value.event &&
    value.blocker,
  );
}

function debugPrimaryBlockerCount(report) {
  const primary =
    report?.primaryBlocker ||
    report?.debugPanel?.primaryBlocker ||
    report?.debugReport?.summaries?.primaryBlocker ||
    null;
  if (Array.isArray(primary)) return primary.filter((item) => validPrimaryBlocker(item)).length;
  return validPrimaryBlocker(primary) ? 1 : 0;
}

function debugPerTurnTimelineRowCount(report) {
  return Number(
    report?.debugPanel?.turnTimelineRowCount || report?.debugPanel?.perTurnTimelineRowCount || 0,
  );
}

function finiteRect(rect) {
  return Boolean(
    rect &&
    Number.isFinite(Number(rect.x)) &&
    Number.isFinite(Number(rect.y)) &&
    Number.isFinite(Number(rect.width)) &&
    Number.isFinite(Number(rect.height)) &&
    Number(rect.width) > 0 &&
    Number(rect.height) > 0,
  );
}

function visualRequiredSourcesLiveCount(report) {
  const sources = Array.isArray(report?.visual?.sources) ? report.visual.sources : [];
  const byId = new Map(sources.map((source) => [String(source?.id || ""), source]));
  return ["host-app", "avatar"].filter((sourceId) => {
    const source = byId.get(sourceId);
    const frameAgeMs = numberOrNull(source?.frameAgeMs);
    return Boolean(
      source?.state === "live" &&
      source?.trackReadyState === "live" &&
      Number(source?.width) > 0 &&
      Number(source?.height) > 0 &&
      Number(source?.frameRate) >= THRESHOLDS.hostVisualFrameRateFps &&
      frameAgeMs != null &&
      frameAgeMs <= THRESHOLDS.hostVisualFrameAgeMs,
    );
  }).length;
}

function operatorComposedTrackLiveCount(report) {
  const composition = report?.visual?.composition || {};
  return composition.mode === "operator_side" &&
    composition.localComposedTrack === true &&
    composition.trackKind === "video" &&
    composition.trackReadyState === "live" &&
    Number(composition.width) > 0 &&
    Number(composition.height) > 0 &&
    Number(composition.targetFps) >= THRESHOLDS.hostVisualFrameRateFps
    ? 1
    : 0;
}

function operatorLayoutUpdateCount(report) {
  const composition = report?.visual?.composition || {};
  const avatarRect = composition?.sourceRects?.avatar;
  const layoutUpdate = report?.visual?.layoutUpdate || {};
  const composedTrack = layoutUpdate.composedTrack || {};
  const sourceTracks = layoutUpdate.sourceTracks || {};
  return Number(composition.layoutRevision) >= 1 &&
    composition.focusedSourceId === "avatar" &&
    finiteRect(avatarRect) &&
    layoutUpdate.schema === "oneesama.operator_visual_layout_update.v1" &&
    layoutUpdate.sourceId === "avatar" &&
    layoutUpdate.action === "move_resize" &&
    finiteRect(layoutUpdate.beforeRect) &&
    finiteRect(layoutUpdate.afterRect) &&
    layoutUpdate.moved === true &&
    layoutUpdate.resized === true &&
    composedTrack.liveBefore === true &&
    composedTrack.liveAfter === true &&
    composedTrack.trackKindBefore === "video" &&
    composedTrack.trackKindAfter === "video" &&
    composedTrack.trackIdStable === true &&
    sourceTracks.hostAppStable === true &&
    sourceTracks.avatarStable === true
    ? 1
    : 0;
}

function operatorCompositionEvidenceCount(report) {
  const composition = report?.visual?.composition || {};
  const sourceRects = composition.sourceRects || {};
  const lastRenderedFrameAgeMs = numberOrNull(composition.lastRenderedFrameAgeMs);
  const checks = [
    composition.mode === "operator_side",
    operatorComposedTrackLiveCount(report) === 1,
    lastRenderedFrameAgeMs != null && lastRenderedFrameAgeMs <= THRESHOLDS.compositionFrameAgeMs,
    operatorLayoutUpdateCount(report) === 1,
    finiteRect(sourceRects["host-app"]),
    finiteRect(sourceRects.avatar),
    Number(composition.overlayCount) >= 1 || report?.visual?.overlayVisible === true,
    report?.visual?.operatorScreenBackflow === false,
  ];
  return checks.filter(Boolean).length;
}

function avatarRendererSourceCount(report) {
  return report?.visual?.avatarSourceMode === "avatar_renderer" &&
    Boolean(report?.visual?.avatarRenderer)
    ? 1
    : 0;
}

function externalLanSurfaceEvidenceCount(report) {
  const evidence = report?.lanEvidence || {};
  return evidence.externalSurfaceMode === true &&
    evidence.nonLoopbackSurfaceHost === true &&
    evidence.publisherMode === "preexisting_host_publishers"
    ? 1
    : 0;
}

function hostDisplayCaptureSourceCount(report) {
  return report?.visual?.hostSourceMode === "display_capture" &&
    report?.visual?.hostCaptureStatus === "live"
    ? 1
    : 0;
}

function entry(input) {
  const actual = numberOrNull(input.actual);
  const measured = actual != null;
  const threshold = numberOrNull(input.threshold);
  const comparator = input.comparator || "lte";
  let ok = null;
  if (measured && threshold != null) {
    ok = comparator === "gte" ? actual >= threshold : actual <= threshold;
  }
  if (input.required && ok == null) ok = false;
  return {
    id: input.id,
    label: input.label,
    unit: input.unit || "ms",
    comparator,
    actual,
    threshold,
    ok,
    required: Boolean(input.required),
    source: input.source || "",
  };
}

function reachabilityEntry(report) {
  return entry({
    id: "local_operator_surface_reachability_observed",
    label: "Local Operator Surface reachability advertised",
    unit: "count",
    comparator: "gte",
    actual: lanOperatorReachabilityCount(report),
    threshold: 1,
    required: lanOperatorReachabilityRequired(report),
    source: "host.reachability + debugReport.summaries.surfaceContext.lanReachability",
  });
}

function assistantAudioPlaybackEntry(report) {
  return entry({
    id: "assistant_audio_playback_observed",
    label: "Assistant audio playback observed",
    unit: "count",
    comparator: "gte",
    actual: assistantAudioPlaybackCount(report),
    threshold: 1,
    required: assistantAudioPlaybackRequired(report),
    source: "output.assistantAudio.chunksPlayed + output.assistantAudio.rms",
  });
}

function gateEntries(report) {
  const gate = normalizeLocalOperatorGate(report?.gate);
  if (gate === LOCAL_OPERATOR_GATES.voice) {
    return [
      entry({
        id: "turn_heard_to_speech_started_ms",
        label: "Turn correlation: heard to speech-start",
        actual: deltaWithinTurn(report, ["operator_voice_chunk_received"], ["speech_started"]),
        threshold: THRESHOLDS.conversationSpeechStartMs,
        required: true,
        source: "turn.operator_voice_chunk_received_to_speech_started",
      }),
      entry({
        id: "conversation_speech_start_ms",
        label: "Conversation Engine speech-start/user-turn observed",
        actual:
          report?.conversationEngine?.speechStartMs ?? firstDuration(report, ["speech_started"]),
        threshold: THRESHOLDS.conversationSpeechStartMs,
        required: true,
        source: "conversationEngine.speechStartMs",
      }),
      entry({
        id: "turn_heard_to_assistant_output_ms",
        label: "Turn correlation: heard to assistant output",
        actual: deltaWithinTurn(
          report,
          ["operator_voice_chunk_received"],
          ["assistant_text_delta", "assistant_text_completed", "assistant_audio_started"],
        ),
        threshold: THRESHOLDS.assistantFirstTextMs,
        required: true,
        source: "turn.operator_voice_chunk_received_to_assistant_*",
      }),
      assistantAudioPlaybackEntry(report),
      entry({
        id: "assistant_first_text_ms",
        label: "Assistant first text for no-tool chat",
        actual: firstDuration(report, ["assistant_text_delta", "assistant_text_completed"]),
        threshold: THRESHOLDS.assistantFirstTextMs,
        required: true,
        source: "timeline.assistant_text_*",
      }),
      entry({
        id: "turn_voice_milestones_observed",
        label: "Turn correlation includes heard/speech/transcript/output",
        unit: "count",
        comparator: "gte",
        actual: requiredTurnMilestoneCount(report, [
          "heard",
          "speechStarted",
          "transcript",
          "output",
        ]),
        threshold: 4,
        required: true,
        source: "debug.timeline.turns.milestones",
      }),
      entry({
        id: "operator_voice_local_vad_not_required",
        label: "Operator Voice forwards with Local VAD disabled",
        unit: "count",
        comparator: "gte",
        actual: localVadDisabledVoiceLoopCount(report),
        threshold: 1,
        required: true,
        source:
          "audio.localVadRole + audio.forwardedChunks + conversationEngine.canonicalEventCounts",
      }),
      entry({
        id: "operator_voice_host_receive_lag_ms",
        label: "Operator Voice host receive lag observed",
        actual: report?.audio?.hostReceiveLagMs,
        threshold: THRESHOLDS.operatorVoiceHostReceiveLagMs,
        required: true,
        source: "audio.hostReceiveLagMs",
      }),
      entry({
        id: "operator_voice_ack_rtt_ms",
        label: "Operator Voice chunk ack RTT observed",
        actual: report?.audio?.voiceAckRttMs,
        threshold: THRESHOLDS.operatorVoiceAckRttMs,
        required: true,
        source: "audio.voiceAckRttMs",
      }),
      entry({
        id: "operator_voice_fresh_stream_observed",
        label: "Operator Voice chunks belong to the active stream",
        unit: "count",
        comparator: "gte",
        actual: voiceFreshStreamEvidenceCount(report),
        threshold: 1,
        required: true,
        source: "audio.voiceStreamId + audio.staleChunksRejected",
      }),
      entry({
        id: "operator_voice_real_microphone_energy_observed",
        label: "Real microphone input energy observed",
        unit: "count",
        comparator: "gte",
        actual:
          report?.audio?.realMicrophoneRequired === true
            ? realMicrophoneEnergyEvidenceCount(report)
            : null,
        threshold: 1,
        required: report?.audio?.realMicrophoneRequired === true,
        source: "audio.realMicrophoneEvidenceOk + audio.maxInputEnergy",
      }),
      reachabilityEntry(report),
      entry({
        id: "lan_voice_external_lan_surface_observed",
        label: "External LAN Operator Voice surface evidence observed",
        unit: "count",
        comparator: "gte",
        actual: voiceExternalLanSurfaceEvidenceCount(report),
        threshold: 1,
        required: report?.lanEvidence?.externalSurfaceMode === true,
        source: "lanEvidence.externalSurfaceMode + lanEvidence.nonLoopbackSurfaceHost",
      }),
      entry({
        id: "lan_voice_external_operator_peer_observed",
        label: "External LAN Operator Voice peer evidence observed",
        unit: "count",
        comparator: "gte",
        actual: externalOperatorPeerEvidenceCount(report),
        threshold: 1,
        required: report?.lanEvidence?.externalSurfaceMode === true,
        source: "lanEvidence.peerEvidence.operatorNonLoopbackPeerCount",
      }),
    ];
  }
  if (gate === LOCAL_OPERATOR_GATES.hostVisual) {
    return [
      entry({
        id: "webrtc_connected_ms",
        label: "WebRTC Host Visual Stream connected",
        actual: report?.timings?.visualConnectedAfterReadyMs ?? report?.timings?.connectedMs,
        threshold: THRESHOLDS.webrtcConnectedMs,
        required: true,
        source:
          report?.timings?.visualConnectedAfterReadyMs == null
            ? "timings.connectedMs"
            : "timings.visualConnectedAfterReadyMs",
      }),
      entry({
        id: "host_visual_frame_age_ms",
        label: "WebRTC Host Visual Stream frame age",
        actual: report?.visual?.frameAgeMs,
        threshold: THRESHOLDS.hostVisualFrameAgeMs,
        required: true,
        source: "visual.frameAgeMs",
      }),
      entry({
        id: "host_visual_frame_rate_fps",
        label: "WebRTC Host Visual Stream sustained frame rate",
        unit: "fps",
        comparator: "gte",
        actual: report?.visual?.frameRate,
        threshold: THRESHOLDS.hostVisualFrameRateFps,
        required: true,
        source: "visual.frameRate",
      }),
      entry({
        id: "host_visual_required_sources_live",
        label: "Host Visual Stream host-app/avatar sources live",
        unit: "count",
        comparator: "gte",
        actual: visualRequiredSourcesLiveCount(report),
        threshold: 2,
        required: true,
        source: "visual.sources",
      }),
      entry({
        id: "operator_composed_track_live",
        label: "Operator Composed Video Track is live",
        unit: "count",
        comparator: "gte",
        actual: operatorComposedTrackLiveCount(report),
        threshold: 1,
        required: true,
        source: "visual.composition",
      }),
      entry({
        id: "operator_visual_layout_update_observed",
        label: "Operator-side move/resize layout update observed",
        unit: "count",
        comparator: "gte",
        actual: operatorLayoutUpdateCount(report),
        threshold: 1,
        required: true,
        source: "visual.composition.layoutRevision/sourceRects",
      }),
      entry({
        id: "operator_composition_frame_age_ms",
        label: "Operator Visual Composition rendered-frame age",
        actual: report?.visual?.composition?.lastRenderedFrameAgeMs,
        threshold: THRESHOLDS.compositionFrameAgeMs,
        required: true,
        source: "visual.composition.lastRenderedFrameAgeMs",
      }),
      entry({
        id: "operator_visual_composition_evidence_observed",
        label: "Operator Visual Composition evidence observed",
        unit: "count",
        comparator: "gte",
        actual: operatorCompositionEvidenceCount(report),
        threshold: 8,
        required: true,
        source: "visual.composition + visual.operatorScreenBackflow",
      }),
      entry({
        id: "host_visual_avatar_renderer_source_observed",
        label: "Host Visual Stream avatar source uses avatar renderer",
        unit: "count",
        comparator: "gte",
        actual: avatarRendererSourceCount(report),
        threshold: 1,
        required: true,
        source: "visual.avatarSourceMode + visual.avatarRenderer",
      }),
      reachabilityEntry(report),
      entry({
        id: "host_visual_external_lan_surface_observed",
        label: "External LAN Operator Surface evidence observed",
        unit: "count",
        comparator: "gte",
        actual: externalLanSurfaceEvidenceCount(report),
        threshold: 1,
        required: report?.lanEvidence?.externalSurfaceMode === true,
        source: "lanEvidence.externalSurfaceMode + lanEvidence.nonLoopbackSurfaceHost",
      }),
      entry({
        id: "host_visual_external_operator_peer_observed",
        label: "External LAN Operator Visual peer evidence observed",
        unit: "count",
        comparator: "gte",
        actual: externalOperatorPeerEvidenceCount(report),
        threshold: 1,
        required: report?.lanEvidence?.externalSurfaceMode === true,
        source: "lanEvidence.peerEvidence.operatorNonLoopbackPeerCount",
      }),
      entry({
        id: "host_visual_display_capture_source_observed",
        label: "Host Visual Stream host-app source uses display capture",
        unit: "count",
        comparator: "gte",
        actual: hostDisplayCaptureSourceCount(report),
        threshold: 1,
        required: report?.visual?.hostDisplayCaptureRequired === true,
        source: "visual.hostSourceMode",
      }),
    ];
  }
  if (gate === LOCAL_OPERATOR_GATES.toolRouting) {
    return [
      entry({
        id: "turn_heard_to_tool_call_ms",
        label: "Turn correlation: heard to tool call",
        actual: deltaWithinTurn(
          report,
          ["operator_voice_chunk_received", "speech_started"],
          ["tool_call_started"],
        ),
        threshold: THRESHOLDS.toolCallEmittedMs,
        required: true,
        source: "turn.heard_or_speech_to_tool_call_started",
      }),
      entry({
        id: "tool_call_emitted_ms",
        label: "Tool call emitted for simple app command",
        actual: firstDuration(report, ["tool_call_started"]),
        threshold: THRESHOLDS.toolCallEmittedMs,
        required: true,
        source: "timeline.tool_call_started",
      }),
      entry({
        id: "turn_tool_milestones_observed",
        label: "Turn correlation includes heard/speech/transcript/tool",
        unit: "count",
        comparator: "gte",
        actual: requiredTurnMilestoneCount(report, [
          "heard",
          "speechStarted",
          "transcript",
          "tool",
        ]),
        threshold: 4,
        required: true,
        source: "debug.timeline.turns.milestones",
      }),
      entry({
        id: "canonical_tool_boundary_observed",
        label: "Canonical tool boundary observed",
        unit: "count",
        comparator: "gte",
        actual: canonicalToolBoundaryCount(report),
        threshold: 1,
        required: true,
        source: "tool.canonicalBoundary + conversationEngine.canonicalEventCounts",
      }),
    ];
  }
  if (gate === LOCAL_OPERATOR_GATES.kwwkAction) {
    return [
      entry({
        id: "turn_heard_to_tool_call_ms",
        label: "Turn correlation: heard to tool call",
        actual: deltaWithinTurn(
          report,
          ["operator_voice_chunk_received", "speech_started"],
          ["tool_call_started"],
        ),
        threshold: THRESHOLDS.toolCallEmittedMs,
        required: true,
        source: "turn.heard_or_speech_to_tool_call_started",
      }),
      entry({
        id: "tool_call_emitted_ms",
        label: "Tool call emitted for simple app command",
        actual: firstDuration(report, ["tool_call_started"]),
        threshold: THRESHOLDS.toolCallEmittedMs,
        required: true,
        source: "timeline.tool_call_started",
      }),
      entry({
        id: "kwwk_visible_feedback_after_tool_ms",
        label: "KWWK visible feedback after tool accepted",
        actual: deltaWithinTurn(
          report,
          ["tool_result_accepted"],
          ["kwwk_queued", "kwwk_observing", "kwwk_planning", "kwwk_executing"],
        ),
        threshold: THRESHOLDS.kwwkVisibleFeedbackAfterToolMs,
        required: true,
        source: "turn.tool_result_accepted_to_kwwk_*",
      }),
      entry({
        id: "turn_kwwk_milestones_observed",
        label: "Turn correlation includes heard/speech/transcript/tool/KWWK",
        unit: "count",
        comparator: "gte",
        actual: requiredTurnMilestoneCount(report, [
          "heard",
          "speechStarted",
          "transcript",
          "tool",
          "kwwk",
        ]),
        threshold: 5,
        required: true,
        source: "debug.timeline.turns.milestones",
      }),
      entry({
        id: "canonical_tool_boundary_observed",
        label: "Canonical tool boundary observed",
        unit: "count",
        comparator: "gte",
        actual: canonicalToolBoundaryCount(report),
        threshold: 1,
        required: true,
        source: "tool.canonicalBoundary + timeline.tool_*",
      }),
      entry({
        id: "kwwk_phase_evidence_observed",
        label: "KWWK observe/plan/execute phase evidence observed",
        unit: "count",
        comparator: "gte",
        actual: phaseEvidenceCount(report),
        threshold: report?.kwwk?.cold || report?.kwwk?.warm ? 6 : 3,
        required: true,
        source: "kwwk.cold/warm.phaseEvidence",
      }),
      entry({
        id: "real_kwwk_job_state_observed",
        label: "Real KWWK/CU job state observed",
        unit: "count",
        comparator: "gte",
        actual: realKwwkJobStateCount(report),
        threshold: report?.kwwk?.cold || report?.kwwk?.warm ? 2 : 1,
        required: true,
        source: "kwwk.cold/warm.phaseEvidence + verification + mutation",
      }),
      entry({
        id: "kwwk_phase_blocker_matrix_observed",
        label: "KWWK phase blocker matrix observed",
        unit: "count",
        comparator: "gte",
        actual: kwwkPhaseBlockerMatrixCount(report),
        threshold: 4,
        required: true,
        source: "kwwk.phaseBlockers.entries",
      }),
      entry({
        id: "kwwk_in_flight_phase_progress_observed",
        label: "KWWK in-flight observe/plan/execute progress observed",
        unit: "count",
        comparator: "gte",
        actual: kwwkInFlightPhaseCount(report),
        threshold: 3,
        required: true,
        source: "kwwk.inFlightProgress.phasesBeforeResponse",
      }),
      entry({
        id: "kwwk_cursor_action_feedback_observed",
        label: "KWWK cursor/action feedback observed",
        unit: "count",
        comparator: "gte",
        actual: kwwkCursorActionFeedbackCount(report),
        threshold: 1,
        required: true,
        source: "kwwk.latestActionKind + kwwk.cursorEventCount + kwwk.phaseEvidence.execute.detail",
      }),
      entry({
        id: "kwwk_hard_cancel_observed",
        label: "KWWK running helper hard-cancel observed",
        unit: "count",
        comparator: "gte",
        actual: kwwkHardCancelCount(report),
        threshold: 1,
        required: true,
        source: "kwwk.hardCancel",
      }),
      entry({
        id: "kwwk_verification_evidence_observed",
        label: "KWWK final verification evidence observed",
        unit: "count",
        comparator: "gte",
        actual: verificationEvidenceCount(report),
        threshold: report?.kwwk?.cold || report?.kwwk?.warm ? 2 : 1,
        required: true,
        source: "kwwk.cold/warm.verification",
      }),
      entry({
        id: "kwwk_app_mutation_verified",
        label: "KWWK host app mutation verified",
        unit: "count",
        comparator: "gte",
        actual: mutationVerifiedCount(report),
        threshold: 1,
        required: true,
        source: "kwwk.cold/warm.mutation.verified",
      }),
      entry({
        id: "cold_simple_app_action_verified_ms",
        label: "Cold simple app action verified",
        actual: report?.kwwk?.cold?.totalMs ?? report?.kwwk?.totalMs,
        threshold: THRESHOLDS.coldSimpleAppActionVerifiedMs,
        required: true,
        source: "kwwk.cold.totalMs",
      }),
      entry({
        id: "warm_simple_app_action_verified_ms",
        label: "Warm simple app action verified",
        actual: report?.kwwk?.warm?.totalMs,
        threshold: THRESHOLDS.warmSimpleAppActionVerifiedMs,
        required: true,
        source: "kwwk.warm.totalMs",
      }),
      entry({
        id: "operator_final_response_after_verified_action_ms",
        label: "Operator sees final response after verified action",
        actual: minDeltaWithinTurn(report, ["kwwk_completed"], ["assistant_text_completed"]),
        threshold: THRESHOLDS.operatorFinalResponseAfterVerifiedActionMs,
        required: true,
        source: "turn.kwwk_completed_to_assistant_text_completed",
      }),
      entry({
        id: "kwwk_compact_followup_observed",
        label: "KWWK compact assistant follow-up observed",
        unit: "count",
        comparator: "gte",
        actual: kwwkCompactFollowUpCount(report),
        threshold: 1,
        required: true,
        source: "output.compactFollowUpDelivered + output.compactFollowUpText",
      }),
      entry({
        id: "spoken_app_control_real_microphone_observed",
        label: "Spoken app-control real microphone evidence observed",
        unit: "count",
        comparator: "gte",
        actual:
          report?.spokenInput?.realMicrophoneRequired === true
            ? spokenKwwkRealMicrophoneEvidenceCount(report)
            : null,
        threshold: 1,
        required: report?.spokenInput?.realMicrophoneRequired === true,
        source: "spokenInput.realMicrophoneEvidenceOk + spokenInput.maxInputEnergy",
      }),
    ];
  }
  if (gate === LOCAL_OPERATOR_GATES.debugPanel) {
    const failureMatrix = debugFailureMatrix(report);
    const expectedFailureLayers = Number(failureMatrix?.expectedCount || 7);
    return [
      entry({
        id: "debug_panel_sections_visible",
        label: "Debug Panel required sections visible",
        unit: "count",
        comparator: "gte",
        actual: debugSectionVisibleCount(report),
        threshold: debugSectionExpectedCount(report),
        required: true,
        source: "debugPanel.sectionChecks",
      }),
      entry({
        id: "debug_panel_embedded_in_surface",
        label: "Debug Panel is embedded in LAN Operator Surface",
        unit: "count",
        comparator: "gte",
        actual: debugPanelEmbeddedCount(report),
        threshold: 1,
        required: true,
        source: "debugPanel.embedded",
      }),
      entry({
        id: "debug_panel_opened_from_surface",
        label: "Debug Panel can be opened from LAN Operator Surface",
        unit: "count",
        comparator: "gte",
        actual: debugPanelOpenedCount(report),
        threshold: 1,
        required: true,
        source: "debugPanel.openedFromSurface",
      }),
      entry({
        id: "debug_panel_filter_observed",
        label: "Debug Panel search/filter observed",
        unit: "count",
        comparator: "gte",
        actual: debugPanelFilterEvidenceCount(report),
        threshold: 1,
        required: true,
        source: "debugPanel.filterEvidence",
      }),
      entry({
        id: "debug_failure_layers_observed",
        label: "Debuggable failure layers observed",
        unit: "count",
        comparator: "gte",
        actual: failureMatrix?.observedCount,
        threshold: expectedFailureLayers,
        required: true,
        source: "failureMatrix.observedCount",
      }),
      entry({
        id: "debug_failure_timeline_rows_observed",
        label: "Debuggable failure timeline rows observed",
        unit: "count",
        comparator: "gte",
        actual: failureMatrix?.timelineRowCount,
        threshold: expectedFailureLayers,
        required: true,
        source: "failureMatrix.timelineRowCount",
      }),
      entry({
        id: "diagnostic_canonical_event_parity_observed",
        label: "Diagnostic canonical event parity observed",
        unit: "count",
        comparator: "gte",
        actual: diagnosticCanonicalParityCount(report),
        threshold: 1,
        required: true,
        source: "conversationEngine.diagnosticCanonicalParity",
      }),
      entry({
        id: "debug_good_turn_milestones_observed",
        label: "Debug Panel good-turn milestones observed",
        unit: "count",
        comparator: "gte",
        actual: requiredTurnMilestoneCount(report, [
          "heard",
          "speechStarted",
          "transcript",
          "tool",
          "kwwk",
          "verification",
          "output",
        ]),
        threshold: 7,
        required: true,
        source: "debug.timeline.turns.milestones",
      }),
      entry({
        id: "debug_per_turn_timeline_rows_observed",
        label: "Debug Panel per-turn timeline rows observed",
        unit: "count",
        comparator: "gte",
        actual: debugPerTurnTimelineRowCount(report),
        threshold: 10,
        required: true,
        source: "debugPanel.turnTimelineRowCount",
      }),
      entry({
        id: "debug_primary_blocker_observed",
        label: "Debug Panel names a primary blocker",
        unit: "count",
        comparator: "gte",
        actual: debugPrimaryBlockerCount(report),
        threshold: 1,
        required: true,
        source: "debugReport.summaries.primaryBlocker",
      }),
      entry({
        id: "debug_primary_blocker_unique",
        label: "Debug Panel names exactly one primary blocker",
        unit: "count",
        comparator: "lte",
        actual: debugPrimaryBlockerCount(report),
        threshold: 1,
        required: true,
        source: "debugReport.summaries.primaryBlocker",
      }),
      entry({
        id: "debug_report_copy_or_download_observed",
        label: "Debug report copy/download observed",
        unit: "count",
        comparator: "gte",
        actual: debugReportCopyOrDownloadCount(report),
        threshold: 1,
        required: true,
        source: "artifacts.reportCopyCount + artifacts.reportDownloadCount",
      }),
      entry({
        id: "debug_large_artifact_links_observed",
        label: "Debug large-artifact links observed",
        unit: "count",
        comparator: "gte",
        actual: debugLargeArtifactLinks(report).length,
        threshold: 1,
        required: true,
        source: "artifacts.largeArtifacts",
      }),
      entry({
        id: "debug_large_artifact_inline_violations",
        label: "Debug large artifacts are linked-only",
        unit: "count",
        comparator: "lte",
        actual: debugLargeArtifactInlineViolationCount(report),
        threshold: 0,
        required: true,
        source: "artifacts.largeArtifacts.*",
      }),
      entry({
        id: "debug_artifact_bundle_manifest_observed",
        label: "Debug artifact bundle manifest observed",
        unit: "count",
        comparator: "gte",
        actual: debugArtifactBundleManifestCount(report),
        threshold: 1,
        required: true,
        source: "artifacts.bundles + debugReport.summaries.artifactBundle",
      }),
    ];
  }
  const openaiEntries = openaiRealtimeGateEntries(gate, report, entry, THRESHOLDS);
  if (openaiEntries.length > 0) return openaiEntries;
  return [];
}

function withRatio(item) {
  const threshold = numberOrNull(item.threshold);
  if (threshold == null || threshold === 0) {
    return {
      ...item,
      ratio: null,
    };
  }
  const ratio =
    item.comparator === "gte"
      ? threshold / Math.max(0.0001, Number(item.actual))
      : Number(item.actual) / threshold;
  return {
    ...item,
    ratio: Math.round(ratio * 1000) / 1000,
  };
}

function perceivedStage(entryItem) {
  return {
    id: entryItem.id,
    label: entryItem.label,
    actual: entryItem.actual ?? null,
    threshold: entryItem.threshold ?? null,
    unit: entryItem.unit || "ms",
    ok: entryItem.ok === true,
    source: entryItem.source || "",
  };
}

function buildPerceivedUxSummary(report, slo) {
  const entries = (slo?.entries || []).filter((item) => item.required);
  const stages = entries.map(perceivedStage);
  const measured = stages.filter((stage) => stage.actual != null);
  const latencyStages = measured.filter((stage) => stage.unit === "ms");
  const firstFeedback =
    [
      "turn_heard_to_speech_started_ms",
      "conversation_speech_start_ms",
      "tool_call_emitted_ms",
      "kwwk_visible_feedback_after_tool_ms",
      "webrtc_connected_ms",
    ]
      .map((id) => latencyStages.find((stage) => stage.id === id))
      .find(Boolean) ||
    latencyStages[0] ||
    null;
  const slowestStage =
    entries
      .map((item) => withRatio(item))
      .sort((left, right) => Number(right.ratio || 0) - Number(left.ratio || 0))[0] || null;
  return {
    schema: "oneesama.lan_perceived_ux.v1",
    gate: normalizeLocalOperatorGate(report?.gate),
    ok: slo?.ok === true,
    stageCount: stages.length,
    measuredStageCount: measured.length,
    firstFeedbackMs: firstFeedback?.actual ?? null,
    firstFeedbackStageId: firstFeedback?.id || null,
    failedStageIds: stages.filter((stage) => stage.ok !== true).map((stage) => stage.id),
    missingStageIds: stages.filter((stage) => stage.actual == null).map((stage) => stage.id),
    slowestStage: slowestStage ? perceivedStage(slowestStage) : null,
    stages,
  };
}

export function scoreLanAcceptanceSlo(report) {
  const entries = gateEntries(report);
  const requiredEntries = entries.filter((item) => item.required);
  const failures = requiredEntries.filter((item) => item.ok !== true);
  const measured = entries.filter((item) => item.actual != null);
  const slowest =
    measured
      .map((item) => withRatio(item))
      .sort((left, right) => Number(right.ratio || 0) - Number(left.ratio || 0))[0] || null;
  return {
    schemaVersion: SCHEMA_VERSION,
    sampleCount: 1,
    statistic: "single_run",
    ok: failures.length === 0,
    thresholds: THRESHOLDS,
    entries,
    failures,
    slowest,
  };
}

export function attachLanAcceptanceSlo(report) {
  const slo = scoreLanAcceptanceSlo(report);
  const perceivedUx = buildPerceivedUxSummary(report, slo);
  return {
    ...report,
    ok: report?.ok === true && slo.ok === true,
    functionalOk: report?.functionalOk ?? report?.ok === true,
    perceivedUx,
    slo,
  };
}

function percentile(values, percentileValue) {
  const sorted = values
    .map((value) => numberOrNull(value))
    .filter((value) => value != null)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function aggregateEntry(gate, entryId, entries) {
  const template = entries.find((item) => item.entry) || {};
  const entryTemplate = template.entry || {};
  const values = entries
    .map((item) => numberOrNull(item.entry?.actual))
    .filter((value) => value != null);
  const threshold = numberOrNull(entryTemplate.threshold);
  const comparator = entryTemplate.comparator || "lte";
  const statistic = comparator === "gte" ? "p50" : "p95";
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  const actual = statistic === "p50" ? p50 : p95;
  const missingCount = entries.filter((item) => item.entry?.actual == null).length;
  const failedCount = entries.filter((item) => item.entry?.ok !== true).length;
  let ok = null;
  if (actual != null && threshold != null) {
    ok = comparator === "gte" ? actual >= threshold : actual <= threshold;
  }
  if (entryTemplate.required && ok == null) ok = false;
  return {
    gate,
    id: entryId,
    label: entryTemplate.label || entryId,
    unit: entryTemplate.unit || "ms",
    comparator,
    threshold,
    required: Boolean(entryTemplate.required),
    statistic,
    p50,
    p95,
    min: percentile(values, 0),
    max: percentile(values, 100),
    values,
    sampleCount: entries.length,
    measuredCount: values.length,
    missingCount,
    failedCount,
    ok,
  };
}

export function aggregateLanAcceptanceSloReports(reports) {
  const reportList = Array.isArray(reports) ? reports : [];
  const reportSummaries = reportList.map((report) => ({
    gate: normalizeLocalOperatorGate(report?.gate),
    ok: report?.ok === true,
    functionalOk: report?.functionalOk === true,
    sloOk: report?.slo?.ok === true,
    perceivedUx: {
      ok: report?.perceivedUx?.ok === true,
      firstFeedbackMs: report?.perceivedUx?.firstFeedbackMs ?? null,
      slowestStageId: report?.perceivedUx?.slowestStage?.id || null,
      failedStageIds: report?.perceivedUx?.failedStageIds || [],
    },
    generatedAt: String(report?.generatedAt || ""),
  }));
  const groupedByGate = new Map();
  for (const report of reportList) {
    const gate = normalizeLocalOperatorGate(report?.gate);
    if (!groupedByGate.has(gate)) groupedByGate.set(gate, []);
    groupedByGate.get(gate).push(report);
  }

  const gates = {};
  for (const [gate, gateReports] of groupedByGate.entries()) {
    const entryIds = new Set();
    for (const report of gateReports) {
      for (const entryItem of report?.slo?.entries || []) entryIds.add(entryItem.id);
    }
    const entries = [];
    for (const entryId of entryIds) {
      const samples = gateReports.map((report) => ({
        report,
        entry: (report?.slo?.entries || []).find((item) => item.id === entryId) || null,
      }));
      entries.push(aggregateEntry(gate, entryId, samples));
    }
    const gateFailures = entries.filter((entryItem) => entryItem.required && entryItem.ok !== true);
    const functionalFailures = gateReports.filter((report) => report?.functionalOk !== true);
    gates[gate] = {
      sampleCount: gateReports.length,
      ok: gateFailures.length === 0 && functionalFailures.length === 0,
      functionalFailures: functionalFailures.length,
      entries,
      failures: gateFailures,
    };
  }

  const failedReports = reportSummaries.filter((report) => report.ok !== true);
  const failedGates = Object.entries(gates)
    .filter(([, gateSummary]) => gateSummary.ok !== true)
    .map(([gate, gateSummary]) => ({ gate, failures: gateSummary.failures }));
  const firstFeedbackValues = reportList
    .map((report) => numberOrNull(report?.perceivedUx?.firstFeedbackMs))
    .filter((value) => value != null);
  const perceivedUx = {
    schema: "oneesama.lan_perceived_ux_suite.v1",
    ok: reportSummaries.every((report) => report.perceivedUx.ok === true),
    reportCount: reportList.length,
    firstFeedbackP50Ms: percentile(firstFeedbackValues, 50),
    firstFeedbackP95Ms: percentile(firstFeedbackValues, 95),
    failedStages: reportSummaries.flatMap((report) =>
      report.perceivedUx.failedStageIds.map((stageId) => ({ gate: report.gate, stageId })),
    ),
  };
  return {
    schema: "oneesama.lan_slo_suite.v1",
    generatedAt: new Date().toISOString(),
    ok: failedReports.length === 0 && failedGates.length === 0,
    sampleCount: reportList.length,
    perceivedUx,
    reports: reportSummaries,
    gates,
    failedReports,
    failedGates,
  };
}
