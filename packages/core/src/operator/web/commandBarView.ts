import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { RealtimeState } from "./useRealtime.ts";
import { canStopKwwkStatus } from "./operatorKwwkStatus.ts";

export type StatusTone = "ok" | "warn" | "bad" | "idle";

export interface CommandBarView {
  selectedTransport: string;
  connectionStatus: string;
  health: string;
  switching: boolean;
  canConnect: boolean;
  canStopAction: boolean;
  providerStatus: "switching" | "selected";
  providerModel: string;
  providerKeySource: string;
  eventsLabel: string;
  eventsTone: StatusTone;
  runtimeTone: StatusTone;
  sessionTone: StatusTone;
  copyEnvDisabled: boolean;
  connectButtonDisabled: boolean;
  stopReplyDisabled: boolean;
  stopActionDisabled: boolean;
}

const STATUS_TONE: Record<string, StatusTone> = {
  connected: "ok",
  connecting: "warn",
  degraded: "warn",
  failed: "bad",
  not_connected: "idle",
};

export function commandBarView(
  runtime: Pick<
    OperatorRuntimeState,
    "debug" | "providerConfig" | "providerSwitch" | "selectedProvider" | "snapshot"
  >,
  realtime: Pick<RealtimeState, "status" | "transport" | "wsOpen">,
): CommandBarView {
  const providerConfig = runtime.providerConfig;
  const selectedProvider = runtime.selectedProvider;
  const selectedTransport =
    selectedProvider?.transport ||
    providerConfig?.selectedLiveTransport ||
    providerConfig?.selectedTransport ||
    realtime.transport;
  const connectionStatus =
    String(runtime.debug.conversation?.status || realtime.status || "not_connected") ||
    "not_connected";
  const health = String(runtime.snapshot?.health || "starting");
  const switching = runtime.providerSwitch.status === "switching";
  const canConnect = realtime.wsOpen && connectionStatus !== "connected";
  const canStopAction = commandBarCanStopAction(runtime.debug);

  return {
    selectedTransport,
    connectionStatus,
    health,
    switching,
    canConnect,
    canStopAction,
    providerStatus: switching ? "switching" : "selected",
    providerModel: selectedProvider?.model || selectedTransport || "unknown",
    providerKeySource: selectedProvider?.keySource || "no key source",
    eventsLabel: realtime.wsOpen ? "ws open" : "ws closed",
    eventsTone: realtime.wsOpen ? "ok" : "idle",
    runtimeTone: health === "ready" ? "ok" : "warn",
    sessionTone: STATUS_TONE[connectionStatus] || "idle",
    copyEnvDisabled: !selectedProvider?.runCommand,
    connectButtonDisabled: !canConnect,
    stopReplyDisabled: !runtime.debug.output?.assistantText?.currentText,
    stopActionDisabled: !canStopAction,
  };
}

export function commandBarCanStopAction(debug: OperatorRuntimeState["debug"]): boolean {
  return (
    canStopKwwkStatus(String(debug.toolRouting?.status || debug.kwwk?.status || "")) ||
    Number(debug.conversation?.control?.inFlight || 0) > 0
  );
}
