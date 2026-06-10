import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "vite-plus/test";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";

// Probe the WS upgrade with a raw HTTP request so the assertion is on the
// exact status line (101 accepted vs 401 rejected), independent of any
// test-environment WebSocket implementation quirks.
function upgradeProbe(baseUrl, pathWithQuery) {
  return new Promise((resolve) => {
    const base = new URL(baseUrl);
    const target = new URL(pathWithQuery, base);
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.from("0123456789012345").toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(-1));
    req.setTimeout(4000, () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}

test("LAN operator surface gates HTTP and WS behind the access token", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-auth-token-test",
    accessToken: "secret-token-1",
  });
  const { url } = await surface.listen();
  try {
    const denied = await fetch(new URL("/operator", url));
    assert.equal(denied.status, 401);

    const deniedStatus = await fetch(new URL("/runtime/status", url));
    assert.equal(deniedStatus.status, 401);

    const deniedProvider = await fetch(new URL("/runtime/provider", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transport: "openai_realtime" }),
    });
    assert.equal(deniedProvider.status, 401);

    const allowedQuery = await fetch(new URL("/operator?token=secret-token-1", url));
    assert.equal(allowedQuery.status, 200);

    const allowedHeader = await fetch(new URL("/runtime/status", url), {
      headers: { authorization: "Bearer secret-token-1" },
    });
    assert.equal(allowedHeader.status, 200);

    assert.equal(await upgradeProbe(url, "/operator/events/ws"), 401);
    assert.equal(await upgradeProbe(url, "/operator/events/ws?token=wrong"), 401);
    assert.equal(await upgradeProbe(url, "/operator/events/ws?token=secret-token-1"), 101);
    assert.equal(await upgradeProbe(url, "/operator/voice/ws?token=secret-token-1"), 101);
    assert.equal(await upgradeProbe(url, "/host/visual/ws?token=secret-token-1"), 101);
  } finally {
    await surface.close();
  }
});

test("LAN operator surface stays open when no access token is configured", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-auth-open-test",
    accessToken: "",
  });
  const { url } = await surface.listen();
  try {
    const page = await fetch(new URL("/operator", url));
    assert.equal(page.status, 200);
    assert.equal(await upgradeProbe(url, "/operator/events/ws"), 101);
  } finally {
    await surface.close();
  }
});
