import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";

// Phase 3b cursor-parity: the operator stage must render a Cueboard-standard
// cursor (arrow + ring + click pulse + drag trail + label), not a flat
// crosshair, with rendered-pixel proof (canvas pixels actually change).
test("LAN operator stage renders a Cueboard cursor with rendered-pixel proof", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-cursor-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });

    // The pointer fixture + Cueboard renderer must be wired into the page.
    const wired = await page.evaluate(() => ({
      fixture: typeof window.MAB_LAN_OPERATOR_SURFACE.runKwwkCursorFixture === "function",
      renderer: Boolean(window.MAB_LAN_OPERATOR_KWWK_CURSOR),
      button: Boolean(document.getElementById("cu-cursor-button")),
    }));
    assert.equal(wired.fixture, true, JSON.stringify(wired));
    assert.equal(wired.renderer, true, JSON.stringify(wired));
    assert.equal(wired.button, true, JSON.stringify(wired));

    const result = await page.evaluate(async () => {
      const canvas = document.getElementById("composition");
      const ctx = canvas.getContext("2d");
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
      await raf();
      await raf();
      const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      window.MAB_LAN_OPERATOR_SURFACE.runKwwkCursorFixture({ animated: false });
      for (let k = 0; k < 5; k += 1) await raf();
      const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let changed = 0;
      for (let i = 0; i < before.length; i += 4) {
        const delta =
          Math.abs(after[i] - before[i]) +
          Math.abs(after[i + 1] - before[i + 1]) +
          Math.abs(after[i + 2] - before[i + 2]);
        if (delta > 36) changed += 1;
      }
      const artifact = window.MAB_LAN_OPERATOR_KWWK_CURSOR.artifact();
      const eventKinds = new Set(artifact.events.map((e) => e.kind));
      return {
        renderedRatio: changed / (before.length / 4),
        trailPoints: artifact.trail.length,
        hasClick: eventKinds.has("cursor.click"),
        hasDrag: eventKinds.has("cursor.drag"),
        styles: artifact.styles,
        latestVisible: artifact.latest.visible,
      };
    });

    // Rendered-pixel proof: the cursor actually painted onto the canvas.
    assert.ok(
      result.renderedRatio >= 0.0008,
      `cursor rendered ratio too low: ${JSON.stringify(result)}`,
    );
    // Cueboard standard: click pulse + drag trail + target ring + drag evidence.
    assert.equal(result.hasClick, true, JSON.stringify(result));
    assert.equal(result.hasDrag, true, JSON.stringify(result));
    assert.ok(result.trailPoints >= 2, `drag trail too short: ${JSON.stringify(result)}`);
    assert.equal(result.styles.clickPulse, true, JSON.stringify(result));
    assert.equal(result.styles.dragTrail, true, JSON.stringify(result));
    assert.equal(result.styles.targetRing, true, JSON.stringify(result));
    assert.equal(result.latestVisible, true, JSON.stringify(result));
    assert.deepEqual(consoleErrors, [], consoleErrors.join("\n"));
  } finally {
    await browser.close();
    await surface.close();
  }
});

// The "CU Cursor" toolbar button drives the animated fixture end to end.
test("LAN operator CU Cursor button drives the pointer fixture", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-cursor-button-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });

    await page.click("#diagnostic-controls > summary");
    await page.click("#cu-cursor-button");
    // The animated fixture steps over time; wait until the trail has accumulated.
    await page.waitForFunction(
      () => {
        const art = window.MAB_LAN_OPERATOR_KWWK_CURSOR?.artifact();
        return (
          Boolean(art) && art.trail.length >= 2 && art.events.some((e) => e.kind === "cursor.drag")
        );
      },
      null,
      { timeout: 5_000 },
    );
    const visible = await page.evaluate(
      () => window.MAB_LAN_OPERATOR_KWWK_CURSOR.snapshot().visible,
    );
    assert.equal(visible, true);
  } finally {
    await browser.close();
    await surface.close();
  }
});

