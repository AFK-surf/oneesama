import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  RENDERED_REALTIME_EVENT_LIMIT,
  canonicalEventFromPayload,
  foldRealtimePayload,
  initialRealtimeViewState,
  realtimeConnectRequested,
  realtimeSocketClosed,
  realtimeSocketOpened,
} from "../packages/core/src/operator/web/realtimeState.ts";

test("operator realtime state tracks socket and connect-request view state", () => {
  const initial = initialRealtimeViewState("openai_realtime");
  assert.deepEqual(initial, {
    wsOpen: false,
    status: "not_connected",
    transport: "openai_realtime",
    events: [],
    error: "",
  });

  const opened = realtimeSocketOpened(initial);
  assert.equal(opened.wsOpen, true);

  const connecting = realtimeConnectRequested({
    ...opened,
    status: "failed",
    error: "engine_down",
  });
  assert.equal(connecting.status, "connecting");
  assert.equal(connecting.error, "");

  const closed = realtimeSocketClosed(connecting);
  assert.equal(closed.wsOpen, false);
});

test("operator realtime state folds canonical events and engine errors", () => {
  const state = initialRealtimeViewState();
  const withTranscript = foldRealtimePayload(state, {
    type: "canonical_conversation_event",
    event: { type: "transcript_completed", text: "hello" },
  });
  assert.equal(withTranscript.events.length, 1);
  assert.equal(withTranscript.events[0].type, "transcript_completed");
  assert.equal(withTranscript.events[0].text, "hello");

  const failed = foldRealtimePayload(withTranscript, {
    type: "canonical_conversation_event",
    event: { type: "engine_error", error: "engine_down" },
  });
  assert.equal(failed.events.length, 2);
  assert.equal(failed.error, "engine_down");
});

test("operator realtime state keeps assistant audio chunks out of rendered events", () => {
  const before = initialRealtimeViewState();
  const after = foldRealtimePayload(before, {
    type: "canonical_conversation_event",
    event: { type: "assistant_audio_chunk", audioBase64: "AAAA" },
    debug: {
      conversation: {
        status: "connected",
        provider: { adapterKind: "openai_realtime" },
      },
    },
  });
  assert.equal(after.events.length, 0);
  assert.equal(after.status, "connected");
  assert.equal(after.transport, "openai_realtime");
});

test("operator realtime state caps rendered canonical events", () => {
  let state = initialRealtimeViewState();
  for (let index = 0; index < RENDERED_REALTIME_EVENT_LIMIT + 5; index += 1) {
    state = foldRealtimePayload(state, {
      type: "canonical_conversation_event",
      event: { type: "assistant_text_delta", text: String(index) },
    });
  }

  assert.equal(state.events.length, RENDERED_REALTIME_EVENT_LIMIT);
  assert.equal(state.events[0].text, "5");
  assert.equal(state.events.at(-1)?.text, String(RENDERED_REALTIME_EVENT_LIMIT + 4));
});

test("operator realtime state parses canonical event envelopes", () => {
  assert.equal(canonicalEventFromPayload({ type: "work_event" }), null);
  assert.equal(canonicalEventFromPayload({ type: "canonical_conversation_event" }), null);
  assert.deepEqual(
    canonicalEventFromPayload({
      type: "canonical_conversation_event",
      event: { type: "assistant_text_completed", responseId: "r1", text: "done" },
    }),
    { type: "assistant_text_completed", responseId: "r1", text: "done" },
  );
});
