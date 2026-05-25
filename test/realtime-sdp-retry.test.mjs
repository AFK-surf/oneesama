import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime browser bridge records SDP 429 details and schedules retry", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: `
        (() => {
          const calls = [];
          window.__sdpRetryTestCalls = calls;
          window.fetch = async (url, options = {}) => {
            calls.push({ url: String(url), method: String(options.method || "GET") });
            if (String(url).includes("/realtime/client-secret")) {
              return new Response(JSON.stringify({ ok: true, client_secret: { value: "ek_test" } }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            if (String(url).includes("/v1/realtime/calls")) {
              return new Response(JSON.stringify({ error: { message: "rate limit" } }), {
                status: 429,
                headers: {
                  "content-type": "application/json",
                  "retry-after": "2",
                  "x-request-id": "req_sdp_429_test",
                },
              });
            }
            return new Response("not found", { status: 404 });
          };

          class MockDataChannel {
            constructor() {
              this.readyState = "connecting";
              this.label = "oai-events";
            }
            send() {}
            close() {
              this.readyState = "closed";
              this.onclose?.();
            }
          }

          class MockPeerConnection {
            constructor() {
              this.connectionState = "new";
            }
            addEventListener() {}
            addTransceiver() {
              return { sender: { track: null } };
            }
            addTrack(track) {
              return { track };
            }
            createDataChannel() {
              return new MockDataChannel();
            }
            async createOffer() {
              return { type: "offer", sdp: "v=0\\r\\n" };
            }
            async setLocalDescription() {}
            async setRemoteDescription() {}
            getSenders() {
              return [];
            }
            close() {
              this.connectionState = "closed";
            }
          }

          class MockAudioContext {
            constructor() {
              this.state = "running";
            }
            createGain() {
              return { gain: { value: 1 }, connect() {} };
            }
            createMediaStreamDestination() {
              return { stream: new MediaStream() };
            }
            createConstantSource() {
              return { offset: { value: 0 }, connect() {}, start() {} };
            }
          }

          window.RTCPeerConnection = MockPeerConnection;
          window.AudioContext = MockAudioContext;
          window.webkitAudioContext = MockAudioContext;
        })();
      `,
    });
    await page.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc",
        agentRuntime: "raw",
        autoConnect: true,
        autoReconnect: true,
        tokenUrl: "/realtime/client-secret",
        sdpUrl: "https://api.openai.com/v1/realtime/calls",
        botName: "Onee-sama",
        session: { model: "gpt-realtime-2" },
        instructions: "Test only.",
        tools: [],
      }),
    });
    await page.goto("data:text/html,<html><body>realtime sdp retry</body></html>");

    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.lastSdpError?.status === 429,
    );
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.reconnectAttempts === 1,
    );

    const state = await page.evaluate(() => ({
      connection: window.MAB_REALTIME_BRIDGE.connection,
      feedback: window.MAB_REALTIME_BRIDGE.feedback,
      errors: window.MAB_REALTIME_BRIDGE.errors,
      calls: window.__sdpRetryTestCalls,
    }));

    assert.equal(state.connection.lastSdpError.status, 429);
    assert.equal(state.connection.lastSdpError.retryable, true);
    assert.equal(state.connection.lastSdpError.retryAfter, "2");
    assert.equal(state.connection.lastSdpError.retryAfterMs, 2000);
    assert.equal(state.connection.lastSdpError.requestId, "req_sdp_429_test");
    assert.match(state.connection.lastSdpError.body, /rate limit/);
    assert.equal(state.connection.lastReconnectReason, "realtime_sdp_rate_limited");
    assert.equal(state.feedback.blockers.includes("realtime_sdp_rate_limited"), true);
    assert.match(state.errors.at(-1).message, /Realtime SDP exchange failed: 429/);
    assert.equal(
      state.calls.filter((entry) => String(entry.url).includes("/v1/realtime/calls")).length,
      1,
    );
  } finally {
    await browser.close();
  }
});
