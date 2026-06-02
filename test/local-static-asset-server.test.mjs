import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { startLocalStaticAssetServer } from "../packages/core/src/meeting/google-meet-joiner-base.ts";

test("local static asset URLs use localhost loopback", async () => {
  const root = await mkdtemp(join(tmpdir(), "oneesama-assets-"));
  const filePath = join(root, "clip.mp4");
  await writeFile(filePath, "fake-mp4");
  const server = await startLocalStaticAssetServer({ root, pathPrefix: "/avatar-assets" });
  try {
    const url = server.urlFor("clip.mp4");
    assert.match(url, /^http:\/\/localhost:\d+\/avatar-assets\//);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(await response.text(), "fake-mp4");
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("localhost static assets still trigger mixed-content warnings from a secure page", async () => {
  const root = await mkdtemp(join(tmpdir(), "oneesama-assets-"));
  const filePath = join(root, "clip.mp4");
  await writeFile(filePath, "fake-mp4");
  const server = await startLocalStaticAssetServer({ root, pathPrefix: "/avatar-assets" });
  const browser = await chromium.launch({ headless: true });
  try {
    const url = server.urlFor("clip.mp4");
    const page = await browser.newPage();
    const mixedContentWarnings = [];
    page.on("console", (message) => {
      const text = message.text();
      if (/Mixed Content/i.test(text)) mixedContentWarnings.push(text);
    });
    await page.route("https://secure.example.test/", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<video src="${url}" muted autoplay playsinline></video>`,
      }),
    );
    const assetRequest = page.waitForRequest(url, { timeout: 5000 });
    await page.goto("https://secure.example.test/");
    await assetRequest;
    assert.ok(
      mixedContentWarnings.some((warning) => warning.includes("http://localhost:")),
      "secure pages should not treat local HTTP media as a clean production video source",
    );
  } finally {
    await browser.close();
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
