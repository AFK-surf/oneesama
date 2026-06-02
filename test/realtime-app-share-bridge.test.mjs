import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";
import { realtimeToolSchemas } from "../packages/core/src/realtime/realtime-contract.ts";

const shareTool = realtimeToolSchemas.find((tool) => tool.name === "share_existing_app_window");

async function withRealtimeBridge(callback, options = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        simulateRemoteAudio: false,
        dryRunLocalTools: true,
        tools: options.tools || [],
        ...options.config,
      }),
    });
    await page.goto("data:text/html,<html><body>bridge</body></html>");
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen === true,
    );
    await callback(page);
  } finally {
    await browser.close();
  }
}

test("Realtime app-share success stays silent after verified active share evidence", async () => {
  await withRealtimeBridge(
    async (page) => {
      await page.route("http://meeting.local/screen-share/app", async (route) => {
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
          body: JSON.stringify({
            ok: true,
            screenShare: { active: true },
            beforePresentation: {
              textHead: "SHOULD_NOT_REACH_MODEL".repeat(200),
              buttons: Array.from({ length: 50 }, (_, index) => ({
                index,
                label: `button-${index}-SHOULD_NOT_REACH_MODEL`,
              })),
            },
            postcheck: {
              screenShare: {
                active: true,
                title: "Chrome",
                subtitle: "共享 Chrome 窗口",
                frames: 12,
                imageReady: true,
              },
              textHead: "POSTCHECK_SHOULD_NOT_REACH_MODEL".repeat(200),
            },
            capture: {
              mode: "macos_window_to_synthetic",
              source: "macos_screencapturekit",
              windowId: 42,
              loop: {
                update: {
                  screenShare: {
                    active: true,
                    title: "Chrome",
                    subtitle: "共享 Chrome 窗口",
                    frames: 12,
                    imageReady: true,
                  },
                },
              },
            },
          }),
        });
      });

      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-realtime-server-event", {
            detail: {
              type: "response.function_call_arguments.done",
              name: "share_existing_app_window",
              call_id: "call_share_codex",
              arguments: JSON.stringify({ applicationName: "Codex" }),
            },
          }),
        );
      });

      await page.waitForFunction(() =>
        window.MAB_REALTIME_BRIDGE?.meetTools?.calls?.some(
          (call) => call.callId === "call_share_codex",
        ),
      );

      const responseCreate = await page.evaluate(() =>
        window.MAB_REALTIME_BRIDGE.outbound.some(
          (entry) =>
            entry.event?.type === "response.create" &&
            entry.event?.response?.instructions?.includes("screen-share"),
        ),
      );
      assert.equal(responseCreate, false);

      const shareCall = await page.evaluate(() =>
        window.MAB_REALTIME_BRIDGE.meetTools.calls.find(
          (call) => call.callId === "call_share_codex",
        ),
      );
      assert.equal(shareCall.resultCompacted, true);
      assert.equal(shareCall.result.beforePresentation, undefined);
      assert.equal(shareCall.result.postcheck, undefined);
      assert.equal(shareCall.result.screenShare.active, true);
      assert.equal(shareCall.result.screenShare.title, "Chrome");
      assert.ok(JSON.stringify(shareCall.delivery.modelResult).length < 2000);
      assert.doesNotMatch(JSON.stringify(shareCall.delivery.modelResult), /SHOULD_NOT_REACH_MODEL/);
      assert.equal(shareCall.delivery.policy.channel, "visual_only");
      assert.equal(shareCall.delivery.responseChannel, "");
      assert.equal(shareCall.delivery.meetingEvent.type, "tool_result.visual_only");
      assert.equal(shareCall.delivery.meetingEvent.visibility, "visual_only");

      const functionOutput = await page.evaluate(() =>
        window.MAB_REALTIME_BRIDGE.outbound.find(
          (entry) => entry.event?.item?.type === "function_call_output",
        ),
      );
      assert.ok(functionOutput);
      assert.doesNotMatch(functionOutput.event.item.output, /SHOULD_NOT_REACH_MODEL/);
      assert.ok(functionOutput.event.item.output.length < 2000);
    },
    {
      tools: shareTool ? [shareTool] : [],
      config: {
        dryRunLocalTools: false,
        tokenUrl: "http://meeting.local/realtime/client-secret",
      },
    },
  );
});
