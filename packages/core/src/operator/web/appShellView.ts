import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { RealtimeState } from "./useRealtime.ts";
import {
  operatorConnectionConnected,
  operatorConnectionStatus,
} from "./operatorConnectionStatus.ts";

export interface AppShellView {
  connectionStatus: string;
  connected: boolean;
  shellClass: string;
}

export function appShellView(
  runtime: Pick<OperatorRuntimeState, "debug">,
  realtime: Pick<RealtimeState, "status">,
): AppShellView {
  const connectionStatus = operatorConnectionStatus(runtime.debug, realtime.status);
  return {
    connectionStatus,
    connected: operatorConnectionConnected(runtime.debug, realtime.status),
    shellClass: `op op-${connectionStatus}`,
  };
}
