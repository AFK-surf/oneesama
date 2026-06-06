import type {
  ConversationEngineControlCommand,
  ConversationEngineControlOutput,
} from "./lan-operator-conversation-engine.ts";
import type { DebugState } from "./lan-operator-debug-state.ts";

export function recordEngineControlStarted(
  debug: DebugState,
  command: ConversationEngineControlCommand,
) {
  debug.conversation.control.inFlight += 1;
  debug.conversation.control.lastCommand = command.type;
  debug.conversation.control.lastCommandAt = command.ts;
  debug.conversation.control.lastDetail = command.detail || null;
  debug.conversation.control.lastResult = null;
  debug.conversation.control.lastError = null;
  debug.conversation.control.commandCounts[command.type] =
    Number(debug.conversation.control.commandCounts[command.type] || 0) + 1;
}

export function recordEngineControlFinished(
  debug: DebugState,
  output: ConversationEngineControlOutput,
) {
  const result = output.result || { ok: true };
  debug.conversation.control.inFlight = Math.max(0, debug.conversation.control.inFlight - 1);
  debug.conversation.control.lastResult = result.ok === false ? "failed" : "ok";
  debug.conversation.control.lastError =
    result.ok === false ? String(result.error || result.reason || "engine_control_failed") : null;
}

export function recordEngineControlFailed(debug: DebugState, error: unknown) {
  debug.conversation.control.inFlight = Math.max(0, debug.conversation.control.inFlight - 1);
  debug.conversation.control.lastResult = "failed";
  debug.conversation.control.lastError = String((error as Error)?.message || error);
}
