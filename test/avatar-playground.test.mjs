import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createAvatarPlaygroundServer } from "../packages/core/src/avatar-runtime/avatar-playground.ts";

test("avatar playground renders runtime HUD signals and state presets", async () => {
  const playground = createAvatarPlaygroundServer({ port: 0, botName: "Playground Smoke" });
  const started = await playground.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    const page = await context.newPage();
    await page.goto(`${started.url}?avatar=fallback-canvas`);
    await page.waitForFunction(() => window.MAB_AVATAR_PLAYGROUND?.state?.ready === true, null, {
      timeout: 10_000,
    });
    const renderer = await page.evaluate(() => window.MAB_AVATAR_RENDERER?.renderer);
    assert.equal(renderer, "fallback");
    const listening = await page.evaluate(() =>
      window.MAB_AVATAR_PLAYGROUND.applyPreset("listening"),
    );
    assert.deepEqual(
      listening.signals.map((signal) => signal.label),
      ["RT", "Audio", "Voice", "Tool", "Err"],
    );
    assert.equal(listening.signals.find((signal) => signal.label === "Audio")?.value, "tap");

    const tool = await page.evaluate(() => window.MAB_AVATAR_PLAYGROUND.applyPreset("tool"));
    assert.equal(tool.signals.find((signal) => signal.label === "Tool")?.level, "active");

    const blocked = await page.evaluate(() => window.MAB_AVATAR_PLAYGROUND.applyPreset("blocked"));
    assert.equal(blocked.signals.find((signal) => signal.label === "Err")?.level, "blocked");

    const snapshot = await page.evaluate(() =>
      window.MAB_AVATAR_VISUAL_TEST.captureSourceSnapshot({ label: "playground" }),
    );
    assert.ok(snapshot.status.nonBackgroundRatio > 0.12);
  } finally {
    await browser.close();
    await playground.close();
  }
});
