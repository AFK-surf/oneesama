import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  lanOperatorKwwkActionTurnContextFromStatus,
  operatorCursorsFromKwwkResult,
  operatorCursorKindFromKwwkEvent,
} from "../scripts/lan-operator-kwwk-action-benchmark.mjs";

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

test("KWWK action benchmark replays helper cursor metadata as normalized operator cursors", () => {
  const cursors = operatorCursorsFromKwwkResult(
    {
      metadata: {
        cursor: {
          events: [
            {
              kind: "cursor.click",
              x: 640,
              y: 360,
              normalizedX: 0.4,
              normalizedY: 0.6,
              label: "click",
            },
            {
              kind: "cursor.drag.end",
              normalizedX: 1.2,
              normalizedY: -0.2,
              label: "drag",
            },
          ],
        },
      },
    },
    { sourceId: "host-app" },
  );

  assert.deepEqual(cursors, [
    { x: 0.4, y: 0.6, kind: "click", label: "click", sourceId: "host-app" },
    { x: 1, y: 0, kind: "drag", label: "drag", sourceId: "host-app" },
  ]);
  assert.equal(operatorCursorKindFromKwwkEvent("cursor.scroll"), "move");
});
