import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { appShellView } from "../packages/core/src/operator/web/appShellView.ts";

test("operator app shell view prefers runtime conversation status", () => {
  const view = appShellView(
    { debug: { conversation: { status: "connected" } } },
    { status: "failed" },
  );

  assert.deepEqual(view, {
    connectionStatus: "connected",
    connected: true,
    shellClass: "op op-connected",
  });
});

test("operator app shell view falls back to realtime status", () => {
  const view = appShellView({ debug: {} }, { status: "connecting" });

  assert.deepEqual(view, {
    connectionStatus: "connecting",
    connected: false,
    shellClass: "op op-connecting",
  });
});

test("operator app shell view falls back to not connected", () => {
  const view = appShellView({ debug: {} }, { status: "" });

  assert.deepEqual(view, {
    connectionStatus: "not_connected",
    connected: false,
    shellClass: "op op-not_connected",
  });
});

test("operator app shell view marks degraded sessions disconnected", () => {
  const view = appShellView(
    { debug: { conversation: { status: "degraded" } } },
    { status: "connected" },
  );

  assert.equal(view.connectionStatus, "degraded");
  assert.equal(view.connected, false);
  assert.equal(view.shellClass, "op op-degraded");
});
