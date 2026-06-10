export function buildLanOperatorWebSocketClientScript() {
  return `(() => {
  const DEFAULT_RECONNECT_MS = 650;
  const MAX_RECONNECT_MS = 3000;
  const PING_INTERVAL_MS = 2000;

  function nowIso() {
    return new Date().toISOString();
  }

  function defaultConnection() {
    return {
      state: "closed",
      connectCount: 0,
      reconnectCount: 0,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      lastPacketAt: null,
      lastError: null,
      rttMs: null,
      nextReconnectAt: null,
    };
  }

  function ensureConnectionState(state, label) {
    state.transport = state.transport || {};
    state.transport[label] = { ...defaultConnection(), ...(state.transport[label] || {}) };
    return state.transport[label];
  }

  function create(options) {
    const state = options.state;
    const label = options.label;
    const connection = ensureConnectionState(state, label);
    let ws = null;
    let reconnectTimer = null;
    let pingTimer = null;
    let manualClose = false;
    const pendingPings = new Map();

    function patch(patchInput = {}) {
      Object.assign(connection, patchInput);
      options.onState?.(connection);
      options.syncDebug?.();
      return connection;
    }

    function sendRaw(payload) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ sessionId: state.sessionId, ...payload }));
      return true;
    }

    function reportState() {
      return sendRaw({
        type: "operator_connection_state",
        label,
        connection,
      });
    }

    function scheduleReconnect(reason) {
      if (manualClose || reconnectTimer) return;
      const delay = Math.min(MAX_RECONNECT_MS, DEFAULT_RECONNECT_MS * Math.max(1, connection.reconnectCount + 1));
      const nextReconnectAt = new Date(Date.now() + delay).toISOString();
      patch({
        state: "reconnecting",
        reconnectCount: connection.reconnectCount + 1,
        lastDisconnectedAt: nowIso(),
        lastError: reason || connection.lastError,
        nextReconnectAt,
      });
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function startPing() {
      if (label !== "events" || pingTimer) return;
      pingTimer = window.setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const pingId = "ping_" + Date.now().toString(36);
        pendingPings.set(pingId, performance.now());
        sendRaw({ type: "operator_connection_ping", pingId, sentAt: nowIso() });
      }, PING_INTERVAL_MS);
    }

    function stopPing() {
      if (pingTimer) window.clearInterval(pingTimer);
      pingTimer = null;
      pendingPings.clear();
    }

    function handleMessage(event) {
      patch({ lastPacketAt: nowIso() });
      let payload = {};
      try {
        payload = JSON.parse(String(event.data || "{}"));
      } catch (error) {
        patch({ lastError: "invalid_json:" + String(error?.message || error) });
        return;
      }
      if (payload.type === "operator_connection_pong" && pendingPings.has(payload.pingId)) {
        const startedAt = pendingPings.get(payload.pingId);
        pendingPings.delete(payload.pingId);
        patch({ rttMs: Math.max(0, Math.round(performance.now() - startedAt)) });
      }
      options.onMessage?.(payload, event);
    }

    function connect() {
      manualClose = false;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return ws;
      patch({ state: connection.connectCount > 0 ? "reconnecting" : "connecting", nextReconnectAt: null });
      // Pass the page's access token through to the upgrade request — the
      // server gates WS upgrades when MAB_LAN_OPERATOR_TOKEN is set.
      const authToken = new URLSearchParams(location.search).get("token") || "";
      const authSuffix = authToken
        ? (options.path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(authToken)
        : "";
      ws = new WebSocket((location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + options.path + authSuffix);
      ws.addEventListener("open", () => {
        patch({
          state: "open",
          connectCount: connection.connectCount + 1,
          lastConnectedAt: nowIso(),
          lastPacketAt: nowIso(),
          lastError: null,
          nextReconnectAt: null,
        });
        options.onOpen?.(api);
        reportState();
        startPing();
      });
      ws.addEventListener("message", handleMessage);
      ws.addEventListener("close", () => {
        stopPing();
        patch({ state: manualClose ? "closed" : "reconnecting", lastDisconnectedAt: nowIso() });
        options.onClose?.(connection);
        if (options.autoReconnect !== false) scheduleReconnect("websocket_closed");
      });
      ws.addEventListener("error", () => {
        patch({ state: "failed", lastError: label + "_websocket_error" });
        options.onError?.(connection);
      });
      return ws;
    }

    function close(reason = "operator_closed") {
      manualClose = true;
      stopPing();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      patch({ state: "closed", lastDisconnectedAt: nowIso(), lastError: reason });
      ws?.close?.();
    }

    const api = {
      connect,
      close,
      send: sendRaw,
      socket: () => ws,
      state: () => connection,
      reportState,
    };
    return api;
  }

  window.MAB_LAN_OPERATOR_WEBSOCKET = { create, defaultConnection };
})();`;
}
