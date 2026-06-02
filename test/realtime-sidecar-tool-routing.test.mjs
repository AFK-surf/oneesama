import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";
import { startRealtimeSidecarPage } from "../packages/core/src/meeting/google-meet-joiner-realtime-sidecar.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sidecarModuleUrl = new URL(
  "../packages/core/src/meeting/google-meet-joiner-realtime-sidecar.ts",
  import.meta.url,
).href;

test("Realtime sidecar startup cleans up the local server when page creation fails", () => {
  const script = `
    import { startRealtimeSidecarPage } from ${JSON.stringify(sidecarModuleUrl)};
    try {
      await startRealtimeSidecarPage({
        context: {
          newPage: async () => {
            throw new Error("fixture_new_page_failed");
          },
        },
        diagnostics: {
          console: [],
          pageErrors: [],
          requestFailures: [],
          record() {},
        },
        getMeetPage: () => null,
        realtimeBridgeConfig: { mode: "mock", autoConnect: false },
        sessionId: "sidecar-startup-cleanup-session",
      });
      throw new Error("fixture_expected_startup_failure");
    } catch (error) {
      if (!String(error?.message || error).includes("fixture_new_page_failed")) {
        throw error;
      }
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 3000,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error || ""));
});

test("Realtime sidecar routes Meet DOM tools through the Meet surface page", async () => {
  await withToolRoutingServer(async ({ baseUrl, calls }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const meetPage = await context.newPage();
    const sidecarPage = await context.newPage();
    const hostSurfaceCalls = [];
    try {
      await installMeetSurfaceFixture(meetPage, {
        sessionId: "sidecar-surface-tool-session",
        tokenUrl: `${baseUrl}/realtime/client-secret`,
        toolCallbackToken: "test-session-token",
      });
      await sidecarPage.exposeFunction("MAB_HOST_RUN_SURFACE_TOOL", async (payload) => {
        hostSurfaceCalls.push(payload);
        return await meetPage.evaluate(
          async (request) => window.MAB_MEET_SURFACE_TOOLS.run(request.name, request.args || {}),
          payload,
        );
      });
      await sidecarPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk-mock",
          agentRuntime: "agents-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "sidecar",
          sessionId: "sidecar-surface-tool-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          toolCallbackToken: "test-session-token",
          instructions: "Use tools when needed.",
          tools: [
            {
              type: "function",
              name: "send_meet_chat",
              description: "Send a chat message in Meet.",
              parameters: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        }),
      });

      await meetPage.goto(`${baseUrl}/meet`);
      await sidecarPage.goto(`${baseUrl}/sidecar`);
      await sidecarPage.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );
      const toolResult = await sidecarPage.evaluate(() =>
        window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall("send_meet_chat", {
          text: "sidecar surface hello",
        }),
      );
      const meetState = await meetPage.evaluate(() => ({
        hasSDKGlobal: Boolean(window.OpenAIAgentsRealtime),
        surfaceReady: typeof window.MAB_MEET_SURFACE_TOOLS?.run === "function",
        surfaceConfig: window.MAB_REALTIME_BRIDGE_CONFIG,
        bridge: window.MAB_REALTIME_BRIDGE,
        fixture: window.__MAB_MEET_FIXTURE,
      }));
      const forbiddenSurfaceShare = await meetPage.evaluate(() =>
        window.MAB_MEET_SURFACE_TOOLS.run("list_shareable_windows", {}),
      );
      const sidecarState = await sidecarPage.evaluate(() => window.MAB_REALTIME_BRIDGE);

      assert.equal(meetState.hasSDKGlobal, false);
      assert.equal(meetState.surfaceReady, true);
      assert.equal("toolCallbackToken" in meetState.surfaceConfig, false);
      assert.equal(meetState.bridge.agentRuntime.sdkSuppressedOnMeetSurface, true);
      assert.equal(forbiddenSurfaceShare.ok, false);
      assert.equal(forbiddenSurfaceShare.error, "meet_surface_tool_not_authorized");
      assert.equal(toolResult.ok, true);
      assert.equal(toolResult.result.path, "fixture-event");
      assert.equal(hostSurfaceCalls.length, 1);
      assert.equal(hostSurfaceCalls[0].name, "send_meet_chat");
      assert.equal(hostSurfaceCalls[0].sessionId, "sidecar-surface-tool-session");
      assert.equal(meetState.fixture.chatMessages.at(-1).text, "sidecar surface hello");
      assert.ok(sidecarState.meetTools.calls.some((entry) => entry.name === "send_meet_chat"));
      assert.equal(calls.filter((entry) => entry.path === "/tools/send_meet_chat").length, 0);
      assert.equal(calls.filter((entry) => entry.path === "/screen-share/apps").length, 0);
    } finally {
      await browser.close();
    }
  });
});

test("Realtime Meet surface dry-run still rejects unauthorized local tools", async () => {
  await withToolRoutingServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const meetPage = await browser.newPage();
    try {
      await meetPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "webrtc",
          agentRuntime: "agents-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "meet-surface",
          sessionId: "meet-surface-dry-run-auth-session",
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          dryRunLocalTools: true,
        }),
      });
      await meetPage.goto(`${baseUrl}/meet`);

      const forbiddenSurfaceShare = await meetPage.evaluate(() =>
        window.MAB_MEET_SURFACE_TOOLS.run("list_shareable_windows", {}),
      );
      const surfaceChat = await meetPage.evaluate(() =>
        window.MAB_MEET_SURFACE_TOOLS.run("read_meet_chat", {}),
      );

      assert.equal(forbiddenSurfaceShare.ok, false);
      assert.equal(forbiddenSurfaceShare.error, "meet_surface_tool_not_authorized");
      assert.equal(surfaceChat.ok, true);
      assert.equal(surfaceChat.dryRun, undefined);
    } finally {
      await browser.close();
    }
  });
});

test("Realtime sidecar rejects stale-session Meet surface tool payloads", async () => {
  await withToolRoutingServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const meetPage = await context.newPage();
    const events = [];
    const diagnostics = {
      sessionId: "sidecar-current-surface-tool-session",
      console: [],
      pageErrors: [],
      requestFailures: [],
      events,
      record: (type, detail = {}) => events.push({ type, detail }),
    };
    let sidecar;
    try {
      await installMeetSurfaceFixture(meetPage, {
        sessionId: "sidecar-current-surface-tool-session",
        tokenUrl: `${baseUrl}/realtime/client-secret`,
      });
      await meetPage.goto(`${baseUrl}/meet`);
      sidecar = await startRealtimeSidecarPage({
        context,
        diagnostics,
        getMeetPage: () => meetPage,
        realtimeBridgeConfig: {
          mode: "mock",
          autoConnect: false,
          sessionId: "sidecar-current-surface-tool-session",
        },
        sessionId: "sidecar-current-surface-tool-session",
      });

      const rejected = await sidecar.page.evaluate(() =>
        window.MAB_HOST_RUN_SURFACE_TOOL({
          name: "send_meet_chat",
          args: { text: "stale sidecar hello" },
          sessionId: "stale-surface-tool-session",
          callId: "call_stale_surface_tool",
        }),
      );
      const meetState = await meetPage.evaluate(() => window.__MAB_MEET_FIXTURE);

      assert.deepEqual(rejected, {
        ok: false,
        error: "realtime_sidecar_session_mismatch",
      });
      assert.equal(meetState.chatMessages.length, 0);
      assert.ok(
        events.some(
          (event) =>
            event.type === "realtime_sidecar_surface_tool" &&
            event.detail?.error === "realtime_sidecar_session_mismatch" &&
            event.detail?.callId === "call_stale_surface_tool",
        ),
      );
    } finally {
      sidecar?.server?.stop?.();
      await browser.close();
    }
  });
});

test("Realtime sidecar Meet chat tools require the host surface port", async () => {
  await withToolRoutingServer(async ({ baseUrl, calls }) => {
    const browser = await chromium.launch({ headless: true });
    const sidecarPage = await browser.newPage();
    try {
      await sidecarPage.addInitScript({
        content: `
          window.__MAB_MEET_FIXTURE = { chatMessages: [] };
          window.addEventListener("meeting-avatar-meet-chat-send", (event) => {
            window.__MAB_MEET_FIXTURE.chatMessages.push({
              ts: new Date().toISOString(),
              source: "sidecar-fixture",
              text: event.detail?.text || "",
            });
          });
        `,
      });
      await sidecarPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk-mock",
          agentRuntime: "agents-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "sidecar",
          sessionId: "sidecar-surface-port-required-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          toolCallbackToken: "test-session-token",
          instructions: "Use tools when needed.",
          tools: [
            {
              type: "function",
              name: "send_meet_chat",
              description: "Send a chat message in Meet.",
              parameters: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
            {
              type: "function",
              name: "read_meet_chat",
              description: "Read Meet chat.",
              parameters: { type: "object", properties: {}, required: [] },
            },
          ],
        }),
      });

      await sidecarPage.goto(`${baseUrl}/sidecar`);
      await sidecarPage.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );
      const sent = await sidecarPage.evaluate(() =>
        window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall("send_meet_chat", {
          text: "must not hit sidecar fixture",
        }),
      );
      const read = await sidecarPage.evaluate(() =>
        window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall("read_meet_chat", {}),
      );
      const sidecarState = await sidecarPage.evaluate(() => ({
        fixture: window.__MAB_MEET_FIXTURE,
        bridge: window.MAB_REALTIME_BRIDGE,
      }));

      assert.equal(sent.ok, true);
      assert.equal(sent.result.ok, false);
      assert.equal(sent.result.error, "meet_surface_tool_port_missing");
      assert.equal(read.ok, true);
      assert.equal(read.result.ok, false);
      assert.equal(read.result.error, "meet_surface_tool_port_missing");
      assert.equal(sidecarState.fixture.chatMessages.length, 0);
      assert.ok(
        sidecarState.bridge.meetTools.calls.some(
          (entry) =>
            entry.name === "send_meet_chat" &&
            entry.result?.error === "meet_surface_tool_port_missing",
        ),
      );
      assert.equal(calls.filter((entry) => entry.path === "/tools/send_meet_chat").length, 0);
    } finally {
      await browser.close();
    }
  });
});

test("Realtime sidecar routes app-control tools through local app-control wrappers", async () => {
  await withToolRoutingServer(async ({ baseUrl, calls }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const meetPage = await context.newPage();
    const sidecarPage = await context.newPage();
    const hostHudCalls = [];
    try {
      await installMeetSurfaceFixture(meetPage, {
        sessionId: "sidecar-app-control-session",
        tokenUrl: `${baseUrl}/realtime/client-secret`,
      });
      await sidecarPage.exposeFunction("MAB_HOST_UPDATE_AVATAR_HUD", async (payload) => {
        hostHudCalls.push(payload);
        return await meetPage.evaluate(
          (request) =>
            window.MAB_AVATAR_CONTROLLER.updateState({
              mood: request?.mood,
              action: request?.action,
              status_kind: request?.statusKind || request?.status_kind || request?.kind,
              status_text: request?.statusText || request?.status_text || request?.text || "",
              status_hold_ms:
                request?.holdMs || request?.statusHoldMs || request?.status_hold_ms || undefined,
            }),
          payload,
        );
      });
      await sidecarPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk-mock",
          agentRuntime: "agents-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "sidecar",
          sessionId: "sidecar-app-control-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          toolCallbackToken: "test-session-token",
          instructions: "Use app-control tools when needed.",
          tools: [
            {
              type: "function",
              name: "control_shared_app_window",
              description: "Control the currently shared app window.",
              parameters: {
                type: "object",
                properties: { instruction: { type: "string" } },
                required: ["instruction"],
              },
            },
          ],
        }),
      });

      await meetPage.goto(`${baseUrl}/meet`);
      await sidecarPage.goto(`${baseUrl}/sidecar`);
      await sidecarPage.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );
      const toolResult = await sidecarPage.evaluate(() =>
        window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall("control_shared_app_window", {
          instruction: "click the login button",
        }),
      );
      const meetState = await meetPage.evaluate(() => ({
        hasSDKGlobal: Boolean(window.OpenAIAgentsRealtime),
        bridge: window.MAB_REALTIME_BRIDGE,
        fixture: window.__MAB_MEET_FIXTURE,
      }));
      const sidecarState = await sidecarPage.evaluate(() => window.MAB_REALTIME_BRIDGE);
      const appControlCalls = calls.filter(
        (entry) => entry.path === "/tools/control_shared_app_window",
      );

      assert.equal(meetState.hasSDKGlobal, false);
      assert.equal(meetState.bridge.agentRuntime.sdkSuppressedOnMeetSurface, true);
      assert.equal(toolResult.ok, true);
      assert.equal(toolResult.result.status, "queued");
      assert.equal(toolResult.delivery.policy.reason, "app_control_async_accepted");
      assert.equal(appControlCalls.length, 1);
      assert.equal(appControlCalls[0].auth, "test-session-token");
      assert.equal(appControlCalls[0].body.instruction, "click the login button");
      assert.ok(
        sidecarState.workspaceTools.calls.some(
          (entry) => entry.name === "control_shared_app_window",
        ),
      );
      assert.equal(
        sidecarState.turnPolicy.appControlJobs.job_sidecar_app_control.visibility,
        "silent",
      );
      assert.ok(
        hostHudCalls.some((entry) => entry.statusKind === "opening_preview"),
        "sidecar forwarded app-control HUD state to the Meet page",
      );
      assert.ok(
        meetState.fixture.avatarHudUpdates.some(
          (entry) =>
            entry.status_kind === "opening_preview" && /正在操作/.test(entry.status_text || ""),
        ),
      );
    } finally {
      await browser.close();
    }
  });
});

test("Realtime sidecar host forwards avatar HUD updates to the Meet page", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const meetPage = await context.newPage();
  const events = [];
  const diagnostics = {
    sessionId: "sidecar-avatar-hud-session",
    console: [],
    pageErrors: [],
    requestFailures: [],
    events,
    record: (type, detail = {}) => events.push({ type, detail }),
  };
  let sidecar;
  try {
    await meetPage.addInitScript({
      content: `
        window.__MAB_AVATAR_UPDATES = [];
        window.MAB_AVATAR_CONTROLLER = {
          updateState(input = {}) {
            window.__MAB_AVATAR_UPDATES.push(input);
            return { ok: true, ...input };
          },
        };
      `,
    });
    await meetPage.goto("data:text/html,<html><body>meet</body></html>");
    sidecar = await startRealtimeSidecarPage({
      context,
      diagnostics,
      getMeetPage: () => meetPage,
      realtimeBridgeConfig: {
        mode: "mock",
        autoConnect: false,
        sessionId: "sidecar-avatar-hud-session",
      },
      sessionId: "sidecar-avatar-hud-session",
    });

    const result = await sidecar.page.evaluate(() =>
      window.MAB_HOST_UPDATE_AVATAR_HUD({
        statusKind: "opening_preview",
        statusText: "正在操作 Pencil",
        mood: "thinking",
        action: "lean_forward",
        holdMs: 1234,
      }),
    );
    const updates = await meetPage.evaluate(() => window.__MAB_AVATAR_UPDATES);

    assert.equal(result.ok, true);
    assert.equal(updates.at(-1).status_kind, "opening_preview");
    assert.equal(updates.at(-1).status_text, "正在操作 Pencil");
    assert.equal(updates.at(-1).status_hold_ms, 1234);
    assert.ok(events.some((event) => event.type === "realtime_sidecar_avatar_hud"));
  } finally {
    sidecar?.server?.stop?.();
    await browser.close();
  }
});

test("Realtime sidecar host forwards KWWK cursor feedback to the Meet page", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const meetPage = await context.newPage();
  const events = [];
  const diagnostics = {
    sessionId: "sidecar-kwwk-cursor-session",
    console: [],
    pageErrors: [],
    requestFailures: [],
    events,
    record: (type, detail = {}) => events.push({ type, detail }),
  };
  let sidecar;
  try {
    await meetPage.addInitScript({
      content: `
        window.__MAB_CURSOR_UPDATES = [];
        window.MAB_KWWK_CURSOR_FEEDBACK = (input = {}) => {
          window.__MAB_CURSOR_UPDATES.push(input);
          return { visible: true, kind: input.kind, x: input.x, y: input.y, label: input.label };
        };
      `,
    });
    await meetPage.goto("data:text/html,<html><body>meet</body></html>");
    sidecar = await startRealtimeSidecarPage({
      context,
      diagnostics,
      getMeetPage: () => meetPage,
      realtimeBridgeConfig: {
        mode: "mock",
        autoConnect: false,
        sessionId: "sidecar-kwwk-cursor-session",
      },
      sessionId: "sidecar-kwwk-cursor-session",
    });

    const result = await sidecar.page.evaluate(() =>
      window.MAB_HOST_UPDATE_KWWK_CURSOR_FEEDBACK({
        kind: "click",
        label: "完成",
        x: 0.25,
        y: 0.75,
      }),
    );
    const updates = await meetPage.evaluate(() => window.__MAB_CURSOR_UPDATES);

    assert.equal(result.ok, true);
    assert.equal(updates.at(-1).kind, "click");
    assert.equal(updates.at(-1).x, 0.25);
    assert.equal(updates.at(-1).y, 0.75);
    assert.ok(events.some((event) => event.type === "realtime_sidecar_kwwk_cursor_feedback"));
  } finally {
    sidecar?.server?.stop?.();
    await browser.close();
  }
});

test("Realtime sidecar owns worker-result polling and realtime delivery ack", async () => {
  await withToolRoutingServer(async ({ baseUrl, calls }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const meetPage = await context.newPage();
    const events = [];
    const diagnostics = {
      sessionId: "sidecar-worker-result-session",
      console: [],
      pageErrors: [],
      requestFailures: [],
      events,
      record: (type, detail = {}) => events.push({ type, detail }),
    };
    let sidecar;
    try {
      await installMeetSurfaceFixture(meetPage, {
        sessionId: "sidecar-worker-result-session",
        tokenUrl: `${baseUrl}/realtime/client-secret`,
      });
      await meetPage.goto(`${baseUrl}/meet`);

      sidecar = await startRealtimeSidecarPage({
        context,
        diagnostics,
        getMeetPage: () => meetPage,
        realtimeBridgeConfig: {
          mode: "mock",
          autoConnect: false,
          sessionId: "sidecar-worker-result-session",
          botName: "Onee-sama",
        },
        sessionId: "sidecar-worker-result-session",
        workerResultConfig: {
          workerPollUrl: `${baseUrl}/worker/poll-realtime`,
          workerMarkRealtimeDeliveredUrl: `${baseUrl}/worker/mark-realtime-delivered`,
          enabled: true,
          autoStart: false,
          sessionId: "sidecar-worker-result-session",
          toolCallbackToken: "test-session-token",
        },
      });
      await sidecar.page.waitForFunction(() => window.MAB_WORKER_RESULT_BRIDGE_API?.pollOnce);

      const meetBridge = await meetPage.evaluate(() => ({
        hasWorkerResultBridge: Boolean(window.MAB_WORKER_RESULT_BRIDGE),
        hasSDKGlobal: Boolean(window.OpenAIAgentsRealtime),
      }));
      const jobs = await sidecar.page.evaluate(() =>
        window.MAB_WORKER_RESULT_BRIDGE_API.pollOnce(),
      );
      const sidecarBridge = await sidecar.page.evaluate(() => window.MAB_WORKER_RESULT_BRIDGE);

      assert.equal(meetBridge.hasWorkerResultBridge, false);
      assert.equal(meetBridge.hasSDKGlobal, false);
      assert.equal(jobs.length, 1);
      assert.equal(
        sidecarBridge.delivered.at(-1).channel,
        "MAB_REALTIME_CLIENT.injectWorkerResult",
      );
      assert.equal(sidecarBridge.delivered.at(-1).ack.ok, true);
      assert.ok(
        calls.some(
          (entry) =>
            entry.path === "/worker/poll-realtime" &&
            entry.body.markDelivered === false &&
            entry.auth === "test-session-token",
        ),
      );
      assert.ok(
        calls.some(
          (entry) =>
            entry.path === "/worker/mark-realtime-delivered" &&
            entry.body.jobId === "job_sidecar_worker_result" &&
            entry.body.deliveryToken === "attempt_sidecar_worker_result" &&
            entry.auth === "test-session-token",
        ),
      );
      assert.ok(events.some((event) => event.type === "realtime_sidecar_page_start"));
    } finally {
      sidecar?.server?.stop?.();
      await browser.close();
    }
  });
});

test("Realtime sidecar dry-run worker tools do not launch background workers", async () => {
  await withToolRoutingServer(async ({ baseUrl, calls }) => {
    const browser = await chromium.launch({ headless: true });
    const sidecarPage = await browser.newPage();
    try {
      await sidecarPage.addInitScript({
        content: buildRealtimeBrowserInitScript({
          mode: "agents-sdk-mock",
          agentRuntime: "agents-sdk",
          realtimeRuntimePlacement: "sidecar",
          realtimePageRole: "sidecar",
          sessionId: "sidecar-worker-dry-run-session",
          botName: "Onee-sama",
          autoConnect: true,
          tokenUrl: `${baseUrl}/realtime/client-secret`,
          toolCallbackToken: "test-session-token",
          instructions: "Use worker tools when needed.",
          dryRunLocalTools: true,
          tools: [
            {
              type: "function",
              name: "delegate_to_worker",
              description: "Delegate background work.",
              parameters: {
                type: "object",
                properties: { task: { type: "string" } },
                required: ["task"],
              },
            },
            {
              type: "function",
              name: "worker_status",
              description: "Check background work.",
              parameters: {
                type: "object",
                properties: { jobId: { type: "string" } },
                required: [],
              },
            },
          ],
        }),
      });

      await sidecarPage.goto(`${baseUrl}/sidecar`);
      await sidecarPage.waitForFunction(
        () => window.MAB_REALTIME_BRIDGE?.agentRuntime?.sdkConnected === true,
      );
      const delegated = await sidecarPage.evaluate(() =>
        window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall("delegate_to_worker", {
          task: "write a short report",
        }),
      );
      const status = await sidecarPage.evaluate(() =>
        window.MAB_REALTIME_CLIENT.simulateRealtimeAgentToolCall("worker_status", {
          jobId: "dry_run_worker_job",
        }),
      );
      const sidecarState = await sidecarPage.evaluate(() => window.MAB_REALTIME_BRIDGE);

      assert.equal(delegated.ok, true);
      assert.equal(delegated.result.dryRun, true);
      assert.equal(delegated.result.status, "queued");
      assert.equal(status.ok, true);
      assert.equal(status.result.dryRun, true);
      assert.equal(status.result.job.status, "completed");
      assert.equal(calls.filter((entry) => entry.path === "/worker/delegate").length, 0);
      assert.equal(calls.filter((entry) => entry.path === "/worker/status").length, 0);
      assert.ok(
        sidecarState.workerTools.calls.some(
          (entry) => entry.name === "delegate_to_worker" && entry.result?.dryRun === true,
        ),
      );
      assert.ok(
        sidecarState.workerTools.calls.some(
          (entry) => entry.name === "worker_status" && entry.result?.dryRun === true,
        ),
      );
    } finally {
      await browser.close();
    }
  });
});

test("Meet surface sidecar placeholder captures outbound audio sender without loading SDK", async () => {
  await withToolRoutingServer(async ({ baseUrl }) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.addInitScript({
        content: `
          window.__MAB_FAKE_PEERS = [];
          class FakeRTCPeerConnection {
            constructor() {
              this.connectionState = "connected";
              this.senders = [];
              window.__MAB_FAKE_PEERS.push(this);
            }
            addTrack(track) {
              const sender = this.createSender(track);
              this.senders.push(sender);
              return sender;
            }
            addTransceiver(trackOrKind, init = {}) {
              const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind?.kind || "";
              const sender = this.createSender(typeof trackOrKind === "object" ? trackOrKind : null, kind);
              this.senders.push(sender);
              return {
                sender,
                direction: init.direction || "sendrecv",
                currentDirection: "sendrecv",
              };
            }
            createSender(track, hintKind = "") {
              const sender = {
                track,
                hintKind,
                bytesSent: 0,
                packetsSent: 0,
                async replaceTrack(nextTrack) {
                  sender.track = nextTrack || null;
                },
                async getStats() {
                  if (sender.track?.readyState === "live") {
                    sender.bytesSent += 2048;
                    sender.packetsSent += 16;
                  }
                  return new Map([
                    [
                      "outbound-audio",
                      {
                        id: "outbound-audio",
                        type: "outbound-rtp",
                        kind: "audio",
                        bytesSent: sender.bytesSent,
                        packetsSent: sender.packetsSent,
                      },
                    ],
                  ]);
                },
              };
              return sender;
            }
            getSenders() {
              return this.senders;
            }
            addEventListener() {}
          }
          window.RTCPeerConnection = FakeRTCPeerConnection;
        `,
      });
      await installMeetSurfaceFixture(page, {
        sessionId: "sidecar-surface-audio-output-session",
        tokenUrl: `${baseUrl}/realtime/client-secret`,
      });
      await page.goto(`${baseUrl}/meet`);
      const result = await page.evaluate(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const audioContext = new AudioContext();
        await audioContext.resume();
        const destination = audioContext.createMediaStreamDestination();
        const [avatarTrack] = destination.stream.getAudioTracks();
        window.MAB_AVATAR_AUDIO_BUS = { track: avatarTrack };
        const meetPeer = new RTCPeerConnection();
        meetPeer.addTransceiver("audio", { direction: "sendrecv" });
        await wait(1300);
        return {
          hasSDKGlobal: Boolean(window.OpenAIAgentsRealtime || window.openaiAgentsRealtime),
          bridge: window.MAB_REALTIME_BRIDGE,
          senderTrackId: window.__MAB_FAKE_PEERS[0].getSenders()[0].track?.id || "",
          senderTrackReadyState: window.__MAB_FAKE_PEERS[0].getSenders()[0].track?.readyState || "",
          avatarTrackId: avatarTrack.id,
        };
      });

      assert.equal(result.hasSDKGlobal, false);
      assert.equal(result.bridge.pageRole, "meet-surface");
      assert.equal(result.bridge.sdkOwner, "sidecar");
      assert.notEqual(result.senderTrackId, result.avatarTrackId);
      assert.equal(result.senderTrackReadyState, "live");
      assert.equal(result.bridge.connection.meetSurfaceAudioOutputHookInstalled, true);
      assert.equal(result.bridge.connection.primaryMeetAudioSenderUsingAvatarBus, true);
      assert.equal(result.bridge.connection.primaryMeetAudioSenderStats.supported, true);
      assert.ok(result.bridge.connection.primaryMeetAudioSenderStats.bytesSent > 0);
      assert.ok(
        result.bridge.connection.meetOutboundAudioSenderCandidates.some(
          (candidate) => candidate.reason === "audio_kind_hint",
        ),
      );
    } finally {
      await browser.close();
    }
  });
});

async function installMeetSurfaceFixture(page, { sessionId, tokenUrl, toolCallbackToken = "" }) {
  await page.addInitScript({
    content: `
      window.__MAB_MEET_FIXTURE = { chatMessages: [], avatarHudUpdates: [] };
      window.MAB_AVATAR_CONTROLLER = {
        updateState(input = {}) {
          window.__MAB_MEET_FIXTURE.avatarHudUpdates.push(input);
          return { ok: true, ...input };
        },
      };
      window.addEventListener("meeting-avatar-meet-chat-send", (event) => {
        window.__MAB_MEET_FIXTURE.chatMessages.push({
          ts: new Date().toISOString(),
          source: "fixture",
          text: event.detail?.text || "",
        });
      });
    `,
  });
  await page.addInitScript({
    content: buildRealtimeBrowserInitScript({
      mode: "webrtc",
      agentRuntime: "agents-sdk",
      realtimeRuntimePlacement: "sidecar",
      realtimePageRole: "meet-surface",
      sessionId,
      tokenUrl,
      toolCallbackToken,
    }),
  });
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

async function withToolRoutingServer(callback) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    try {
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type,x-oneesama-internal-key");
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }
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
      if (request.url === "/tools/control_shared_app_window") {
        response.end(
          JSON.stringify({
            ok: true,
            status: "queued",
            jobId: "job_sidecar_app_control",
            summary: "Queued sidecar app control job.",
          }),
        );
        return;
      }
      if (request.url === "/worker/poll-realtime") {
        response.end(
          JSON.stringify({
            ok: true,
            jobs: [
              {
                id: "job_sidecar_worker_result",
                status: "completed",
                task: "finish shared app control",
                result: "done",
                context: {
                  session_kind: "meeting_app_control",
                  meeting_session_id: "sidecar-worker-result-session",
                },
                realtimeDeliveryAttempt: {
                  token: "attempt_sidecar_worker_result",
                },
              },
            ],
          }),
        );
        return;
      }
      if (request.url === "/worker/mark-realtime-delivered") {
        response.end(
          JSON.stringify({
            ok: true,
            job: {
              id: body.jobId || body.id,
              deliveredToRealtime: true,
            },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback({ baseUrl: `http://127.0.0.1:${address.port}`, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
