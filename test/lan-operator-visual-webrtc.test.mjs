import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";

async function waitForRuntimeStatus(url, predicate, timeoutMs = 8_000) {
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

test("LAN operator receives Host Visual Stream over WebRTC and composes the track", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-host-visual-webrtc-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const operatorPage = await context.newPage();
    await operatorPage.goto(url);
    await operatorPage.waitForFunction(
      () =>
        window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true &&
        window.MAB_LAN_OPERATOR_SURFACE.state.visual.receiverWebSocketState === "open",
      null,
      { timeout: 10_000 },
    );

    async function openPublisher(sourceId, label, kind, input = {}) {
      const publisherPage = await context.newPage();
      const publisherUrl = new URL("/host-visual", url);
      if (input.avatar) publisherUrl.searchParams.set("avatar", "1");
      else publisherUrl.searchParams.set("diagnostic", "1");
      publisherUrl.searchParams.set("sourceId", sourceId);
      publisherUrl.searchParams.set("label", label);
      publisherUrl.searchParams.set("kind", kind);
      await publisherPage.goto(publisherUrl.toString());
      await publisherPage.waitForFunction(
        () => window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.trackReadyState === "live",
        null,
        { timeout: 10_000 },
      );
      return publisherPage;
    }
    await openPublisher("host-app", "Host app", "desktop_app");
    const avatarPublisher = await openPublisher("avatar", "Avatar", "avatar", { avatar: true });

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) => {
        const source = nextBody.debug.visual.sources.find((entry) => entry.id === "host-app");
        const avatar = nextBody.debug.visual.sources.find((entry) => entry.id === "avatar");
        return (
          nextBody.debug.visual.connectionState === "connected" &&
          nextBody.debug.visual.trackCount >= 2 &&
          nextBody.debug.visual.receiverWebSocketState === "open" &&
          nextBody.debug.visual.hostPublisherConnections >= 2 &&
          source?.state === "live" &&
          source?.trackReadyState === "live" &&
          avatar?.state === "live" &&
          avatar?.trackReadyState === "live" &&
          Number(source?.width) > 0 &&
          Number(source?.height) > 0 &&
          Number(avatar?.width) > 0 &&
          Number(avatar?.height) > 0 &&
          source?.frameAgeMs != null &&
          Number(source?.frameAgeMs) < 1200 &&
          avatar?.frameAgeMs != null &&
          Number(avatar?.frameAgeMs) < 1200
        );
      },
      10_000,
    );
    const operatorVisual = await operatorPage.evaluate(() => ({
      state: window.MAB_LAN_OPERATOR_SURFACE.state.visual,
      source: window.MAB_LAN_OPERATOR_SURFACE.state.sources.find(
        (entry) => entry.id === "host-app",
      ),
      avatar: window.MAB_LAN_OPERATOR_SURFACE.state.sources.find((entry) => entry.id === "avatar"),
      hasVideo: Boolean(
        window.MAB_LAN_OPERATOR_SURFACE.visualReceiver?.()?.sourceVideo("host-app"),
      ),
      hasAvatarVideo: Boolean(
        window.MAB_LAN_OPERATOR_SURFACE.visualReceiver?.()?.sourceVideo("avatar"),
      ),
      composition: window.MAB_LAN_OPERATOR_SURFACE.currentComposition(),
    }));
    const avatarPublisherState = await avatarPublisher.evaluate(
      () => window.MAB_LAN_HOST_VISUAL_PUBLISHER.state,
    );

    const hostSource = body.debug.visual.sources.find((entry) => entry.id === "host-app");
    const avatarSource = body.debug.visual.sources.find((entry) => entry.id === "avatar");
    assert.equal(body.ok, true);
    assert.equal(body.debug.visual.transport, "webrtc");
    assert.equal(body.debug.visual.connectionState, "connected");
    assert.equal(body.debug.visual.receiverWebSocketState, "open");
    assert.ok(
      ["checking", "connected", "completed"].includes(body.debug.visual.iceConnectionState),
    );
    assert.ok(["connecting", "connected"].includes(body.debug.visual.peerConnectionState));
    assert.ok(body.debug.visual.trackCount >= 2);
    assert.ok(body.debug.visual.hostPublisherConnections >= 2);
    assert.equal(hostSource.state, "live");
    assert.equal(avatarSource.state, "live");
    assert.equal(avatarSource.kind, "avatar");
    assert.ok(hostSource.streamId, JSON.stringify(hostSource));
    assert.ok(avatarSource.streamId, JSON.stringify(avatarSource));
    assert.ok(hostSource.trackId, JSON.stringify(hostSource));
    assert.ok(avatarSource.trackId, JSON.stringify(avatarSource));
    assert.equal(hostSource.trackReadyState, "live");
    assert.equal(avatarSource.trackReadyState, "live");
    assert.equal(hostSource.sourceMode, "diagnostic_canvas");
    assert.equal(hostSource.captureStatus, "live");
    assert.equal(avatarSource.sourceMode, "avatar_renderer");
    assert.equal(avatarSource.captureStatus, "live");
    assert.equal(avatarSource.avatarReady, true);
    assert.equal(avatarSource.avatarRenderer, "fallback");
    assert.equal(avatarPublisherState.sourceMode, "avatar_renderer");
    assert.equal(avatarPublisherState.avatarReady, true);
    assert.equal(avatarPublisherState.avatarRenderer, "fallback");
    assert.ok(hostSource.width > 0, JSON.stringify(hostSource));
    assert.ok(hostSource.height > 0, JSON.stringify(hostSource));
    assert.ok(hostSource.frameAgeMs < 1200, JSON.stringify(hostSource));
    assert.ok(avatarSource.frameAgeMs < 1200, JSON.stringify(avatarSource));
    assert.equal(operatorVisual.hasVideo, true);
    assert.equal(operatorVisual.hasAvatarVideo, true);
    assert.equal(operatorVisual.source.state, "live");
    assert.equal(operatorVisual.avatar.state, "live");
    assert.equal(operatorVisual.composition.localComposedTrack, true);
    assert.ok(
      body.recentEvents.some((event) => event.event === "host_visual_stream_state_updated"),
      JSON.stringify(body.recentEvents),
    );

    await context.close();
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator records Host Visual source metrics from receiver video frames", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-host-visual-receiver-frame-metrics",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const operatorPage = await context.newPage();
    await operatorPage.goto(url);
    await operatorPage.waitForFunction(
      () =>
        window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true &&
        window.MAB_LAN_OPERATOR_SURFACE.state.visual.receiverWebSocketState === "open",
      null,
      { timeout: 10_000 },
    );
    await operatorPage.evaluate(() => {
      const receiver = window.MAB_LAN_OPERATOR_SURFACE.visualReceiver?.();
      receiver.noteSourceRendered = () => undefined;
    });

    const publisherPage = await context.newPage();
    const publisherUrl = new URL("/host-visual", url);
    publisherUrl.searchParams.set("diagnostic", "1");
    publisherUrl.searchParams.set("sourceId", "host-app");
    publisherUrl.searchParams.set("label", "Host app");
    publisherUrl.searchParams.set("kind", "desktop_app");
    await publisherPage.goto(publisherUrl.toString());
    await publisherPage.waitForFunction(
      () => window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.trackReadyState === "live",
      null,
      { timeout: 10_000 },
    );

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) => {
        const source = nextBody.debug.visual.sources.find((entry) => entry.id === "host-app");
        return (
          source?.state === "live" &&
          source?.trackReadyState === "live" &&
          Number(source?.width) > 0 &&
          Number(source?.height) > 0 &&
          Number(source?.frameRate) >= 15 &&
          source?.frameAgeMs != null &&
          Number(source.frameAgeMs) < 1200
        );
      },
      10_000,
    );
    const operatorProbe = await operatorPage.evaluate(() => ({
      receiverVideoAttached: Boolean(
        document.querySelector('video[data-lan-visual-source-id="host-app"]'),
      ),
      source: window.MAB_LAN_OPERATOR_SURFACE.state.sources.find(
        (entry) => entry.id === "host-app",
      ),
    }));
    const source = body.debug.visual.sources.find((entry) => entry.id === "host-app");

    assert.equal(operatorProbe.receiverVideoAttached, true);
    assert.ok(source.width > 0, JSON.stringify(source));
    assert.ok(source.height > 0, JSON.stringify(source));
    assert.ok(source.frameRate >= 15, JSON.stringify(source));
    assert.ok(source.frameAgeMs < 1200, JSON.stringify(source));

    await context.close();
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("Host Visual publishers republish when the operator receiver joins late", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-host-visual-late-receiver-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });

    async function openPublisher(sourceId, label, kind, input = {}) {
      const publisherPage = await context.newPage();
      const publisherUrl = new URL("/host-visual", url);
      if (input.avatar) publisherUrl.searchParams.set("avatar", "1");
      else publisherUrl.searchParams.set("diagnostic", "1");
      publisherUrl.searchParams.set("sourceId", sourceId);
      publisherUrl.searchParams.set("label", label);
      publisherUrl.searchParams.set("kind", kind);
      await publisherPage.goto(publisherUrl.toString());
      await publisherPage.waitForFunction(
        () => window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.trackReadyState === "live",
        null,
        { timeout: 10_000 },
      );
      return publisherPage;
    }

    await Promise.all([
      openPublisher("host-app", "Host app", "desktop_app"),
      openPublisher("avatar", "Avatar", "avatar", { avatar: true }),
    ]);

    const operatorPage = await context.newPage();
    await operatorPage.goto(url);
    await operatorPage.waitForFunction(
      () =>
        window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true &&
        window.MAB_LAN_OPERATOR_SURFACE.state.visual.receiverWebSocketState === "open",
      null,
      { timeout: 10_000 },
    );

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) => {
        const source = nextBody.debug.visual.sources.find((entry) => entry.id === "host-app");
        const avatar = nextBody.debug.visual.sources.find((entry) => entry.id === "avatar");
        return (
          nextBody.debug.visual.connectionState === "connected" &&
          nextBody.debug.visual.trackCount >= 2 &&
          source?.state === "live" &&
          avatar?.state === "live" &&
          avatar?.sourceMode === "avatar_renderer" &&
          avatar?.avatarRenderer === "fallback"
        );
      },
      10_000,
    );
    const source = body.debug.visual.sources.find((entry) => entry.id === "host-app");
    const avatar = body.debug.visual.sources.find((entry) => entry.id === "avatar");
    assert.equal(source.trackReadyState, "live");
    assert.equal(avatar.trackReadyState, "live");
    assert.equal(avatar.avatarReady, true);

    await context.close();
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator restores Host Visual Stream after publisher signaling reconnect", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-host-visual-reconnect-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const operatorPage = await context.newPage();
    await operatorPage.goto(url);
    await operatorPage.waitForFunction(
      () =>
        window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true &&
        window.MAB_LAN_OPERATOR_SURFACE.state.visual.receiverWebSocketState === "open",
      null,
      { timeout: 10_000 },
    );

    const publisherPage = await context.newPage();
    const publisherUrl = new URL("/host-visual", url);
    publisherUrl.searchParams.set("diagnostic", "1");
    publisherUrl.searchParams.set("sourceId", "host-app");
    publisherUrl.searchParams.set("label", "Host app");
    publisherUrl.searchParams.set("kind", "desktop_app");
    await publisherPage.goto(publisherUrl.toString());
    await publisherPage.waitForFunction(
      () =>
        window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.trackReadyState === "live" &&
        window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.transport?.hostVisual?.state === "open",
      null,
      { timeout: 10_000 },
    );
    await waitForRuntimeStatus(
      url,
      (nextBody) => {
        const source = nextBody.debug.visual.sources.find((entry) => entry.id === "host-app");
        return (
          nextBody.debug.transport.hostVisual.state === "open" &&
          nextBody.debug.visual.connectionState === "connected" &&
          source?.state === "live" &&
          source?.frameAgeMs != null &&
          Number(source.frameAgeMs) < 1200
        );
      },
      10_000,
    );

    await publisherPage.evaluate(() => window.MAB_LAN_HOST_VISUAL_PUBLISHER.forceCloseTransport());
    await publisherPage.waitForFunction(
      () => {
        const connection = window.MAB_LAN_HOST_VISUAL_PUBLISHER.state.transport?.hostVisual;
        return (
          connection?.reconnectCount >= 1 &&
          connection?.connectCount >= 2 &&
          connection?.state === "open"
        );
      },
      null,
      { timeout: 10_000 },
    );

    const body = await waitForRuntimeStatus(
      url,
      (nextBody) => {
        const source = nextBody.debug.visual.sources.find((entry) => entry.id === "host-app");
        return (
          nextBody.debug.transport.hostVisual.state === "open" &&
          nextBody.debug.transport.hostVisual.reconnectCount >= 1 &&
          nextBody.debug.transport.hostVisual.connectCount >= 2 &&
          nextBody.debug.transport.hostVisual.lastDisconnectedAt &&
          nextBody.debug.visual.connectionState === "connected" &&
          nextBody.debug.visual.trackCount >= 1 &&
          source?.state === "live" &&
          source?.frameAgeMs != null &&
          Number(source.frameAgeMs) < 1200
        );
      },
      15_000,
    );
    const publisherState = await publisherPage.evaluate(
      () => window.MAB_LAN_HOST_VISUAL_PUBLISHER.state,
    );
    const panel = await operatorPage.evaluate(() => ({
      transport: document.getElementById("debug-transport-table")?.innerText || "",
      source: window.MAB_LAN_OPERATOR_SURFACE.state.sources.find(
        (entry) => entry.id === "host-app",
      ),
    }));

    assert.equal(body.debug.transport.hostVisual.state, "open");
    assert.ok(body.debug.transport.hostVisual.lastDisconnectedAt);
    assert.equal(publisherState.transport.hostVisual.state, "open");
    assert.ok(publisherState.transport.hostVisual.reconnectCount >= 1);
    assert.equal(panel.source.state, "live");
    assert.match(panel.transport, /hostVisual/);
    assert.ok(
      body.debug.timeline.rows.some(
        (row) => row.layer === "transport" && row.event.includes("visual_host"),
      ),
      JSON.stringify(body.debug.timeline),
    );

    await context.close();
  } finally {
    await browser.close();
    await surface.close();
  }
});
