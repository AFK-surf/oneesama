import { normalizeRealtimeRuntimePlacement } from "../../../packages/core/src/realtime/realtime-browser-init-builder.js";

export function validateRealtimeRuntimePlacementForJoin(
  value: unknown,
  installRealtimeBridge: boolean,
) {
  let realtimeRuntimePlacement = "sidecar";
  try {
    realtimeRuntimePlacement = normalizeRealtimeRuntimePlacement(value);
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: String((error as { message?: string })?.message || error),
    };
  }
  if (installRealtimeBridge && realtimeRuntimePlacement === "inline") {
    return {
      ok: false,
      status: 400,
      error: "inline Realtime SDK on Meet has been removed; use realtimeRuntimePlacement=sidecar",
    };
  }
  return { ok: true, realtimeRuntimePlacement };
}
