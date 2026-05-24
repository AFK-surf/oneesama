import assert from "node:assert/strict";
import test from "node:test";

import { buildScreenShareInitScript } from "../packages/core/src/meeting/screen-share-init-builder.ts";

test("screen-share init script supports local MJPEG frame streams", () => {
  const script = buildScreenShareInitScript({
    imageUrl: "http://127.0.0.1:12345/screen-share/test.mjpg",
  });

  assert.match(script, /mjpg/);
  assert.match(script, /state\.imageReady = true/);
  assert.ok(
    script.indexOf('image.crossOrigin = "anonymous"') < script.indexOf("image.src = state.imageUrl"),
    "crossOrigin must be set before image.src so localhost frame streams stay canvas-readable",
  );
});
