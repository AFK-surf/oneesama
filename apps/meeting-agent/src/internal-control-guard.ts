import type { IncomingMessage } from "node:http";

const internalAuthHeader = "x-oneesama-internal-key";

export function meetingAgentControlRequestRejected(
  req: IncomingMessage,
  options: { internalAuthKey?: string } = {},
) {
  const configuredKey = String(options.internalAuthKey || "").trim();
  const providedKey = String(req.headers[internalAuthHeader] || "").trim();
  if (configuredKey && providedKey === configuredKey) return null;

  const origin = String(req.headers.origin || "").trim();
  if (!origin) return null;

  const host = String(req.headers.host || "").trim();
  if (host && originMatchesHost(origin, host)) return null;

  return {
    status: 403,
    body: {
      ok: false,
      error: "cross_origin_internal_control_forbidden",
      header: "X-Oneesama-Internal-Key",
    },
  };
}

export function realtimeToolRouteRejected(
  toolName: string,
  exposedTools: Array<{ name?: string }>,
) {
  const allowed = new Set(exposedTools.map((tool) => String(tool.name || "")));
  const compatibilityAllowed = new Set(["control_shared_app_window"]);
  if (allowed.has(toolName)) return null;
  if (compatibilityAllowed.has(toolName)) return null;
  return {
    status: 404,
    body: {
      ok: false,
      error: "hidden_realtime_tool_not_exposed",
      toolName,
    },
  };
}

function originMatchesHost(origin: string, host: string) {
  try {
    const parsed = new URL(origin);
    return parsed.host === host;
  } catch {
    return false;
  }
}
