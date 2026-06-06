import { randomUUID } from "node:crypto";

import type {
  CanonicalConversationEvent,
  ConversationEnginePort,
} from "./lan-operator-conversation-engine.ts";

export interface ConversationEventDrainPumpOptions {
  conversationEngine: ConversationEnginePort;
  sessionId: string;
  onEvents(events: CanonicalConversationEvent[]): void;
  onFailure(detail: Record<string, unknown>): void;
}

export function createConversationEventDrainPump(options: ConversationEventDrainPumpOptions) {
  let inFlight = false;

  async function drain(reason = "provider_event_pump") {
    if (!options.conversationEngine.control || inFlight) return;
    inFlight = true;
    try {
      const output = await options.conversationEngine.control({
        id: randomUUID(),
        ts: new Date().toISOString(),
        sessionId: options.sessionId,
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
