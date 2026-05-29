import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime Agents SDK init carries the OpenAI base URL into the browser bridge", () => {
  const script = buildRealtimeBrowserInitScript({
    mode: "webrtc",
    agentRuntime: "agents-sdk",
    tokenUrl: "http://127.0.0.1:8781/realtime/client-secret",
    openaiRealtimeBaseUrl: "https://api.openai.com/v1",
    sdpUrl: "https://api.openai.com/v1/realtime/calls",
  });
  const configLine = script.split("\n")[0];

  assert.match(configLine, /openaiRealtimeBaseUrl/);
  assert.match(configLine, /https:\/\/api\.openai\.com\/v1/);
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

async function withToolServer(callback) {
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
      response.setHeader("content-type", "application/json");
      if (request.url === "/realtime/client-secret") {
        response.end(JSON.stringify({ ok: true, client_secret: { value: "ek_mock_sdk" } }));
        return;
      }
      if (request.url === "/tools/now") {
        if (request.headers["x-oneesama-internal-key"] !== "test-session-token") {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, error: "missing_internal_session_token" }));
          return;
        }
        response.end(
          JSON.stringify({
            ok: true,
            timezone: "Asia/Shanghai",
            now: "2026-05-15T14:00:00+08:00",
          }),
        );
        return;
      }
      if (request.url === "/tools/control_shared_app_window") {
        response.end(
          JSON.stringify({
            ok: true,
            status: "queued",
            jobId: "job_sdk_app_control_queued",
            summary: "Queued app control job.",
          }),
        );
        return;
      }
      if (request.url === "/tools/fetch_url") {
        response.statusCode = 500;
        response.end(JSON.stringify({ ok: false, error: "upstream_fetch_failed" }));
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

test("Realtime Agents SDK adapter connects, calls a local tool, and disconnects", async () => {
  await withToolServer(async ({ baseUrl, calls }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk-mock",
          agentRuntime: "agents-sdk",
          sessionId: "sdk-smoke-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          toolCallbackToken: "test-session-token",
          instructions: "Use tools when needed.",
          currentUser: {
            name: "Peng Xiao",
            aliases: ["彭潇"],
          },
          contextLifecycle: {
            compactItemThreshold: 200,
            recentItems: 20,
          },
          tools: [
            {
              type: "function",
              name: "now",
              description: "Return current date/time.",
              parameters: { type: "object", properties: {}, required: [] },
            },
            {
              type: "function",
              name: "meet_participants",
              description: "Return live Meet participants.",
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
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );
      const connected = await page.evaluate(() => window.MAB_REALTIME_BRIDGE);
      assert.equal(connected.agentRuntime.active, "agents-sdk");
      assert.equal(connected.agentRuntime.sdkVersion, "0.11.4");
      assert.equal(connected.sessionId, "sdk-smoke-session");
      assert.ok(connected.agentRuntime.sdkToolNames.includes("now"));

      const toolResult = await page.evaluate(() =>
        window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall("now", {}),
      );
      assert.equal(toolResult.ok, true);
      assert.equal(toolResult.result.ok, true);
      assert.equal(toolResult.result.timezone, "Asia/Shanghai");
      assert.ok(calls.some((entry) => entry.path === "/realtime/client-secret"));
      assert.ok(
        calls.some((entry) => entry.path === "/tools/now" && entry.auth === "test-session-token"),
      );

      const participantsResult = await page.evaluate(() => {
        window.MAB_MEETING_AWARENESS = {
          ok: true,
          observedAt: "2026-05-16T15:25:30Z",
          source: "meet_dom_and_caption_tail",
          participants: [
            { name: "Peng Xiao", source: "meet_participant_tile", confidence: "medium" },
          ],
          participantCount: 1,
          activeSpeaker: {
            name: "Peng Xiao",
            source: "google-meet-caption-dom",
            confidence: "high",
            observedAt: "2026-05-16T15:25:29Z",
          },
          recentSpeakers: [],
          caveat: "Best-effort Google Meet DOM/caption heuristic.",
        };
        return window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall("meet_participants", {});
      });
      assert.equal(participantsResult.ok, true);
      assert.equal(participantsResult.result.ok, true);
      assert.equal(participantsResult.result.participants[0].name, "Peng Xiao");
      assert.equal(participantsResult.result.activeSpeaker.name, "Peng Xiao");

      const compact = await page.evaluate(() => {
        window.MAB_REALTIME_CLIENT.rememberSessionContext(
          "meetingAwareness",
          {
            ok: true,
            activeSpeaker: {
              name: "彭潇",
              identity: {
                resolved: true,
                canonicalName: "Peng Xiao",
                preferredName: "Peng Xiao",
                isCurrentUser: true,
              },
            },
            participants: [{ name: "Peng Xiao" }],
          },
          "test-fixture",
        );
        const history = Array.from({ length: 205 }, (_, index) => ({
          itemId: `item_${index}`,
          type: "message",
          role: index % 2 === 0 ? "user" : "assistant",
          content: [{ type: "input_text", text: `history item ${index}` }],
        }));
        const compacted = window.MAB_REALTIME_CLIENT.buildCompactedHistory(
          history,
          "unit_test_long_meeting",
        );
        return {
          length: compacted.length,
          first: compacted[0],
          last: compacted.at(-1),
          health: window.MAB_REALTIME_CLIENT.contextHealth(),
        };
      });
      assert.equal(compact.length, 21);
      assert.match(compact.first.content[0].text, /会议上下文快照/);
      assert.match(compact.first.content[0].text, /Peng Xiao/);
      assert.match(compact.first.content[0].text, /当前用户/);
      assert.equal(compact.last.itemId, "item_204");
      assert.equal(compact.health.enabled, true);

      const lifecycle = await page.evaluate(() => {
        const first = window.MAB_REALTIME_CLIENT.pushSessionContext({
          text: "会议上下文快照：\n当前用户：Peng Xiao",
          signature: "same-context",
          reason: "dedupe-test",
          kind: "identity",
          value: { preferredName: "Peng Xiao", isCurrentUser: true },
          force: true,
        });
        const second = window.MAB_REALTIME_CLIENT.pushSessionContext({
          text: "会议上下文快照：\n当前用户：Peng Xiao",
          signature: "same-context",
          reason: "dedupe-test",
          kind: "identity",
          value: { preferredName: "Peng Xiao", isCurrentUser: true },
        });
        const compactResult = window.MAB_REALTIME_CLIENT.compactRealtimeHistory("manual-test");
        return {
          first,
          second,
          compactResult,
          health: window.MAB_REALTIME_CLIENT.contextHealth(),
          resetMessages: window.MAB_REALTIME_BRIDGE.connection.sentDataChannelMessages.filter(
            (entry) => String(entry.payload || "").includes("mock.reset_history"),
          ),
        };
      });
      assert.equal(lifecycle.first.ok, true);
      assert.equal(lifecycle.second.skipped, true);
      assert.equal(lifecycle.second.reason, "dedupe_window");
      assert.equal(lifecycle.compactResult.ok, true);
      assert.ok(lifecycle.health.compactCount >= 1);
      assert.ok(lifecycle.resetMessages.length >= 1);

      const disconnected = await page.evaluate(() => {
        window.MAB_REALTIME_CLIENT.disconnect("sdk-smoke-disconnect");
        return window.MAB_REALTIME_BRIDGE;
      });
      assert.equal(disconnected.connected, false);
      assert.equal(disconnected.agentRuntime.sdkConnected, false);
      assert.ok(
        disconnected.timeline.some(
          (entry) =>
            entry.type === "realtime_agent_sdk_tool_start" &&
            entry.detail.session_id === "sdk-smoke-session",
        ),
      );
    } finally {
      await browser.close();
    }
  });
});

test("Realtime Agents SDK local tool failures use the shared blocked turn policy", async () => {
  await withToolServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk-mock",
          agentRuntime: "agents-sdk",
          sessionId: "sdk-tool-failure-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          toolCallbackToken: "test-session-token",
          tools: [
            {
              type: "function",
              name: "fetch_url",
              description: "Fetch URL.",
              parameters: { type: "object", properties: {}, required: [] },
            },
          ],
        }),
      });
      await page.goto(`${baseUrl}/`);
      await page.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );

      const toolResult = await page.evaluate(() =>
        window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall("fetch_url", {
          url: "https://example.test",
        }),
      );
      const bridge = await page.evaluate(() => window.MAB_REALTIME_BRIDGE);

      assert.equal(toolResult.delivery.policy.channel, "blocked");
      assert.equal(toolResult.delivery.policy.reason, "workspace_tool_blocked");
      assert.equal(toolResult.delivery.modelResult.turnPolicy.channel, "blocked");
      assert.equal(bridge.turnPolicy.decisions.at(-1).channel, "blocked");
      assert.equal(bridge.turnPolicy.events.at(-1).visibility, "blocked");
    } finally {
      await browser.close();
    }
  });
});

