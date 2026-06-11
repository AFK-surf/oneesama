import { operatorSurfaceConnectedMessage } from "./realtimeCommands.ts";

export const REALTIME_SOCKET_OPEN_STATE = 1;
export const REALTIME_RECONNECT_DELAY_MS = 1000;

export type RealtimeSocketEventName = "open" | "close" | "message";

export interface RealtimeSocketLike {
  readyState: number;
  addEventListener: (
    type: RealtimeSocketEventName,
    listener: (event: { data?: unknown }) => void,
  ) => void;
  close: () => void;
  send: (data: string) => void;
}

export interface RealtimeSocketConstructor {
  new (url: string): RealtimeSocketLike;
}

type RealtimeSocketTimer = unknown;

export interface RealtimeSocketSessionInput {
  url: string;
  WebSocketCtor?: RealtimeSocketConstructor;
  reconnectDelayMs?: number;
  setCurrentSocket?: (socket: RealtimeSocketLike | null) => void;
  setTimeoutFn?: (handler: () => void, timeoutMs: number) => RealtimeSocketTimer;
  clearTimeoutFn?: (timer: RealtimeSocketTimer) => void;
  onOpen: () => void;
  onClose: () => void;
  onMessageData: (data: unknown) => void;
}

export function startRealtimeSocketSession(input: RealtimeSocketSessionInput): () => void {
  const WebSocketCtor = input.WebSocketCtor || (WebSocket as unknown as RealtimeSocketConstructor);
  const setTimer =
    input.setTimeoutFn ||
    ((handler: () => void, timeoutMs: number) => window.setTimeout(handler, timeoutMs));
  const clearTimer =
    input.clearTimeoutFn || ((timer: RealtimeSocketTimer) => window.clearTimeout(timer as number));
  const reconnectDelayMs = input.reconnectDelayMs ?? REALTIME_RECONNECT_DELAY_MS;

  let closed = false;
  let socket: RealtimeSocketLike | null = null;
  let reconnectTimer: RealtimeSocketTimer | null = null;

  const open = () => {
    socket = new WebSocketCtor(input.url);
    input.setCurrentSocket?.(socket);
    socket.addEventListener("open", () => {
      input.onOpen();
      socket?.send(JSON.stringify(operatorSurfaceConnectedMessage()));
    });
    socket.addEventListener("close", () => {
      input.onClose();
      if (!closed) {
        reconnectTimer = setTimer(() => {
          reconnectTimer = null;
          if (closed) return;
          open();
        }, reconnectDelayMs);
      }
    });
    socket.addEventListener("message", (event) => {
      input.onMessageData(event.data);
    });
  };

  open();

  return () => {
    closed = true;
    if (reconnectTimer) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    const activeSocket = socket;
    socket = null;
    input.setCurrentSocket?.(null);
    activeSocket?.close();
  };
}
