function openaiProviderEventCounts(report) {
  return report?.conversationEngine?.providerEventCounts || {};
}

function openaiProviderEventTotal(report) {
  return Object.values(openaiProviderEventCounts(report)).reduce(
    (total, value) => total + Number(value || 0),
    0,
  );
}

function openaiProviderTextEventCount(report) {
  const counts = openaiProviderEventCounts(report);
  return [
    "response.output_text.delta",
    "response.output_text.done",
    "response.text.delta",
    "response.text.done",
    "response.output_audio_transcript.delta",
    "response.output_audio_transcript.done",
  ].reduce((total, eventType) => total + Number(counts[eventType] || 0), 0);
}

function openaiProviderAudioInputEventCount(report) {
  const counts = openaiProviderEventCounts(report);
  return [
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
    "input_audio_buffer.committed",
    "conversation.item.input_audio_transcription.delta",
    "conversation.item.input_audio_transcription.completed",
  ].reduce((total, eventType) => total + Number(counts[eventType] || 0), 0);
}

function openaiProviderToolCallEventCount(report) {
  const counts = openaiProviderEventCounts(report);
  const counted = [
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.added",
    "response.output_item.done",
    "response.done",
  ].reduce((total, eventType) => total + Number(counts[eventType] || 0), 0);
  return Math.max(counted, Number(report?.conversationEngine?.providerToolCallEventCount || 0));
}

function openaiLiveTransportCount(report) {
  return report?.conversationEngine?.kind === "openai_realtime" &&
    report?.conversationEngine?.transport === "openai_realtime" &&
    report?.conversationEngine?.providerAdapterKind === "openai_realtime" &&
    report?.diagnosticOnly !== true &&
    report?.skipped !== true
    ? 1
    : 0;
}

function openaiSessionCreatedCount(report) {
  return Number(openaiProviderEventCounts(report)["session.created"] || 0) >= 1 ? 1 : 0;
}

function openaiRawProviderDrilldownCount(report) {
  return report?.conversationEngine?.rawProviderEventsAvailable === true &&
    openaiProviderEventTotal(report) >= 2 &&
    report?.provider?.rawPayloadStored !== true
    ? 1
    : 0;
}

function openaiCanonicalEventEvidenceCount(report) {
  const counts = report?.conversationEngine?.canonicalEventCounts || {};
  return [
    Number(counts.engine_connected || 0) >= 1,
    Number(counts.assistant_text_completed || 0) >= 1,
    report?.conversationEngine?.latestCanonicalEvent,
  ].filter(Boolean).length;
}

function openaiCanonicalToolEventEvidenceCount(report) {
  const counts = report?.conversationEngine?.canonicalEventCounts || {};
  return [
    Number(counts.engine_connected || 0) >= 1,
    Number(counts.transcript_completed || 0) >= 1,
    Number(counts.tool_call_started || 0) >= 1,
    Number(counts.tool_call_completed || 0) >= 1,
    Number(counts.tool_result_accepted || 0) >= 1,
    Number(counts.assistant_text_completed || 0) >= 1,
    report?.conversationEngine?.latestCanonicalEvent,
  ].filter(Boolean).length;
}

function openaiCanonicalVoiceEventEvidenceCount(report) {
  const counts = report?.conversationEngine?.canonicalEventCounts || {};
  return [
    Number(counts.engine_connected || 0) >= 1,
    Number(counts.speech_started || 0) >= 1,
    Number(counts.transcript_completed || 0) >= 1,
    Number(counts.assistant_text_completed || 0) >= 1,
    report?.conversationEngine?.latestCanonicalEvent,
  ].filter(Boolean).length;
}

function openaiVoiceIngressChunkCount(report) {
  const audio = report?.audio || {};
  return Math.min(
    Number(audio.chunksReceivedDelta ?? audio.chunksReceived ?? 0),
    Number(audio.forwardedChunksDelta ?? audio.forwardedChunks ?? 0),
  );
}

function openaiKwwkToolSelectedCount(report) {
  return report?.tool?.expectedTool === "kwwk_computer_use" &&
    report?.tool?.actualTool === "kwwk_computer_use"
    ? 1
    : 0;
}

