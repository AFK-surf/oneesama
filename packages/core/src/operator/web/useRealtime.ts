import { useCallback, useEffect, useRef, useState } from "react";

import type { LanOperatorLiveProviderConfig } from "../lan-operator-live-provider-config.ts";
import { wsUrl } from "./protocol.ts";

export interface OperatorBoot {
  sessionId: string;
  token?: string;
  conversationTransport?: string;
  botName?: string;
  webrtcIceServers?: Array<Record<string, unknown>>;
  liveProviderConfig?: LanOperatorLiveProviderConfig | null;
}

export interface CanonicalEvent {
  type: string;
  text?: string;
  responseId?: string;
  audioBase64?: string;
  error?: string;
  detail?: Record<string, unknown>;
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
  /** Send a raw message over the events WS (e.g. work_run). */
  send: (message: Record<string, unknown>) => void;
  /** Subscribe to every canonical event (audio playback etc.); returns unsubscribe. */
  subscribe: (listener: (event: CanonicalEvent) => void) => () => void;
  /** Subscribe to every raw WS envelope (work_event etc.); returns unsubscribe. */
  subscribeRaw: (listener: (payload: Record<string, unknown>) => void) => () => void;
}

/**
 * Realtime hook: owns the events WebSocket and the canonical-event stream,
 * and sends engine controls + text input over the same wire protocol the
 * legacy surface uses. High-frequency assistant_audio_chunk events are
 * delivered only to subscribers (kept out of the rendered `events` list so
 * playback doesn't re-render the conversation on every ~50ms chunk).
 */
export function useRealtime(boot: OperatorBoot): RealtimeState {
  const [wsOpen, setWsOpen] = useState(false);
  const [status, setStatus] = useState<RealtimeStatus>("not_connected");
  const [transport, setTransport] = useState(boot.conversationTransport || "unknown");
  const [events, setEvents] = useState<CanonicalEvent[]>([]);
  const [error, setError] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  const listenersRef = useRef(new Set<(event: CanonicalEvent) => void>());
  const rawListenersRef = useRef(new Set<(payload: Record<string, unknown>) => void>());

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      ws = new WebSocket(wsUrl(boot.token, "/operator/events/ws"));
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
        for (const listener of rawListenersRef.current) listener(payload);
        if (payload.type === "canonical_conversation_event" && payload.event) {
          const ev = payload.event as CanonicalEvent;
          // Audio chunks go to subscribers only — keeping them out of the
          // rendered event list avoids re-rendering on every ~50ms chunk.
          for (const listener of listenersRef.current) listener(ev);
          if (ev.type !== "assistant_audio_chunk") {
            setEvents((prev) => [...prev, ev].slice(-200));
          }
          if (ev.type === "engine_error") setError(String(ev.error || "engine_error"));
        }
        const debug = payload.debug as
          | { conversation?: { status?: string; provider?: { adapterKind?: string } } }
          | undefined;
        if (debug?.conversation?.status) setStatus(debug.conversation.status as RealtimeStatus);
        if (debug?.conversation?.provider?.adapterKind) {
          setTransport(debug.conversation.provider.adapterKind);
        }
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

  const subscribe = useCallback((listener: (event: CanonicalEvent) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const subscribeRaw = useCallback((listener: (payload: Record<string, unknown>) => void) => {
    rawListenersRef.current.add(listener);
    return () => {
      rawListenersRef.current.delete(listener);
    };
  }, []);

  return {
    wsOpen,
    status,
    transport,
    events,
    error,
    connect,
    disconnect,
    sendText,
    send,
    subscribe,
    subscribeRaw,
  };
}
