import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("app-control helper serves stdio JSON-RPC on macOS", { skip: process.platform !== "darwin" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "oneesama-app-control-helper-test-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "packages/core/src/meeting/app-control-helper.ts", "--stdio"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ONEESAMA_APP_CONTROL_HELPER: join(dir, "helper"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: "1", method: "list_apps", params: {} })}\n`);
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, 0, stderr.join(""));

  const lines = stdout.join("").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, "1");
  assert.equal(response.result.ok, true);
  assert.ok(Array.isArray(response.result.applications));
});
