import { useCallback, useEffect, useReducer, useRef } from "react";

import type { LanOperatorLiveProviderConfig } from "../lan-operator-live-provider-config.ts";
import { wsUrl } from "./protocol.ts";
import { operatorTextInputMessage, realtimeEngineControlMessage } from "./realtimeCommands.ts";
import { parseRealtimeSocketPayload, publishRealtimePayload } from "./realtimeIncoming.ts";
import {
  REALTIME_SOCKET_OPEN_STATE,
  startRealtimeSocketSession,
  type RealtimeSocketLike,
} from "./realtimeSocket.ts";
import {
  foldRealtimePayload,
  initialRealtimeViewState,
  realtimeConnectRequested,
  realtimeSocketClosed,
  realtimeSocketOpened,
} from "./realtimeState.ts";
import type { CanonicalEvent, RealtimeViewState } from "./realtimeState.ts";
export type { CanonicalEvent, RealtimeStatus } from "./realtimeState.ts";

export interface OperatorBoot {
  sessionId: string;
  token?: string;
  conversationTransport?: string;
  botName?: string;
  webrtcIceServers?: Array<Record<string, unknown>>;
  liveProviderConfig?: LanOperatorLiveProviderConfig | null;
}

export interface RealtimeState extends RealtimeViewState {
  connect: () => void;
  disconnect: () => void;
  sendText: (text: string) => void;
  /** Send a raw message over the events WS (e.g. work_run). */
  send: (message: Record<string, unknown>) => boolean;
  /** Subscribe to every canonical event (audio playback etc.); returns unsubscribe. */
  subscribe: (listener: (event: CanonicalEvent) => void) => () => void;
  /** Subscribe to every raw WS envelope (work_event etc.); returns unsubscribe. */
  subscribeRaw: (listener: (payload: Record<string, unknown>) => void) => () => void;
}

type RealtimeAction =
  | { type: "socket_opened" }
  | { type: "socket_closed" }
  | { type: "payload"; payload: Record<string, unknown> }
  | { type: "connect_requested" };

function realtimeReducer(state: RealtimeViewState, action: RealtimeAction): RealtimeViewState {
  if (action.type === "socket_opened") return realtimeSocketOpened(state);
  if (action.type === "socket_closed") return realtimeSocketClosed(state);
  if (action.type === "connect_requested") return realtimeConnectRequested(state);
  return foldRealtimePayload(state, action.payload);
}

/**
 * Realtime hook: owns the events WebSocket and the canonical-event stream,
 * and sends engine controls + text input over the same wire protocol the
 * legacy surface uses. High-frequency assistant_audio_chunk events are
 * delivered only to subscribers (kept out of the rendered `events` list so
 * playback doesn't re-render the conversation on every ~50ms chunk).
 */
export function useRealtime(boot: OperatorBoot): RealtimeState {
  const [state, dispatch] = useReducer(
    realtimeReducer,
    boot.conversationTransport,
    initialRealtimeViewState,
  );
  const wsRef = useRef<RealtimeSocketLike | null>(null);
  const seqRef = useRef(0);
  const listenersRef = useRef(new Set<(event: CanonicalEvent) => void>());
  const rawListenersRef = useRef(new Set<(payload: Record<string, unknown>) => void>());

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== REALTIME_SOCKET_OPEN_STATE) return false;
    ws.send(JSON.stringify(message));
    return true;
  }, []);

  useEffect(() => {
    return startRealtimeSocketSession({
      url: wsUrl(boot.token, "/operator/events/ws"),
      setCurrentSocket: (socket) => {
        wsRef.current = socket;
      },
      onOpen: () => {
        dispatch({ type: "socket_opened" });
      },
      onClose: () => {
        dispatch({ type: "socket_closed" });
      },
      onMessageData: (data) => {
        const payload = parseRealtimeSocketPayload(data);
        if (!payload) return;
        publishRealtimePayload({
          payload,
          rawListeners: rawListenersRef.current,
          canonicalListeners: listenersRef.current,
        });
        dispatch({ type: "payload", payload });
      },
    });
  }, [boot.token]);

  const connect = useCallback(() => {
    dispatch({ type: "connect_requested" });
    send(realtimeEngineControlMessage(boot.sessionId, "connect", "operator_web_connect"));
  }, [boot.sessionId, send]);

  const disconnect = useCallback(() => {
    send(realtimeEngineControlMessage(boot.sessionId, "disconnect", "operator_web_disconnect"));
  }, [boot.sessionId, send]);

  const sendText = useCallback(
    (text: string) => {
      const message = operatorTextInputMessage({
        sessionId: boot.sessionId,
        text,
        sequence: seqRef.current + 1,
      });
      if (!message) return;
      seqRef.current += 1;
      send(message);
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
    ...state,
    connect,
    disconnect,
    sendText,
    send,
    subscribe,
    subscribeRaw,
  };
}
