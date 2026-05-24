import assert from "node:assert/strict";
import test from "node:test";

import { matchesMacOSWindowCaptureTarget } from "../packages/core/src/meeting/macos-window-capture.ts";

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
