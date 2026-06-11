import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  operatorSurfaceConnectedMessage,
  operatorTextInputMessage,
  realtimeEngineControlMessage,
} from "../packages/core/src/operator/web/realtimeCommands.ts";

test("operator realtime commands build surface connected payload", () => {
  assert.deepEqual(operatorSurfaceConnectedMessage(), {
    type: "operator_surface_connected",
  });
});

test("operator realtime commands build engine control payloads", () => {
  assert.deepEqual(realtimeEngineControlMessage("session-1", "connect", "operator_web_connect"), {
    type: "engine_control",
    sessionId: "session-1",
    control: {
      type: "connect",
      reason: "operator_web_connect",
      detail: { source: "operator_web" },
    },
  });

  assert.deepEqual(
    realtimeEngineControlMessage("session-1", "disconnect", "operator_web_disconnect"),
    {
      type: "engine_control",
      sessionId: "session-1",
      control: {
        type: "disconnect",
        reason: "operator_web_disconnect",
        detail: { source: "operator_web" },
      },
    },
  );
});

test("operator realtime commands build trimmed text input payloads", () => {
  assert.deepEqual(
    operatorTextInputMessage({
      sessionId: "session-1",
      text: "  hello operator  ",
      sequence: 7,
      nowMs: 1234,
    }),
    {
      type: "operator_text_input",
      sessionId: "session-1",
      inputId: "web_text_ya_7",
      text: "hello operator",
      source: "operator_web_text",
    },
  );
});

test("operator realtime commands skip blank text inputs", () => {
  assert.equal(
    operatorTextInputMessage({
      sessionId: "session-1",
      text: "  \n\t  ",
      sequence: 1,
      nowMs: 1234,
    }),
    null,
  );
});
