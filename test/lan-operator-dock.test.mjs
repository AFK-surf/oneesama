import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";

async function dockState(page) {
  return await page.evaluate(() => ({
    dock: document.querySelector("main")?.dataset.dock || "",
    summonHidden: document.getElementById("dock-summon")?.hidden !== false,
    debugVisible: (() => {
      const shell = document.getElementById("debug-panel");
      return Boolean(shell) && getComputedStyle(shell).display !== "none";
    })(),
    dockW: getComputedStyle(document.querySelector("main")).getPropertyValue("--dock-w").trim(),
    splitterOrient:
      document.getElementById("dock-splitter")?.getAttribute("aria-orientation") || "",
    controlDockVisible: (() => {
      const cd = document.querySelector(".control-dock");
      return Boolean(cd) && getComputedStyle(cd).display !== "none";
    })(),
    canvasVisible: (() => {
      const c = document.getElementById("composition");
      return Boolean(c) && getComputedStyle(c).display !== "none";
    })(),
  }));
}

test("LAN operator debug dock is open by default and supports right/bottom/hidden + resize + summon", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-dock-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });

    // Default is debug-first: dock open on the right, summon hidden.
    const initial = await dockState(page);
    assert.equal(initial.dock, "right", JSON.stringify(initial));
    assert.equal(initial.summonHidden, true, JSON.stringify(initial));
    assert.equal(initial.debugVisible, true, JSON.stringify(initial));
    assert.equal(initial.splitterOrient, "vertical", JSON.stringify(initial));
    // Debug-first default: the debug-oriented control dock is visible.
    assert.equal(initial.controlDockVisible, true, JSON.stringify(initial));

    // Resize: dragging the splitter left widens the debug dock (sets --dock-w).
    const box = await page.locator("#dock-splitter").boundingBox();
    assert.ok(box, "dock splitter should be present in right dock");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const resized = await dockState(page);
    assert.match(resized.dockW, /\d+px/, JSON.stringify(resized));

    // Dock to bottom: separator orientation flips to horizontal.
    await page.click("#dock-bottom-button");
    const bottom = await dockState(page);
    assert.equal(bottom.dock, "bottom", JSON.stringify(bottom));
    assert.equal(bottom.splitterOrient, "horizontal", JSON.stringify(bottom));

    // Hide: debug disappears, summon rail appears.
    await page.click("#dock-hide-button");
    const hidden = await dockState(page);
    assert.equal(hidden.dock, "hidden", JSON.stringify(hidden));
    assert.equal(hidden.summonHidden, false, JSON.stringify(hidden));
    assert.equal(hidden.debugVisible, false, JSON.stringify(hidden));
    // Clean mode: debug control dock is gone, but the shared-screen stage remains.
    assert.equal(hidden.controlDockVisible, false, JSON.stringify(hidden));
    assert.equal(hidden.canvasVisible, true, JSON.stringify(hidden));

    // Summon restores the last open dock state (bottom).
    await page.click("#dock-summon");
    assert.equal((await dockState(page)).dock, "bottom");

    // Backtick hotkey toggles hide/summon.
    await page.keyboard.press("`");
    assert.equal((await dockState(page)).dock, "hidden");
    await page.keyboard.press("`");
    assert.equal((await dockState(page)).dock, "bottom");
  } finally {
    await browser.close();
    await surface.close();
  }
});

async function tabState(page) {
  return await page.evaluate(() => ({
    ledger: document.getElementById("tabpanel-ledger")?.hidden === false,
    telemetry: document.getElementById("tabpanel-telemetry")?.hidden === false,
    sources: document.getElementById("tabpanel-sources")?.hidden === false,
    ledgerSelected: document.getElementById("debug-tab-ledger")?.getAttribute("aria-selected"),
    telemetrySelected: document
      .getElementById("debug-tab-telemetry")
      ?.getAttribute("aria-selected"),
    opened: document.getElementById("debug-panel")?.dataset.debugPanelOpened,
    streamPresent: Boolean(document.getElementById("operator-conversation-stream")),
    denseInTelemetry: Boolean(
      document.querySelector("#tabpanel-telemetry [data-debug-panel='dense']"),
    ),
    sourceTableInSources: Boolean(
      document.querySelector("#tabpanel-sources #debug-visual-source-table"),
    ),
  }));
}

test("LAN operator debug dock tabs (Ledger/Telemetry/Sources) switch without losing data", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-dock-tabs-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: 10_000,
    });

    // Default tab is Ledger (debug-first conversation view).
    const def = await tabState(page);
    assert.equal(def.ledger, true, JSON.stringify(def));
    assert.equal(def.telemetry, false, JSON.stringify(def));
    assert.equal(def.sources, false, JSON.stringify(def));
    assert.equal(def.ledgerSelected, "true", JSON.stringify(def));
    // All panels stay mounted regardless of active tab.
    assert.equal(def.denseInTelemetry, true, JSON.stringify(def));
    assert.equal(def.sourceTableInSources, true, JSON.stringify(def));

    // Telemetry tab: dense sections visible; open flag set true (gate compatibility).
    await page.click("#debug-tab-telemetry");
    const tel = await tabState(page);
    assert.equal(tel.telemetry, true, JSON.stringify(tel));
    assert.equal(tel.ledger, false, JSON.stringify(tel));
    assert.equal(tel.telemetrySelected, "true", JSON.stringify(tel));
    assert.equal(tel.opened, "true", JSON.stringify(tel));

    // Sources tab.
    await page.click("#debug-tab-sources");
    const src = await tabState(page);
    assert.equal(src.sources, true, JSON.stringify(src));
    assert.equal(src.telemetry, false, JSON.stringify(src));

    // The "Telemetry" dock button also selects the Telemetry tab + sets the open flag.
    await page.click("#open-debug-panel-button");
    const viaButton = await tabState(page);
    assert.equal(viaButton.telemetry, true, JSON.stringify(viaButton));
    assert.equal(viaButton.opened, "true", JSON.stringify(viaButton));

    // Switching back to Ledger keeps the conversation stream mounted (data not lost).
    await page.click("#debug-tab-ledger");
    const back = await tabState(page);
    assert.equal(back.ledger, true, JSON.stringify(back));
    assert.equal(back.streamPresent, true, JSON.stringify(back));
    assert.equal(back.denseInTelemetry, true, JSON.stringify(back));
  } finally {
    await browser.close();
    await surface.close();
  }
});
