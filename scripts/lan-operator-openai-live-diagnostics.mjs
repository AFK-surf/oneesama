export function sanitizeOpenAIProviderText(value) {
  return String(value || "").replace(/\bsk-[A-Za-z0-9_.*-]+/g, "[redacted_openai_api_key]");
}

function collectStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    if (value.trim()) out.push(sanitizeOpenAIProviderText(value.trim()));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const key of ["error", "message", "blocker", "reason", "status", "summary"]) {
    if (key in value) collectStrings(value[key], out);
  }
  return out;
}

function providerEventTypes(report) {
  const events =
    report?.conversationEngine?.recentProviderEvents ||
    report?.debugReport?.summaries?.conversationPort?.recentProviderEvents ||
    report?.debugReport?.debug?.conversation?.provider?.recentEvents ||
    report?.runtimeStatus?.debug?.conversation?.provider?.recentEvents ||
    [];
  return [
    ...new Set(events.map((event) => String(event?.providerEventType || "")).filter(Boolean)),
  ];
}

function providerFailureMessages(report) {
  const messages = [
    ...collectStrings(report?.debugReport?.debug?.conversation?.errors),
    ...collectStrings(report?.runtimeStatus?.debug?.conversation?.errors),
    ...collectStrings(report?.conversationEngine?.recentProviderEvents),
    ...collectStrings(report?.debugReport?.summaries?.conversationPort?.recentProviderEvents),
    ...collectStrings(report?.debugReport?.debug?.conversation?.provider?.recentEvents),
    ...collectStrings(report?.runtimeStatus?.debug?.conversation?.provider?.recentEvents),
    ...collectStrings(report?.failureRows),
    ...collectStrings(report?.timeline),
    ...collectStrings(report?.debugReport?.timeline),
    ...collectStrings(report?.blocker),
    ...collectStrings(report?.error),
  ];
  return [...new Set(messages)].slice(0, 8);
}

export function classifyOpenAIRealtimeProviderFailure(report) {
  if (report?.ok === true || report?.skipped === true) {
    return { present: false, category: "", blocker: "", message: "", messages: [] };
  }
  const messages = providerFailureMessages(report);
  const joined = messages.join("\n");
  const eventTypes = providerEventTypes(report);
  const counts = report?.conversationEngine?.providerEventCounts || {};
  let category = "";
  let blocker = "";
  if (
    /incorrect api key|invalid api key|api key provided|401|authentication|unauthorized/i.test(
      joined,
    )
  ) {
    category = "invalid_api_key";
    blocker = "openai_realtime_api_key_invalid";
  } else if (/insufficient_quota|quota|billing|payment|required/i.test(joined)) {
    category = "quota_or_billing";
    blocker = "openai_realtime_quota_or_billing_blocked";
  } else if (
    /model.*(not found|does not exist|unsupported|unavailable)|unsupported.*model/i.test(joined)
  ) {
    category = "model_unavailable";
    blocker = "openai_realtime_model_unavailable";
  } else if (/rate limit|429/i.test(joined)) {
    category = "rate_limited";
    blocker = "openai_realtime_rate_limited";
  } else if (
    /websocket_closed|close|closed/i.test(joined) ||
    Number(counts["response.failed"] || 0) > 0
  ) {
    category = "websocket_closed";
    blocker = "openai_realtime_websocket_closed";
  } else if (messages.length || Object.keys(counts).length) {
    category = "provider_error";
    blocker = "openai_realtime_provider_error";
  } else {
    category = "unknown";
    blocker = "openai_realtime_unknown_failure";
  }
  return {
    present: true,
    category,
    blocker,
    message: messages[0] || blocker,
    messages,
    providerEventTypes: eventTypes,
  };
}

export function attachOpenAIRealtimeFailureDiagnostics(report) {
  const failure = classifyOpenAIRealtimeProviderFailure(report);
  if (!failure.present) return report;
  const next = {
    ...report,
    acceptanceBlocker: report.acceptanceBlocker || failure.blocker,
    blocker: report.blocker || failure.blocker,
    provider: {
      ...report.provider,
      failure,
    },
    conversationEngine: {
      ...report.conversationEngine,
      providerFailure: failure,
    },
  };
  return next;
}
