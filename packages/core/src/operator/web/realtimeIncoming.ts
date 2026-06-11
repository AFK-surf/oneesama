import { canonicalEventFromPayload, type CanonicalEvent } from "./realtimeState.ts";

export type RealtimeRawListener = (payload: Record<string, unknown>) => void;
export type RealtimeCanonicalListener = (event: CanonicalEvent) => void;

export interface PublishRealtimePayloadInput {
  payload: Record<string, unknown>;
  rawListeners: Iterable<RealtimeRawListener>;
  canonicalListeners: Iterable<RealtimeCanonicalListener>;
}

export function parseRealtimeSocketPayload(data: unknown): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(String(data));
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function publishRealtimePayload(input: PublishRealtimePayloadInput): CanonicalEvent | null {
  for (const listener of input.rawListeners) listener(input.payload);
  const event = canonicalEventFromPayload(input.payload);
  if (!event) return null;
  for (const listener of input.canonicalListeners) listener(event);
  return event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
