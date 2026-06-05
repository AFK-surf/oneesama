import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vite-plus/test";

import { waitForChildProcessExit } from "../packages/core/src/meeting/meeting-recorder.ts";

function fakeChildProcess({ killed = false, exitCode = null, signalCode = null } = {}) {
  const child = new EventEmitter();
  child.killed = killed;
  child.exitCode = exitCode;
  child.signalCode = signalCode;
  return child;
}

test("waitForChildProcessExit does not treat a sent signal as process exit", async () => {
  const child = fakeChildProcess({ killed: true });
  const startedAt = Date.now();
  const exited = await waitForChildProcessExit(child, 25);

  assert.equal(exited, false);
  assert.ok(Date.now() - startedAt >= 20, "must wait for an exit/close event or timeout");
});

test("waitForChildProcessExit resolves when the child emits exit", async () => {
  const child = fakeChildProcess();
  setTimeout(() => child.emit("exit", 0, null), 10);

  assert.equal(await waitForChildProcessExit(child, 100), true);
});
