import type { OperatorRuntimeState } from "./useOperatorRuntime.ts";
import type { RealtimeState } from "./useRealtime.ts";

export interface AppShellView {
  connectionStatus: string;
  connected: boolean;
  shellClass: string;
}

export function appShellView(
  runtime: Pick<OperatorRuntimeState, "debug">,
  realtime: Pick<RealtimeState, "status">,
): AppShellView {
  const rawStatus = runtime.debug.conversation?.status || realtime.status;
  const connectionStatus = String(rawStatus || "not_connected");
  return {
    connectionStatus,
    connected: String(rawStatus) === "connected",
    shellClass: `op op-${connectionStatus}`,
  };
}
