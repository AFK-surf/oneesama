import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  injectWorkerResultIntoActive,
  readMeetChatFromActive,
  requestRealtimeTextTurnFromActive,
  sendRealtimeEventToActive,
  sendMeetChatFromActive,
} from "../packages/core/src/meeting/google-meet-joiner-realtime-control.ts";

function activeWithWindow(windowValue) {
  return {
    page: {
      isClosed: () => false,
      evaluate: async (fn, payload) => {
        const previousWindow = globalThis.window;
        globalThis.window = windowValue;
        try {
          return await fn(payload);
        } finally {
          globalThis.window = previousWindow;
        }
      },
    },
  };
}

function pageWithWindow(windowValue) {
  return {
    isClosed: () => false,
    evaluate: async (fn, payload) => {
      const previousWindow = globalThis.window;
      globalThis.window = windowValue;
      try {
        return await fn(payload);
      } finally {
        globalThis.window = previousWindow;
      }
    },
  };
}

function activeWithSidecarRealtimeClient(client, meetWindow = {}) {
  return {
    page: pageWithWindow(meetWindow),
    realtimeSidecarPage: pageWithWindow({ MAB_REALTIME_CLIENT: client }),
  };
}

test("Google Meet joiner worker-result injection does not fall back to DOM custom events", async () => {
  let refreshed = false;
  const result = await injectWorkerResultIntoActive(
    activeWithSidecarRealtimeClient({}),
    {
      id: "job_missing_client_api",
      status: "completed",
      context: { meeting_session_id: "session_test" },
    },
    async () => {
      refreshed = true;
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "realtime_worker_result_client_missing");
  assert.equal(refreshed, true);
});

test("Google Meet joiner worker-result injection still uses the realtime client API", async () => {
  let injected = null;
  const result = await injectWorkerResultIntoActive(
    activeWithSidecarRealtimeClient({
      injectWorkerResult: async (payload) => {
        injected = payload;
        return { ok: true, jobId: payload.id };
      },
    }),
    {
      id: "job_client_api",
      status: "completed",
      context: { meeting_session_id: "session_test" },
    },
    async () => {},
  );

  assert.equal(result.ok, true);
  assert.equal(result.channel, "MAB_REALTIME_CLIENT.injectWorkerResult");
  assert.equal(result.delivery.ok, true);
  assert.equal(injected.id, "job_client_api");
});

test("Google Meet joiner worker-result injection ignores removed sendWorkerResult alias", async () => {
  let called = false;
  const result = await injectWorkerResultIntoActive(
    activeWithSidecarRealtimeClient({
      sendWorkerResult: async () => {
        called = true;
        return { ok: true };
      },
    }),
    {
      id: "job_legacy_alias",
      status: "completed",
      context: { meeting_session_id: "session_test" },
    },
    async () => {},
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "realtime_worker_result_client_missing");
  assert.equal(called, false);
});

test("Google Meet joiner worker-result injection does not count browser suppression as delivery", async () => {
  const result = await injectWorkerResultIntoActive(
    activeWithSidecarRealtimeClient({
      injectWorkerResult: async () => ({
        suppressed: true,
        reason: "worker_result_session_missing",
      }),
    }),
    {
      id: "job_suppressed_client_api",
      status: "completed",
      context: { session_kind: "meeting_copilot" },
    },
    async () => {},
  );

  assert.equal(result.ok, false);
  assert.equal(result.suppressed, true);
  assert.equal(result.reason, "worker_result_session_missing");
  assert.equal(result.channel, "MAB_REALTIME_CLIENT.injectWorkerResult");
});

test("Google Meet joiner sends realtime control events through the allowlisted API", async () => {
  let sent = null;
  const result = await sendRealtimeEventToActive(
    activeWithSidecarRealtimeClient({
      sendRealtimeControlEvent: (event) => {
        sent = event;
        return "control-event";
      },
    }),
    { type: "response.cancel", reason: "manual" },
    async () => {},
  );

  assert.equal(result.ok, true);
  assert.equal(result.channel, "control-event");
  assert.deepEqual(sent, { type: "response.cancel", reason: "manual" });
});

test("Google Meet joiner does not fall back to public raw realtime event sends", async () => {
  const result = await sendRealtimeEventToActive(
    activeWithSidecarRealtimeClient({
      sendRealtimeEvent: () => "legacy-raw-event",
    }),
    { type: "conversation.item.create" },
    async () => {},
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "realtime_control_event_api_missing");
});

test("Google Meet joiner reports browser control-event rejection as failure", async () => {
  const result = await sendRealtimeEventToActive(
    activeWithSidecarRealtimeClient({
      sendRealtimeControlEvent: () => "realtime-control-event-not-allowed",
    }),
    { type: "conversation.item.create" },
    async () => {},
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "realtime_event_type_not_allowed");
  assert.equal(result.channel, "realtime-control-event-not-allowed");
});

test("Google Meet joiner can send synthetic transcription events through control API", async () => {
  let sent = null;
  const result = await sendRealtimeEventToActive(
    activeWithSidecarRealtimeClient({
      sendRealtimeControlEvent: (payload) => {
        sent = payload;
        return "trusted-control-event";
      },
    }),
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "synthetic_item",
      transcript: "Codex build Gomoku web game with sync",
    },
    async () => {},
  );

  assert.equal(result.ok, true);
  assert.equal(result.channel, "trusted-control-event");
  assert.deepEqual(sent, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "synthetic_item",
    transcript: "Codex build Gomoku web game with sync",
  });
});

