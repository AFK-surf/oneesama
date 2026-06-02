import { defaultGoogleMeetRealtimeTools } from "../../../packages/core/src/meeting/google-meet-joiner.js";
import { buildRealtimeSessionConfig } from "../../../packages/core/src/realtime/realtime-contract.js";

export function defaultMeetingAgentRealtimeTools() {
  return defaultGoogleMeetRealtimeTools();
}

function requestedToolName(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as { name?: unknown; function?: { name?: unknown } };
  return String(record.name || record.function?.name || "").trim();
}

export function meetingAgentRealtimeToolsForRequest(requestedTools?: unknown[]) {
  const defaults = defaultMeetingAgentRealtimeTools();
  if (!Array.isArray(requestedTools)) return defaults;
  const requestedNames = new Set(requestedTools.map(requestedToolName).filter(Boolean));
  return defaults.filter((tool) => requestedNames.has(tool.name));
}

export function buildMeetingAgentRealtimeSessionConfig(options = {}, config = {}) {
  const requestedTools = Array.isArray((options as { tools?: unknown[] }).tools)
    ? (options as { tools?: unknown[] }).tools
    : undefined;
  const tools = meetingAgentRealtimeToolsForRequest(requestedTools);
  return buildRealtimeSessionConfig({ ...options, tools }, config);
}
