import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { ensureAppControlHelperBinary } from "../meeting/app-control-helper.ts";
import type { KwwkTransport } from "./work-ax-surface.ts";

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface KwwkStdioTransportOptions {
  requestTimeoutMs?: number;
  /** Inject a binary path / spawned process for tests; defaults to the built helper. */
  binaryPath?: string;
}

/**
 * Default `KwwkTransport`: a persistent `--stdio` kwwk-cu helper process with
 * newline-framed JSON-RPC and id correlation (the meeting path spawns one
 * process per call; the stepwise loop needs many round-trips on one process).
 */
export async function createKwwkStdioTransport(
  options: KwwkStdioTransportOptions = {},
): Promise<KwwkTransport> {
  const requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs || 30_000));
  const binary = options.binaryPath || (await ensureAppControlHelperBinary());
  const child: ChildProcessWithoutNullStreams = spawn(binary, ["--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const pending = new Map<string, Pending>();
  let buffer = "";
  let seq = 0;

  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = String(message.id || "");
      const waiter = pending.get(id);
      if (!waiter) continue;
      pending.delete(id);
      clearTimeout(waiter.timer);
      const result =
        message.result && typeof message.result === "object"
          ? (message.result as Record<string, unknown>)
          : message;
      waiter.resolve(result);
    }
  });

  const failAll = (error: Error) => {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  child.on("error", (error) => failAll(error instanceof Error ? error : new Error(String(error))));
  child.on("exit", () => failAll(new Error("kwwk_helper_exited")));

  function request(method: string, params: Record<string, unknown>) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      seq += 1;
      const id = `work_ax_${seq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`kwwk_request_timeout:${method}`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async function close() {
    failAll(new Error("kwwk_transport_closed"));
    child.stdin.end();
    child.kill("SIGTERM");
  }

  return { request, close };
}
