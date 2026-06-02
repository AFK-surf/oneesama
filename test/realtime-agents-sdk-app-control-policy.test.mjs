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

test("Realtime Agents SDK local app-control tools record silent turn policy", async () => {
  await withToolServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk-mock",
          agentRuntime: "agents-sdk",
          realtimeRuntimePlacement: "inline",
          allowInlineAgentsSDKDiagnostic: true,
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
