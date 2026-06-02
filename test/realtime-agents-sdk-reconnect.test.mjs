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

function fakeSdkPeerSource() {
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
          const listeners = new Map();
          const pc = {
            connectionState: "connected",
            getSenders: () => [],
            addEventListener(type, callback) {
              const callbacks = listeners.get(type) || [];
              callbacks.push(callback);
              listeners.set(type, callbacks);
            },
            emit(type) {
              for (const callback of listeners.get(type) || []) callback();
            },
            close() {
              this.connectionState = "closed";
              this.emit("connectionstatechange");
            },
          };
          window.__MAB_FAKE_WEBRTC_PC = pc;
          options.changePeerConnection(pc);
        }

        on() {
          return this;
        }

        close() {}
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
  `;
}

function fakeSdkSendFailureSource() {
  return `
    window.OpenAIAgentsRealtime = {
      tool(config) {
        return config;
      },
      RealtimeAgent: function RealtimeAgent(config) {
        this.config = config;
      },
      OpenAIRealtimeWebRTC: class OpenAIRealtimeWebRTC {
        constructor() {}

        on() {
          return this;
        }

        close() {}

        sendEvent() {
          throw new Error("WebRTC data channel is not connected. Make sure you call connect() before sending events.");
        }
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
  `;
}

function reconnectScript(baseUrl, sessionId) {
  return buildRealtimeBrowserInitScript({
    mode: "agents-sdk",
    agentRuntime: "test-sdk",
    sessionId,
    botName: "Onee-sama",
    autoConnect: true,
    tokenUrl: `${baseUrl}/realtime/client-secret`,
    openaiRealtimeBaseUrl: "https://api.openai.com/v1",
  });
}

test("Realtime Agents SDK schedules reconnect when the peer connection closes", async () => {
  await withTokenServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({ content: fakeSdkPeerSource() });
      await page.addInitScript({
        content: reconnectScript(baseUrl, "sdk-peer-close-session"),
      });
      await page.goto(`${baseUrl}/`);
      await page.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );

      const bridge = await page.evaluate(() => {
        window.__MAB_FAKE_WEBRTC_PC.connectionState = "closed";
        window.__MAB_FAKE_WEBRTC_PC.emit("connectionstatechange");
        return window.MAB_REALTIME_BRIDGE;
      });

      assert.equal(bridge.connected, false);
      assert.equal(bridge.agentRuntime.sdkConnected, false);
      assert.equal(bridge.connection.dataChannelOpen, false);
      assert.equal(bridge.connection.reconnecting, true);
      assert.equal(bridge.connection.lastReconnectReason, "agents_sdk_peer_closed");
      assert.ok(
        bridge.timeline.some(
          (entry) =>
            entry.type === "realtime_agent_sdk_disconnected" &&
            entry.detail.reason === "agents_sdk_peer_closed",
        ),
      );
    } finally {
      await browser.close();
    }
  });
});

test("Realtime Agents SDK send failures schedule reconnect instead of escaping page eval", async () => {
  await withTokenServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({ content: fakeSdkSendFailureSource() });
      await page.addInitScript({
        content: reconnectScript(baseUrl, "sdk-send-failure-session"),
      });
      await page.goto(`${baseUrl}/`);
      await page.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );

      const result = await page.evaluate(() => {
        const push = window.MAB_REALTIME_CLIENT.pushSessionContext({
          text: "meeting context",
          signature: "send-failure-context",
          reason: "unit_test_send_failure",
        });
        return {
          push,
          bridge: window.MAB_REALTIME_BRIDGE,
        };
      });

      assert.equal(result.push.channel, "agents-sdk-transport-not-connected");
      assert.equal(result.bridge.connected, false);
      assert.equal(result.bridge.agentRuntime.sdkConnected, false);
      assert.equal(result.bridge.connection.dataChannelOpen, false);
      assert.equal(result.bridge.connection.reconnecting, true);
      assert.equal(result.bridge.connection.lastReconnectReason, "agents_sdk_send_not_connected");
      assert.match(
        result.bridge.connection.lastRealtimeAgentSDKSendError,
        /data channel is not connected/i,
      );
      assert.ok(
        result.bridge.timeline.some(
          (entry) =>
            entry.type === "realtime_agent_sdk_disconnected" &&
            entry.detail.reason === "agents_sdk_send_not_connected",
        ),
      );
    } finally {
      await browser.close();
    }
  });
});
