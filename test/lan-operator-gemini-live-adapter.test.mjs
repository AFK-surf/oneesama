import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  createGeminiLiveConversationEngine,
  createGeminiLiveEventMapper,
  createGeminiLiveWebSocketTransport,
} from "../packages/core/src/operator/lan-operator-gemini-live-adapter.ts";

class FakeGeminiWebSocket {
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
    if (event.setup) {
      this.emit("message", JSON.stringify({ setupComplete: { sessionId: "gemini_sess_fake" } }));
    }
    if (event.clientContent) {
      this.emit(
        "message",
        JSON.stringify({
          serverContent: {
            modelTurn: { parts: [{ text: "typed ok" }] },
            turnComplete: true,
          },
        }),
      );
    }
    if (event.realtimeInput?.audio) {
      this.emit(
        "message",
        JSON.stringify({
          serverContent: {
            inputTranscription: { text: "hello" },
            modelTurn: {
              parts: [
                {
                  inlineData: {
                    mimeType: "audio/pcm;rate=24000",
                    data: "AAAA",
                  },
                },
              ],
            },
            turnComplete: true,
          },
        }),
      );
    }
    if (event.toolResponse) {
      this.emit(
        "message",
        JSON.stringify({
          serverContent: {
            modelTurn: {
              parts: [
                {
                  functionResponse: {
                    id: "call_1",
                    name: "kwwk_computer_use",
                  },
                },
              ],
            },
            turnComplete: true,
          },
        }),
      );
    }
    if (event.realtimeInput?.audioStreamEnd) {
      this.emit(
        "message",
        JSON.stringify({
          serverContent: {
            interrupted: true,
            turnComplete: true,
          },
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

function containsKey(value, key) {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((entry) => containsKey(entry, key));
}

test("Gemini Live mapper emits canonical events without raw event leakage", () => {
  const mapper = createGeminiLiveEventMapper({
    engineId: "gemini_live_test",
    sessionId: "lan-gemini-map-test",
    now: () => "2026-06-09T00:00:00.000Z",
  });
  const events = [
    { setupComplete: { sessionId: "gemini_provider_session" } },
    {
      serverContent: {
        inputTranscription: { text: "turn on the light" },
        modelTurn: {
          parts: [
            { text: "ok" },
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } },
          ],
        },
        turnComplete: true,
      },
    },
    {
      toolCall: {
        functionCalls: [
          {
            id: "call_1",
            name: "kwwk_computer_use",
            args: { instruction: "switch tabs" },
          },
        ],
      },
    },
    { toolCallCancellation: { ids: ["call_1"] } },
    { error: { message: "provider down ?key=AIza123456789012345678901234" } },
  ].flatMap((event) => mapper(event));

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "engine_connected",
      "transcript_completed",
      "assistant_text_completed",
      "assistant_audio_started",
      "assistant_audio_chunk",
      "assistant_audio_stopped",
      "tool_call_started",
      "tool_call_completed",
      "interrupted",
      "engine_error",
    ],
  );
  assert.equal(
    events.find((event) => event.type === "transcript_completed").text,
    "turn on the light",
  );
  assert.equal(events.find((event) => event.type === "assistant_audio_chunk").audioBase64, "AAAA");
  assert.equal(
    events.find((event) => event.type === "tool_call_completed").detail.expectedTool,
    "kwwk_computer_use",
  );
  assert.equal(
    events.find((event) => event.type === "engine_error").error,
    "provider down ?key=[redacted_gemini_api_key]",
  );
  for (const event of events) {
    assert.equal(event.sessionId, "lan-gemini-map-test");
    assert.equal(event.engineId, "gemini_live_test");
    assert.equal(event.detail.provider, "gemini_live");
    assert.ok(event.detail.providerEventType);
    assert.equal(containsKey(event.detail, "rawEvent"), false);
    assert.equal(containsKey(event.detail, "providerRawEvent"), false);
  }
});

test("Gemini Live WebSocket transport sends setup, text, audio, and tool response payloads", async () => {
  let socket = null;
  const transport = createGeminiLiveWebSocketTransport({
    apiKey: "AIzaFakeGeminiLiveKey1234567890",
    model: "gemini-3.1-flash-live-preview",
    drainMs: 0,
    webSocketFactory: (url, init) => {
      socket = new FakeGeminiWebSocket(url, init);
      return socket;
    },
  });

  const connectOutput = await transport.connect("lan-gemini-transport-test");
  assert.equal(connectOutput.ok, true);
  assert.equal(connectOutput.events[0].setupComplete.sessionId, "gemini_sess_fake");
  assert.match(socket.url, /generativelanguage\.googleapis\.com/);
  assert.match(socket.url, /key=AIzaFakeGeminiLiveKey/);
  assert.equal(socket.init.headers && Object.keys(socket.init.headers).length, 0);
  assert.equal(socket.sent[0].setup.model, "models/gemini-3.1-flash-live-preview");
  assert.deepEqual(socket.sent[0].setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(socket.sent[0].setup.generationConfig.thinkingConfig.thinkingLevel, "low");

  const textOutput = await transport.sendTextInput({
    id: "text_1",
    ts: "2026-06-09T00:00:00.000Z",
    sessionId: "lan-gemini-transport-test",
    text: "hello",
    source: "operator_text_input",
    monotonicMs: 1,
  });
  assert.equal(textOutput.ok, true);
  assert.equal(socket.sent[1].clientContent.turnComplete, true);
  assert.equal(socket.sent[1].clientContent.turns[0].parts[0].text, "hello");

  const audioOutput = await transport.sendAudioChunk({
    id: "voice_1",
    ts: "2026-06-09T00:00:00.000Z",
    sessionId: "lan-gemini-transport-test",
    sequence: 1,
    dataBase64: "AAAA",
    sampleRate: 16000,
    channels: 1,
    durationMs: 20,
    energy: 0.1,
    source: "synthetic_pcm16",
    monotonicMs: 2,
  });
  assert.equal(audioOutput.ok, true);
  assert.equal(socket.sent[2].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(socket.sent[2].realtimeInput.audio.data, "AAAA");

  const toolOutput = await transport.sendToolResult({
    id: "tool_1",
    ts: "2026-06-09T00:00:00.000Z",
    sessionId: "lan-gemini-transport-test",
    callId: "call_1",
    toolName: "kwwk_computer_use",
    status: "completed",
    output: { ok: true },
    source: "kwwk",
  });
  assert.equal(toolOutput.ok, true);
  assert.equal(socket.sent[3].toolResponse.functionResponses[0].id, "call_1");
  assert.equal(socket.sent[3].toolResponse.functionResponses[0].response.ok, true);
});

test("Gemini Live conversation engine maps text and control events", async () => {
  const controlEvents = [];
  const engine = createGeminiLiveConversationEngine({
    engineId: "gemini_live_engine_test",
    transport: {
      id: "fake_gemini_transport",
      connect: () => ({ events: [{ setupComplete: { sessionId: "gemini_sess_engine" } }] }),
      sendTextInput: () => ({
        events: [
          {
            serverContent: {
              modelTurn: { parts: [{ text: "typed ok" }] },
              turnComplete: true,
            },
          },
        ],
      }),
      sendControlEvent: (event) => {
        controlEvents.push(event);
        return { events: [{ serverContent: { interrupted: true, turnComplete: true } }] };
      },
    },
  });

  const textOutput = await engine.receiveTextInput({
    id: "text_engine_1",
    ts: "2026-06-09T00:00:00.000Z",
    sessionId: "lan-gemini-engine-test",
    text: "hello",
    source: "operator_text_input",
    monotonicMs: 1,
  });
  assert.equal(textOutput.result.ok, true);
  assert.deepEqual(
    textOutput.events.map((event) => event.type),
    ["transcript_completed", "engine_connected", "assistant_text_completed"],
  );

  const cancelOutput = await engine.control({
    id: "control_1",
    ts: "2026-06-09T00:00:00.000Z",
    sessionId: "lan-gemini-engine-test",
    type: "cancel_response",
    responseId: "gemini_live_response",
  });
  assert.equal(cancelOutput.result.ok, true);
  assert.equal(controlEvents[0].realtimeInput.audioStreamEnd, true);
  assert.ok(cancelOutput.events.some((event) => event.type === "interrupted"));
});

test("Gemini Live engine reports missing backend key without leaking provider secrets", async () => {
  const transport = createGeminiLiveWebSocketTransport({ apiKey: "", drainMs: 0 });
  const engine = createGeminiLiveConversationEngine({
    engineId: "gemini_live_missing_key_test",
    transport,
  });
  const output = await engine.receiveTextInput({
    id: "text_missing_key_1",
    ts: "2026-06-09T00:00:00.000Z",
    sessionId: "lan-gemini-missing-key-test",
    text: "hello",
    source: "operator_text_input",
    monotonicMs: 1,
  });

  assert.equal(output.result.ok, false);
  assert.equal(output.result.error, "gemini_live_api_key_missing");
  assert.ok(output.events.some((event) => event.type === "engine_error"));
  assert.equal(
    output.events.find((event) => event.type === "engine_error").error,
    "gemini_live_api_key_missing",
  );
});
