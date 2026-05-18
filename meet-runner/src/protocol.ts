import type { JsonRpcFailure, JsonRpcRequest, JsonRpcSuccess } from "./types.ts";

export function parseRequestLine(raw: string): JsonRpcRequest {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("empty request");
  }
  return JSON.parse(trimmed) as JsonRpcRequest;
}

export function success(id: JsonRpcRequest["id"], result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function failure(id: JsonRpcRequest["id"], message: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

// IMPORTANT: stdout is the Go <-> meet-runner JSON-RPC channel.
// Use stderr/console.error for diagnostics; any stdout log can corrupt join responses.
export function writeResponse(response: JsonRpcSuccess | JsonRpcFailure): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
