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
    const status = await (await fetch(`${started.url}runtime/status`)).json();
    assert.ok(status.avatars.some((avatar) => avatar.id === "oneesama-video"));
    const listening = await page.evaluate(() =>
      window.MAB_AVATAR_PLAYGROUND.applyPreset("listening"),
    );
    assert.deepEqual(
      listening.signals.map((signal) => signal.label),
      ["连接", "听", "状态", "说", "工具", "错误"],
    );
    assert.equal(listening.signals.find((signal) => signal.label === "听")?.value, "在听");

    const tool = await page.evaluate(() => window.MAB_AVATAR_PLAYGROUND.applyPreset("tool"));
    assert.equal(tool.signals.find((signal) => signal.label === "工具")?.level, "active");
    assert.equal(
      tool.signals.find((signal) => signal.label === "工具")?.value,
      "列窗口→共享→控制",
    );

    const blocked = await page.evaluate(() => window.MAB_AVATAR_PLAYGROUND.applyPreset("blocked"));
    assert.equal(blocked.signals.find((signal) => signal.label === "错误")?.level, "blocked");

    const snapshot = await page.evaluate(() =>
      window.MAB_AVATAR_VISUAL_TEST.captureSourceSnapshot({ label: "playground" }),
    );
    assert.ok(snapshot.status.nonBackgroundRatio > 0.12);
  } finally {
    await browser.close();
    await playground.close();
  }
});

test("video avatar suppresses fallback drawings when sources are unavailable", async () => {
  const playground = createAvatarPlaygroundServer({
    port: 0,
    botName: "Video Failure Smoke",
    avatar: {
      avatarRenderer: "video",
      background: "#0b1018",
      videoChromaKey: { enabled: false },
      videoSources: [
        {
          id: "broken-idle",
          label: "Broken idle",
          state: "idle",
          url: "/assets/avatar/missing-video-source.webm",
          background: "#0b1018",
        },
      ],
    },
  });
  const started = await playground.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    const page = await context.newPage();
    await page.goto(`${started.url}?avatar=oneesama-video`);
    await page.waitForFunction(
      () => {
        const renderer = window.MAB_AVATAR_RENDERER;
        return renderer?.renderer === "video" && Number(renderer.videoHoldFrames || 0) > 0;
      },
      null,
      { timeout: 10_000 },
    );
    const renderer = await page.evaluate(() => window.MAB_AVATAR_RENDERER);
    assert.equal(renderer.renderer, "video");
    assert.equal(renderer.videoLoaded, false);
    assert.equal(renderer.videoFallbackSuppressed, true);
    assert.equal(renderer.videoFallbackFrames, 0);
    assert.match(renderer.videoHoldReason || renderer.videoLoadErrors?.[0]?.error || "", /video/i);
    assert.equal(renderer.fallbackReason, "");
  } finally {
    await browser.close();
    await playground.close();
  }
});
