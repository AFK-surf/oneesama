import type { DebugState } from "./lan-operator-debug-state.ts";

export function mergeAssistantOutputState(
  debug: DebugState,
  output: Partial<DebugState["output"]>,
) {
  if (output.assistantText) {
    debug.output.assistantText = {
      ...debug.output.assistantText,
      ...output.assistantText,
    };
  }
  if (output.assistantAudio) {
    debug.output.assistantAudio = {
      ...debug.output.assistantAudio,
      ...output.assistantAudio,
    };
  }
}

export function assistantOutputRuntimeDetail(debug: DebugState) {
  return {
    assistantText: debug.output.assistantText,
    assistantAudio: debug.output.assistantAudio,
  };
}

export function assistantOutputStateSignature(debug: DebugState) {
  return JSON.stringify(assistantOutputRuntimeDetail(debug));
}
