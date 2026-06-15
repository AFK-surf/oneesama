import type { OperatorDebug } from "./operatorRuntimeClient.ts";

export function operatorConnectionStatus(
  debug: OperatorDebug,
  realtimeStatus: string | null | undefined,
): string {
  return String(debug.conversation?.status || realtimeStatus || "not_connected") || "not_connected";
}

export function operatorConnectionConnected(
  debug: OperatorDebug,
  realtimeStatus: string | null | undefined,
): boolean {
  return operatorConnectionStatus(debug, realtimeStatus) === "connected";
}