function openaiSafeToolArgumentsCount(report) {
  const safety = report?.tool?.argumentSafety || {};
  return safety.ok === true &&
    safety.naturalLanguageInstruction === true &&
    safety.safeTargetHint === true &&
    safety.exposesRawOperations === false &&
    safety.exposesCoordinates === false
    ? 1
    : 0;
}

function openaiToolResultDeliveredCount(report) {
  const counts = report?.conversationEngine?.canonicalEventCounts || {};
  return report?.tool?.functionOutputDelivered === true &&
    Number(counts.tool_result_accepted || 0) >= 1
    ? 1
    : 0;
}

function openaiBaseEntries(report, entry) {
  return [
    entry({
      id: "openai_realtime_live_transport_selected",
      label: "Live OpenAI Realtime transport selected",
      unit: "count",
      comparator: "gte",
      actual: openaiLiveTransportCount(report),
      threshold: 1,
      required: true,
      source: "conversationEngine.kind/transport/providerAdapterKind",
    }),
    entry({
      id: "openai_realtime_session_created_observed",
      label: "OpenAI Realtime session.created observed",
      unit: "count",
      comparator: "gte",
      actual: openaiSessionCreatedCount(report),
      threshold: 1,
      required: true,
      source: "conversationEngine.providerEventCounts.session.created",
    }),
  ];
}

