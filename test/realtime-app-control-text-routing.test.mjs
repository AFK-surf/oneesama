import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";
import { realtimeToolSchemas } from "../packages/core/src/realtime/realtime-contract.ts";

const controlTool = realtimeToolSchemas.find((tool) => tool.name === "kwwk_computer_use");
const shareTool = realtimeToolSchemas.find((tool) => tool.name === "share_existing_app_window");
const delegateTool = realtimeToolSchemas.find((tool) => tool.name === "delegate_to_worker");

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

test("Realtime audio transcripts route high-confidence share turns to native app share", async () => {
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
        allowCustomRealtimeServerEvents: true,
        tools: shareTool ? [shareTool] : [],
      }),
    });
    await page.goto("data:text/html,<html><body>bridge</body></html>");
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen === true,
    );

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "audio_share_1",
            transcript: "请分享 Chrome 浏览器窗口到会议里。请开始屏幕共享。请分享窗口。",
          },
        }),
      );
    });

    await page.waitForFunction(() =>
      window.MAB_REALTIME_BRIDGE?.meetTools?.calls?.some(
        (call) => call.name === "share_existing_app_window",
      ),
    );
    const state = await page.evaluate(() => ({
      call: window.MAB_REALTIME_BRIDGE.meetTools.calls.find(
        (entry) => entry.name === "share_existing_app_window",
      ),
      latestFunctionalTurn: window.MAB_REALTIME_BRIDGE.contextHealth.latestFunctionalTurn,
      timelineTypes: window.MAB_REALTIME_BRIDGE.timeline.map((entry) => entry.type),
    }));

    assert.equal(state.call.arguments.applicationName, "Chrome");
    assert.equal(state.latestFunctionalTurn.source, "audio_transcript");
    assert.equal(state.latestFunctionalTurn.toolCalled, true);
    assert.ok(state.timelineTypes.includes("realtime_audio_functional_turn_recorded"));
    assert.ok(state.timelineTypes.includes("realtime_audio_transcript_direct_tool_requested"));
  } finally {
    await browser.close();
  }
});

test("Realtime audio transcripts route synced Gomoku build requests to code worker", async () => {
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
        allowCustomRealtimeServerEvents: true,
        tools: delegateTool ? [delegateTool] : [],
      }),
    });
    await page.goto("data:text/html,<html><body>bridge</body></html>");
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen === true,
    );

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "audio_gomoku_1",
            transcript: "帮我自动化实现一个 web 版本五子棋，要带同步。跑起来以后你和我一起下。",
          },
        }),
      );
    });

    await page.waitForFunction(() =>
      window.MAB_REALTIME_BRIDGE?.workerTools?.calls?.some(
        (call) => call.name === "delegate_to_worker",
      ),
    );
    const state = await page.evaluate(() => ({
      call: window.MAB_REALTIME_BRIDGE.workerTools.calls.find(
        (entry) => entry.name === "delegate_to_worker",
      ),
      latestFunctionalTurn: window.MAB_REALTIME_BRIDGE.contextHealth.latestFunctionalTurn,
      timelineTypes: window.MAB_REALTIME_BRIDGE.timeline.map((entry) => entry.type),
    }));

    assert.match(state.call.arguments.task, /五子棋/);
    assert.equal(state.call.arguments.mode, "code");
    assert.equal(state.call.arguments.allowCodeChanges, true);
    assert.equal(state.call.arguments.context.acceptanceScenario, "gomoku_sync_build_and_play");
    assert.match(state.call.arguments.context.artifactContract, /ONEESAMA_GOMOKU_ARTIFACT/);
    assert.equal(state.latestFunctionalTurn.source, "audio_transcript");
    assert.ok(state.timelineTypes.includes("realtime_audio_transcript_direct_tool_requested"));
  } finally {
    await browser.close();
  }
});

