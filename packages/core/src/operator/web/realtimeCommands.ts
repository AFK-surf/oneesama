import { operatorEngineControlWireMessage } from "./operatorEngineControlWire.ts";

export type RealtimeWireMessage = Record<string, unknown> & { type: string };

export function operatorSurfaceConnectedMessage(): RealtimeWireMessage {
  return { type: "operator_surface_connected" };
}

export function realtimeEngineControlMessage(
  sessionId: string,
  type: "connect" | "disconnect",
  reason: string,
): RealtimeWireMessage {
  return operatorEngineControlWireMessage({
    sessionId,
    type,
    reason,
  });
}

export function operatorTextInputMessage(input: {
  sessionId: string;
  text: string;
  sequence: number;
  nowMs?: number;
}): RealtimeWireMessage | null {
  const value = input.text.trim();
  if (!value) return null;
  const nowMs = input.nowMs ?? Date.now();
  return {
    type: "operator_text_input",
    sessionId: input.sessionId,
    inputId: "web_text_" + nowMs.toString(36) + "_" + input.sequence,
    text: value,
    source: "operator_web_text",
  };
}