// B+C: a REAL cursor event arriving at the server (the seam upstream "A" will
// use; here simulated via surface.emitKwwkCursor) is pushed over the events
// websocket and renders on the stage — WITHOUT touching the demo button/fixture.
// This proves the operator-side real-event channel is wired (renderer fed from
// the inbound channel) with rendered-pixel proof + server-side evidence count.
test("LAN operator stage renders a REAL inbound KWWK cursor event (server → stage), not the demo fixture", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-cursor-inbound-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });
    // The events websocket must be open so server broadcasts reach the stage.
    await page.waitForFunction(
      () => window.MAB_LAN_OPERATOR_SURFACE?.state?.transport?.events?.state === "open",
      null,
      { timeout: 10_000 },
    );

    // Baseline (cursor-free: no fixture/button has run).
    await page.evaluate(async () => {
      const c = document.getElementById("composition");
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
      await raf();
      await raf();
      window.__cursorBefore = c.getContext("2d").getImageData(0, 0, c.width, c.height).data.slice();
    });

    // Simulate UPSTREAM A: real cursor events land on the server → pushed to stage.
    const seq = [
      { x: 0.4, y: 0.38, kind: "move", label: "real approach" },
      { x: 0.44, y: 0.41, kind: "click", label: "real click" },
      { x: 0.52, y: 0.48, kind: "drag", label: "real drag" },
      { x: 0.6, y: 0.55, kind: "drag", label: "real drag" },
    ];
    for (const cursor of seq) surface.emitKwwkCursor(cursor);

    // The browser receives the inbound events and renders them.
    await page.waitForFunction(
      () => {
        const art = window.MAB_LAN_OPERATOR_KWWK_CURSOR?.artifact();
        return (
          Boolean(art) &&
          art.events.length >= 4 &&
          art.events.some((e) => e.kind === "cursor.click") &&
          art.events.some((e) => e.kind === "cursor.drag")
        );
      },
      null,
      { timeout: 5_000 },
    );

    const result = await page.evaluate(async () => {
      const canvas = document.getElementById("composition");
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
      for (let k = 0; k < 5; k += 1) await raf();
      const after = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const before = window.__cursorBefore;
      let changed = 0;
      for (let i = 0; i < before.length; i += 4) {
        const delta =
          Math.abs(after[i] - before[i]) +
          Math.abs(after[i + 1] - before[i + 1]) +
          Math.abs(after[i + 2] - before[i + 2]);
        if (delta > 36) changed += 1;
      }
      const art = window.MAB_LAN_OPERATOR_KWWK_CURSOR.artifact();
      const overlays = window.MAB_LAN_OPERATOR_SURFACE.state.overlays || [];
      return {
        renderedRatio: changed / (before.length / 4),
        trail: art.trail.length,
        hasClick: art.events.some((e) => e.kind === "cursor.click"),
        hasDrag: art.events.some((e) => e.kind === "cursor.drag"),
        remoteOverlays: overlays.filter((o) => o.remote === true).length,
        nonRemoteOverlays: overlays.filter((o) => o.remote !== true).length,
        visible: art.latest.visible,
      };
    });

    // Rendered-pixel proof: the REAL inbound cursor actually painted on the stage.
    assert.ok(
      result.renderedRatio >= 0.0008,
      `inbound cursor rendered ratio too low: ${JSON.stringify(result)}`,
    );
    assert.equal(result.hasClick, true, JSON.stringify(result));
    assert.equal(result.hasDrag, true, JSON.stringify(result));
    assert.ok(result.trail >= 2, `inbound drag trail too short: ${JSON.stringify(result)}`);
    assert.equal(result.visible, true, JSON.stringify(result));
    // It rendered via the inbound (remote) channel, NOT the demo button/fixture.
    assert.ok(
      result.remoteOverlays >= 4,
      `expected >=4 remote overlays from inbound channel: ${JSON.stringify(result)}`,
    );
    assert.equal(result.nonRemoteOverlays, 0, JSON.stringify(result));

    // Server-side real evidence: cursorEventCount incremented through the operator
    // path (this is the count the tightened acceptance SLO requires).
    const body = surface.status();
    assert.ok(
      Number(body.debug.kwwk.cursorEventCount) >= 4,
      `server cursorEventCount not incremented: ${body.debug.kwwk.cursorEventCount}`,
    );
    assert.deepEqual(consoleErrors, [], consoleErrors.join("\n"));
  } finally {
    await browser.close();
    await surface.close();
  }
});
