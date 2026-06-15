import {
  extractLiveProviderConfig,
  type LanOperatorLiveProviderConfig,
  type LanOperatorLiveProviderEntry,
  type OperatorDebug,
  type ProviderSwitchState,
  type RuntimeEventView,
  type RuntimeStatusBody,
} from "./operatorRuntimeClient.ts";

export interface OperatorRuntimeViewState {
  debug: OperatorDebug;
  snapshot: Record<string, unknown> | null;
  inputPolicy: Record<string, unknown> | null;
  outputPolicy: Record<string, unknown> | null;
  recentEvents: RuntimeEventView[];
  providerConfig: LanOperatorLiveProviderConfig | null;
  runtimeError: string;
  providerSwitch: ProviderSwitchState;
}

export const RECENT_RUNTIME_EVENT_LIMIT = 80;

export function initialOperatorRuntimeViewState(
  providerConfig?: LanOperatorLiveProviderConfig | null,
): OperatorRuntimeViewState {
  return {
    debug: {},
    snapshot: null,
    inputPolicy: null,
    outputPolicy: null,
    recentEvents: [],
    providerConfig: providerConfig || null,
    runtimeError: "",
    providerSwitch: {
      status: "idle",
      targetTransport: "",
      lastError: "",
    },
  };
}

export function foldRuntimeBody(
  state: OperatorRuntimeViewState,
  body: RuntimeStatusBody,
): OperatorRuntimeViewState {
  const nextProviderConfig = extractLiveProviderConfig(body);
  const snapshot = body.snapshot || state.snapshot;
  const inputPolicy = body.inputPolicy || state.inputPolicy;
  const outputPolicy = body.outputPolicy || state.outputPolicy;
  const debug = body.debug || state.debug;
  const recentEvents = body.recentEvents
    ? trimRecentRuntimeEvents(body.recentEvents)
    : state.recentEvents;
  const providerConfig = nextProviderConfig || state.providerConfig;
  if (
    state.snapshot === snapshot &&
    state.inputPolicy === inputPolicy &&
    state.outputPolicy === outputPolicy &&
    state.debug === debug &&
    state.recentEvents === recentEvents &&
    state.providerConfig === providerConfig &&
    state.runtimeError === ""
  ) {
    return state;
  }
  return {
    ...state,
    snapshot,
    inputPolicy,
    outputPolicy,
    debug,
    recentEvents,
    providerConfig,
    runtimeError: "",
  };
}

export function foldRuntimeRawPayload(
  state: OperatorRuntimeViewState,
  payload: Record<string, unknown>,
): OperatorRuntimeViewState {
  let next = state;
  const event = runtimeEventFromPayload(payload);
  if (event) next = appendRuntimeEvent(next, event);
  const body = runtimeBodyFromRawPayload(payload);
  return body ? foldRuntimeBody(next, body) : next;
}

export function appendRuntimeEvent(
  state: OperatorRuntimeViewState,
  event: RuntimeEventView,
): OperatorRuntimeViewState {
  return {
    ...state,
    recentEvents: trimRecentRuntimeEvents([...state.recentEvents, event]),
  };
}

export function runtimeRequestFailed(
  state: OperatorRuntimeViewState,
  error: unknown,
): OperatorRuntimeViewState {
  return {
    ...state,
    runtimeError: errorMessage(error),
  };
}

export function providerSwitchStarted(
  state: OperatorRuntimeViewState,
  targetTransport: string,
): OperatorRuntimeViewState {
  return {
    ...state,
    providerSwitch: { status: "switching", targetTransport, lastError: "" },
  };
}

export function providerSwitchSucceeded(
  state: OperatorRuntimeViewState,
  targetTransport: string,
): OperatorRuntimeViewState {
  return {
    ...state,
    providerSwitch: { status: "active", targetTransport, lastError: "" },
  };
}

export function providerSwitchFailed(
  state: OperatorRuntimeViewState,
  targetTransport: string,
  error: unknown,
): OperatorRuntimeViewState {
  const message = errorMessage(error);
  return {
    ...state,
    runtimeError: message,
    providerSwitch: { status: "failed", targetTransport, lastError: message },
  };
}

export function selectRuntimeProvider(
  providerConfig: LanOperatorLiveProviderConfig | null,
  fallbackTransport: string,
): LanOperatorLiveProviderEntry | null {
  if (!providerConfig) return null;
  const selectedTransport =
    providerConfig.selectedLiveTransport || providerConfig.selectedTransport || fallbackTransport;
  return (
    providerConfig.providers.find((provider) => provider.transport === selectedTransport) ||
    providerConfig.providers.find((provider) => provider.selected) ||
    null
  );
}

function runtimeEventFromPayload(payload: Record<string, unknown>): RuntimeEventView | null {
  if (payload.type !== "runtime_event") return null;
  return isRecord(payload.event) ? (payload.event as RuntimeEventView) : null;
}

function runtimeBodyFromRawPayload(payload: Record<string, unknown>): RuntimeStatusBody | null {
  if (!isRecord(payload.debug)) return null;
  return { debug: payload.debug as OperatorDebug };
}

function trimRecentRuntimeEvents(events: RuntimeEventView[]): RuntimeEventView[] {
  if (events.length <= RECENT_RUNTIME_EVENT_LIMIT) return events;
  return events.slice(-RECENT_RUNTIME_EVENT_LIMIT);
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message || error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
