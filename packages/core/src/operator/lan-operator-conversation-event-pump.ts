import { randomUUID } from "node:crypto";

import type {
  CanonicalConversationEvent,
  ConversationEnginePort,
} from "./lan-operator-conversation-engine.ts";

export interface ConversationEventDrainPumpOptions {
  conversationEngine: ConversationEnginePort | (() => ConversationEnginePort);
  sessionId: string | (() => string);
  onEvents(events: CanonicalConversationEvent[]): void;
  onFailure(detail: Record<string, unknown>): void;
}

export function createConversationEventDrainPump(options: ConversationEventDrainPumpOptions) {
  let inFlight = false;

  function currentEngine() {
    return typeof options.conversationEngine === "function"
      ? options.conversationEngine()
      : options.conversationEngine;
  }

  function currentSessionId() {
    return typeof options.sessionId === "function" ? options.sessionId() : options.sessionId;
  }

  async function drain(reason = "provider_event_pump") {
    const engine = currentEngine();
    if (!engine.control || inFlight) return;
    inFlight = true;
    try {
      const output = await engine.control({
        id: randomUUID(),
        ts: new Date().toISOString(),
        sessionId: currentSessionId(),
        type: "drain_events",
        reason,
        detail: {},
      });
      options.onEvents(output.events || []);
      if (output.result?.ok === false) options.onFailure({ result: output.result });
    } catch (error) {
      options.onFailure({ error: String((error as Error)?.message || error) });
    } finally {
      inFlight = false;
    }
  }

  return { drain };
}
