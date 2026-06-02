import assert from "node:assert/strict";
import http from "node:http";
import { test } from "vite-plus/test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

async function withTokenServer(callback) {
  const server = http.createServer(async (request, response) => {
    await readJson(request).catch(() => ({}));
    response.setHeader("content-type", "application/json");
    if (request.url === "/realtime/client-secret") {
      response.end(JSON.stringify({ ok: true, client_secret: { value: "ek_mock_sdk" } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback({ baseUrl: `http://127.0.0.1:${address.port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function fakeRealtimeSdkSource() {
  return `
    window.OpenAIAgentsRealtime = {
      tool(config) {
        return config;
      },
      RealtimeAgent: function RealtimeAgent(config) {
        this.config = config;
      },
      OpenAIRealtimeWebRTC: class OpenAIRealtimeWebRTC {
        constructor(options) {
          this.options = options;
          window.__MAB_FAKE_REALTIME_TRANSPORT = this;
        }

        on() {
          return this;
        }

        sendEvent(event) {
          window.__MAB_FAKE_REALTIME_TRANSPORT_EVENTS =
            window.__MAB_FAKE_REALTIME_TRANSPORT_EVENTS || [];
          window.__MAB_FAKE_REALTIME_TRANSPORT_EVENTS.push(event);
        }

        close() {}
      },
      RealtimeSession: class RealtimeSession {
        constructor() {
          this.listeners = new Map();
          this.history = [];
          window.__MAB_FAKE_REALTIME_SESSION = this;
        }

        on(type, callback) {
          const callbacks = this.listeners.get(type) || [];
          callbacks.push(callback);
          this.listeners.set(type, callbacks);
          return this;
        }

        emit(type, ...args) {
          for (const callback of this.listeners.get(type) || []) callback(...args);
        }

        async connect() {}

        sendMessage(message, otherEventData = {}) {
          window.__MAB_FAKE_REALTIME_MESSAGES = window.__MAB_FAKE_REALTIME_MESSAGES || [];
          window.__MAB_FAKE_REALTIME_MESSAGES.push({ message, otherEventData });
        }

        close() {}
      },
    };
  `;
}

const functionalTools = [
  {
    type: "function",
    name: "list_shareable_windows",
    description: "List windows.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "share_existing_app_window",
    description: "Share an app window.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "control_shared_app_window",
    description: "Control a shared app window.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

const laneTools = [
  ...functionalTools,
  {
    type: "function",
    name: "delegate_to_worker",
    description: "Start a background workspace job.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "worker_status",
    description: "Check background job status.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

test("Realtime text turns force high-confidence background lane tool choices", async () => {
  await withTokenServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({ content: fakeRealtimeSdkSource() });
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "test-sdk",
          sessionId: "sdk-text-turn-lane-choice-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          openaiRealtimeBaseUrl: "https://api.openai.com/v1",
          tools: laneTools,
        }),
      });
      await page.goto(`${baseUrl}/`);
      await page.waitForFunction(() => window.__MAB_FAKE_REALTIME_SESSION);

      const result = await page.evaluate(() => {
        window.__MAB_FAKE_REALTIME_TRANSPORT_EVENTS = [];
        window.MAB_REALTIME_BRIDGE.session.toolNames = [];
        window.MAB_REALTIME_CLIENT.requestRealtimeTextTurn({
          text: "codex 那个活儿进度到哪了",
          instructions: "Treat this as a live meeting turn.",
        });
        window.MAB_REALTIME_CLIENT.requestRealtimeTextTurn({
          text: "在 github 上搜一下 AFK-surf/oneesama 仓库里关于 realtime 的 issue",
          instructions: "Treat this as a live meeting turn.",
        });
        window.MAB_REALTIME_CLIENT.requestRealtimeTextTurn({
          text: "用 codex 帮我写个脚本处理这批文件",
          instructions: "Treat this as a live meeting turn.",
        });
        window.MAB_REALTIME_CLIENT.requestRealtimeTextTurn({
          text: "介绍一下你自己",
          instructions: "Treat this as a live meeting turn.",
        });
        return window.__MAB_FAKE_REALTIME_TRANSPORT_EVENTS
          .filter((event) => event.type === "response.create")
          .map((event) => ({
            tool: event.response?.tool_choice?.name || "",
            instructions: event.response?.instructions || "",
          }));
      });

      assert.deepEqual(
        result.map((entry) => entry.tool),
        ["worker_status", "delegate_to_worker", "delegate_to_worker", ""],
      );
      assert.match(result[0].instructions, /call worker_status now before any assistant text/);
      assert.match(result[1].instructions, /call delegate_to_worker now before any assistant text/);
      assert.match(result[2].instructions, /call delegate_to_worker now before any assistant text/);
      assert.doesNotMatch(result[3].instructions, /before any assistant text/);
    } finally {
      await browser.close();
    }
  });
});

test("Realtime Agents SDK treats share/control fake execution as hard failure without auto-recovery", async () => {
  await withTokenServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({ content: fakeRealtimeSdkSource() });
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "test-sdk",
          sessionId: "sdk-share-fake-execution-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          openaiRealtimeBaseUrl: "https://api.openai.com/v1",
          allowFunctionalToolRecovery: true,
          tools: functionalTools,
        }),
      });
      await page.goto(`${baseUrl}/`);
      await page.waitForFunction(() => window.__MAB_FAKE_REALTIME_SESSION);

      const fake = await page.evaluate(() => {
        window.__MAB_FAKE_REALTIME_SESSION.emit("transport_event", {
          type: "response.created",
          response: { id: "resp_fake_ack" },
        });
        const history = [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "分享一下 Chrome 浏览器窗口。" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "还在共享处理中，请稍等一下。" }],
          },
        ];
        window.__MAB_FAKE_REALTIME_SESSION.history = history;
        window.__MAB_FAKE_REALTIME_SESSION.emit("history_updated", history);
        return {
          health: window.MAB_REALTIME_BRIDGE.contextHealth,
          feedback: window.MAB_REALTIME_BRIDGE.feedback,
          outbound: window.MAB_REALTIME_BRIDGE.outbound,
          hasFunctionalToolRecoveries: Object.prototype.hasOwnProperty.call(
            window.MAB_REALTIME_BRIDGE.turnPolicy,
            "functionalToolRecoveries",
          ),
        };
      });

      assert.equal(fake.health.latestFunctionalTurn.observed, true);
      assert.equal(fake.health.latestFunctionalTurn.intent, "share");
      assert.equal(fake.health.latestFunctionalTurn.reason, "assistant_text_without_expected_tool");
      assert.equal(fake.feedback.checks.latestFunctionalTurnFakeExecution, true);
      assert.equal(fake.feedback.failureMatrix.toolTurns.status, "blocked");
      assert.equal(
        fake.feedback.failureMatrix.toolTurns.reason,
        "assistant_text_without_expected_functional_tool",
      );
      assert.equal(fake.hasFunctionalToolRecoveries, false);
      assert.equal(
        fake.outbound.some(
          (entry) =>
            entry.event?.type === "response.cancel" && entry.event?.response_id === "resp_fake_ack",
        ),
        false,
      );
      assert.equal(
        fake.outbound.some(
          (entry) =>
            entry.event?.type === "response.create" &&
            entry.event?.metadata?.source === "functional_tool_recovery",
        ),
        false,
      );

      const realTool = await page.evaluate(() => {
        const history = [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "分享一下 Chrome 浏览器窗口。" }],
          },
          {
            type: "function_call",
            name: "list_shareable_windows",
            call_id: "call_share_windows",
          },
          {
            type: "function_call_output",
            call_id: "call_share_windows",
            output:
              '{"ok":true,"result":{"app":{"applicationName":"Chrome","windowTitle":"Chrome 浏览器窗口"},"note":"control_shared_app_window is available after sharing"}}',
          },
        ];
        window.__MAB_FAKE_REALTIME_SESSION.history = history;
        window.__MAB_FAKE_REALTIME_SESSION.emit("history_updated", history);
        return {
          health: window.MAB_REALTIME_BRIDGE.contextHealth,
          feedback: window.MAB_REALTIME_BRIDGE.feedback,
        };
      });

      assert.equal(realTool.health.latestFunctionalTurn.toolCalled, true);
      assert.equal(realTool.health.latestFunctionalTurn.fakeExecution, false);
      assert.equal(realTool.health.latestFunctionalTurn.intent, "share");
      assert.ok(realTool.health.lastHistoryTail.at(-1).text.length <= 500);
      assert.notEqual(
        realTool.feedback.failureMatrix.toolTurns.reason,
        "assistant_text_without_expected_functional_tool",
      );

      const controlRecovery = await page.evaluate(() => {
        const history = [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "你用电脑控制共享的浏览器，在搜索框输入 hello 然后回车。",
              },
            ],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "还在处理，请稍等一下。" }],
          },
        ];
        window.__MAB_FAKE_REALTIME_SESSION.history = history;
        window.__MAB_FAKE_REALTIME_SESSION.emit("history_updated", history);
        return {
          health: window.MAB_REALTIME_BRIDGE.contextHealth,
          outbound: window.MAB_REALTIME_BRIDGE.outbound,
        };
      });

      assert.equal(controlRecovery.health.latestFunctionalTurn.intent, "control");
      assert.equal(
        controlRecovery.outbound.some(
          (entry) =>
            entry.event?.type === "response.create" &&
            entry.event?.metadata?.source === "functional_tool_recovery",
        ),
        false,
      );
    } finally {
      await browser.close();
    }
  });
});

test("Realtime text-turn replay fails hard when model activity has no SDK history or share tool call", async () => {
  await withTokenServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({ content: fakeRealtimeSdkSource() });
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "test-sdk",
          sessionId: "sdk-share-manual-turn-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          openaiRealtimeBaseUrl: "https://api.openai.com/v1",
          tools: functionalTools,
        }),
      });
      await page.goto(`${baseUrl}/`);
      await page.waitForFunction(() => window.__MAB_FAKE_REALTIME_SESSION);

      const result = await page.evaluate(() => {
        const request = window.MAB_REALTIME_CLIENT.requestRealtimeTextTurn({
          text: "请共享这台 Mac mini 上的浏览器窗口。",
          instructions: "Treat this as a live meeting turn.",
        });
        window.__MAB_FAKE_REALTIME_SESSION.emit("agent_end", {}, {}, "好的，我来共享。");
        return {
          request,
          messages: window.__MAB_FAKE_REALTIME_MESSAGES,
          transportEvents: window.__MAB_FAKE_REALTIME_TRANSPORT_EVENTS,
          health: window.MAB_REALTIME_BRIDGE.contextHealth,
          feedback: window.MAB_REALTIME_BRIDGE.feedback,
          manualTurns: window.MAB_REALTIME_BRIDGE.turnPolicy.manualFunctionalTurns,
          meetToolCalls: window.MAB_REALTIME_BRIDGE.meetTools.calls,
        };
      });

      assert.equal(result.request.ok, true);
      assert.equal(result.request.channel, "agents-sdk-transport");
      assert.equal(result.transportEvents[0].type, "conversation.item.create");
      assert.equal(result.transportEvents[1].type, "response.create");
      assert.equal(
        result.transportEvents[0].item.content[0].text,
        "请共享这台 Mac mini 上的浏览器窗口。",
      );
      assert.equal(
        result.transportEvents[1].response.instructions,
        "Treat this as a live meeting turn.",
      );
      assert.equal(result.manualTurns.length, 1);
      assert.equal(result.health.latestFunctionalTurn.source, "manual_text_turn");
      assert.equal(result.health.latestFunctionalTurn.historyObserved, false);
      assert.equal(result.health.latestFunctionalTurn.modelTurnObserved, true);
      assert.equal(result.health.latestFunctionalTurn.toolCalled, false);
      assert.equal(result.health.latestFunctionalTurn.fakeExecution, true);
      assert.equal(
        result.health.latestFunctionalTurn.reason,
        "manual_functional_turn_model_turn_without_expected_tool",
      );
      assert.equal(result.feedback.status, "tool_blocked");
      assert.deepEqual(result.meetToolCalls, []);
      assert.equal(result.transportEvents.length, 2);
      assert.equal(result.transportEvents.at(-1).type, "response.create");
      assert.equal(result.transportEvents.at(-1).response.tool_choice, undefined);
      assert.equal(
        result.transportEvents.some(
          (event) => event.metadata?.source === "functional_tool_recovery",
        ),
        false,
      );
      assert.ok(
        result.feedback.blockers.includes("assistant_text_without_expected_functional_tool"),
      );
    } finally {
      await browser.close();
    }
  });
});

test("Realtime text-turn fallback counts workspace app-control calls", async () => {
  await withTokenServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({ content: fakeRealtimeSdkSource() });
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "test-sdk",
          sessionId: "sdk-control-workspace-call-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          openaiRealtimeBaseUrl: "https://api.openai.com/v1",
          tools: functionalTools,
        }),
      });
      await page.goto(`${baseUrl}/`);
      await page.waitForFunction(() => window.__MAB_FAKE_REALTIME_SESSION);

      const result = await page.evaluate(() => {
        const request = window.MAB_REALTIME_CLIENT.requestRealtimeTextTurn({
          text: "你用电脑控制共享的浏览器，在搜索框输入 hello 然后回车。",
          instructions: "Treat this as a live meeting turn.",
        });
        window.MAB_REALTIME_BRIDGE.workspaceTools.calls.push({
          ts: new Date().toISOString(),
          name: "control_shared_app_window",
          callId: "call_control_workspace",
          result: { ok: true, status: "queued" },
        });
        window.__MAB_FAKE_REALTIME_SESSION.emit("agent_end", {}, {}, "好的，我来处理。");
        return {
          request,
          health: window.MAB_REALTIME_BRIDGE.contextHealth,
          feedback: window.MAB_REALTIME_BRIDGE.feedback,
          manualTurns: window.MAB_REALTIME_BRIDGE.turnPolicy.manualFunctionalTurns,
          workspaceToolCalls: window.MAB_REALTIME_BRIDGE.workspaceTools.calls,
        };
      });

      assert.equal(result.request.ok, true);
      assert.equal(result.manualTurns.length, 1);
      assert.equal(result.manualTurns[0].baselineWorkspaceToolCalls, 0);
      assert.equal(result.health.latestFunctionalTurn.source, "manual_text_turn");
      assert.equal(result.health.latestFunctionalTurn.intent, "control");
      assert.deepEqual(result.health.latestFunctionalTurn.toolNames, ["control_shared_app_window"]);
      assert.equal(result.health.latestFunctionalTurn.toolCalled, true);
      assert.equal(result.health.latestFunctionalTurn.fakeExecution, false);
      assert.equal(
        result.health.latestFunctionalTurn.reason,
        "expected_tool_observed_after_manual_functional_turn",
      );
      assert.equal(result.feedback.checks.latestFunctionalTurnFakeExecution, false);
      assert.equal(
        result.feedback.blockers.includes("assistant_text_without_expected_functional_tool"),
        false,
      );
      assert.equal(result.workspaceToolCalls.length, 1);
    } finally {
      await browser.close();
    }
  });
});

test("Realtime Agents SDK telemetry retains session id and input transcripts", async () => {
  await withTokenServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({ content: fakeRealtimeSdkSource() });
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "test-sdk",
          sessionId: "sdk-input-transcript-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          openaiRealtimeBaseUrl: "https://api.openai.com/v1",
          tools: functionalTools,
        }),
      });
      await page.goto(`${baseUrl}/`);
      await page.waitForFunction(() => window.__MAB_FAKE_REALTIME_SESSION);

      const result = await page.evaluate(() => {
        window.__MAB_FAKE_REALTIME_SESSION.emit("transport_event", {
          type: "session.created",
          session: { id: "sess_sdk_live_123" },
        });
        window.__MAB_FAKE_REALTIME_SESSION.emit("transport_event", {
          type: "conversation.item.input_audio_transcription.delta",
          item_id: "item_audio_1",
          delta: "分享 Chrome ",
        });
        window.__MAB_FAKE_REALTIME_SESSION.emit("transport_event", {
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item_audio_1",
          transcript: "分享 Chrome 浏览器窗口。",
        });
        return {
          openaiSessionId: window.MAB_REALTIME_BRIDGE.connection.openaiSessionId,
          input: window.MAB_REALTIME_BRIDGE.transcripts.input,
          currentInput: window.MAB_REALTIME_BRIDGE.transcripts.currentInput,
        };
      });

      assert.equal(result.openaiSessionId, "sess_sdk_live_123");
      assert.deepEqual(result.input, [
        {
          ts: result.input[0].ts,
          itemId: "item_audio_1",
          text: "分享 Chrome 浏览器窗口。",
        },
      ]);
      assert.equal(result.currentInput, "");
    } finally {
      await browser.close();
    }
  });
});
