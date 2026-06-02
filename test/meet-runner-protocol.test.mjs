import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { buildPlan } from "../meet-runner/src/join-plan.ts";
import { sanitizeRPCPayload, success } from "../meet-runner/src/protocol.ts";

test("meet-runner RPC responses omit inline data URLs", () => {
  const dataUrl = `data:image/png;base64,${"a".repeat(50_000)}`;
  const response = success("screen-share", {
    ok: true,
    present: {
      start: {
        state: {
          imageUrl: dataUrl,
        },
      },
    },
  });

  const line = JSON.stringify(response);

  assert.ok(line.length < 2000, `response line too large: ${line.length}`);
  assert.equal(
    response.result.present.start.state.imageUrl,
    `[data URL omitted: image/png, chars=${dataUrl.length}]`,
  );
});

test("meet-runner RPC sanitizer bounds non-data long strings", () => {
  const sanitized = sanitizeRPCPayload({ text: "x".repeat(10_000) });

  assert.deepEqual(sanitized, { text: "[long string omitted: chars=10000]" });
});

test("meet-runner join plan rejects inline Realtime placement for Google Meet", () => {
  assert.throws(
    () =>
      buildPlan(
        {
          meeting_url: "https://meet.google.com/abc-defg-hij",
          install_realtime_bridge: true,
          realtime_runtime_placement: "inline",
        },
        "https://meet.google.com/abc-defg-hij",
      ),
    /inline Realtime SDK on Meet has been removed/,
  );
});