test("Realtime control transcript events route without enabling arbitrary custom events", async () => {
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
        allowCustomRealtimeServerEvents: false,
        tools: delegateTool ? [delegateTool] : [],
      }),
    });
    await page.goto("data:text/html,<html><body>bridge</body></html>");
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen === true,
    );

    const channel = await page.evaluate(() =>
      window.MAB_REALTIME_CLIENT.sendRealtimeControlEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "trusted_audio_gomoku_1",
        transcript:
          "Codex build Gomoku web game with sync run locally play Gomoku with me Codex build Gomoku web game with sync",
      }),
    );

    assert.equal(channel, "trusted-control-event");
    await page.waitForFunction(() =>
      window.MAB_REALTIME_BRIDGE?.workerTools?.calls?.some(
        (call) => call.name === "delegate_to_worker",
      ),
    );
    const state = await page.evaluate(() => ({
      call: window.MAB_REALTIME_BRIDGE.workerTools.calls.find(
        (entry) => entry.name === "delegate_to_worker",
      ),
      latestFunctionalTurn: window.MAB_REALTIME_BRIDGE.contextHealth.latestFunctionalTurn,
      inboundSources: window.MAB_REALTIME_BRIDGE.inbound.map((entry) => entry.source),
      timelineTypes: window.MAB_REALTIME_BRIDGE.timeline.map((entry) => entry.type),
    }));

    assert.match(state.call.arguments.task, /Gomoku web game/);
    assert.equal(state.call.arguments.mode, "code");
    assert.equal(state.call.arguments.allowCodeChanges, true);
    assert.equal(state.call.arguments.context.acceptanceScenario, "gomoku_sync_build_and_play");
    assert.equal(state.latestFunctionalTurn.source, "audio_transcript");
    assert.ok(state.inboundSources.includes("control-event"));
    assert.ok(state.timelineTypes.includes("realtime_audio_transcript_direct_tool_requested"));
  } finally {
    await browser.close();
  }
});

test("Realtime token fetch failures keep retry metadata and schedule reconnect", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: `
        window.OpenAIAgentsRealtime = {
          tool: (toolDef) => toolDef,
          RealtimeAgent: class {
            constructor(config) { this.config = config; }
          },
          RealtimeSession: class {
            constructor(agent, options) { this.agent = agent; this.options = options; }
            on() {}
            async connect() {}
            close() {}
          }
        };
        let tokenAttempts = 0;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (url, options) => {
          if (String(url).includes("/realtime/client-secret")) {
            tokenAttempts += 1;
            if (tokenAttempts === 1) throw new Error("synthetic token timeout");
            return new Response(JSON.stringify({ value: "ephemeral_test_key" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
          return originalFetch(url, options);
        };
        window.__TOKEN_ATTEMPTS__ = () => tokenAttempts;
      `,
    });
    await page.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "agents-sdk",
        agentRuntime: "agents-sdk",
        autoConnect: true,
        simulateRemoteAudio: false,
        directTextTurnToolRouting: true,
        tokenUrl: "https://meeting.test/realtime/client-secret",
        tools: [],
        session: { model: "gpt-realtime-2" },
      }),
    });
    await page.goto("data:text/html,<html><body>bridge</body></html>");

    await page.waitForFunction(() =>
      window.MAB_REALTIME_BRIDGE?.timeline?.some(
        (entry) => entry.type === "realtime_reconnect_scheduled",
      ),
    );
    await page.waitForFunction(() => window.__TOKEN_ATTEMPTS__() >= 2);

    const state = await page.evaluate(() => ({
      attempts: window.__TOKEN_ATTEMPTS__(),
      sdkConnected: window.MAB_REALTIME_BRIDGE.agentRuntime.sdkConnected,
      tokenError: window.MAB_REALTIME_BRIDGE.connection.lastTokenError,
      timelineTypes: window.MAB_REALTIME_BRIDGE.timeline.map((entry) => entry.type),
    }));

    assert.ok(state.attempts >= 2);
    assert.equal(state.tokenError.reason, "realtime_token_fetch_failed");
    assert.ok(state.timelineTypes.includes("realtime_reconnect_scheduled"));
  } finally {
    await browser.close();
  }
});
