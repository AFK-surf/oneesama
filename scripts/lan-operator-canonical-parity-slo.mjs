const REQUIRED_DIAGNOSTIC_EVENTS = Object.freeze([
  "engine_connected",
  "speech_started",
  "transcript_completed",
  "tool_call_started",
  "tool_call_completed",
  "tool_result_accepted",
  "assistant_text_completed",
  "engine_error",
]);

function canonicalCounts(report) {
  return (
    report?.conversationEngine?.canonicalEventCounts ||
    report?.debugReport?.summaries?.canonicalConversationEvents ||
    report?.debugReport?.debug?.conversation?.eventCounts ||
    report?.runtimeStatus?.debug?.conversation?.eventCounts ||
    {}
  );
}

export function diagnosticCanonicalParityEvidence(report) {
  const counts = canonicalCounts(report);
  const observed = REQUIRED_DIAGNOSTIC_EVENTS.filter((event) => Number(counts[event] || 0) >= 1);
  return {
    schema: "oneesama.diagnostic_canonical_parity.v1",
    source: "diagnostic_conversation_engine",
    requiredEvents: [...REQUIRED_DIAGNOSTIC_EVENTS],
    observedEvents: observed,
    missingEvents: REQUIRED_DIAGNOSTIC_EVENTS.filter((event) => !observed.includes(event)),
    observedCount: observed.length,
    providerRawEventLeakCount: Number(report?.conversationEngine?.providerRawEventLeakCount || 0),
  };
}

export function diagnosticCanonicalParityCount(report) {
  const evidence =
    report?.conversationEngine?.diagnosticCanonicalParity ||
    diagnosticCanonicalParityEvidence(report);
  return evidence.observedCount >= REQUIRED_DIAGNOSTIC_EVENTS.length &&
    evidence.providerRawEventLeakCount === 0
    ? 1
    : 0;
}
