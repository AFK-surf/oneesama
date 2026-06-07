import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { lanOperatorKwwkActionTurnContextFromStatus } from "../scripts/lan-operator-kwwk-action-benchmark.mjs";

test("KWWK action benchmark carries the emitted real-mic tool-call turn context", () => {
  const context = lanOperatorKwwkActionTurnContextFromStatus({
    debug: {
      timeline: {
        rows: [
          {
            event: "tool_call_started",
            turnId: "turn_lan_kwwk_action_274",
            responseId: "response_lan_kwwk_action_274",
          },
        ],
      },
    },
  });

  assert.deepEqual(context, {
    turnId: "turn_lan_kwwk_action_274",
    responseId: "response_lan_kwwk_action_274",
  });
});

test("KWWK action benchmark keeps the synthetic turn context fallback", () => {
  const context = lanOperatorKwwkActionTurnContextFromStatus({ debug: { timeline: { rows: [] } } });

  assert.deepEqual(context, {
    turnId: "turn_lan_kwwk_action_1",
    responseId: "response_lan_kwwk_action_1",
  });
});
