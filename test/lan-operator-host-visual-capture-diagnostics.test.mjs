import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import { classifyDisplayCaptureFailure } from "../scripts/lan-operator-host-visual-acceptance.mjs";

async function waitForRuntimeStatus(url, predicate, timeoutMs = 8_000) {
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(new URL("/runtime/status", url))).json();
    lastBody = body;
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime_status_timeout: ${JSON.stringify(lastBody)}`);
}

test("Host Visual display-capture diagnostics classify browser and macOS failures", () => {
  assert.equal(
    classifyDisplayCaptureFailure("NotAllowedError: Permission denied").category,
    "display_capture_permission_denied",
  );
  assert.equal(
    classifyDisplayCaptureFailure("NotReadableError: Could not start video source").category,
    "display_capture_source_unreadable_or_screen_recording_denied",
  );
  assert.equal(
    classifyDisplayCaptureFailure("InvalidStateError: Invalid state").category,
    "display_capture_activation_or_focus_failed",
  );
  assert.equal(
    classifyDisplayCaptureFailure("NotSupportedError: Not supported").category,
    "display_capture_unsupported_runtime",
  );
  assert.equal(classifyDisplayCaptureFailure(""), null);
});

test("Host Visual Publisher reports display-capture permission failures", async () => {
  const surface = createLanOperatorSurfaceServer({
    host: "127.0.0.1",
    port: 0,
    sessionId: "lan-host-visual-capture-diagnostics",
    botName: "LAN Oneesama",
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const operatorPage = await context.newPage();
    await operatorPage.goto(url);
    await operatorPage.waitForFunction(
      () => window.MAB_LAN_OPERATOR_SURFACE?.state?.visual.receiverWebSocketState === "open",
      null,
      { timeout: 10_000 },
    );

    const publisherPage = await context.newPage();
    await publisherPage.addInitScript(() => {
      const mediaDevices = navigator.mediaDevices || {};
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          ...mediaDevices,
          getDisplayMedia: async () => {
            const error = new Error("Permission denied by test");
            error.name = "NotAllowedError";
            throw error;
          },
        },
      });
    });
    const publisherUrl = new URL("/host-visual", url);
    publisherUrl.searchParams.set("sourceId", "host-app");
    publisherUrl.searchParams.set("label", "App view");
    publisherUrl.searchParams.set("kind", "desktop_app");
    await publisherPage.goto(publisherUrl.toString());
    await publisherPage.waitForFunction(
      () => window.MAB_LAN_HOST_VISUAL_PUBLISHER?.state?.websocketState === "open",
      null,
      { timeout: 10_000 },
    );

    const attempt = await publisherPage.evaluate(async () => {
      try {
        await window.MAB_LAN_HOST_VISUAL_PUBLISHER.startDisplayCapture();
        return { ok: true, state: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state };
      } catch (error) {
        return {
          ok: false,
          name: error?.name || "",
          message: error?.message || "",
          state: window.MAB_LAN_HOST_VISUAL_PUBLISHER.state,
        };
      }
    });
    const body = await waitForRuntimeStatus(
      url,
      (nextBody) => {
        const source = nextBody.debug.visual.sources.find((entry) => entry.id === "host-app");
        return (
          source?.captureStatus === "failed" && /NotAllowedError/.test(source?.captureError || "")
        );
      },
      10_000,
    );
    const source = body.debug.visual.sources.find((entry) => entry.id === "host-app");

    assert.equal(attempt.ok, false);
    assert.equal(attempt.name, "NotAllowedError");
    assert.equal(attempt.state.sourceMode, "display_capture");
    assert.equal(attempt.state.captureStatus, "failed");
    assert.match(attempt.state.captureError, /NotAllowedError/);
    assert.equal(source.sourceMode, "display_capture");
    assert.equal(source.captureStatus, "failed");
    assert.match(source.captureError, /NotAllowedError/);

    await context.close();
  } finally {
    await browser.close();
    await surface.close();
  }
});
