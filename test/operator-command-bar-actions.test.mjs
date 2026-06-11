import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  copyProviderRunCommand,
  shouldResetRealtimeSession,
} from "../packages/core/src/operator/web/commandBarActions.ts";

test("operator command bar actions copy provider run commands", async () => {
  const writes = [];
  const copied = await copyProviderRunCommand("ONEESAMA=1 vp run dev", {
    writeText: async (text) => writes.push(text),
  });

  assert.equal(copied, true);
  assert.deepEqual(writes, ["ONEESAMA=1 vp run dev"]);
});

test("operator command bar actions skip missing copy inputs", async () => {
  assert.equal(await copyProviderRunCommand("", { writeText: async () => undefined }), false);
  assert.equal(await copyProviderRunCommand("cmd", null), false);
  assert.equal(await copyProviderRunCommand("cmd", {}), false);
});

test("operator command bar actions ignore clipboard write failures", async () => {
  const copied = await copyProviderRunCommand("cmd", {
    writeText: async () => {
      throw new Error("clipboard denied");
    },
  });

  assert.equal(copied, true);
});

test("operator command bar actions confirm realtime reset with default copy", () => {
  const messages = [];
  assert.equal(
    shouldResetRealtimeSession((message) => {
      messages.push(message);
      return true;
    }),
    true,
  );
  assert.deepEqual(messages, ["Reset the Realtime session?"]);
});

test("operator command bar actions support reset rejection", () => {
  assert.equal(
    shouldResetRealtimeSession(() => false),
    false,
  );
});
