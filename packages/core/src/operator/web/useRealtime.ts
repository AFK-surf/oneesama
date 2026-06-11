import { useCallback, useEffect, useRef, useState } from "react";

export interface OperatorBoot {
  sessionId: string;
  token?: string;
  conversationTransport?: string;
  botName?: string;
}

export interface CanonicalEvent {
  type: string;
  text?: string;
  responseId?: string;
  [key: string]: unknown;
}

export type RealtimeStatus = "not_connected" | "connecting" | "connected" | "failed";

export interface RealtimeState {
  wsOpen: boolean;
  status: RealtimeStatus;
  transport: string;
  events: CanonicalEvent[];
  error: string;
  connect: () => void;
  disconnect: () => void;
  sendText: (text: string) => void;
}

function authSuffix(token: string | undefined, path: string) {
  if (!token) return path;
  return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
}

/**
 * Phase-1 realtime hook: owns the events WebSocket and the canonical-event
 * stream, and sends engine controls + text input over the same wire protocol
 * the legacy surface uses. The heavy imperative clients (voice/canvas/WebRTC)
 * are reused in later phases; this hook only needs events + control + text.
 */
export function useRealtime(boot: OperatorBoot): RealtimeState {
  const [wsOpen, setWsOpen] = useState(false);
  const [status, setStatus] = useState<RealtimeStatus>("not_connected");
  const [transport, setTransport] = useState(boot.conversationTransport || "unknown");
  const [events, setEvents] = useState<CanonicalEvent[]>([]);
  const [error, setError] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(
        proto + "//" + location.host + authSuffix(boot.token, "/operator/events/ws"),
      );
      wsRef.current = ws;
      ws.addEventListener("open", () => {
        setWsOpen(true);
        ws?.send(JSON.stringify({ type: "operator_surface_connected" }));
      });
      ws.addEventListener("close", () => {
        setWsOpen(false);
        if (!closed) reconnectTimer = setTimeout(open, 1000);
      });
      ws.addEventListener("message", (event) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (payload.type === "canonical_conversation_event" && payload.event) {
          const ev = payload.event as CanonicalEvent;
          setEvents((prev) => [...prev, ev].slice(-200));
          if (ev.type === "engine_error") setError(String(ev.error || "engine_error"));
        }
        const debug = payload.debug as
          | { conversation?: { status?: string; provider?: { adapterKind?: string } } }
          | undefined;
        if (debug?.conversation?.status) setStatus(debug.conversation.status as RealtimeStatus);
        if (debug?.conversation?.provider?.adapterKind)
          setTransport(debug.conversation.provider.adapterKind);
      });
    };
    open();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [boot.token]);

  const connect = useCallback(() => {
    setError("");
    setStatus("connecting");
    send({
      type: "engine_control",
      sessionId: boot.sessionId,
      control: {
        type: "connect",
        reason: "operator_web_connect",
        detail: { source: "operator_web" },
      },
    });
  }, [boot.sessionId, send]);

  const disconnect = useCallback(() => {
    send({
      type: "engine_control",
      sessionId: boot.sessionId,
      control: {
        type: "disconnect",
        reason: "operator_web_disconnect",
        detail: { source: "operator_web" },
      },
    });
  }, [boot.sessionId, send]);

  const sendText = useCallback(
    (text: string) => {
      const value = text.trim();
      if (!value) return;
      seqRef.current += 1;
      send({
        type: "operator_text_input",
        sessionId: boot.sessionId,
        inputId: "web_text_" + Date.now().toString(36) + "_" + seqRef.current,
        text: value,
        source: "operator_web_text",
      });
    },
    [boot.sessionId, send],
  );

  return { wsOpen, status, transport, events, error, connect, disconnect, sendText };
}
