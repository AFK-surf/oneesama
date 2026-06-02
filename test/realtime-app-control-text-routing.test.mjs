import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";
import { realtimeToolSchemas } from "../packages/core/src/realtime/realtime-contract.ts";

const controlTool = realtimeToolSchemas.find((tool) => tool.name === "kwwk_computer_use");

test("Realtime manual text routes simple app operations to generic KWWK Computer Use", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        simulateRemoteAudio: false,
        dryRunLocalTools: true,
        directTextTurnToolRouting: true,
        tools: controlTool ? [controlTool] : [],
      }),
    });
    await page.goto("data:text/html,<html><body>bridge</body></html>");
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen === true,
    );

    for (const text of ["让他切换 tab", "在搜索框输入 hello", "点一下第二个按钮"]) {
      const result = await page.evaluate(
        (turnText) => window.MAB_REALTIME_CLIENT.requestRealtimeTextTurn({ text: turnText }),
        text,
      );

      assert.equal(result.directToolRouting, true);
      assert.equal(result.toolChoice, "kwwk_computer_use");
      await page.waitForFunction(
        (turnText) =>
          window.MAB_REALTIME_BRIDGE?.workspaceTools?.calls?.some(
            (call) => call.name === "kwwk_computer_use" && call.arguments?.instruction === turnText,
          ),
        text,
      );

      const call = await page.evaluate(
        (turnText) =>
          window.MAB_REALTIME_BRIDGE.workspaceTools.calls.find(
            (entry) =>
              entry.name === "kwwk_computer_use" && entry.arguments?.instruction === turnText,
          ),
        text,
      );
      assert.equal(call.arguments.instruction, text);
      assert.equal(Object.hasOwn(call.arguments || {}, "executionMode"), false);
      assert.equal(Object.hasOwn(call.arguments || {}, "operations"), false);
    }
  } finally {
    await browser.close();
  }
});
