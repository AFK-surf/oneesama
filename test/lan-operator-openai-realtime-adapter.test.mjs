import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import {
  createOpenAIRealtimeConversationEngine,
  createOpenAIRealtimeEventMapper,
  createOpenAIRealtimeWebSocketTransport,
} from "../packages/core/src/operator/lan-operator-openai-realtime-adapter.ts";
import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";

class FakeRealtimeWebSocket {
  constructor(url, init = {}) {
    this.url = url;
    this.init = init;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    queueMicrotask(() => this.open());
  }

  on(event, handler) {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  once(event, handler) {
    const wrapped = (...args) => {
      handler(...args);
      this.listeners.set(
        event,
        (this.listeners.get(event) || []).filter((candidate) => candidate !== wrapped),
      );
    };
    return this.on(event, wrapped);
  }

  emit(event, ...args) {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  send(payload) {
    const event = JSON.parse(payload);
    this.sent.push(event);
    if (event.type === "session.update") {
      this.emit(
        "message",
        JSON.stringify({ type: "session.created", session: { id: "sess_live_fake" } }),
      );
    }
    if (event.type === "input_audio_buffer.append") {
      this.emit(
        "message",
        JSON.stringify({ type: "input_audio_buffer.speech_started", event_id: "evt_live_speech" }),
      );
      this.emit(
        "message",
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          event_id: "evt_live_transcript",
          transcript: "hello",
        }),
      );
    }
    if (event.type === "response.cancel") {
      this.emit(
        "message",
        JSON.stringify({ type: "response.cancelled", event_id: "evt_live_cancel" }),
      );
    }
    if (event.type === "response.create") {
      this.emit(
        "message",
        JSON.stringify({
          type: "response.output_text.done",
          event_id: "evt_live_text_done",
          response_id: "resp_live_text",
          text: "typed ok",
        }),
      );
    }
  }

  close(code, reason) {
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit("close", code, reason);
  }
}

