import assert from "node:assert/strict";
import http from "node:http";
import { test } from "vite-plus/test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime sidecar survives a strict-CSP Meet surface fixture", async () => {
  await withStrictCspToolServer(async ({ baseUrl, calls }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const meetPage = await context.newPage();
    const sidecarPage = await context.newPage();
    try {
      await meetPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "webrtc",
          agentRuntime: "agents-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "meet-surface",
          sessionId: "sidecar-csp-session",
        }),
      });
      await sidecarPage.addInitScript({ content: fakeRealtimeSdkSource() });
      await sidecarPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk",
          agentRuntime: "test-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "sidecar",
          sessionId: "sidecar-csp-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          toolCallbackToken: "test-session-token",
          allowMockToolSimulation: true,
          instructions: "Use tools when needed.",
          tools: [
            {
              type: "function",
              name: "list_shareable_windows",
              description: "List shareable app windows.",
              parameters: { type: "object", properties: {}, required: [] },
            },
          ],
          session: {
            model: "gpt-realtime-2",
            audio: { output: { voice: "marin" } },
          },
        }),
      });

      await meetPage.goto(`${baseUrl}/meet-csp`);
      await sidecarPage.goto(`${baseUrl}/sidecar`);
      await sidecarPage.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );
      const sidecarEvidence = await sidecarPage.evaluate(async () => {
        window.__MAB_FAKE_REALTIME_SESSION.emit("transport_event", {
          type: "session.created",
          session: { id: "sess_sidecar_csp_123" },
        });
        const textTurn = window.MAB_REALTIME_CLIENT.requestRealtimeTextTurn({
          text: "分享 Chrome 窗口",
          instructions: "Treat this as a strict-CSP sidecar share turn.",
        });
        const toolResult = await window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall(
          "list_shareable_windows",
          { source: "strict-csp-sidecar-fixture" },
        );
        const history = [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "分享 Chrome 窗口" }],
          },
          {
            type: "function_call",
            name: "list_shareable_windows",
            call_id: toolResult.callId,
          },
          {
            type: "function_call_output",
            call_id: toolResult.callId,
            output: JSON.stringify(toolResult.result),
          },
        ];
        window.__MAB_FAKE_REALTIME_SESSION.history = history;
        window.__MAB_FAKE_REALTIME_SESSION.emit("history_updated", history);
        return {
          textTurn,
          toolResult,
          transportEvents: window.__MAB_FAKE_REALTIME_TRANSPORT_EVENTS || [],
          bridge: window.MAB_REALTIME_BRIDGE,
        };
      });
      const meetState = await meetPage.evaluate(() => {
        let inlineScriptExecuted = false;
        let inlineScriptError = "";
        try {
          const script = document.createElement("script");
          script.text = "window.__MAB_CSP_INLINE_SCRIPT_RAN = true";
          document.documentElement.appendChild(script);
          inlineScriptExecuted = window.__MAB_CSP_INLINE_SCRIPT_RAN === true;
        } catch (error) {
          inlineScriptError = String(error?.message || error);
        }
        return {
          fixture: document.querySelector("[data-fixture='meet-page-csp']")?.textContent || "",
          inlineScriptExecuted,
          inlineScriptError,
          hasSDKGlobal: Boolean(window.OpenAIAgentsRealtime),
          surfaceToolsReady: typeof window.MAB_MEET_SURFACE_TOOLS?.run === "function",
          bridge: window.MAB_REALTIME_BRIDGE,
        };
      });
      const sidecarState = sidecarEvidence.bridge;

      assert.equal(meetState.fixture, "Strict CSP Meet fixture");
      assert.equal(meetState.inlineScriptExecuted, false);
      assert.match(meetState.inlineScriptError, /TrustedScript|trusted|script/i);
      assert.equal(meetState.hasSDKGlobal, false);
      assert.equal(meetState.surfaceToolsReady, true);
      assert.equal(meetState.bridge.agentRuntime.sdkSuppressedOnMeetSurface, true);
      assert.equal(meetState.bridge.agentRuntime.sdkConnected, false);
      assert.equal(sidecarState.agentRuntime.sdkConnected, true);
      assert.equal(sidecarState.connection.openaiSessionId, "sess_sidecar_csp_123");
      assert.equal(sidecarEvidence.textTurn.ok, true);
      assert.equal(sidecarEvidence.textTurn.channel, "agents-sdk-transport");
      assert.equal(sidecarEvidence.transportEvents.at(0)?.type, "conversation.item.create");
      assert.equal(sidecarEvidence.transportEvents.at(1)?.type, "response.create");
      assert.equal(sidecarEvidence.toolResult.ok, true);
      assert.equal(sidecarState.contextHealth.latestFunctionalTurn.intent, "share");
      assert.equal(sidecarState.contextHealth.latestFunctionalTurn.toolCalled, true);
      assert.equal(sidecarState.contextHealth.latestFunctionalTurn.fakeExecution, false);
      assert.ok(
        sidecarState.contextHealth.lastHistoryTail.some((entry) =>
          /分享 Chrome 窗口/.test(entry.text),
        ),
      );
      assert.ok(
        sidecarState.meetTools.calls.some((entry) => entry.name === "list_shareable_windows"),
      );
      assert.ok(calls.some((entry) => entry.path === "/screen-share/apps"));
    } finally {
      await browser.close();
    }
  });
});

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
          this.listeners = new Map();
          window.__MAB_FAKE_REALTIME_TRANSPORT = this;
        }

        on(type, callback) {
          const callbacks = this.listeners.get(type) || [];
          callbacks.push(callback);
          this.listeners.set(type, callbacks);
          return this;
        }

        emit(type, event) {
          for (const callback of this.listeners.get(type) || []) callback(event);
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

        interrupt() {}

        close() {}
      },
    };
  `;
}

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

async function withStrictCspToolServer(callback) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    try {
      const body = await readJson(request);
      calls.push({
        path: request.url,
        method: request.method,
        auth: request.headers["x-oneesama-internal-key"] || "",
        body,
      });
      if (request.url === "/meet-csp") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.setHeader(
          "content-security-policy",
          [
            "default-src 'self'",
            "script-src 'self'",
            "connect-src *",
            "img-src 'self' data:",
            "style-src 'self' 'unsafe-inline'",
            "require-trusted-types-for 'script'",
            "trusted-types oneesama",
          ].join("; "),
        );
        response.end(`<!doctype html>
<html><body><main data-fixture="meet-page-csp">Strict CSP Meet fixture</main></body></html>`);
        return;
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/realtime/client-secret") {
        response.end(JSON.stringify({ ok: true, client_secret: { value: "ek_mock_sdk" } }));
        return;
      }
      if (request.url === "/screen-share/apps") {
        response.end(
          JSON.stringify({
            ok: true,
            windows: [
              {
                id: "chrome-window-1",
                applicationName: "Google Chrome",
                windowTitle: "Chrome 浏览器窗口",
              },
            ],
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
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await callback({ baseUrl, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
