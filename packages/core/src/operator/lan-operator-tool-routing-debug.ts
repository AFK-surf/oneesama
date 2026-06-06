import type { CanonicalConversationEvent } from "./lan-operator-conversation-engine.ts";
import type { DebugState } from "./lan-operator-debug-state.ts";
import { appendTimelineRow } from "./lan-operator-timeline-debug.ts";

type ToolRoutingState = DebugState["toolRouting"];

function stringDetail(event: CanonicalConversationEvent, key: string) {
  const value = event.detail?.[key];
  return typeof value === "string" ? value : "";
}

function parseArguments(text: string) {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasKeyDeep(value: unknown, keys: Set<string>): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, keys));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) => keys.has(key) || hasKeyDeep(entry, keys),
  );
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function argumentSafety(
  parsedArguments: Record<string, unknown> | null,
): ToolRoutingState["argumentSafety"] {
  const instruction = stringField(
    parsedArguments?.instruction || parsedArguments?.goal || parsedArguments?.prompt,
  );
  const target = parsedArguments?.target;
  const targetObject =
    target && typeof target === "object" && !Array.isArray(target)
      ? (target as Record<string, unknown>)
      : {};
  const safeTargetHint = Boolean(
    stringField(parsedArguments?.appHint) ||
    stringField(parsedArguments?.windowHint) ||
    stringField(parsedArguments?.applicationName) ||
    stringField(parsedArguments?.windowTitle) ||
    stringField(parsedArguments?.bundleIdentifier) ||
    stringField(targetObject.applicationName) ||
    stringField(targetObject.app) ||
    stringField(targetObject.windowTitle) ||
    stringField(targetObject.window),
  );
  const exposesRawOperations = hasKeyDeep(
    parsedArguments,
    new Set(["operations", "operation", "actions"]),
  );
  const exposesCoordinates = hasKeyDeep(
    parsedArguments,
    new Set(["x", "y", "coordinate", "coordinates", "point"]),
  );
  return {
    naturalLanguageInstruction: instruction.length > 0,
    safeTargetHint,
    exposesRawOperations,
    exposesCoordinates,
    ok: instruction.length > 0 && safeTargetHint && !exposesRawOperations && !exposesCoordinates,
  };
}

function statusFor(event: CanonicalConversationEvent): ToolRoutingState["status"] | null {
  if (event.type === "tool_call_started") return "started";
  if (event.type === "tool_call_delta") return "streaming";
  if (event.type === "tool_call_completed") return "completed";
  if (event.type === "tool_result_accepted") return "result_accepted";
  if (event.type === "engine_error") return "failed";
  return null;
}

function callSummary(debug: DebugState, event: CanonicalConversationEvent) {
  return {
    ts: event.ts,
    event: event.type,
    expectedTool: debug.toolRouting.expectedTool,
    actualTool: debug.toolRouting.actualTool,
    callId: debug.toolRouting.callId,
    itemId: debug.toolRouting.itemId,
    status: debug.toolRouting.status,
    argumentsText: debug.toolRouting.argumentsText,
    functionOutputDelivered: debug.toolRouting.functionOutputDelivered,
  };
}

export function recordToolRoutingCanonicalEvent(
  debug: DebugState,
  event: CanonicalConversationEvent,
) {
  if (!event.type.startsWith("tool_") && event.type !== "engine_error") return null;

  const expectedTool = stringDetail(event, "expectedTool");
  const actualTool = stringDetail(event, "name");
  const callId = stringDetail(event, "callId");
  const status = statusFor(event);
  if (expectedTool) debug.toolRouting.expectedTool = expectedTool;
  if (actualTool) debug.toolRouting.actualTool = actualTool;
  if (callId) debug.toolRouting.callId = callId;
  if (event.itemId) debug.toolRouting.itemId = event.itemId;
  if (status) debug.toolRouting.status = status;
  debug.toolRouting.lastUpdatedAt = event.ts;

  if (event.type === "tool_call_delta") {
    debug.toolRouting.argumentsText += event.text || "";
  }
  if (event.type === "tool_call_completed") {
    debug.toolRouting.argumentsText = event.text || debug.toolRouting.argumentsText;
    debug.toolRouting.parsedArguments = parseArguments(debug.toolRouting.argumentsText);
    debug.toolRouting.argumentSafety = argumentSafety(debug.toolRouting.parsedArguments);
  }
  if (event.type === "tool_result_accepted") {
    debug.toolRouting.functionOutputDelivered = true;
    debug.toolRouting.functionOutput = parseArguments(event.text || "") || event.text || null;
  }
  if (event.type === "engine_error") {
    debug.toolRouting.errors = [
      ...debug.toolRouting.errors,
      { ts: event.ts, error: String(event.error || event.detail?.error || "engine_error") },
    ].slice(-20);
  }

  debug.toolRouting.calls = [...debug.toolRouting.calls, callSummary(debug, event)].slice(-80);
  if (event.type === "tool_call_completed" && !debug.toolRouting.argumentSafety.ok) {
    appendTimelineRow(debug, {
      at: event.ts,
      layer: "tool_routing",
      event: "tool_arguments_rejected",
      ok: false,
      turnId: event.turnId || debug.timeline.currentTurnId,
      responseId: event.responseId || null,
      blocker: "unsafe_tool_arguments",
      detail: {
        expectedTool: debug.toolRouting.expectedTool || "",
        actualTool: debug.toolRouting.actualTool || "",
        callId: debug.toolRouting.callId || "",
        argumentSafety: debug.toolRouting.argumentSafety,
      },
    });
  }

  return debug.toolRouting;
}

export function toolRoutingRuntimeDetail(debug: DebugState) {
  return {
    expectedTool: debug.toolRouting.expectedTool,
    actualTool: debug.toolRouting.actualTool,
    callId: debug.toolRouting.callId,
    status: debug.toolRouting.status,
    functionOutputDelivered: debug.toolRouting.functionOutputDelivered,
    argumentSafety: debug.toolRouting.argumentSafety,
    cancel: debug.toolRouting.cancel,
  };
}
