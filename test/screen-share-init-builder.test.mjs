import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

import { buildScreenShareInitScript } from "../packages/core/src/meeting/screen-share-init-builder.ts";

test("screen-share init script supports local multipart frame streams", () => {
  const script = buildScreenShareInitScript({
    imageUrl: "http://127.0.0.1:12345/screen-share/test.mjpg",
  });

  assert.match(script, /mjpg/);
  assert.match(script, /state\.imageReady = true/);
  assert.match(script, /state\.showOverlay/);
  assert.match(script, /track\.contentHint = "detail"/);
  assert.ok(
    script.indexOf('image.crossOrigin = "anonymous"') <
      script.indexOf("image.src = state.imageUrl"),
    "crossOrigin must be set before image.src so localhost frame streams stay canvas-readable",
  );
});

test("meet runner late screen-share install reuses full image-capable bridge", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");
  const ensureStart = source.indexOf("async function ensureScreenShareController");
  const ensureEnd = source.indexOf("async function fillGuestName", ensureStart);
  const ensureBody = source.slice(ensureStart, ensureEnd);

  assert.match(ensureBody, /buildScreenShareInitScript/);
  assert.match(source, /buildAvatarRuntimeInitScripts/);
  assert.match(source, /validateGoogleMeetRuntimeSessionConfig/);
  assert.ok(
    source.indexOf("const runtimeSessionValidation") < source.indexOf("const runtimeInitScripts"),
    "Meet joiner must validate runtime session config before composing init scripts",
  );
  assert.doesNotMatch(
    source.slice(
      source.indexOf("const runtimeInitScripts"),
      source.indexOf("const page = await context.newPage"),
    ),
    /buildScreenShareInitScript/,
    "main init stack should use the runtime composer instead of manually assembling screen-share init",
  );
  assert.doesNotMatch(
    ensureBody,
    /function ensureVideo\(\)/,
    "late install must not carry a simplified video-only controller that drops app-share image frames",
  );
  assert.match(source, /screen_share_image_source_not_attached/);
});

test("screen-share bridge draws image sources onto the shared canvas", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      content: buildScreenShareInitScript({ width: 8, height: 8, fps: 5 }),
    });

    const redSquare =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="rgb(255,0,0)"/></svg>',
      );
    const started = await page.evaluate(
      (imageUrl) =>
        window.MAB_SCREEN_SHARE_CONTROLLER.start({
          imageUrl,
          width: 8,
          height: 8,
          fps: 5,
        }),
      redSquare,
    );

    assert.equal(started.ok, true);
    await page.waitForFunction(
      () => {
        const state = window.MAB_SCREEN_SHARE_CONTROLLER.state();
        const canvas = document.querySelector("canvas[data-meeting-avatar-screen-share]");
        if (!state.imageReady || !canvas) return false;
        const pixel = canvas
          .getContext("2d")
          .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        return pixel[0] > 220 && pixel[1] < 40 && pixel[2] < 40;
      },
      null,
      { timeout: 2000 },
    );
    const pixel = await page.evaluate(() => {
      const canvas = document.querySelector("canvas[data-meeting-avatar-screen-share]");
      return Array.from(
        canvas
          .getContext("2d")
          .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data,
      );
    });

    assert.ok(pixel[0] > 220, `red channel = ${pixel[0]}`);
    assert.ok(pixel[1] < 40, `green channel = ${pixel[1]}`);
    assert.ok(pixel[2] < 40, `blue channel = ${pixel[2]}`);
  } finally {
    await browser.close();
  }
});