test("Realtime Agents SDK audio lifecycle uses the shared output protection state", async () => {
  await withToolServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({
        content: `
          window.MAB_AVATAR_AUDIO_BUS = {
            syntheticSpeechActive: false,
            setSyntheticSpeech(active) {
              this.syntheticSpeechActive = active === true;
            },
            debugState() {
              return { syntheticSpeechActive: this.syntheticSpeechActive };
            },
          };
          window.OpenAIAgentsRealtime = {
            tool(config) {
              return config;
            },
            RealtimeAgent: function RealtimeAgent(config) {
              this.config = config;
            },
            RealtimeSession: class RealtimeSession {
              constructor() {
                this.listeners = new Map();
                window.__MAB_FAKE_SDK_SESSION = this;
              }

              on(type, callback) {
                const callbacks = this.listeners.get(type) || [];
                callbacks.push(callback);
                this.listeners.set(type, callbacks);
                return this;
              }

              emit(type, event = {}) {
                for (const callback of this.listeners.get(type) || []) callback(event);
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
          agentRuntime: "raw",
          sessionId: "sdk-audio-lifecycle-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          outputAudioStaleFallbackMs: 50,
        }),
      });
      await page.goto(`${baseUrl}/`);
      await page.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );

      const started = await page.evaluate(() => {
        window.__MAB_FAKE_SDK_SESSION.emit("audio_start", { type: "audio_start" });
        return {
          protection: { ...window.MAB_REALTIME_BRIDGE.protection },
          syntheticSpeechActive: window.MAB_AVATAR_AUDIO_BUS.syntheticSpeechActive,
          checkpoints: window.MAB_REALTIME_BRIDGE.connection.validationCheckpoints,
          timelineTypes: window.MAB_REALTIME_BRIDGE.timeline.map((entry) => entry.type),
        };
      });
      assert.equal(started.protection.outputAudioActive, true);
      assert.equal(started.syntheticSpeechActive, true);
      assert.equal(started.checkpoints.lastOutputAudioStarted.type, "agents_sdk.audio_start");
      assert.ok(started.timelineTypes.includes("realtime_agent_sdk_audio_start"));

      const stopped = await page.evaluate(() => {
        window.__MAB_FAKE_SDK_SESSION.emit("audio_stopped", { type: "audio_stopped" });
        return {
          protection: { ...window.MAB_REALTIME_BRIDGE.protection },
          syntheticSpeechActive: window.MAB_AVATAR_AUDIO_BUS.syntheticSpeechActive,
          checkpoints: window.MAB_REALTIME_BRIDGE.connection.validationCheckpoints,
          clearReasons: window.MAB_REALTIME_BRIDGE.timeline
            .filter((entry) => entry.type === "realtime_output_audio_cleared")
            .map((entry) => entry.detail.reason),
        };
      });
      assert.equal(stopped.protection.outputAudioActive, false);
      assert.equal(stopped.syntheticSpeechActive, false);
      assert.equal(stopped.checkpoints.lastOutputAudioStopped.type, "agents_sdk.audio_stopped");
      assert.equal(
        stopped.checkpoints.lastOutputAudioCleared.detail.reason,
        "agents_sdk.audio_stopped",
      );
      assert.ok(stopped.clearReasons.includes("agents_sdk.audio_stopped"));

      await page.evaluate(() => {
        window.__MAB_FAKE_SDK_SESSION.emit("audio_start", { type: "audio_start" });
      });
      await page.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.protection?.outputAudioActive === false,
      );
      const fallback = await page.evaluate(() => ({
        protection: { ...window.MAB_REALTIME_BRIDGE.protection },
        syntheticSpeechActive: window.MAB_AVATAR_AUDIO_BUS.syntheticSpeechActive,
        checkpoints: window.MAB_REALTIME_BRIDGE.connection.validationCheckpoints,
        clearReasons: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type === "realtime_output_audio_cleared")
          .map((entry) => entry.detail.reason),
      }));
      assert.equal(fallback.protection.outputAudioActive, false);
      assert.equal(fallback.syntheticSpeechActive, false);
      assert.equal(
        fallback.checkpoints.lastOutputAudioCleared.detail.reason,
        "agents_sdk.audio_start_stale_fallback",
      );
      assert.ok(fallback.clearReasons.includes("agents_sdk.audio_start_stale_fallback"));
    } finally {
      await browser.close();
    }
  });
});

test("Realtime Agents SDK local app-control tools record silent turn policy", async () => {
  await withToolServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk-mock",
          agentRuntime: "agents-sdk",
          sessionId: "sdk-policy-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          toolCallbackToken: "test-session-token",
          tools: [
            {
              type: "function",
              name: "control_shared_app_window",
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
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );
      assert.equal(
        await page.evaluate(() => typeof window.OpenAIAgentsRealtime?.backgroundResult),
        "function",
      );

      const toolResult = await page.evaluate(() =>
        window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall("control_shared_app_window", {
          operation: "type_text",
        }),
      );
      const bridge = await page.evaluate(() => window.MAB_REALTIME_BRIDGE);

      assert.equal(toolResult.result.status, "queued");
      assert.equal(toolResult.delivery.policy.reason, "app_control_async_accepted");
      assert.equal(toolResult.delivery.policy.autoRespond, false);
      assert.equal(bridge.turnPolicy.decisions.at(-1).reason, "app_control_async_accepted");
      assert.equal(bridge.turnPolicy.events.at(-1).type, "app_control.accepted");
      assert.equal(
        bridge.turnPolicy.appControlJobs.job_sdk_app_control_queued.visibility,
        "silent",
      );
      assert.equal(
        bridge.connection.sentDataChannelMessages.some((entry) =>
          String(entry.payload || "").includes("response.create"),
        ),
        false,
      );
    } finally {
      await browser.close();
    }
  });
});
