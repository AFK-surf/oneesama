import type { JsonRpcFailure, JsonRpcRequest, JsonRpcSuccess } from "./types.ts";

const maxInlineRPCStringChars = 8192;

export function parseRequestLine(raw: string): JsonRpcRequest {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("empty request");
  }
  return JSON.parse(trimmed) as JsonRpcRequest;
}

export function success(id: JsonRpcRequest["id"], result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result: sanitizeRPCPayload(result) };
}

export function failure(id: JsonRpcRequest["id"], message: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

export function sanitizeRPCPayload(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:")) {
      const mime = value.slice(5, value.indexOf(";") > 5 ? value.indexOf(";") : 64);
      return `[data URL omitted: ${mime || "unknown"}, chars=${value.length}]`;
    }
    if (value.length > maxInlineRPCStringChars) {
      return `[long string omitted: chars=${value.length}]`;
    }
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth > 12) return "[nested value omitted]";
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeRPCPayload(entry, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = sanitizeRPCPayload(entry, depth + 1);
  }
  return output;
}

// IMPORTANT: stdout is the Go <-> meet-runner JSON-RPC channel.
// Use stderr/console.error for diagnostics; any stdout log can corrupt join responses.
export function writeResponse(response: JsonRpcSuccess | JsonRpcFailure): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