export function openaiRealtimeGateEntries(gate, report, entry, thresholds) {
  const normalizedGate = normalizeLocalOperatorGate(gate);
  if (normalizedGate === LOCAL_OPERATOR_GATES.openaiLive) {
    return [
      ...openaiBaseEntries(report, entry),
      entry({
        id: "openai_realtime_provider_events_observed",
        label: "OpenAI Realtime provider event summaries observed",
        unit: "count",
        comparator: "gte",
        actual: openaiProviderEventTotal(report),
        threshold: 2,
        required: true,
        source: "conversationEngine.providerEventCounts",
      }),
      entry({
        id: "openai_realtime_provider_text_response_observed",
        label: "OpenAI Realtime provider text response observed",
        unit: "count",
        comparator: "gte",
        actual: openaiProviderTextEventCount(report),
        threshold: 1,
        required: true,
        source: "conversationEngine.providerEventCounts.response.output_text_*",
      }),
      entry({
        id: "openai_realtime_raw_provider_drilldown_observed",
        label: "Provider raw-event drilldown summaries observed",
        unit: "count",
        comparator: "gte",
        actual: openaiRawProviderDrilldownCount(report),
        threshold: 1,
        required: true,
        source: "conversationEngine.rawProviderEventsAvailable + provider.rawPayloadStored",
      }),
      entry({
        id: "openai_realtime_canonical_events_observed",
        label: "OpenAI provider events mapped to canonical events",
        unit: "count",
        comparator: "gte",
        actual: openaiCanonicalEventEvidenceCount(report),
        threshold: 3,
        required: true,
        source: "conversationEngine.canonicalEventCounts",
      }),
    ];
  }
  if (normalizedGate === LOCAL_OPERATOR_GATES.openaiToolLive) {
    return [
      ...openaiBaseEntries(report, entry),
      entry({
        id: "openai_realtime_provider_tool_call_observed",
        label: "OpenAI Realtime provider tool-call events observed",
        unit: "count",
        comparator: "gte",
        actual: openaiProviderToolCallEventCount(report),
        threshold: 1,
        required: true,
        source: "conversationEngine.providerEventCounts.response.function_call_*",
      }),
      entry({
        id: "openai_realtime_kwwk_tool_selected",
        label: "Live model selected kwwk_computer_use",
        unit: "count",
        comparator: "gte",
        actual: openaiKwwkToolSelectedCount(report),
        threshold: 1,
        required: true,
        source: "tool.expectedTool + tool.actualTool",
      }),
      entry({
        id: "openai_realtime_tool_arguments_safe",
        label: "KWWK tool arguments stay high-level",
        unit: "count",
        comparator: "gte",
        actual: openaiSafeToolArgumentsCount(report),
        threshold: 1,
        required: true,
        source: "tool.argumentSafety",
      }),
      entry({
        id: "openai_realtime_tool_result_delivered",
        label: "KWWK function output delivered back to Realtime",
        unit: "count",
        comparator: "gte",
        actual: openaiToolResultDeliveredCount(report),
        threshold: 1,
        required: true,
        source: "tool.functionOutputDelivered + canonicalEventCounts.tool_result_accepted",
      }),
      entry({
        id: "openai_realtime_provider_text_response_observed",
        label: "OpenAI Realtime provider text response observed after tool result",
        unit: "count",
        comparator: "gte",
        actual: openaiProviderTextEventCount(report),
        threshold: 1,
        required: true,
        source: "conversationEngine.providerEventCounts.response.output_text_*",
      }),
      entry({
        id: "openai_realtime_raw_provider_drilldown_observed",
        label: "Provider raw-event drilldown summaries observed",
        unit: "count",
        comparator: "gte",
        actual: openaiRawProviderDrilldownCount(report),
        threshold: 1,
        required: true,
        source: "conversationEngine.rawProviderEventsAvailable + provider.rawPayloadStored",
      }),
      entry({
        id: "openai_realtime_tool_canonical_events_observed",
        label: "OpenAI tool-call provider events mapped to canonical events",
        unit: "count",
        comparator: "gte",
        actual: openaiCanonicalToolEventEvidenceCount(report),
        threshold: 6,
        required: true,
        source: "conversationEngine.canonicalEventCounts",
      }),
    ];
  }
  if (normalizedGate !== LOCAL_OPERATOR_GATES.openaiVoiceLive) return [];
  return [
    ...openaiBaseEntries(report, entry),
    entry({
      id: "openai_realtime_voice_chunks_forwarded",
      label: "Operator Voice PCM chunks reached the live provider adapter",
      unit: "chunks",
      comparator: "gte",
      actual: openaiVoiceIngressChunkCount(report),
      threshold: Number(report?.args?.minVoiceChunks || 12),
      required: true,
      source: "audio.chunksReceivedDelta + audio.forwardedChunksDelta",
    }),
    entry({
      id: "openai_realtime_voice_ack_rtt_ms",
      label: "Live OpenAI voice gate chunk ACK RTT",
      actual: report?.audio?.voiceAckRttMs,
      threshold: thresholds.operatorVoiceAckRttMs,
      required: true,
      source: "audio.voiceAckRttMs",
    }),
    entry({
      id: "openai_realtime_voice_host_receive_lag_ms",
      label: "Live OpenAI voice gate host receive lag",
      actual: report?.audio?.hostReceiveLagMs,
      threshold: thresholds.operatorVoiceHostReceiveLagMs,
      required: true,
      source: "audio.hostReceiveLagMs",
    }),
    entry({
      id: "openai_realtime_provider_audio_input_observed",
      label: "OpenAI Realtime provider audio-input events observed",
      unit: "count",
      comparator: "gte",
      actual: openaiProviderAudioInputEventCount(report),
      threshold: 2,
      required: true,
      source: "conversationEngine.providerEventCounts.input_audio_buffer_*",
    }),
    entry({
      id: "openai_realtime_provider_text_response_observed",
      label: "OpenAI Realtime provider text response observed after voice input",
      unit: "count",
      comparator: "gte",
      actual: openaiProviderTextEventCount(report),
      threshold: 1,
      required: true,
      source: "conversationEngine.providerEventCounts.response.output_text_*",
    }),
    entry({
      id: "openai_realtime_raw_provider_drilldown_observed",
      label: "Provider raw-event drilldown summaries observed",
      unit: "count",
      comparator: "gte",
      actual: openaiRawProviderDrilldownCount(report),
      threshold: 1,
      required: true,
      source: "conversationEngine.rawProviderEventsAvailable + provider.rawPayloadStored",
    }),
    entry({
      id: "openai_realtime_voice_canonical_events_observed",
      label: "OpenAI voice provider events mapped to canonical events",
      unit: "count",
      comparator: "gte",
      actual: openaiCanonicalVoiceEventEvidenceCount(report),
      threshold: 5,
      required: true,
      source: "conversationEngine.canonicalEventCounts",
    }),
  ];
}
import { LOCAL_OPERATOR_GATES, normalizeLocalOperatorGate } from "./local-operator-gates.mjs";
