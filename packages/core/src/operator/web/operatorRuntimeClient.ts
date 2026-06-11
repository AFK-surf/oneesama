import type { DebugState } from "../lan-operator-debug-state.ts";
import type {
  LanOperatorLiveProviderConfig,
  LanOperatorLiveProviderEntry,
} from "../lan-operator-live-provider-config.ts";
import { authSuffix } from "./protocol.ts";

export type OperatorDebug = Partial<DebugState> & Record<string, unknown>;

export interface RuntimeEventView {
  id?: string;
  ts?: string;
  phase?: string;
  event?: string;
  severity?: string;
  summary?: string;
  detail?: Record<string, unknown>;
}

export interface RuntimeStatusBody {
  ok?: boolean;
  snapshot?: Record<string, unknown>;
  inputPolicy?: Record<string, unknown>;
  outputPolicy?: Record<string, unknown>;
  debug?: OperatorDebug;
  recentEvents?: RuntimeEventView[];
  liveProviderConfig?: LanOperatorLiveProviderConfig;
  conversationTransport?: string;
  report?: unknown;
  error?: string;
}

export interface ProviderSwitchState {
  status: "idle" | "switching" | "active" | "failed";
  targetTransport: string;
  lastError: string;
}

export interface OperatorRuntimeClient {
  refreshStatus: () => Promise<RuntimeStatusBody>;
  switchProvider: (transport: string) => Promise<RuntimeStatusBody>;
  fetchReportText: () => Promise<string>;
}

export type { LanOperatorLiveProviderConfig, LanOperatorLiveProviderEntry };

export function extractLiveProviderConfig(
  body: RuntimeStatusBody,
): LanOperatorLiveProviderConfig | null {
  const direct = body.liveProviderConfig;
  if (direct) return direct;
  const fromDebug = body.debug?.surfaceContext as
    | { liveProviderConfig?: LanOperatorLiveProviderConfig }
    | undefined;
  return fromDebug?.liveProviderConfig || null;
}

export function createOperatorRuntimeClient(token: string | undefined): OperatorRuntimeClient {
  return {
    refreshStatus: () => jsonRequest(token, "/runtime/status"),
    switchProvider: (transport: string) =>
      jsonRequest(token, "/runtime/provider", {
        method: "POST",
        body: JSON.stringify({ transport, connect: true }),
      }),
    fetchReportText: async () => {
      const body = await jsonRequest(token, "/runtime/report");
      return JSON.stringify(body.report || body, null, 2);
    },
  };
}

async function jsonRequest(
  token: string | undefined,
  path: string,
  init?: RequestInit,
): Promise<RuntimeStatusBody> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(authSuffix(token, path), {
    cache: "no-store",
    ...init,
    headers,
  });
  const body = (await response.json().catch(() => ({}))) as RuntimeStatusBody;
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `runtime_request_failed:${response.status}`);
  }
  return body;
}
