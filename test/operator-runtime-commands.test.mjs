import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  debugReportArtifactMessage,
  engineControlMessage,
  toolCancelMessage,
} from "../packages/core/src/operator/web/operatorRuntimeCommands.ts";

test("operator runtime commands build engine control payloads", () => {
  assert.deepEqual(
    engineControlMessage({
      sessionId: "session_1",
      type: "cancel_response",
      detail: { reason: "manual" },
      debug: { output: { assistantText: { lastResponseId: "resp_1" } } },
    }),
    {
      type: "engine_control",
      sessionId: "session_1",
      control: {
        type: "cancel_response",
        reason: "operator_web_cancel_response",
        responseId: "resp_1",
        detail: { source: "operator_web", reason: "manual" },
      },
    },
  );

  assert.equal(
    engineControlMessage({
      sessionId: "session_1",
      type: "reset_session",
      detail: { responseId: "override" },
      debug: { output: { assistantText: { lastResponseId: "resp_1" } } },
    }).control.responseId,
    "override",
  );
});

test("operator runtime commands build tool cancel payloads from debug state", () => {
  assert.deepEqual(
    toolCancelMessage(
      {
        toolRouting: {
          callId: "call_1",
          itemId: "item_1",
          actualTool: "browser_tool",
        },
        kwwk: { currentJobId: "job_1" },
        timeline: { currentTurnId: "turn_1" },
        output: { assistantText: { lastResponseId: "resp_1" } },
      },
      "operator_requested_stop",
    ),
    {
      type: "tool_cancel",
      callId: "call_1",
      itemId: "item_1",
      toolName: "browser_tool",
      jobId: "job_1",
      turnId: "turn_1",
      responseId: "resp_1",
      reason: "operator_requested_stop",
    },
  );
});

test("operator runtime commands keep tool cancel defaults", () => {
  assert.deepEqual(toolCancelMessage({}), {
    type: "tool_cancel",
    callId: "",
    itemId: "",
    toolName: "kwwk_computer_use",
    jobId: "",
    turnId: "",
    responseId: "",
    reason: "operator_cancelled",
  });
});

test("operator runtime commands build debug report artifact payloads", () => {
  assert.deepEqual(debugReportArtifactMessage({ action: "copy", label: "operator_web" }), {
    type: "debug_report_artifact",
    action: "copy",
    label: "operator_web",
  });
  assert.deepEqual(
    debugReportArtifactMessage({
      action: "mark",
      label: "operator_web_mark",
      note: "",
    }),
    {
      type: "debug_report_artifact",
      action: "mark",
      label: "operator_web_mark",
      note: "",
    },
  );
});
