import type { RuntimeStatusBody } from "./operatorRuntimeClient.ts";
import {
  foldRuntimeBody,
  foldRuntimeRawPayload,
  providerSwitchFailed,
  providerSwitchStarted,
  providerSwitchSucceeded,
  runtimeRequestFailed,
} from "./runtimeState.ts";
import type { OperatorRuntimeViewState } from "./runtimeState.ts";

export type OperatorRuntimeAction =
  | { type: "body"; body: RuntimeStatusBody }
  | { type: "raw_payload"; payload: Record<string, unknown> }
  | { type: "request_failed"; error: unknown }
  | { type: "provider_switch_started"; targetTransport: string }
  | { type: "provider_switch_succeeded"; targetTransport: string }
  | { type: "provider_switch_failed"; targetTransport: string; error: unknown };

export function operatorRuntimeReducer(
  state: OperatorRuntimeViewState,
  action: OperatorRuntimeAction,
): OperatorRuntimeViewState {
  if (action.type === "body") return foldRuntimeBody(state, action.body);
  if (action.type === "raw_payload") return foldRuntimeRawPayload(state, action.payload);
  if (action.type === "request_failed") return runtimeRequestFailed(state, action.error);
  if (action.type === "provider_switch_started") {
    return providerSwitchStarted(state, action.targetTransport);
  }
  if (action.type === "provider_switch_succeeded") {
    return providerSwitchSucceeded(state, action.targetTransport);
  }
  return providerSwitchFailed(state, action.targetTransport, action.error);
}
