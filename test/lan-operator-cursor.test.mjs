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
      await raf();
      await raf();
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
