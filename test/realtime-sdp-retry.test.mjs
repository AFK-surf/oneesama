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
            addEventListener(type, handler) {
              this["on" + type] = handler;
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
            createAnalyser() {
              return {
                fftSize: 2048,
                getFloatTimeDomainData(buffer) {
                  buffer.fill(0);
                },
                connect() {},
              };
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

test("Realtime browser bridge retries SDP network failures", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: `
        (() => {
          const calls = [];
          window.__sdpNetworkFailureTestCalls = calls;
          window.fetch = async (url, options = {}) => {
            calls.push({ url: String(url), method: String(options.method || "GET") });
            if (String(url).includes("/realtime/client-secret")) {
              return new Response(JSON.stringify({ ok: true, client_secret: { value: "ek_test" } }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            if (String(url).includes("/v1/realtime/calls")) {
              throw new TypeError("Failed to fetch");
            }
            return new Response("not found", { status: 404 });
          };

          class MockDataChannel {
            constructor() {
              this.readyState = "connecting";
              this.label = "oai-events";
            }
            addEventListener(type, handler) {
              this["on" + type] = handler;
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
            createAnalyser() {
              return {
                fftSize: 2048,
                getFloatTimeDomainData(buffer) {
                  buffer.fill(0);
                },
                connect() {},
              };
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
    await page.goto("data:text/html,<html><body>realtime sdp network failure</body></html>");

    await page.waitForFunction(
      () =>
        window.MAB_REALTIME_BRIDGE?.connection?.lastSdpError?.reason ===
        "realtime_sdp_fetch_failed",
    );
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.reconnectAttempts === 1,
    );

    const state = await page.evaluate(() => ({
      connection: window.MAB_REALTIME_BRIDGE.connection,
      feedback: window.MAB_REALTIME_BRIDGE.feedback,
      errors: window.MAB_REALTIME_BRIDGE.errors,
      calls: window.__sdpNetworkFailureTestCalls,
    }));

    assert.equal(state.connection.lastSdpError.status, 0);
    assert.equal(state.connection.lastSdpError.retryable, true);
    assert.equal(state.connection.lastSdpError.terminal, false);
    assert.match(state.connection.lastSdpError.error, /Failed to fetch/);
    assert.equal(state.connection.lastReconnectReason, "realtime_sdp_fetch_failed");
    assert.equal(state.feedback.blockers.includes("realtime_sdp_failed"), true);
    assert.match(state.errors.at(-1).message, /Realtime SDP fetch failed/);
    assert.equal(
      state.calls.filter((entry) => String(entry.url).includes("/v1/realtime/calls")).length,
      1,
    );
  } finally {
    await browser.close();
  }
});

test("Realtime browser bridge renews connected sessions before provider limit", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: `
        (() => {
          const calls = [];
          window.__sessionRenewalTestCalls = calls;
          window.fetch = async (url, options = {}) => {
            calls.push({ url: String(url), method: String(options.method || "GET") });
            if (String(url).includes("/realtime/client-secret")) {
              return new Response(JSON.stringify({ ok: true, client_secret: { value: "ek_test" } }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            if (String(url).includes("/v1/realtime/calls")) {
              return new Response("v=0\\r\\n", {
                status: 201,
                headers: { "content-type": "application/sdp" },
              });
            }
            return new Response("not found", { status: 404 });
          };

          class MockDataChannel {
            constructor() {
              this.readyState = "connecting";
              this.label = "oai-events";
            }
            addEventListener(type, handler) {
              this["on" + type] = handler;
            }
            send() {}
            open() {
              this.readyState = "open";
              this.onopen?.();
            }
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
              const channel = new MockDataChannel();
              setTimeout(() => channel.open(), 0);
              return channel;
            }
            async createOffer() {
              return { type: "offer", sdp: "v=0\\r\\n" };
            }
            async setLocalDescription() {}
            async setRemoteDescription() {
              this.connectionState = "connected";
              this.onconnectionstatechange?.();
            }
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
            createAnalyser() {
              return {
                fftSize: 2048,
                getFloatTimeDomainData(buffer) {
                  buffer.fill(0);
                },
                connect() {},
              };
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
        realtimeSessionRenewalMs: 40,
        tokenUrl: "/realtime/client-secret",
        sdpUrl: "https://api.openai.com/v1/realtime/calls",
        botName: "Onee-sama",
        session: { model: "gpt-realtime-2" },
        instructions: "Test only.",
        tools: [],
      }),
    });
    await page.goto("data:text/html,<html><body>realtime session renewal</body></html>");

    await page.waitForFunction(() =>
      window.MAB_REALTIME_BRIDGE?.timeline?.some(
        (entry) => entry.type === "realtime_session_renewal_scheduled",
      ),
    );
    await page.waitForFunction(
      () =>
        window.__sessionRenewalTestCalls.filter((entry) =>
          String(entry.url).includes("/realtime/client-secret"),
        ).length >= 2,
      null,
      { timeout: 2000 },
    );

    const state = await page.evaluate(() => ({
      connection: window.MAB_REALTIME_BRIDGE.connection,
      timeline: window.MAB_REALTIME_BRIDGE.timeline,
      tokenCalls: window.__sessionRenewalTestCalls.filter((entry) =>
        String(entry.url).includes("/realtime/client-secret"),
      ).length,
    }));

    assert.equal(state.connection.lastReconnectReason, "session_renewal");
    assert.ok(state.connection.sessionRenewalAt);
    assert.ok(state.tokenCalls >= 2);
    assert.equal(
      state.timeline.some(
        (entry) =>
          entry.type === "realtime_reconnect_scheduled" &&
          entry.detail.reason === "session_renewal",
      ),
      true,
    );
  } finally {
    await browser.close();
  }
});

test("Realtime browser bridge treats insufficient quota SDP 429 as terminal", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: `
        (() => {
          const calls = [];
          window.__sdpQuotaTestCalls = calls;
          window.fetch = async (url, options = {}) => {
            calls.push({ url: String(url), method: String(options.method || "GET") });
            if (String(url).includes("/realtime/client-secret")) {
              return new Response(JSON.stringify({ ok: true, client_secret: { value: "ek_test" } }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            if (String(url).includes("/v1/realtime/calls")) {
              return new Response(JSON.stringify({
                error: {
                  message: "You exceeded your current quota, please check your plan and billing details.",
                  type: "insufficient_quota",
                  code: "insufficient_quota"
                }
              }), {
                status: 429,
                headers: {
                  "content-type": "application/json",
                  "x-request-id": "req_sdp_quota_test",
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
            addEventListener(type, handler) {
              this["on" + type] = handler;
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
            createAnalyser() {
              return {
                fftSize: 2048,
                getFloatTimeDomainData(buffer) {
                  buffer.fill(0);
                },
                connect() {},
              };
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
    await page.goto("data:text/html,<html><body>realtime sdp quota</body></html>");

    await page.waitForFunction(
      () =>
        window.MAB_REALTIME_BRIDGE?.connection?.lastSdpError?.reason ===
        "realtime_sdp_insufficient_quota",
    );

    const state = await page.evaluate(() => ({
      connection: window.MAB_REALTIME_BRIDGE.connection,
      feedback: window.MAB_REALTIME_BRIDGE.feedback,
      errors: window.MAB_REALTIME_BRIDGE.errors,
      calls: window.__sdpQuotaTestCalls,
    }));

    assert.equal(state.connection.lastSdpError.status, 429);
    assert.equal(state.connection.lastSdpError.retryable, false);
    assert.equal(state.connection.lastSdpError.terminal, true);
    assert.equal(state.connection.lastSdpError.requestId, "req_sdp_quota_test");
    assert.match(state.connection.lastSdpError.body, /insufficient_quota/);
    assert.equal(state.connection.reconnectAttempts, 0);
    assert.equal(state.connection.lastReconnectReason, "");
    assert.equal(state.feedback.blockers.includes("realtime_sdp_insufficient_quota"), true);
    assert.match(state.feedback.summary, /quota/);
    assert.match(state.errors.at(-1).message, /Realtime SDP exchange failed: 429/);
    assert.equal(
      state.calls.filter((entry) => String(entry.url).includes("/v1/realtime/calls")).length,
      1,
    );
  } finally {
    await browser.close();
  }
});

test("Realtime browser bridge records client-secret failures before SDP", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: `
        (() => {
          const calls = [];
          window.__tokenFailureTestCalls = calls;
          window.fetch = async (url, options = {}) => {
            calls.push({ url: String(url), method: String(options.method || "GET") });
            if (String(url).includes("/realtime/client-secret")) {
              return new Response(JSON.stringify({
                ok: false,
                error: "openai_realtime_upstream",
                status: 400,
                detail: {
                  error: {
                    code: "beta_api_shape_disabled",
                    message: "The Realtime Beta API is no longer supported. Please use /v1/realtime for the GA API."
                  }
                }
              }), {
                status: 502,
                headers: {
                  "content-type": "application/json",
                  "x-request-id": "req_token_502_test",
                },
              });
            }
            if (String(url).includes("/v1/realtime/calls")) {
              return new Response("unexpected SDP call", { status: 500 });
            }
            return new Response("not found", { status: 404 });
          };

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
              return { readyState: "connecting", label: "oai-events", send() {}, close() {} };
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
            createAnalyser() {
              return {
                fftSize: 2048,
                getFloatTimeDomainData(buffer) {
                  buffer.fill(0);
                },
                connect() {},
              };
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
    await page.goto("data:text/html,<html><body>realtime token failure</body></html>");

    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.lastTokenError?.status === 502,
    );

    const state = await page.evaluate(() => ({
      connection: window.MAB_REALTIME_BRIDGE.connection,
      feedback: window.MAB_REALTIME_BRIDGE.feedback,
      errors: window.MAB_REALTIME_BRIDGE.errors,
      calls: window.__tokenFailureTestCalls,
    }));

    assert.equal(state.connection.lastTokenError.status, 502);
    assert.equal(state.connection.lastTokenError.retryable, true);
    assert.equal(state.connection.lastTokenError.requestId, "req_token_502_test");
    assert.match(state.connection.lastTokenError.body, /beta_api_shape_disabled/);
    assert.equal(state.connection.lastReconnectReason, "realtime_token_request_failed");
    assert.equal(state.feedback.blockers.includes("realtime_token_failed"), true);
    assert.match(state.errors.at(-1).message, /Realtime client secret/);
    assert.equal(
      state.calls.filter((entry) => String(entry.url).includes("/v1/realtime/calls")).length,
      0,
    );
  } finally {
    await browser.close();
  }
});
