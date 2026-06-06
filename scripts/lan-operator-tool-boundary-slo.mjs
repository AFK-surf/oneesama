function countCanonicalToolEvents(report) {
  const counts = report?.conversationEngine?.canonicalEventCounts || {};
  const fromCounts =
    Number(counts.tool_call_started || 0) +
    Number(counts.tool_call_completed || 0) +
    Number(counts.tool_result_accepted || 0);
  if (fromCounts > 0) return fromCounts;
  return (Array.isArray(report?.timeline) ? report.timeline : []).filter((row) =>
    ["tool_call_started", "tool_call_completed", "tool_result_accepted"].includes(row?.event),
  ).length;
}

export function canonicalToolBoundaryCount(report) {
  const boundary = report?.tool?.canonicalBoundary || {};
  const safety = report?.tool?.argumentSafety || {};
  const canonicalToolEventCount = Number(
    boundary.canonicalToolEventCount ?? countCanonicalToolEvents(report),
  );
  const providerRawEventLeakCount = Number(boundary.providerRawEventLeakCount ?? 0);
  const providerAgnostic =
    boundary.providerAgnostic === true ||
    (boundary.source === "conversation_engine_port" && !boundary.provider) ||
    (["lan_tool_routing", "lan_kwwk_action"].includes(report?.gate) &&
      report?.conversationEngine?.rawProviderEventsAvailable !== true);
  const rawOperationsExposed =
    boundary.rawOperationsExposed ??
    safety.exposesRawOperations ??
    Boolean(report?.tool?.arguments?.operations);
  const coordinatesExposed =
    boundary.coordinatesExposed ??
    safety.exposesCoordinates ??
    Boolean(report?.tool?.arguments?.x || report?.tool?.arguments?.y);
  return canonicalToolEventCount >= 2 &&
    providerRawEventLeakCount === 0 &&
    providerAgnostic &&
    rawOperationsExposed === false &&
    coordinatesExposed === false
    ? 1
    : 0;
}