async function waitForRuntimeStatus(url, predicate, timeoutMs = 5_000) {
  const statusUrl = new URL("/runtime/status", url);
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(statusUrl)).json();
    lastBody = body;
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime_status_timeout: ${JSON.stringify(lastBody)}`);
}

test("OpenAI Realtime mapper emits canonical conversation events without raw event leakage", () => {
  const mapper = createOpenAIRealtimeEventMapper({
    engineId: "openai_realtime_test",
    sessionId: "lan-realtime-map-test",
    now: () => "2026-06-05T00:00:00.000Z",
  });
  const events = [
    { type: "session.created", event_id: "evt_session", session: { id: "sess_provider" } },
    { type: "input_audio_buffer.speech_started", event_id: "evt_speech" },
    {
      type: "conversation.item.input_audio_transcription.delta",
      event_id: "evt_transcript_delta",
      item_id: "input_item",
      delta: "turn",
    },
    {
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "evt_transcript_done",
      item_id: "input_item",
      transcript: "turn on the light",
    },
    { type: "input_audio_buffer.speech_stopped", event_id: "evt_speech_stopped" },
    {
      type: "response.output_text.delta",
      event_id: "evt_text_delta",
      response_id: "resp_1",
      delta: "ok",
    },
    {
      type: "response.output_text.done",
      event_id: "evt_text_done",
      response_id: "resp_1",
      text: "ok",
    },
    {
      type: "response.output_audio.delta",
      event_id: "evt_audio_1",
      response_id: "resp_1",
      item_id: "audio_item",
      delta: "AAAA",
    },
    {
      type: "response.output_audio.delta",
      event_id: "evt_audio_2",
      response_id: "resp_1",
      item_id: "audio_item",
      delta: "BBBB",
    },
    { type: "response.output_audio.done", event_id: "evt_audio_done", response_id: "resp_1" },
    {
      type: "conversation.item.created",
      event_id: "evt_tool_started",
      item: {
        id: "tool_call_item",
        type: "function_call",
        call_id: "call_1",
        name: "kwwk_computer_use",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      event_id: "evt_tool_delta",
      response_id: "resp_1",
      call_id: "call_1",
      name: "kwwk_computer_use",
      delta: '{"instruction"',
    },
    {
      type: "response.function_call_arguments.done",
      event_id: "evt_tool_done",
      response_id: "resp_1",
      call_id: "call_1",
      name: "kwwk_computer_use",
      arguments: '{"instruction":"switch tabs"}',
    },
    {
      type: "conversation.item.created",
      event_id: "evt_tool_result",
      item: { id: "tool_result_item", type: "function_call_output", call_id: "call_1" },
    },
    {
      type: "response.cancelled",
      event_id: "evt_cancel",
      response_id: "resp_1",
      reason: "turn_detected",
    },
    { type: "error", event_id: "evt_error", error: { message: "provider down" } },
  ].flatMap((event) => mapper(event));

  const eventTypes = events.map((event) => event.type);
  assert.deepEqual(eventTypes, [
    "engine_connected",
    "speech_started",
    "transcript_delta",
    "transcript_completed",
    "speech_stopped",
    "assistant_text_delta",
    "assistant_text_completed",
    "assistant_audio_started",
    "assistant_audio_chunk",
    "assistant_audio_chunk",
    "assistant_audio_stopped",
    "tool_call_started",
    "tool_call_delta",
    "tool_call_completed",
    "tool_result_accepted",
    "interrupted",
    "engine_error",
  ]);
  assert.equal(events.filter((event) => event.type === "assistant_audio_started").length, 1);
  assert.equal(
    events.find((event) => event.type === "transcript_completed").text,
    "turn on the light",
  );
  assert.equal(events.find((event) => event.type === "assistant_audio_chunk").audioBase64, "AAAA");
  assert.equal(
    events.find((event) => event.type === "tool_call_completed").detail.callId,
    "call_1",
  );
  assert.equal(
    events.find((event) => event.type === "tool_call_completed").detail.expectedTool,
    "kwwk_computer_use",
  );
  assert.equal(events.find((event) => event.type === "engine_error").error, "provider down");
  for (const event of events) {
    assert.equal(event.sessionId, "lan-realtime-map-test");
    assert.equal(event.engineId, "openai_realtime_test");
    assert.equal(event.detail.provider, "openai_realtime");
    assert.ok(event.detail.providerEventType);
    assert.equal("rawEvent" in event.detail, false);
    assert.equal("providerRawEvent" in event.detail, false);
  }
});

test("OpenAI Realtime mapper preserves expected tool for response.done function-call output", () => {
  const mapper = createOpenAIRealtimeEventMapper({
    engineId: "openai_realtime_done_test",
    sessionId: "lan-realtime-done-test",
    now: () => "2026-06-05T00:00:00.000Z",
  });
  const events = mapper({
    type: "response.done",
    event_id: "evt_response_done_tool",
    response: {
      id: "resp_done_tool",
      output: [
        {
          id: "item_done_tool",
          type: "function_call",
          call_id: "call_done_tool",
          name: "kwwk_computer_use",
          arguments: '{"instruction":"switch tabs","applicationName":"Chrome"}',
        },
      ],
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool_call_completed");
  assert.equal(events[0].detail.name, "kwwk_computer_use");
  assert.equal(events[0].detail.expectedTool, "kwwk_computer_use");
  assert.equal(events[0].detail.callId, "call_done_tool");
});

test("OpenAI Realtime WebSocket transport uses GA wire shape for LAN audio chunks", async () => {
  const sockets = [];
  const transport = createOpenAIRealtimeWebSocketTransport({
    apiKey: "sk-test",
    model: "gpt-realtime-2",
    safetyIdentifier: "operator-test-user",
    drainMs: 0,
    session: {
      instructions: "LAN operator smoke",
    },
    response: {
      output_modalities: ["text"],
    },
    webSocketFactory: (url, init) => {
      const socket = new FakeRealtimeWebSocket(url, init);
      sockets.push(socket);
      return socket;
    },
  });

  const connectOutput = await transport.connect("lan-live-transport-test");
  const audioOutput = await transport.sendAudioChunk({
    sessionId: "lan-live-transport-test",
    sequence: 7,
    source: "synthetic_pcm16",
    sampleRate: 24000,
    channels: 1,
    durationMs: 20,
    energy: 0.42,
    monotonicMs: 123,
    sentAt: "2026-06-05T00:00:00.000Z",
    receivedAt: "2026-06-05T00:00:00.012Z",
    receiveLagMs: 12,
    dataBase64: "AAAA",
  });
  const controlOutput = await transport.sendControlEvent(
    { type: "response.cancel", response_id: "resp_1" },
    { type: "cancel_response", sessionId: "lan-live-transport-test", responseId: "resp_1" },
  );
  const textOutput = await transport.sendTextInput({
    id: "text_live_transport",
    ts: "2026-06-05T00:00:00.000Z",
    sessionId: "lan-live-transport-test",
    text: "typed debug hello",
    source: "operator_text_input",
    monotonicMs: 123,
    surfaceContext: { focusedSourceId: "host-app" },
  });
  const toolResultOutput = await transport.sendToolResult({
    id: "tool_result_live_transport",
    ts: "2026-06-05T00:00:01.000Z",
    sessionId: "lan-live-transport-test",
    callId: "call_live_tool",
    toolName: "kwwk_computer_use",
    status: "completed",
    output: { ok: true, jobId: "kwwk_live_job" },
    source: "kwwk",
  });

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "wss://api.openai.com/v1/realtime?model=gpt-realtime-2");
  assert.equal(sockets[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(sockets[0].init.headers["OpenAI-Safety-Identifier"], "operator-test-user");
  assert.equal("OpenAI-Beta" in sockets[0].init.headers, false);
  assert.deepEqual(
    sockets[0].sent.map((event) => event.type),
    [
      "session.update",
      "input_audio_buffer.append",
      "response.cancel",
      "conversation.item.create",
      "response.create",
      "conversation.item.create",
      "response.create",
    ],
  );
  assert.equal(sockets[0].sent[0].session.type, "realtime");
  assert.equal(sockets[0].sent[0].session.instructions, "LAN operator smoke");
  assert.equal(sockets[0].sent[1].audio, "AAAA");
  assert.equal(sockets[0].sent[3].item.role, "user");
  assert.equal(sockets[0].sent[3].item.content[0].type, "input_text");
  assert.equal(sockets[0].sent[3].item.content[0].text, "typed debug hello");
  assert.deepEqual(sockets[0].sent[4].response.output_modalities, ["text"]);
  assert.equal(sockets[0].sent[5].item.type, "function_call_output");
  assert.equal(sockets[0].sent[5].item.call_id, "call_live_tool");
  assert.equal(
    sockets[0].sent[5].item.output,
    JSON.stringify({ ok: true, jobId: "kwwk_live_job" }),
  );
  assert.deepEqual(sockets[0].sent[6].response.output_modalities, ["text"]);
  assert.equal(connectOutput.ok, true);
  assert.equal(audioOutput.ok, true);
  assert.equal(controlOutput.ok, true);
  assert.equal(textOutput.ok, true);
  assert.equal(toolResultOutput.ok, true);
  assert.ok(connectOutput.events.some((event) => event.type === "session.created"));
  assert.ok(audioOutput.events.some((event) => event.type === "input_audio_buffer.speech_started"));
  assert.ok(controlOutput.events.some((event) => event.type === "response.cancelled"));
  assert.ok(textOutput.events.some((event) => event.type === "response.output_text.done"));
  assert.ok(toolResultOutput.events.some((event) => event.type === "response.output_text.done"));
});

test("OpenAI Realtime WebSocket transport can attach an HTTP CONNECT proxy agent", async () => {
  const proxiedSockets = [];
  const proxiedTransport = createOpenAIRealtimeWebSocketTransport({
    apiKey: "sk-test",
    proxyUrl: "http://127.0.0.1:6152",
    drainMs: 0,
    webSocketFactory: (url, init) => {
      const socket = new FakeRealtimeWebSocket(url, init);
      proxiedSockets.push(socket);
      return socket;
    },
  });
  const directSockets = [];
  const directTransport = createOpenAIRealtimeWebSocketTransport({
    apiKey: "sk-test",
    proxyUrl: false,
    drainMs: 0,
    webSocketFactory: (url, init) => {
      const socket = new FakeRealtimeWebSocket(url, init);
      directSockets.push(socket);
      return socket;
    },
  });

  await proxiedTransport.connect("lan-live-proxy-test");
  await directTransport.connect("lan-live-direct-test");

  assert.equal(proxiedSockets.length, 1);
  assert.equal(typeof proxiedSockets[0].init.agent, "object");
  assert.equal(directSockets.length, 1);
  assert.equal("agent" in directSockets[0].init, false);
});

test("OpenAI Realtime engine can drain provider events after audio forwarding settles", async () => {
  const queuedEvents = [];
  const controlEvents = [];
  const conversationEngine = createOpenAIRealtimeConversationEngine({
    engineId: "openai_realtime_drain_test",
    transport: {
      connect: () => ({
        ok: true,
        events: [
          { type: "session.created", event_id: "evt_drain_session", session: { id: "sess_drain" } },
        ],
      }),
      sendAudioChunk: () => {
        queuedEvents.push(
          {
            type: "conversation.item.input_audio_transcription.completed",
            event_id: "evt_drain_transcript",
            transcript: "voice live ok",
          },
          {
            type: "response.output_text.done",
            event_id: "evt_drain_text",
            response_id: "resp_drain_text",
            text: "voice live ok",
          },
        );
        return { ok: true, events: [] };
      },
      sendControlEvent: (event, command) => {
        controlEvents.push({ event, command });
        return { ok: true, control: command.type, events: queuedEvents.splice(0) };
      },
    },
  });

  const voiceOutput = await conversationEngine.receiveVoiceChunk({
    sessionId: "lan-openai-drain-test",
    sequence: 1,
    source: "synthetic_pcm16",
    sampleRate: 24000,
    channels: 1,
    durationMs: 20,
    energy: 0.2,
    monotonicMs: 123,
    sentAt: "2026-06-05T00:00:00.000Z",
    receivedAt: "2026-06-05T00:00:00.012Z",
    receiveLagMs: 12,
    dataBase64: "AAAA",
  });
  const drainOutput = await conversationEngine.control({
    id: "control_drain_provider_events",
    ts: "2026-06-05T00:00:01.000Z",
    sessionId: "lan-openai-drain-test",
    type: "drain_events",
    reason: "test_event_pump",
  });

  assert.equal(voiceOutput.result.ok, true);
  assert.deepEqual(
    drainOutput.events.map((event) => event.type),
    ["transcript_completed", "assistant_text_completed"],
  );
  assert.equal(drainOutput.events[0].text, "voice live ok");
  assert.equal(drainOutput.events[1].text, "voice live ok");
  assert.equal(controlEvents.length, 1);
  assert.equal(controlEvents[0].command.type, "drain_events");
  assert.equal(controlEvents[0].event.type, "session.drain_events");
});

test("OpenAI Realtime engine reports connect failures instead of fake connected state", async () => {
  const conversationEngine = createOpenAIRealtimeConversationEngine({
    engineId: "openai_realtime_missing_key_test",
    transport: createOpenAIRealtimeWebSocketTransport({
      apiKey: "",
      webSocketFactory: () => {
        throw new Error("websocket_should_not_start_without_key");
      },
    }),
  });

  const output = await conversationEngine.receiveVoiceChunk({
    sessionId: "lan-openai-missing-key",
    sequence: 1,
    source: "synthetic_pcm16",
    sampleRate: 24000,
    channels: 1,
    durationMs: 20,
    energy: 0.2,
    monotonicMs: 123,
    sentAt: "2026-06-05T00:00:00.000Z",
    receivedAt: "2026-06-05T00:00:00.012Z",
    receiveLagMs: 12,
    dataBase64: "AAAA",
  });

  assert.equal(output.result.ok, false);
  assert.equal(output.result.error, "openai_realtime_api_key_missing");
  assert.deepEqual(
    output.events.map((event) => event.type),
    ["engine_error"],
  );
  assert.equal(output.events[0].error, "openai_realtime_api_key_missing");
});

test("OpenAI Realtime engine treats provider error events during connect as failed", async () => {
  const conversationEngine = createOpenAIRealtimeConversationEngine({
    engineId: "openai_realtime_provider_error_test",
    transport: {
      id: "provider_error_transport",
      connect: () => ({
        ok: true,
        events: [
          {
            type: "error",
            event_id: "evt_provider_error",
            error: { message: "Incorrect API key provided: sk-proj-********abcd." },
          },
        ],
      }),
    },
  });

  const output = await conversationEngine.control({
    id: "control_connect_provider_error",
    ts: "2026-06-05T00:00:00.000Z",
    sessionId: "lan-openai-provider-error",
    type: "connect",
    reason: "test",
  });

  assert.equal(output.result.ok, false);
  assert.equal(output.result.error, "openai_realtime_transport_connect_failed");
  assert.deepEqual(
    output.events.map((event) => event.type),
    ["engine_error"],
  );
  assert.match(output.events[0].error, /redacted_openai_api_key/);
  assert.doesNotMatch(output.events[0].error, /sk-proj/);
});

test("OpenAI Realtime engine accepts typed text input through the Conversation Engine Port", async () => {
  const textInputs = [];
  const conversationEngine = createOpenAIRealtimeConversationEngine({
    engineId: "openai_realtime_text_test",
    transport: {
      connect: () => ({
        ok: true,
        events: [
          { type: "session.created", event_id: "evt_text_session", session: { id: "sess_text" } },
        ],
      }),
      sendTextInput: (input) => {
        textInputs.push(input);
        return {
          ok: true,
          events: [
            {
              type: "response.output_text.done",
              event_id: "evt_text_done",
              response_id: "resp_text",
              text: "typed response",
            },
          ],
        };
      },
    },
  });

  const output = await conversationEngine.receiveTextInput({
    id: "text_engine_input",
    ts: "2026-06-05T00:00:00.000Z",
    sessionId: "lan-openai-text-engine",
    text: "typed debug hello",
    source: "operator_text_input",
    monotonicMs: 123,
    surfaceContext: { focusedSourceId: "host-app" },
  });

  assert.equal(output.result.ok, true);
  assert.equal(textInputs.length, 1);
  assert.deepEqual(
    output.events.map((event) => event.type),
    ["transcript_completed", "engine_connected", "assistant_text_completed"],
  );
  assert.equal(output.events[0].text, "typed debug hello");
  assert.equal(output.events[0].detail.inputMode, "text");
  assert.deepEqual(output.events[0].detail.surfaceContext, { focusedSourceId: "host-app" });
  assert.equal(output.events[2].text, "typed response");
  assert.equal(output.events[2].detail.providerEventType, "response.output_text.done");
});

test("OpenAI Realtime engine accepts KWWK tool results through the Conversation Engine Port", async () => {
  const toolResults = [];
  const conversationEngine = createOpenAIRealtimeConversationEngine({
    engineId: "openai_realtime_tool_result_test",
    transport: {
      connect: () => ({
        ok: true,
        events: [
          {
            type: "session.created",
            event_id: "evt_tool_result_session",
            session: { id: "sess_tool_result" },
          },
        ],
      }),
      sendToolResult: (input) => {
        toolResults.push(input);
        return {
          ok: true,
          events: [
            {
              type: "response.output_text.done",
              event_id: "evt_tool_result_done",
              response_id: "resp_tool_result",
              text: "done",
            },
          ],
        };
      },
    },
  });

  const output = await conversationEngine.receiveToolResult({
    id: "tool_result_engine_input",
    ts: "2026-06-05T00:00:02.000Z",
    sessionId: "lan-openai-tool-result-engine",
    callId: "call_tool_result_engine",
    turnId: "turn_tool_result_engine",
    responseId: "response_tool_result_engine",
    toolName: "kwwk_computer_use",
    jobId: "kwwk_tool_result_job",
    status: "completed",
    output: { ok: true, status: "completed" },
    source: "kwwk",
    surfaceContext: { focusedSourceId: "host-app" },
  });

  assert.equal(output.result.ok, true);
  assert.equal(toolResults.length, 1);
  assert.deepEqual(
    output.events.map((event) => event.type),
    ["tool_result_accepted", "engine_connected", "assistant_text_completed"],
  );
  assert.equal(output.events[0].detail.callId, "call_tool_result_engine");
  assert.equal(output.events[0].detail.inputMode, "tool_result");
  assert.deepEqual(output.events[0].detail.surfaceContext, { focusedSourceId: "host-app" });
  assert.equal(output.events[2].text, "done");
});

test("OpenAI Realtime adapter feeds canonical events into LAN operator Debug Panel", async () => {
  const chunks = [];
  const conversationEngine = createOpenAIRealtimeConversationEngine({
    engineId: "openai_realtime_surface_test",
    transport: {
      id: "mock_openai_realtime_transport",
      connect: () => ({
        ok: true,
        events: [
          { type: "session.created", event_id: "evt_session", session: { id: "sess_debug" } },
        ],
      }),
      sendAudioChunk: (chunk) => {
        chunks.push(chunk);
        return {
          ok: true,
          events: [
            { type: "input_audio_buffer.speech_started", event_id: "evt_speech" },
            {
              type: "conversation.item.input_audio_transcription.completed",
              event_id: "evt_transcript",
              item_id: "input_item",
              transcript: "switch to the first tab",
            },
            {
              type: "conversation.item.created",
              event_id: "evt_tool_started",
              item: {
                id: "tool_call_item",
                type: "function_call",
                call_id: "call_debug_tool",
                name: "kwwk_computer_use",
              },
            },
            {
              type: "response.function_call_arguments.done",
              event_id: "evt_tool_done",
              response_id: "resp_debug",
              call_id: "call_debug_tool",
              name: "kwwk_computer_use",
              arguments:
                '{"instruction":"switch to the first browser tab","applicationName":"Chrome","windowTitle":"LAN fixture"}',
            },
            {
              type: "response.output_text.delta",
              event_id: "evt_text",
              response_id: "resp_debug",
              delta: "Switching",
            },
            {
              type: "response.output_audio.delta",
              event_id: "evt_audio",
              response_id: "resp_debug",
              item_id: "audio_item",
              delta: "AAAA",
            },
            { type: "response.cancelled", event_id: "evt_cancel", response_id: "resp_debug" },
          ],
        };
      },
    },
  });
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-openai-adapter-smoke",
    botName: "LAN Oneesama",
    conversationEngine,
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({
        sequence: 1,
        sampleRate: 24000,
        channels: 1,
        durationMs: 20,
        energy: 0.33,
      }),
    );

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.conversation.eventCounts.engine_connected >= 1 &&
        nextBody.debug.conversation.eventCounts.speech_started >= 1 &&
        nextBody.debug.conversation.eventCounts.transcript_completed >= 1 &&
        nextBody.debug.conversation.eventCounts.tool_call_completed >= 1 &&
        nextBody.debug.conversation.eventCounts.assistant_audio_chunk >= 1 &&
        nextBody.debug.conversation.eventCounts.interrupted >= 1 &&
        nextBody.debug.output.assistantText.deltaCount >= 1 &&
        nextBody.debug.output.assistantAudio.chunksReceived >= 1 &&
        nextBody.debug.toolRouting.argumentSafety.ok === true,
    );
    const clientCanonicalEvents = await page.evaluate(
      () => window.MAB_LAN_OPERATOR_SURFACE.state.canonicalEvents || [],
    );

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].source, "synthetic_pcm16");
    assert.equal(body.debug.conversation.engineId, "openai_realtime_surface_test");
    assert.equal(body.debug.conversation.status, "connected");
    assert.equal(body.debug.conversation.eventCounts.assistant_audio_started, 1);
    assert.equal(body.debug.conversation.eventCounts.assistant_audio_chunk, 1);
    assert.equal(body.debug.toolRouting.expectedTool, "kwwk_computer_use");
    assert.equal(body.debug.toolRouting.actualTool, "kwwk_computer_use");
    assert.equal(body.debug.toolRouting.argumentSafety.safeTargetHint, true);
    assert.equal(body.debug.toolRouting.argumentSafety.exposesRawOperations, false);
    assert.equal(body.debug.output.assistantText.currentText, "Switching");
    assert.ok(["playing", "stopped"].includes(body.debug.output.assistantAudio.status));
    assert.equal(body.debug.output.assistantAudio.chunksReceived, 1);
    assert.equal(body.debug.output.assistantAudio.chunksPlayed, 1);
    assert.ok(body.debug.output.assistantAudio.bytesReceived > 0);
    assert.equal(body.debug.output.assistantAudio.sampleRate, 24000);
    assert.equal(body.debug.output.assistantAudio.channels, 1);
    assert.ok(
      body.debug.conversation.canonicalEvents.every((event) => !event.type.includes(".")),
      JSON.stringify(body.debug.conversation.canonicalEvents),
    );
    assert.ok(
      body.debug.conversation.canonicalEvents.some(
        (event) => event.detail.providerEventType === "response.output_audio.delta",
      ),
      JSON.stringify(body.debug.conversation.canonicalEvents),
    );
    assert.equal(
      body.debug.conversation.canonicalEvents.some((event) => event.detail.rawEvent),
      false,
    );
    assert.ok(clientCanonicalEvents.some((event) => event.type === "interrupted"));
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator engine controls route through the OpenAI Realtime adapter", async () => {
  const controlEvents = [];
  const lifecycleEvents = [];
  const conversationEngine = createOpenAIRealtimeConversationEngine({
    engineId: "openai_realtime_control_test",
    transport: {
      connect: (sessionId) => {
        lifecycleEvents.push({ type: "connect", sessionId });
        return { events: [{ type: "session.created", event_id: "evt_control_session" }] };
      },
      disconnect: (reason) => {
        lifecycleEvents.push({ type: "disconnect", reason });
        return { ok: true };
      },
      sendAudioChunk: () => ({
        events: [
          {
            type: "response.output_text.delta",
            event_id: "evt_control_text",
            response_id: "resp_control",
            delta: "working",
          },
          {
            type: "response.output_audio.delta",
            event_id: "evt_control_audio",
            response_id: "resp_control",
            delta: "AAAA",
          },
        ],
      }),
      sendControlEvent: (event) => {
        controlEvents.push(event);
        if (event.type === "response.cancel") {
          return { events: [{ type: "response.cancelled", event_id: "evt_control_cancel" }] };
        }
        if (event.type === "session.reset") {
          return { events: [{ type: "session.created", event_id: "evt_control_reset" }] };
        }
        return { ok: true };
      },
    },
  });
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-openai-control-smoke",
    botName: "LAN Oneesama",
    conversationEngine,
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({ sequence: 1 }),
    );
    await waitForRuntimeStatus(url, (body) => body.debug.output.assistantAudio.chunksReceived >= 1);
    await page.evaluate(async () => {
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("disconnect");
      await new Promise((resolve) => setTimeout(resolve, 20));
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("connect");
      await new Promise((resolve) => setTimeout(resolve, 20));
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("set_voice_armed", {
        detail: { armed: true },
      });
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("set_voice_muted", {
        detail: { muted: true },
      });
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("cancel_response", {
        responseId: "resp_control",
      });
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("clear_audio_buffer");
      window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl("reset_session");
    });

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) =>
        nextBody.debug.conversation.control.commandCounts.disconnect >= 1 &&
        nextBody.debug.conversation.control.commandCounts.connect >= 1 &&
        nextBody.debug.conversation.control.commandCounts.set_voice_armed >= 1 &&
        nextBody.debug.conversation.control.commandCounts.set_voice_muted >= 1 &&
        nextBody.debug.conversation.control.commandCounts.cancel_response >= 1 &&
        nextBody.debug.conversation.control.commandCounts.clear_audio_buffer >= 1 &&
        nextBody.debug.conversation.control.commandCounts.reset_session >= 1 &&
        nextBody.debug.conversation.control.inFlight === 0 &&
        nextBody.debug.conversation.eventCounts.engine_disconnected >= 1 &&
        nextBody.debug.conversation.eventCounts.interrupted >= 1,
    );

    assert.deepEqual(
      controlEvents.map((event) => event.type),
      ["response.cancel", "input_audio_buffer.clear", "session.reset"],
    );
    assert.equal(lifecycleEvents[0].type, "connect");
    assert.ok(
      lifecycleEvents.some((event) => event.type === "disconnect"),
      JSON.stringify(lifecycleEvents),
    );
    assert.ok(
      lifecycleEvents.filter((event) => event.type === "connect").length >= 2,
      JSON.stringify(lifecycleEvents),
    );
    assert.equal(lifecycleEvents[0].sessionId, "lan-openai-control-smoke");
    assert.equal(
      lifecycleEvents.find((event) => event.type === "disconnect").reason,
      "operator_debug_panel",
    );
    assert.ok(
      lifecycleEvents.every(
        (event) => event.type !== "connect" || event.sessionId === "lan-openai-control-smoke",
      ),
    );
    assert.equal(controlEvents[0].response_id, "resp_control");
    assert.equal(body.debug.conversation.control.lastResult, "ok");
    assert.equal(body.debug.output.assistantAudio.status, "stopped");
    assert.ok(
      body.recentEvents.some((event) => event.event === "engine_control_completed"),
      JSON.stringify(body.recentEvents),
    );
  } finally {
    await browser.close();
    await surface.close();
  }
});
