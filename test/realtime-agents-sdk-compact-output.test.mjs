import assert from "node:assert/strict";
import http from "node:http";
import { test } from "vite-plus/test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime Agents SDK execute return keeps turn policy out of model-visible output", async () => {
  await withCompactOutputToolServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({
        content: `
          window.__MAB_FAKE_SDK_TOOLS = [];
          window.OpenAIAgentsRealtime = {
            tool(config) {
              return config;
            },
            backgroundResult(output) {
              return { background: true, output };
            },
            RealtimeAgent: function RealtimeAgent(config) {
              this.config = config;
              window.__MAB_FAKE_SDK_TOOLS = config.tools || [];
            },
            RealtimeSession: class RealtimeSession {
              constructor() {
                this.listeners = new Map();
              }

              on(type, callback) {
                const callbacks = this.listeners.get(type) || [];
                callbacks.push(callback);
                this.listeners.set(type, callbacks);
                return this;
              }

              async connect() {}

              close() {}
            },
          };
        `,
      });
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk-mock",
          agentRuntime: "test-sdk",
          realtimeRuntimePlacement: "inline",
          allowInlineAgentsSDKDiagnostic: true,
          sessionId: "sdk-compact-output-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          toolCallbackToken: "test-session-token",
          tools: [
            {
              type: "function",
              name: "kwwk_computer_use",
              description: "Control the currently shared app window.",
              parameters: { type: "object", properties: {}, required: [] },
            },
          ],
          session: {
            model: "gpt-realtime-2",
            audio: { output: { voice: "marin" } },
          },
        }),
      });
      await page.goto(`${baseUrl}/`);
      await page.waitForFunction(
        () =>
          window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true &&
          window.__MAB_FAKE_SDK_TOOLS?.length > 0,
      );

      const result = await page.evaluate(async () => {
        const tool = window.__MAB_FAKE_SDK_TOOLS.find(
          (entry) => entry.name === "kwwk_computer_use",
        );
        const output = await tool.execute(
          { instruction: "observe the shared window" },
          {},
          { toolCall: { callId: "call_compact_output" } },
        );
        return {
          output,
          bridge: window.MAB_REALTIME_BRIDGE,
        };
      });

      const outputText = result.output.background ? result.output.output : result.output;
      const parsed = JSON.parse(outputText);
      assert.equal(result.output.background, true);
      assert.equal(parsed.status, "queued");
      assert.equal(parsed.job_id, "job_sdk_app_control_queued");
      assert.equal(parsed.summary, "Queued app control job.");
      assert.equal(parsed.displayText, "Needs background handling.");
      assert.equal(parsed.answer_hint_en, "Needs background handling.");
      assert.equal(parsed.answer_hint_zh, undefined);
      assert.equal(parsed.turnPolicy, undefined);
      assert.doesNotMatch(outputText, /turnPolicy|autoRespond|responseInstructions|instructions/);
      assert.equal(result.bridge.turnPolicy.decisions.at(-1).reason, "app_control_async_accepted");
      assert.equal(
        result.bridge.workspaceTools.calls.at(-1).delivery.modelResult.turnPolicy.reason,
        "app_control_async_accepted",
      );
    } finally {
      await browser.close();
    }
  });
});

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

async function withCompactOutputToolServer(callback) {
  const server = http.createServer(async (request, response) => {
    try {
      await readJson(request);
      response.setHeader("content-type", "application/json");
      if (request.url === "/realtime/client-secret") {
        response.end(JSON.stringify({ ok: true, client_secret: { value: "ek_mock_sdk" } }));
        return;
      }
      if (request.url === "/tools/kwwk_computer_use") {
        response.end(
          JSON.stringify({
            ok: true,
            status: "queued",
            jobId: "job_sdk_app_control_queued",
            summary: "Queued app control job.",
            displayText: "Needs background handling.",
            answer_hint_en: "Needs background handling.",
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback({ baseUrl: `http://127.0.0.1:${address.port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
