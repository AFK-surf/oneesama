import { isRecord } from "./operatorRecord.ts";

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

export interface RealtimeViewState {
  wsOpen: boolean;
  status: RealtimeStatus;
  transport: string;
  events: CanonicalEvent[];
  error: string;
}

export const RENDERED_REALTIME_EVENT_LIMIT = 200;

export function initialRealtimeViewState(conversationTransport?: string): RealtimeViewState {
  return {
    wsOpen: false,
    status: "not_connected",
    transport: conversationTransport || "unknown",
    events: [],
    error: "",
  };
}

export function realtimeSocketOpened(state: RealtimeViewState): RealtimeViewState {
  return { ...state, wsOpen: true };
}

export function realtimeSocketClosed(state: RealtimeViewState): RealtimeViewState {
  return { ...state, wsOpen: false };
}

export function realtimeConnectRequested(state: RealtimeViewState): RealtimeViewState {
  return {
    ...state,
    status: "connecting",
    error: "",
  };
}

export function canonicalEventFromPayload(payload: Record<string, unknown>): CanonicalEvent | null {
  if (payload.type !== "canonical_conversation_event") return null;
  if (!isRecord(payload.event)) return null;
  return payload.event as CanonicalEvent;
}

export function foldRealtimePayload(
  state: RealtimeViewState,
  payload: Record<string, unknown>,
): RealtimeViewState {
  let next = state;
  const event = canonicalEventFromPayload(payload);
  if (event) next = foldCanonicalEvent(next, event);
  return foldRealtimeDebug(next, payload);
}

function foldCanonicalEvent(state: RealtimeViewState, event: CanonicalEvent): RealtimeViewState {
  const events =
    event.type === "assistant_audio_chunk"
      ? state.events
      : [...state.events, event].slice(-RENDERED_REALTIME_EVENT_LIMIT);
  const error = event.type === "engine_error" ? String(event.error || "engine_error") : state.error;
  if (events === state.events && error === state.error) return state;
  return { ...state, events, error };
}

function foldRealtimeDebug(
  state: RealtimeViewState,
  payload: Record<string, unknown>,
): RealtimeViewState {
  const conversation = conversationDebugFromPayload(payload);
  if (!conversation) return state;
  const status = stringValue(conversation.status);
  const provider = isRecord(conversation.provider) ? conversation.provider : null;
  const transport = stringValue(provider?.adapterKind);
  if (!status && !transport) return state;
  const nextStatus = (status || state.status) as RealtimeStatus;
  const nextTransport = transport || state.transport;
  if (nextStatus === state.status && nextTransport === state.transport) return state;
  return {
    ...state,
    status: nextStatus,
    transport: nextTransport,
  };
}

function conversationDebugFromPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const debug = isRecord(payload.debug) ? payload.debug : null;
  if (!debug) return null;
  return isRecord(debug.conversation) ? debug.conversation : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
