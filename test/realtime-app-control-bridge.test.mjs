import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";
import { realtimeToolSchemas } from "../packages/core/src/realtime/realtime-contract.ts";

const controlTool = realtimeToolSchemas.find((tool) => tool.name === "control_shared_app_window");

async function withRealtimeBridge(callback) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        simulateRemoteAudio: false,
        dryRunLocalTools: true,
        tools: controlTool ? [controlTool] : [],
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

async function dispatchToolCall(page, callId, args) {
  await page.evaluate(
    ({ callId: id, args: payload }) => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.function_call_arguments.done",
            name: "control_shared_app_window",
            call_id: id,
            arguments: JSON.stringify(payload),
          },
        }),
      );
    },
    { callId, args },
  );
  await page.waitForFunction(
    (id) =>
      window.MAB_REALTIME_BRIDGE?.workspaceTools?.calls?.some((call) => call.callId === id),
    callId,
  );
}

test("Realtime app-control dry-run state result asks the model to continue with primitive operations", async () => {
  await withRealtimeBridge(async (page) => {
    await dispatchToolCall(page, "call_state_probe", {
      applicationName: "Pencil",
      instruction: "draw a snake mockup",
      operations: [{ kind: "state" }],
    });

    const stateCall = await page.evaluate(() =>
      window.MAB_REALTIME_BRIDGE.workspaceTools.calls.find(
        (call) => call.callId === "call_state_probe",
      ),
    );
    assert.equal(stateCall.result.ok, true);
    assert.deepEqual(stateCall.result.actions, ["state"]);
    assert.match(stateCall.result.summary, /Continue with concrete click\/type_text/);

    const responseCreate = await page.evaluate(() =>
      window.MAB_REALTIME_BRIDGE.connection.sentDataChannelMessages
        .map((entry) => {
          try {
            return typeof entry.payload === "string" ? JSON.parse(entry.payload) : entry.payload;
          } catch {
            return entry.payload;
          }
        })
        .find(
          (event) =>
            event.type === "response.create" &&
            event.response?.instructions?.includes("Continue by calling control_shared_app_window"),
        ),
    );
    assert.ok(responseCreate, "state-only app-control result should prompt a follow-up tool call");

    await dispatchToolCall(page, "call_direct_ops", {
      applicationName: "Pencil",
      windowId: 12345,
      instruction: "draw a snake mockup",
      operations: [
        { kind: "click", x: 40, y: 40 },
        { kind: "drag", from_x: 120, from_y: 120, to_x: 240, to_y: 120 },
        { kind: "type_text", text: "Score: 000" },
      ],
    });

    const directCall = await page.evaluate(() =>
      window.MAB_REALTIME_BRIDGE.workspaceTools.calls.find(
        (call) => call.callId === "call_direct_ops",
      ),
    );
    assert.equal(directCall.result.ok, true);
    assert.deepEqual(directCall.result.actions, ["click", "drag", "type_text"]);
    assert.match(directCall.result.summary, /executed primitive app-control operations/i);
  });
});
