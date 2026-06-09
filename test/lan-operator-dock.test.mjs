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

test("LAN operator foreground avatar controls open and switch real publisher preset URLs", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-avatar-controls-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await waitReady(page);

    const initial = await page.evaluate(() => ({
      select: document.getElementById("avatar-publisher-renderer-select")?.value,
      status: document.getElementById("avatar-publisher-status")?.textContent,
      url: window.MAB_LAN_OPERATOR_SURFACE.avatarPublisherUrl(),
      frameSrc: document.getElementById("avatar-publisher-frame")?.getAttribute("src"),
      openButton: Boolean(document.getElementById("open-avatar-publisher-button")),
      closeButton: Boolean(document.getElementById("close-avatar-publisher-button")),
    }));
    assert.equal(initial.select, "fallback-canvas", JSON.stringify(initial));
    assert.match(initial.status, /(embedded|live) · fallback/, JSON.stringify(initial));
    assert.equal(new URL(initial.url).searchParams.get("avatarPreset"), "fallback-canvas");
    assert.equal(
      new URL(initial.frameSrc, url).searchParams.get("avatarPreset"),
      "fallback-canvas",
    );
    assert.equal(initial.openButton, false, JSON.stringify(initial));
    assert.equal(initial.closeButton, false, JSON.stringify(initial));

    await page.evaluate(() => {
      window.__avatarPublisherOpens = [];
      window.open = (href, name) => {
        window.__avatarPublisherOpens.push({ url: String(href), name: String(name) });
        return null;
      };
    });

    await page.selectOption("#avatar-publisher-renderer-select", "oneesama-video");
    const openedFrame = await page.evaluate(() => ({
      src: document.getElementById("avatar-publisher-frame")?.getAttribute("src"),
      opens: window.__avatarPublisherOpens,
      state: window.MAB_LAN_OPERATOR_SURFACE.state.publishers,
    }));
    assert.equal(openedFrame.opens.length, 0, JSON.stringify(openedFrame));
    assert.equal(
      new URL(openedFrame.src, url).searchParams.get("avatarPreset"),
      "oneesama-video",
      JSON.stringify(openedFrame),
    );
    assert.equal(openedFrame.state.avatarWindowOpen, true, JSON.stringify(openedFrame.state));
    await page.waitForFunction(
      () => {
        const rect = window.MAB_LAN_OPERATOR_SURFACE?.sourceMediaDrawRects?.().avatar;
        return (
          rect &&
          rect.fit !== "placeholder" &&
          rect.media?.width > 0 &&
          rect.media?.height > 0 &&
          ["webrtc_receiver", "embedded_avatar_preview"].includes(rect.source)
        );
      },
      null,
      { timeout: 12_000 },
    );
    const visibleVideo = await page.evaluate(
      () => window.MAB_LAN_OPERATOR_SURFACE.sourceMediaDrawRects().avatar,
    );
    assert.notEqual(visibleVideo.fit, "placeholder", JSON.stringify(visibleVideo));
    assert.ok(visibleVideo.media.width > 0, JSON.stringify(visibleVideo));
    assert.ok(visibleVideo.media.height > 0, JSON.stringify(visibleVideo));

    await page.selectOption("#avatar-publisher-renderer-select", "hiyori-live2d");
    const selected = await page.evaluate(() => ({
      select: document.getElementById("avatar-publisher-renderer-select")?.value,
      status: document.getElementById("avatar-publisher-status")?.textContent,
      frameSrc: document.getElementById("avatar-publisher-frame")?.getAttribute("src"),
      opens: window.__avatarPublisherOpens,
      state: window.MAB_LAN_OPERATOR_SURFACE.state.publishers,
    }));
    assert.equal(selected.select, "hiyori-live2d", JSON.stringify(selected));
    assert.match(selected.status, /(embedded|live) · hiyori/, JSON.stringify(selected));
    assert.equal(selected.opens.length, 0, JSON.stringify(selected));
    assert.equal(
      new URL(selected.frameSrc, url).searchParams.get("avatarPreset"),
      "hiyori-live2d",
      JSON.stringify(selected),
    );
    assert.equal(selected.state.avatarWindowOpen, true, JSON.stringify(selected.state));
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator embedded avatar publisher autostarts without opening a popup", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-embedded-avatar-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    await context.addInitScript(() => {
      window.__avatarPublisherOpens = [];
      const originalOpen = window.open.bind(window);
      window.open = (...args) => {
        window.__avatarPublisherOpens.push(args.map((value) => String(value)));
        return originalOpen(...args);
      };
    });
    const page = await context.newPage();
    const target = new URL(url);
    target.searchParams.set("autoAvatarPublisher", "0");
    target.searchParams.set("avatarPreset", "fallback-canvas");
    await page.goto(target.toString());
    await waitReady(page);
    await page.waitForFunction(
      () => {
        const avatar = window.MAB_LAN_OPERATOR_SURFACE?.state?.sources?.find(
          (source) => source.id === "avatar",
        );
        const draw = window.MAB_LAN_OPERATOR_SURFACE?.sourceMediaDrawRects?.().avatar;
        return (
          Boolean(document.getElementById("avatar-publisher-frame")) &&
          avatar?.state === "live" &&
          avatar?.captureStatus === "live" &&
          window.MAB_LAN_OPERATOR_SURFACE?.state?.visual?.trackCount >= 1 &&
          draw?.fit !== "placeholder" &&
          draw?.media?.width > 0 &&
          draw?.media?.height > 0
        );
      },
      null,
      { timeout: 12_000 },
    );
    const proof = await page.evaluate(() => {
      const avatar = window.MAB_LAN_OPERATOR_SURFACE.state.sources.find(
        (source) => source.id === "avatar",
      );
      return {
        opens: window.__avatarPublisherOpens,
        search: location.search,
        frameSrc: document.getElementById("avatar-publisher-frame")?.getAttribute("src"),
        visual: window.MAB_LAN_OPERATOR_SURFACE.state.visual,
        avatar,
        draw: window.MAB_LAN_OPERATOR_SURFACE.sourceMediaDrawRects().avatar,
      };
    });
    assert.equal(context.pages().length, 1, JSON.stringify(proof));
    assert.equal(proof.opens.length, 0, JSON.stringify(proof));
    assert.equal(
      new URL(`http://local.test/${proof.search}`).searchParams.has("autoAvatarPublisher"),
      false,
      JSON.stringify(proof),
    );
    assert.equal(
      new URL(proof.frameSrc, url).searchParams.get("avatarPreset"),
      "fallback-canvas",
      JSON.stringify(proof),
    );
    assert.equal(proof.visual.connectionState, "connected", JSON.stringify(proof.visual));
    assert.ok(proof.visual.trackCount >= 1, JSON.stringify(proof.visual));
    assert.equal(proof.avatar.avatarReady, true, JSON.stringify(proof.avatar));
    assert.notEqual(proof.draw.fit, "placeholder", JSON.stringify(proof.draw));
    assert.ok(proof.draw.media.width > 0, JSON.stringify(proof.draw));
    assert.ok(proof.draw.media.height > 0, JSON.stringify(proof.draw));
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator app view fills the composition with avatar overlaid", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-app-view-fill-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    await context.addInitScript(() => {
      localStorage.setItem(
        "mab.operator.user-state.v1",
        JSON.stringify({
          focusedSourceId: "host-app",
          sourceRects: {
            "host-app": { x: 0.2, y: 0.16, width: 0.32, height: 0.44 },
            avatar: { x: 0.72, y: 0.56, width: 0.24, height: 0.24 },
          },
          publishers: { avatarPreset: "fallback-canvas", avatarPublisherOpen: true },
          voice: { deviceId: "", localVadEnabled: false },
        }),
      );
    });
    const page = await context.newPage();
    await page.goto(url);
    await waitReady(page);
    await page.waitForFunction(
      () => {
        const rects = window.MAB_LAN_OPERATOR_SURFACE?.sourceMediaDrawRects?.();
        return (
          rects?.["host-app"]?.box?.width === 1280 &&
          rects?.["host-app"]?.box?.height === 720 &&
          rects?.avatar?.box?.width > 0
        );
      },
      null,
      { timeout: 8_000 },
    );

    const canvasBox = await page.locator("#composition").boundingBox();
    assert.ok(canvasBox, "composition canvas should be visible");
    await page.mouse.move(
      canvasBox.x + canvasBox.width * 0.95,
      canvasBox.y + canvasBox.height * 0.95,
    );
    await page.mouse.down();
    await page.mouse.move(
      canvasBox.x + canvasBox.width * 0.72,
      canvasBox.y + canvasBox.height * 0.72,
    );
    await page.mouse.up();
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.moveSource("host-app", {
        x: 0.2,
        y: 0.2,
        width: 0.4,
        height: 0.4,
      }),
    );

    const proof = await page.evaluate(() => ({
      sourceRects: window.MAB_LAN_OPERATOR_SURFACE.state.sourceRects,
      drawRects: window.MAB_LAN_OPERATOR_SURFACE.sourceMediaDrawRects(),
      sourceOrder: window.MAB_LAN_OPERATOR_SURFACE.state.sources.map((source) => source.id),
      stored: JSON.parse(localStorage.getItem("mab.operator.user-state.v1")),
    }));
    assert.deepEqual(proof.sourceRects["host-app"], {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    assert.equal(proof.sourceOrder.at(-1), "avatar", JSON.stringify(proof.sourceOrder));
    assert.deepEqual(proof.drawRects["host-app"].box, {
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(proof.stored.sourceRects, "host-app"),
      false,
      JSON.stringify(proof.stored),
    );
    assert.ok(proof.drawRects.avatar.box.x > 0, JSON.stringify(proof.drawRects.avatar));
    assert.ok(proof.drawRects.avatar.box.y > 0, JSON.stringify(proof.drawRects.avatar));
  } finally {
    await browser.close();
    await surface.close();
  }
});

