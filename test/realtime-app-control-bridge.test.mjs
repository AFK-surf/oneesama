import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";
import { realtimeToolSchemas } from "../packages/core/src/realtime/realtime-contract.ts";

const controlTool = realtimeToolSchemas.find((tool) => tool.name === "control_shared_app_window");
const shareTool = realtimeToolSchemas.find((tool) => tool.name === "share_existing_app_window");

test("Realtime bridge skips auto-connect in the initial about:blank document", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        simulateRemoteAudio: false,
      }),
    });
    const page = await context.newPage();
    await page.waitForTimeout(250);

    const beforeNavigation = await page.evaluate(() => ({
      href: window.location.href,
      connected: window.MAB_REALTIME_BRIDGE?.connected,
      dataChannelOpen: window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen,
    }));
    assert.equal(beforeNavigation.href, "about:blank");
    assert.equal(beforeNavigation.connected, false);
    assert.equal(beforeNavigation.dataChannelOpen, false);

    await page.goto("data:text/html,<html><body>bridge</body></html>");
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen === true,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

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
        tools: options.tools || (controlTool ? [controlTool] : []),
        ...(options.config || {}),
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
    (id) => window.MAB_REALTIME_BRIDGE?.workspaceTools?.calls?.some((call) => call.callId === id),
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

test("Realtime bridge cancels output when user speech starts even without a tracked response id", async () => {
  await withRealtimeBridge(async (page) => {
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: { type: "output_audio_buffer.started" },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: { type: "input_audio_buffer.speech_started" },
        }),
      );
    });

    await page.waitForFunction(() =>
      window.MAB_REALTIME_BRIDGE?.outbound?.some((entry) => entry.event?.type === "response.cancel"),
    );

    const protection = await page.evaluate(() => window.MAB_REALTIME_BRIDGE.protection);
    assert.equal(protection.userSpeechCancels, 1);
    assert.equal(protection.outputAudioActive, false);
  });
});

test("Realtime worker results are posted to Meet chat and only briefly acknowledged by voice", async () => {
  await withRealtimeBridge(async (page) => {
    const delivery = await page.evaluate(() => {
      window.__MAB_MEET_FIXTURE = { chatMessages: [] };
      window.addEventListener("meeting-avatar-meet-chat-send", (event) => {
        window.__MAB_MEET_FIXTURE.chatMessages.push({ text: event.detail.text });
      });
      return window.MAB_REALTIME_CLIENT.injectWorkerResult({
        id: "job_codex_settings",
        status: "completed",
        task: "打开 Codex 设置",
        result: "Codex 设置页面已经打开，当前可见 General 和 Account 设置。",
      });
    });

    assert.equal(delivery.meetChat?.ok, true);

    const state = await page.evaluate(() => ({
      chatMessages: window.__MAB_MEET_FIXTURE.chatMessages,
      outbound: window.MAB_REALTIME_BRIDGE.outbound,
    }));
    assert.equal(state.chatMessages.length, 1);
    assert.match(state.chatMessages[0].text, /Codex 设置页面已经打开/);

    const systemMessage = state.outbound
      .map((entry) => entry.event?.item)
      .find((item) => item?.type === "message" && item?.role === "system");
    const voiceText = systemMessage?.content?.[0]?.text || "";
    assert.match(voiceText, /完整结果我已经发到 Meet chat/);
    assert.doesNotMatch(voiceText, /General 和 Account/);
  });
});

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
            postcheck: { screenShare: { active: true } },
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
