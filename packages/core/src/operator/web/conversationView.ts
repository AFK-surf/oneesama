import type { DebugState } from "../lan-operator-debug-state.ts";
import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { CanonicalEvent, RealtimeState } from "./useRealtime.ts";

export interface Turn {
  role: "you" | "bot";
  text: string;
  status: string;
}

export type ConversationTimelineTurn = DebugState["timeline"]["turns"][number];

export interface ConversationView {
  turns: Turn[];
  latestTurn: ConversationTimelineTurn | null;
  latestEventLabel: string;
  currentTurnLabel: string;
  eventCountLabel: string;
  speechStartedCountLabel: string;
  controlLabel: string;
  connected: boolean;
  liveAssistantText: string;
  errorText: string;
  empty: boolean;
}

export function conversationView(
  runtime: Pick<OperatorRuntimeState, "debug" | "runtimeError">,
  realtime: Pick<RealtimeState, "error" | "events" | "status">,
): ConversationView {
  const turns = turnsFromEvents(realtime.events);
  const timeline = runtime.debug.timeline as DebugState["timeline"] | undefined;
  const latestTurn = timeline?.turns?.at(-1) || null;
  const output = runtime.debug.output as DebugState["output"] | undefined;
  const control = runtime.debug.conversation?.control;
  const liveAssistantText = output?.assistantText?.currentText || "";

  return {
    turns,
    latestTurn,
    latestEventLabel: latestTurn?.latestEvent || realtime.events.at(-1)?.type || "idle",
    currentTurnLabel: timeline?.currentTurnId || "no turn",
    eventCountLabel: String(realtime.events.length),
    speechStartedCountLabel: String(runtime.debug.conversation?.eventCounts?.speech_started || 0),
    controlLabel: control?.lastResult || control?.lastCommand || "idle",
    connected: String(runtime.debug.conversation?.status || realtime.status) === "connected",
    liveAssistantText,
    errorText: realtime.error || runtime.runtimeError || "",
    empty: turns.length === 0 && !liveAssistantText,
  };
}

export function turnsFromEvents(events: CanonicalEvent[]): Turn[] {
  const turns: Turn[] = [];
  const assistantByResponse = new Map<string, Turn>();
  for (const ev of events) {
    if (ev.type === "transcript_completed" && ev.text) {
      turns.push({ role: "you", text: String(ev.text), status: "heard" });
    } else if (ev.type === "assistant_text_delta" || ev.type === "assistant_text_completed") {
      const key = String(ev.responseId || "r");
      let turn = assistantByResponse.get(key);
      if (!turn) {
        turn = { role: "bot", text: "", status: "speaking" };
        assistantByResponse.set(key, turn);
        turns.push(turn);
      }
      if (ev.type === "assistant_text_completed") {
        if (ev.text) turn.text = String(ev.text);
        turn.status = "final";
      } else if (ev.text) {
        turn.text += String(ev.text);
      }
    }
  }
  return turns;
}
