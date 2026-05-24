import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  matchesMacOSWindowCaptureTarget,
  readImageDimensions,
} from "../packages/core/src/meeting/macos-window-capture.ts";

const safariWindow = {
  windowId: 101,
  windowID: 101,
  title: "Product dashboard",
  name: "Product dashboard",
  applicationName: "Safari",
  bundleIdentifier: "com.apple.Safari",
  processId: 42,
  pid: 42,
  source: "macos_screencapturekit",
};

test("macOS window capture target matching accepts stable window metadata", () => {
  assert.equal(matchesMacOSWindowCaptureTarget(safariWindow, { windowId: 101 }), true);
  assert.equal(matchesMacOSWindowCaptureTarget(safariWindow, { pid: 42 }), true);
  assert.equal(
    matchesMacOSWindowCaptureTarget(safariWindow, { bundleIdentifier: "com.apple.Safari" }),
    true,
  );
  assert.equal(matchesMacOSWindowCaptureTarget(safariWindow, { applicationName: "saf" }), true);
});

test("macOS window capture target matching rejects unrelated apps", () => {
  assert.equal(matchesMacOSWindowCaptureTarget(safariWindow, { windowId: 202 }), false);
  assert.equal(matchesMacOSWindowCaptureTarget(safariWindow, { pid: 99 }), false);
  assert.equal(
    matchesMacOSWindowCaptureTarget(safariWindow, { bundleIdentifier: "com.google.Chrome" }),
    false,
  );
  assert.equal(matchesMacOSWindowCaptureTarget(safariWindow, { applicationName: "Code" }), false);
});

test("macOS window capture dimensions support PNG, JPEG, and WebP frames", () => {
  const dir = mkdtempSync(join(tmpdir(), "oneesama-macos-capture-test-"));
  const pngPath = join(dir, "frame.png");
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(1920, 16);
  png.writeUInt32BE(1280, 20);
  writeFileSync(pngPath, png);

  const jpegPath = join(dir, "frame.jpg");
  const app0 = Buffer.alloc(14);
  const sof0Payload = Buffer.alloc(15);
  sof0Payload[0] = 8;
  sof0Payload.writeUInt16BE(1720, 1);
  sof0Payload.writeUInt16BE(2640, 3);
  writeFileSync(
    jpegPath,
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      app0,
      Buffer.from([0xff, 0xc0, 0x00, 0x11]),
      sof0Payload,
      Buffer.from([0xff, 0xd9]),
    ]),
  );

  const webpPath = join(dir, "frame.webp");
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUInt32LE(10, 16);
  webp[20] = 0;
  webp.writeUIntLE(1365 - 1, 24, 3);
  webp.writeUIntLE(768 - 1, 27, 3);
  writeFileSync(webpPath, webp);

  assert.deepEqual(readImageDimensions(pngPath), { width: 1920, height: 1280 });
  assert.deepEqual(readImageDimensions(jpegPath), { width: 2640, height: 1720 });
  assert.deepEqual(readImageDimensions(webpPath), { width: 1365, height: 768 });
});
