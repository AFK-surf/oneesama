import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  parseRealtimeSocketPayload,
  publishRealtimePayload,
} from "../packages/core/src/operator/web/realtimeIncoming.ts";

test("operator realtime incoming parses websocket object payloads defensively", () => {
  assert.deepEqual(parseRealtimeSocketPayload('{"type":"work_event","id":1}'), {
    type: "work_event",
    id: 1,
  });
  assert.equal(parseRealtimeSocketPayload("{not json"), null);
  assert.equal(parseRealtimeSocketPayload("null"), null);
  assert.equal(parseRealtimeSocketPayload("[1,2,3]"), null);
  assert.equal(parseRealtimeSocketPayload('"string"'), null);
});

test("operator realtime incoming fans out raw and canonical payloads", () => {
  const raw = [];
  const canonical = [];
  const payload = {
    type: "canonical_conversation_event",
    event: { type: "assistant_text_completed", responseId: "r1", text: "done" },
  };

  const event = publishRealtimePayload({
    payload,
    rawListeners: [(next) => raw.push(next)],
    canonicalListeners: [(next) => canonical.push(next)],
  });

  assert.deepEqual(raw, [payload]);
  assert.deepEqual(canonical, [payload.event]);
  assert.deepEqual(event, payload.event);
});

test("operator realtime incoming only fans out raw listeners for non-canonical payloads", () => {
  const raw = [];
  const canonical = [];
  const payload = { type: "work_event", item: "tool" };

  const event = publishRealtimePayload({
    payload,
    rawListeners: [(next) => raw.push(next)],
    canonicalListeners: [(next) => canonical.push(next)],
  });

  assert.deepEqual(raw, [payload]);
  assert.deepEqual(canonical, []);
  assert.equal(event, null);
});