test("Google Meet joiner reports empty synthetic transcription rejection", async () => {
  const result = await sendRealtimeEventToActive(
    activeWithSidecarRealtimeClient({
      sendRealtimeControlEvent: () => "realtime-control-event-not-allowed",
    }),
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "synthetic_item",
    },
    async () => {},
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "realtime_event_type_not_allowed");
});

test("Google Meet joiner sends realtime text turns through the sidecar page", async () => {
  let request = null;
  const result = await requestRealtimeTextTurnFromActive(
    activeWithSidecarRealtimeClient({
      requestRealtimeTextTurn: (payload) => {
        request = payload;
        return { ok: true, channel: "sidecar-text-turn" };
      },
    }),
    { text: "请共享 Chrome", instructions: "call tool" },
    async () => {},
  );

  assert.equal(result.ok, true);
  assert.equal(result.channel, "sidecar-text-turn");
  assert.deepEqual(request, { text: "请共享 Chrome", instructions: "call tool" });
});

test("Google Meet joiner Meet chat uses the Meet surface tool port", async () => {
  const calls = [];
  const active = activeWithWindow({
    MAB_MEET_SURFACE_TOOLS: {
      run: async (name, payload) => {
        calls.push({ name, payload });
        return { ok: true, name, payload };
      },
    },
    MAB_REALTIME_CLIENT: {
      runLocalMeetTool: async () => {
        throw new Error("legacy realtime client local meet tool should not run");
      },
    },
  });

  const sent = await sendMeetChatFromActive(active, { text: "hello" }, async () => {});
  const read = await readMeetChatFromActive(active, { limit: 3, onlyLinks: true }, async () => {});

  assert.equal(sent.ok, true);
  assert.equal(read.ok, true);
  assert.deepEqual(calls, [
    { name: "send_meet_chat", payload: { text: "hello" } },
    { name: "read_meet_chat", payload: { limit: 3, onlyLinks: true } },
  ]);
});

test("Google Meet joiner Meet chat does not fall back to realtime client local tools", async () => {
  const active = activeWithWindow({
    MAB_REALTIME_CLIENT: {
      runLocalMeetTool: async () => ({ ok: true, legacy: true }),
    },
  });

  const sent = await sendMeetChatFromActive(active, { text: "hello" }, async () => {});
  const read = await readMeetChatFromActive(active, {}, async () => {});

  assert.equal(sent.ok, false);
  assert.equal(sent.error, "meet_chat_bridge_missing");
  assert.equal(read.ok, false);
  assert.equal(read.error, "meet_chat_bridge_missing");
});

test("Google Meet joiner realtime controls do not fall back to Meet page clients", async () => {
  let legacyEventCalled = false;
  let legacyWorkerCalled = false;
  const active = activeWithWindow({
    MAB_REALTIME_CLIENT: {
      sendRealtimeControlEvent: () => {
        legacyEventCalled = true;
        return "legacy-meet-page-event";
      },
      injectWorkerResult: async () => {
        legacyWorkerCalled = true;
        return { ok: true };
      },
    },
  });

  const event = await sendRealtimeEventToActive(
    active,
    { type: "response.cancel" },
    async () => {},
  );
  const worker = await injectWorkerResultIntoActive(
    active,
    { id: "job_meet_page_client", status: "completed" },
    async () => {},
  );

  assert.equal(event.ok, false);
  assert.equal(event.error, "realtime_sidecar_page_missing");
  assert.equal(worker.ok, false);
  assert.equal(worker.error, "realtime_sidecar_page_missing");
  assert.equal(legacyEventCalled, false);
  assert.equal(legacyWorkerCalled, false);
});

test("Google Meet joiner realtime text turns do not fall back to Meet page clients", async () => {
  let legacyTextTurnCalled = false;
  const result = await requestRealtimeTextTurnFromActive(
    activeWithWindow({
      MAB_REALTIME_CLIENT: {
        requestRealtimeTextTurn: () => {
          legacyTextTurnCalled = true;
          return { ok: true };
        },
      },
    }),
    { text: "hello" },
    async () => {},
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "realtime_sidecar_page_missing");
  assert.equal(legacyTextTurnCalled, false);
});

test("Google Meet joiner realtime controls reject closed sidecar pages", async () => {
  const active = {
    page: pageWithWindow({}),
    realtimeSidecarPage: {
      isClosed: () => true,
      evaluate: async () => {
        throw new Error("closed sidecar should not be evaluated");
      },
    },
  };

  const result = await sendRealtimeEventToActive(
    active,
    { type: "response.cancel" },
    async () => {},
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "realtime_sidecar_page_missing");
});

test("Google Meet joiner Meet chat ignores sidecar realtime local meet tools", async () => {
  const active = activeWithSidecarRealtimeClient({
    runLocalMeetTool: async () => ({ ok: true, legacy: true }),
  });

  const sent = await sendMeetChatFromActive(active, { text: "hello" }, async () => {});
  const read = await readMeetChatFromActive(active, {}, async () => {});

  assert.equal(sent.ok, false);
  assert.equal(sent.error, "meet_chat_bridge_missing");
  assert.equal(read.ok, false);
  assert.equal(read.error, "meet_chat_bridge_missing");
});
