import type { DebugState } from "../lan-operator-debug-state.ts";
import type { EngineControlType, OperatorDebug } from "./useOperatorRuntime.ts";

export interface EngineControlMessage {
  [key: string]: unknown;
  type: "engine_control";
  sessionId: string;
  control: {
    type: EngineControlType;
    reason: string;
    responseId: string;
    detail: Record<string, unknown>;
  };
}

export interface ToolCancelMessage {
  [key: string]: unknown;
  type: "tool_cancel";
  callId: string;
  itemId: string;
  toolName: string;
  jobId: string;
  turnId: string;
  responseId: string;
  reason: string;
}

export interface DebugReportArtifactMessage {
  [key: string]: unknown;
  type: "debug_report_artifact";
  action: "copy" | "download" | "mark";
  label: string;
  note?: string;
}

export function engineControlMessage({
  debug,
  detail = {},
  sessionId,
  type,
}: {
  debug: OperatorDebug;
  detail?: Record<string, unknown>;
  sessionId: string;
  type: EngineControlType;
}): EngineControlMessage {
  return {
    type: "engine_control",
    sessionId,
    control: {
      type,
      reason: `operator_web_${type}`,
      responseId: String(detail.responseId || lastAssistantResponseId(debug) || ""),
      detail: { source: "operator_web", ...detail },
    },
  };
}

export function toolCancelMessage(
  debug: OperatorDebug,
  reason = "operator_cancelled",
): ToolCancelMessage {
  const toolRouting = debug.toolRouting as DebugState["toolRouting"] | undefined;
  const kwwk = debug.kwwk as DebugState["kwwk"] | undefined;
  const timeline = debug.timeline as DebugState["timeline"] | undefined;

  return {
    type: "tool_cancel",
    callId: toolRouting?.callId || "",
    itemId: toolRouting?.itemId || "",
    toolName: toolRouting?.actualTool || "kwwk_computer_use",
    jobId: kwwk?.currentJobId || "",
    turnId: timeline?.currentTurnId || "",
    responseId: lastAssistantResponseId(debug),
    reason,
  };
}

export function debugReportArtifactMessage({
  action,
  label,
  note,
}: {
  action: DebugReportArtifactMessage["action"];
  label: string;
  note?: string;
}): DebugReportArtifactMessage {
  return {
    type: "debug_report_artifact",
    action,
    label,
    ...(note == null ? {} : { note }),
  };
}

function lastAssistantResponseId(debug: OperatorDebug): string {
  const output = debug.output as DebugState["output"] | undefined;
  return output?.assistantText?.lastResponseId || "";
}
