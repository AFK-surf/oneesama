import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  REALTIME_RECONNECT_DELAY_MS,
  REALTIME_SOCKET_OPEN_STATE,
  startRealtimeSocketSession,
} from "../packages/core/src/operator/web/realtimeSocket.ts";

class FakeRealtimeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closeCount = 0;
    this.listeners = { close: [], message: [], open: [] };
    FakeRealtimeSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners[type].push(listener);
  }

  close() {
    this.closeCount += 1;
    this.emit("close");
  }

  emit(type, event = {}) {
    if (type === "open") this.readyState = REALTIME_SOCKET_OPEN_STATE;
    for (const listener of this.listeners[type]) listener(event);
  }

  send(data) {
    this.sent.push(data);
  }
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutFn: (handler, timeoutMs) => {
      const timer = { cancelled: false, handler, timeoutMs };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timer.cancelled = true;
    },
  };
}

test("operator realtime socket session opens and sends surface hello", () => {
  FakeRealtimeSocket.instances = [];
  const sockets = [];
  const events = [];

  startRealtimeSocketSession({
    url: "ws://operator/events",
    WebSocketCtor: FakeRealtimeSocket,
    setCurrentSocket: (socket) => sockets.push(socket),
    onOpen: () => events.push("open"),
    onClose: () => events.push("close"),
    onMessageData: (data) => events.push(["message", data]),
  });

  const socket = FakeRealtimeSocket.instances[0];
  assert.equal(socket.url, "ws://operator/events");
  assert.equal(sockets[0], socket);

  socket.emit("open");
  assert.deepEqual(events, ["open"]);
  assert.deepEqual(
    socket.sent.map((item) => JSON.parse(item)),
    [{ type: "operator_surface_connected" }],
  );

  socket.emit("message", { data: '{"type":"canonical_conversation_event"}' });
  assert.deepEqual(events.at(-1), ["message", '{"type":"canonical_conversation_event"}']);
});

test("operator realtime socket session reconnects after remote close", () => {
  FakeRealtimeSocket.instances = [];
  const timerState = fakeTimers();
  const events = [];

  startRealtimeSocketSession({
    url: "ws://operator/events",
    WebSocketCtor: FakeRealtimeSocket,
    setTimeoutFn: timerState.setTimeoutFn,
    clearTimeoutFn: timerState.clearTimeoutFn,
    onOpen: () => events.push("open"),
    onClose: () => events.push("close"),
    onMessageData: () => undefined,
  });

  FakeRealtimeSocket.instances[0].emit("close");
  assert.deepEqual(events, ["close"]);
  assert.equal(timerState.timers.length, 1);
  assert.equal(timerState.timers[0].timeoutMs, REALTIME_RECONNECT_DELAY_MS);

  timerState.timers[0].handler();
  assert.equal(FakeRealtimeSocket.instances.length, 2);
  assert.equal(FakeRealtimeSocket.instances[1].url, "ws://operator/events");
});

test("operator realtime socket session cleanup closes socket and cancels reconnect", () => {
  FakeRealtimeSocket.instances = [];
  const timerState = fakeTimers();
  const sockets = [];
  const events = [];

  const stop = startRealtimeSocketSession({
    url: "ws://operator/events",
    WebSocketCtor: FakeRealtimeSocket,
    setCurrentSocket: (socket) => sockets.push(socket),
    setTimeoutFn: timerState.setTimeoutFn,
    clearTimeoutFn: timerState.clearTimeoutFn,
    onOpen: () => events.push("open"),
    onClose: () => events.push("close"),
    onMessageData: () => undefined,
  });
  const socket = FakeRealtimeSocket.instances[0];

  stop();

  assert.equal(socket.closeCount, 1);
  assert.deepEqual(events, ["close"]);
  assert.equal(timerState.timers.length, 0);
  assert.equal(sockets.at(-1), null);
});

test("operator realtime socket session cleanup cancels pending reconnect", () => {
  FakeRealtimeSocket.instances = [];
  const timerState = fakeTimers();

  const stop = startRealtimeSocketSession({
    url: "ws://operator/events",
    WebSocketCtor: FakeRealtimeSocket,
    setTimeoutFn: timerState.setTimeoutFn,
    clearTimeoutFn: timerState.clearTimeoutFn,
    onOpen: () => undefined,
    onClose: () => undefined,
    onMessageData: () => undefined,
  });

  FakeRealtimeSocket.instances[0].emit("close");
  assert.equal(timerState.timers.length, 1);

  stop();

  assert.equal(timerState.timers[0].cancelled, true);
  timerState.timers[0].handler();
  assert.equal(FakeRealtimeSocket.instances.length, 1);
});
