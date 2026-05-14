import assert from "node:assert/strict";
import test from "node:test";

import { waitForMeetAdmission } from "../packages/core/src/meeting/meet-admission.ts";

function fakePage({ captionVisible = false, leaveVisible = false } = {}) {
  return {
    locator(selector) {
      return {
        first() {
          return {
            async isVisible() {
              if (selector.includes("caption")) return captionVisible;
              if (selector.includes("Leave")) return leaveVisible;
              return false;
            },
          };
        },
      };
    },
    async evaluate() {
      return null;
    },
    async waitForTimeout(ms) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2)));
    },
  };
}

test("waitForMeetAdmission keeps waiting when only waiting-room leave controls are visible", async () => {
  const result = await waitForMeetAdmission(fakePage({ leaveVisible: true }), {
    timeoutMs: 2,
    evaluateMeetPageState: async () => ({ inMeeting: false, waitingForAdmit: true }),
  });

  assert.equal(result.state, "timeout");
});

test("waitForMeetAdmission admits when the caption toggle is visible", async () => {
  const result = await waitForMeetAdmission(
    fakePage({ captionVisible: true, leaveVisible: true }),
    {
      timeoutMs: 100,
      evaluateMeetPageState: async () => ({ inMeeting: false, waitingForAdmit: true }),
    },
  );

  assert.deepEqual(result, { state: "admitted", signal: "captions" });
});

test("waitForMeetAdmission admits on explicit in-meeting page state fallback", async () => {
  const result = await waitForMeetAdmission(fakePage({ leaveVisible: true }), {
    timeoutMs: 100,
    evaluateMeetPageState: async () => ({ inMeeting: true, waitingForAdmit: false }),
  });

  assert.equal(result.state, "admitted");
  assert.equal(result.signal, "page_state");
});
