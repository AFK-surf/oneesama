import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
    script.indexOf('image.crossOrigin = "anonymous"') < script.indexOf("image.src = state.imageUrl"),
    "crossOrigin must be set before image.src so localhost frame streams stay canvas-readable",
  );
});

test("meet runner late screen-share install reuses full image-capable bridge", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");
  const ensureStart = source.indexOf("async function ensureScreenShareController");
  const ensureEnd = source.indexOf("async function fillGuestName", ensureStart);
  const ensureBody = source.slice(ensureStart, ensureEnd);

  assert.match(ensureBody, /buildScreenShareInitScript/);
  assert.doesNotMatch(
    ensureBody,
    /function ensureVideo\(\)/,
    "late install must not carry a simplified video-only controller that drops app-share image frames",
  );
  assert.match(source, /screen_share_image_source_not_attached/);
});