async function waitReady(page) {
  await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
    timeout: 10_000,
  });
}

test("LAN operator layout persists to URL hash + localStorage and restores on reload", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-dock-persist-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await waitReady(page);

    // Change layout: dock bottom + Telemetry tab. Both are persisted.
    await page.click("#dock-bottom-button");
    await page.click("#debug-tab-telemetry");

    const persisted = await page.evaluate(() => ({
      hash: location.hash,
      stored: localStorage.getItem("mab.operator.layout.v1"),
    }));
    assert.match(persisted.hash, /dock=bottom/, JSON.stringify(persisted));
    assert.match(persisted.hash, /tab=telemetry/, JSON.stringify(persisted));
    assert.ok(persisted.stored, "layout should be saved to localStorage");
    const parsed = JSON.parse(persisted.stored);
    assert.equal(parsed.dock, "bottom", persisted.stored);
    assert.equal(parsed.tab, "telemetry", persisted.stored);

    // Reload (same context keeps URL hash + localStorage) → state is restored.
    await page.reload();
    await waitReady(page);
    const restored = await dockState(page);
    assert.equal(restored.dock, "bottom", JSON.stringify(restored));
    const restoredTab = await tabState(page);
    assert.equal(restoredTab.telemetry, true, JSON.stringify(restoredTab));
    assert.equal(restoredTab.telemetrySelected, "true", JSON.stringify(restoredTab));
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator user state persists avatar/source/VAD intent without faking live status", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-user-state-persist-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    await page.goto(url);
    await waitReady(page);

    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.moveSource("avatar", {
        x: 0.18,
        y: 0.2,
        width: 0.33,
        height: 0.25,
      }),
    );
    await page.selectOption("#avatar-publisher-renderer-select", "oneesama-video");
    await page.click("#local-vad-toggle");
    await page.waitForFunction(
      () =>
        document
          .getElementById("avatar-publisher-frame")
          ?.getAttribute("src")
          ?.includes("avatarPreset=oneesama-video"),
      null,
      { timeout: 8_000 },
    );

    const persisted = await page.evaluate(() => ({
      search: location.search,
      stored: JSON.parse(localStorage.getItem("mab.operator.user-state.v1")),
    }));
    assert.match(persisted.search, /avatarPreset=oneesama-video/, JSON.stringify(persisted));
    assert.equal(
      new URL(`http://local.test/${persisted.search}`).searchParams.has("autoAvatarPublisher"),
      false,
      JSON.stringify(persisted),
    );
    assert.equal(persisted.stored.focusedSourceId, "avatar", JSON.stringify(persisted.stored));
    assert.equal(persisted.stored.publishers.avatarPreset, "oneesama-video");
    assert.equal(persisted.stored.publishers.avatarPublisherOpen, true);
    assert.equal(persisted.stored.voice.localVadEnabled, true);
    assert.equal(persisted.stored.sourceRects.avatar.x, 0.18);

    await page.reload();
    await waitReady(page);
    await page.waitForFunction(
      () =>
        document
          .getElementById("avatar-publisher-frame")
          ?.getAttribute("src")
          ?.includes("avatarPreset=oneesama-video"),
      null,
      { timeout: 8_000 },
    );
    const restored = await page.evaluate(() => ({
      focusedSourceId: window.MAB_LAN_OPERATOR_SURFACE.state.focusedSourceId,
      rect: window.MAB_LAN_OPERATOR_SURFACE.state.sourceRects.avatar,
      publisher: window.MAB_LAN_OPERATOR_SURFACE.state.publishers,
      frameSrc: document.getElementById("avatar-publisher-frame")?.getAttribute("src"),
      vadChecked: document.getElementById("local-vad-toggle")?.checked,
      localVad: window.MAB_LAN_OPERATOR_SURFACE.state.voiceLocalVad,
      conversationStatus: window.MAB_LAN_OPERATOR_SURFACE.state.conversation.status,
      visualTrackCount: window.MAB_LAN_OPERATOR_SURFACE.state.visual.trackCount,
    }));
    assert.equal(restored.focusedSourceId, "avatar", JSON.stringify(restored));
    assert.equal(restored.rect.x, 0.18, JSON.stringify(restored.rect));
    assert.equal(restored.publisher.avatarPreset, "oneesama-video", JSON.stringify(restored));
    assert.equal(restored.publisher.avatarWindowOpen, true, JSON.stringify(restored.publisher));
    assert.equal(
      new URL(restored.frameSrc, url).searchParams.get("avatarPreset"),
      "oneesama-video",
    );
    assert.equal(restored.vadChecked, true, JSON.stringify(restored));
    assert.equal(restored.localVad.enabled, true, JSON.stringify(restored.localVad));
    assert.notEqual(restored.conversationStatus, "connected", JSON.stringify(restored));
    assert.ok(Number(restored.visualTrackCount) >= 0, JSON.stringify(restored));
  } finally {
    await browser.close();
    await surface.close();
  }
});

test("LAN operator layout: URL hash wins over localStorage (shareable links)", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-operator-dock-hash-precedence-smoke",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    // Seed localStorage with a "hidden" layout via real interaction.
    await page.goto(url);
    await waitReady(page);
    await page.click("#dock-hide-button");
    const seeded = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("mab.operator.layout.v1")),
    );
    assert.equal(seeded.dock, "hidden", JSON.stringify(seeded));

    // Open a shared link whose hash disagrees with localStorage → hash wins.
    await page.goto(url + "#dock=bottom&tab=sources&w=520");
    await waitReady(page);
    const restored = await dockState(page);
    assert.equal(restored.dock, "bottom", JSON.stringify(restored));
    assert.match(restored.dockW, /520px/, JSON.stringify(restored));
    const tab = await tabState(page);
    assert.equal(tab.sources, true, JSON.stringify(tab));
  } finally {
    await browser.close();
    await surface.close();
  }
});
