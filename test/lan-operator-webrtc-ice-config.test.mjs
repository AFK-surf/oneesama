import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import {
  createLanOperatorSurfaceServer,
  parseLanOperatorWebrtcIceServers,
} from "../packages/core/src/operator/lan-operator-surface.ts";

async function waitForRuntimeStatus(url, predicate, timeoutMs = 5_000) {
  const statusUrl = new URL("/runtime/status", url);
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(statusUrl)).json();
    lastBody = body;
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime_status_timeout: ${JSON.stringify(lastBody)}`);
}

test("LAN operator WebRTC ICE server config accepts URLs and JSON", () => {
  assert.deepEqual(parseLanOperatorWebrtcIceServers("stun:stun.l.google.com:19302"), [
    { urls: "stun:stun.l.google.com:19302" },
  ]);
  assert.deepEqual(
    parseLanOperatorWebrtcIceServers(
      '[{"urls":["turn:turn.example.test:3478?transport=tcp"],"username":"operator","credential":"secret"}]',
    ),
    [
      {
        urls: ["turn:turn.example.test:3478?transport=tcp"],
        username: "operator",
        credential: "secret",
      },
    ],
  );
});

test("LAN operator surface exposes configured WebRTC ICE servers to visual peers", async () => {
  const webrtcIceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:turn.example.test:3478?transport=tcp",
      username: "operator",
      credential: "secret",
    },
  ];
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-ice-config",
    botName: "LAN Oneesama",
    webrtcIceServers,
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });

    const pageState = await page.evaluate(() => ({
      iceServers: window.MAB_LAN_OPERATOR_SURFACE.state.webrtcIceServers,
    }));
    const publisherPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const publisherUrl = new URL("/host-visual", url);
    publisherUrl.searchParams.set("diagnostic", "1");
    publisherUrl.searchParams.set("sourceId", "host-app");
    publisherUrl.searchParams.set("label", "App view");
    publisherUrl.searchParams.set("kind", "desktop_app");
    await publisherPage.goto(publisherUrl.toString());
    await publisherPage.waitForFunction(
      () => window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.trackReadyState === "live",
      null,
      { timeout: 10_000 },
    );
    const publisherState = await publisherPage.evaluate(() => ({
      iceServers: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.webrtcIceServers,
    }));
    const body = await waitForRuntimeStatus(
      url,
      (nextBody) => nextBody.debug.surfaceContext.visual.iceServerCount === 2,
    );

    assert.deepEqual(pageState.iceServers, webrtcIceServers);
    assert.deepEqual(publisherState.iceServers, webrtcIceServers);
    assert.equal(body.debug.surfaceContext.visual.iceServerCount, 2);
  } finally {
    await browser.close();
    await surface.close();
  }
});
