import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";
import { buildWorkerResultInitScript } from "../packages/core/src/realtime/worker-result-init-builder.ts";
import { realtimeToolSchemas } from "../packages/core/src/realtime/realtime-contract.ts";

const controlTool = realtimeToolSchemas.find((tool) => tool.name === "control_shared_app_window");
const shareTool = realtimeToolSchemas.find((tool) => tool.name === "share_existing_app_window");
assert.ok(shareTool, "share_existing_app_window must be available to bridge tests");

test("Realtime bridge skips auto-connect in the initial about:blank document", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    await context.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        simulateRemoteAudio: false,
      }),
    });
    const page = await context.newPage();
    await page.waitForTimeout(250);

    const beforeNavigation = await page.evaluate(() => ({
      href: window.location.href,
      connected: window.MAB_REALTIME_BRIDGE?.connected,
      dataChannelOpen: window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen,
    }));
    assert.equal(beforeNavigation.href, "about:blank");
    assert.equal(beforeNavigation.connected, false);
    assert.equal(beforeNavigation.dataChannelOpen, false);

    await page.goto("data:text/html,<html><body>bridge</body></html>");
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen === true,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

async function withRealtimeBridge(callback, options = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc-mock",
        autoConnect: true,
        simulateRemoteAudio: false,
        dryRunLocalTools: true,
        tools: options.tools || (controlTool ? [controlTool] : []),
        ...options.config,
      }),
    });
    await page.goto("data:text/html,<html><body>bridge</body></html>");
    await page.waitForFunction(
      () => window.MAB_REALTIME_BRIDGE?.connection?.dataChannelOpen === true,
    );
    await callback(page);
  } finally {
    await browser.close();
  }
}

async function dispatchToolCall(page, callId, args) {
  await page.evaluate(
    ({ callId: id, args: payload }) => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: {
            type: "response.function_call_arguments.done",
            name: "control_shared_app_window",
            call_id: id,
            arguments: JSON.stringify(payload),
          },
        }),
      );
    },
    { callId, args },
  );
  await page.waitForFunction(
    (id) => window.MAB_REALTIME_BRIDGE?.workspaceTools?.calls?.some((call) => call.callId === id),
    callId,
  );
}

test("Worker result bridge only marks realtime delivered after client injection succeeds", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requests = [];
  try {
    await page.route("https://meeting.test/worker/poll-realtime", async (route) => {
      const request = route.request();
      requests.push({
        path: "/worker/poll-realtime",
        body: JSON.parse(request.postData() || "{}"),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          jobs: [
            {
              id: "job_worker_bridge",
              status: "completed",
              task: "finish app control",
              result: "done",
              context: {
                session_kind: "meeting_app_control",
                meeting_session_id: "session_bridge",
              },
              realtimeDeliveryAttempt: {
                token: "attempt_bridge",
              },
            },
          ],
        }),
      });
    });
    await page.route("https://meeting.test/worker/mark-realtime-delivered", async (route) => {
      const request = route.request();
      requests.push({
        path: "/worker/mark-realtime-delivered",
        body: JSON.parse(request.postData() || "{}"),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, job: { id: "job_worker_bridge" } }),
      });
    });
    await page.addInitScript({
      content: buildWorkerResultInitScript({
        workerPollUrl: "https://meeting.test/worker/poll-realtime",
        workerMarkRealtimeDeliveredUrl: "https://meeting.test/worker/mark-realtime-delivered",
        autoStart: false,
        pollIntervalMs: 60_000,
        sessionId: "session_bridge",
      }),
    });
    await page.goto("data:text/html,<html><body>worker bridge</body></html>");

    const missingClientDelivery = await page.evaluate(() =>
      window.MAB_WORKER_RESULT_BRIDGE_API.pollOnce(),
    );
    assert.equal(missingClientDelivery.length, 1);
    assert.equal(
      requests.some((request) => request.path === "/worker/mark-realtime-delivered"),
      false,
    );
    assert.ok(
      requests
        .filter((request) => request.path === "/worker/poll-realtime")
        .every((request) => request.body.markDelivered === false),
    );

    await page.evaluate(() => {
      window.MAB_REALTIME_CLIENT = {
        injectWorkerResult: async (job) => ({ ok: true, jobId: job.id }),
      };
    });
    const delivered = await page.evaluate(() => window.MAB_WORKER_RESULT_BRIDGE_API.pollOnce());
    assert.equal(delivered.length, 1);
    assert.ok(
      requests.some(
        (request) =>
          request.path === "/worker/mark-realtime-delivered" &&
          request.body.jobId === "job_worker_bridge" &&
          request.body.channel === "MAB_REALTIME_CLIENT.injectWorkerResult" &&
          request.body.deliveryToken === "attempt_bridge",
      ),
    );
  } finally {
    await browser.close();
  }
});

test("Worker result bridge does not mark realtime delivered after client suppression", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requests = [];
  try {
    await page.route("https://meeting.test/worker/poll-realtime", async (route) => {
      const request = route.request();
      requests.push({
        path: "/worker/poll-realtime",
        body: JSON.parse(request.postData() || "{}"),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          jobs: [
            {
              id: "job_worker_bridge_suppressed",
              status: "completed",
              task: "finish app control",
              result: "done",
              context: {
                session_kind: "meeting_app_control",
              },
              realtimeDeliveryAttempt: {
                token: "attempt_bridge_suppressed",
              },
            },
          ],
        }),
      });
    });
    await page.route("https://meeting.test/worker/mark-realtime-delivered", async (route) => {
      const request = route.request();
      requests.push({
        path: "/worker/mark-realtime-delivered",
        body: JSON.parse(request.postData() || "{}"),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, job: { id: "job_worker_bridge_suppressed" } }),
      });
    });
    await page.addInitScript({
      content: buildWorkerResultInitScript({
        workerPollUrl: "https://meeting.test/worker/poll-realtime",
        workerMarkRealtimeDeliveredUrl: "https://meeting.test/worker/mark-realtime-delivered",
        autoStart: false,
        pollIntervalMs: 60_000,
        sessionId: "session_bridge",
      }),
    });
    await page.goto("data:text/html,<html><body>worker bridge suppressed</body></html>");
    await page.evaluate(() => {
      window.MAB_REALTIME_CLIENT = {
        injectWorkerResult: async () => ({
          suppressed: true,
          reason: "worker_result_session_missing",
        }),
      };
    });

    const jobs = await page.evaluate(() => window.MAB_WORKER_RESULT_BRIDGE_API.pollOnce());
    const delivered = await page.evaluate(() => window.MAB_WORKER_RESULT_BRIDGE.delivered);

    assert.equal(jobs.length, 1);
    assert.equal(
      requests.some((request) => request.path === "/worker/mark-realtime-delivered"),
      false,
    );
    assert.equal(delivered.at(-1).suppressed, true);
    assert.equal(delivered.at(-1).reason, "worker_result_session_missing");
    assert.equal(delivered.at(-1).ack, null);
  } finally {
    await browser.close();
  }
});

test("Worker result bridge ignores removed sendWorkerResult alias", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requests = [];
  try {
    await page.route("https://meeting.test/worker/poll-realtime", async (route) => {
      const request = route.request();
      requests.push({
        path: "/worker/poll-realtime",
        body: JSON.parse(request.postData() || "{}"),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          jobs: [
            {
              id: "job_worker_bridge_alias",
              status: "completed",
              task: "finish app control",
              result: "done",
              context: {
                meeting_session_id: "session_bridge_alias",
                session_kind: "meeting_app_control",
              },
              realtimeDeliveryAttempt: {
                token: "attempt_bridge_alias",
              },
            },
          ],
        }),
      });
    });
    await page.route("https://meeting.test/worker/mark-realtime-delivered", async (route) => {
      const request = route.request();
      requests.push({
        path: "/worker/mark-realtime-delivered",
        body: JSON.parse(request.postData() || "{}"),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.addInitScript({
      content: buildWorkerResultInitScript({
        workerPollUrl: "https://meeting.test/worker/poll-realtime",
        workerMarkRealtimeDeliveredUrl: "https://meeting.test/worker/mark-realtime-delivered",
        autoStart: false,
        pollIntervalMs: 60_000,
        sessionId: "session_bridge_alias",
      }),
    });
    await page.goto("data:text/html,<html><body>worker bridge alias</body></html>");

    const result = await page.evaluate(async () => {
      let legacyCalled = false;
      window.MAB_REALTIME_CLIENT = {
        sendWorkerResult: async () => {
          legacyCalled = true;
          return { ok: true };
        },
      };
      await window.MAB_WORKER_RESULT_BRIDGE_API.pollOnce();
      return {
        legacyCalled,
        latestDelivery: window.MAB_WORKER_RESULT_BRIDGE.delivered.at(-1),
      };
    });

    assert.equal(result.legacyCalled, false);
    assert.equal(result.latestDelivery.channel, "realtime-client-missing");
    assert.equal(
      requests.some((request) => request.path === "/worker/mark-realtime-delivered"),
      false,
    );
  } finally {
    await browser.close();
  }
});

test("Worker result bridge custom-event fallback is diagnostic-only", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requests = [];
  try {
    await page.route("https://meeting.test/worker/poll-realtime", async (route) => {
      const request = route.request();
      requests.push({
        path: "/worker/poll-realtime",
        body: JSON.parse(request.postData() || "{}"),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          jobs: [
            {
              id: "job_worker_bridge_custom_event",
              status: "completed",
              task: "finish app control",
              result: "done",
              context: {
                session_kind: "meeting_app_control",
                meeting_session_id: "session_bridge",
              },
              realtimeDeliveryAttempt: {
                token: "attempt_bridge_custom_event",
              },
            },
          ],
        }),
      });
    });
    await page.route("https://meeting.test/worker/mark-realtime-delivered", async (route) => {
      const request = route.request();
      requests.push({
        path: "/worker/mark-realtime-delivered",
        body: JSON.parse(request.postData() || "{}"),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, job: { id: "job_worker_bridge_custom_event" } }),
      });
    });
    await page.addInitScript({
      content: buildWorkerResultInitScript({
        workerPollUrl: "https://meeting.test/worker/poll-realtime",
        workerMarkRealtimeDeliveredUrl: "https://meeting.test/worker/mark-realtime-delivered",
        autoStart: false,
        pollIntervalMs: 60_000,
        sessionId: "session_bridge",
        allowCustomWorkerResultEvents: true,
      }),
    });
    await page.goto("data:text/html,<html><body>worker bridge custom event</body></html>");

    const jobs = await page.evaluate(() => window.MAB_WORKER_RESULT_BRIDGE_API.pollOnce());
    const delivered = await page.evaluate(() => window.MAB_WORKER_RESULT_BRIDGE.delivered);

    assert.equal(jobs.length, 1);
    assert.equal(
      requests.some((request) => request.path === "/worker/mark-realtime-delivered"),
      false,
    );
    assert.equal(delivered.at(-1).channel, "custom-event-diagnostic");
    assert.equal(delivered.at(-1).suppressed, true);
    assert.equal(delivered.at(-1).reason, "custom_worker_result_event_diagnostic_only");
    assert.equal(delivered.at(-1).ack, null);
  } finally {
    await browser.close();
  }
});

test("Realtime custom worker-result events stay diagnostic-only when fixture opt-in is present", async () => {
  await withRealtimeBridge(
    async (page) => {
      const bridge = await page.evaluate(async () => {
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-worker-result", {
            detail: {
              id: "job_custom_worker_event_allowed",
              status: "completed",
              task: "forged worker result",
              result: "SHOULD_NOT_REACH_MODEL",
              context: {
                meeting_session_id: "custom-worker-result-diagnostic-session",
              },
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        return window.MAB_REALTIME_BRIDGE;
      });

      assert.equal(
        bridge.outbound.some((entry) =>
          JSON.stringify(entry.event || {}).includes("SHOULD_NOT_REACH_MODEL"),
        ),
        false,
      );
      assert.ok(
        bridge.timeline.some(
          (entry) =>
            entry.type === "realtime_custom_worker_result_event_diagnostic" &&
            entry.detail?.reason === "custom_worker_result_event_diagnostic_only",
        ),
      );
      assert.ok(
        bridge.workerResults.some(
          (entry) =>
            entry.suppressed === true &&
            entry.reason === "custom_worker_result_event_diagnostic_only",
        ),
      );
      assert.ok(
        bridge.meetingEvents.some(
          (entry) =>
            entry.type === "worker_result.suppressed" &&
            entry.reason === "custom_worker_result_event_diagnostic_only",
        ),
      );
    },
    {
      config: {
        sessionId: "custom-worker-result-diagnostic-session",
        allowCustomWorkerResultEvents: true,
      },
    },
  );
});

test("Realtime app-control terminal job status updates the typed state machine", async () => {
  await withRealtimeBridge(
    async (page) => {
      await page.route("http://meeting.local/tools/control_shared_app_window", async (route) => {
        const body = route.request().postDataJSON();
        const jobId = body.job_id || body.jobId;
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
          body: JSON.stringify(
            jobId === "app_job_blocked"
              ? {
                  ok: false,
                  status: "failed",
                  job_id: "app_job_blocked",
                  error: "accessibility permission denied",
                }
              : jobId === "app_job_state_only"
                ? {
                    ok: true,
                    status: "completed",
                    job_id: "app_job_state_only",
                    result: {
                      ok: true,
                      status: "completed",
                      summary: "Captured shared app state.",
                      actions: ["state"],
                    },
                  }
                : {
                    ok: true,
                    status: "completed",
                    job_id: "app_job_done",
                    session_id: "current_session",
                    screenShare: {
                      active: true,
                      applicationName: "Chrome",
                      windowId: 42,
                      realtimeBridge: "SHOULD_NOT_REACH_MODEL".repeat(200),
                    },
                    result: {
                      ok: true,
                      status: "completed",
                      summary: "queued job finished",
                      actions: ["observed Chrome", "clicked Got it"],
                      responseText: "SHOULD_NOT_REACH_MODEL".repeat(200),
                      job: {
                        id: "app_job_done",
                        task: "SHOULD_NOT_REACH_MODEL".repeat(200),
                      },
                      report: {
                        id: "app_job_done",
                        task: "SHOULD_NOT_REACH_MODEL".repeat(200),
                      },
                      backendResult: {
                        trace: "SHOULD_NOT_REACH_MODEL".repeat(200),
                      },
                      workerResult: {
                        trace: "SHOULD_NOT_REACH_MODEL".repeat(200),
                      },
                    },
                  },
          ),
        });
      });

      await dispatchToolCall(page, "call_completed_app_control", { job_id: "app_job_done" });
      await dispatchToolCall(page, "call_blocked_app_control", { job_id: "app_job_blocked" });
      await dispatchToolCall(page, "call_state_only_app_control", {
        job_id: "app_job_state_only",
      });

      const calls = await page.evaluate(() => window.MAB_REALTIME_BRIDGE.workspaceTools.calls);
      const completed = calls.find((call) => call.callId === "call_completed_app_control");
      const blocked = calls.find((call) => call.callId === "call_blocked_app_control");
      const stateOnly = calls.find((call) => call.callId === "call_state_only_app_control");

      assert.equal(completed.delivery.meetingEvent.type, "app_control.completed");
      assert.equal(completed.delivery.meetingEvent.jobId, "app_job_done");
      assert.equal(completed.delivery.policy.channel, "voice");
      assert.equal(completed.result.screenShare.applicationName, "Chrome");
      assert.equal(completed.result.screenShare.windowId, 42);
      assert.equal(completed.result.screenShare.realtimeBridge, undefined);
      assert.equal(completed.result.result.summary, "queued job finished");
      assert.deepEqual(completed.result.result.actions, ["observed Chrome", "clicked Got it"]);
      assert.equal(completed.result.result.responseText, undefined);
      assert.equal(completed.result.result.job, undefined);
      assert.equal(completed.result.result.report, undefined);
      assert.equal(completed.result.result.backendResult, undefined);
      assert.equal(completed.result.result.workerResult, undefined);
      assert.ok(JSON.stringify(completed.delivery.modelResult).length < 2500);
      assert.doesNotMatch(JSON.stringify(completed.delivery.modelResult), /SHOULD_NOT_REACH_MODEL/);
      assert.equal(blocked.delivery.meetingEvent.type, "app_control.blocked");
      assert.equal(blocked.delivery.meetingEvent.jobId, "app_job_blocked");
      assert.equal(blocked.delivery.policy.channel, "blocked");
      assert.equal(stateOnly.delivery.meetingEvent.type, "app_control.running");
      assert.equal(stateOnly.delivery.meetingEvent.jobId, "app_job_state_only");
      assert.equal(stateOnly.delivery.policy.channel, "silent");
      assert.equal(stateOnly.delivery.policy.reason, "app_control_executor_running");
      assert.equal(stateOnly.delivery.responseChannel, "");

      const jobs = await page.evaluate(() => window.MAB_REALTIME_BRIDGE.turnPolicy.appControlJobs);
      assert.equal(jobs.app_job_done.status, "completed");
      assert.equal(jobs.app_job_done.visibility, "voice");
      assert.equal(jobs.app_job_blocked.status, "blocked");
      assert.equal(jobs.app_job_blocked.visibility, "blocked");
      assert.equal(jobs.app_job_state_only.status, "running");
      assert.equal(jobs.app_job_state_only.visibility, "silent");

      const responseCreate = await page.evaluate(() =>
        window.MAB_REALTIME_BRIDGE.outbound.some(
          (entry) =>
            entry.event?.type === "response.create" &&
            entry.event?.response?.instructions?.includes(
              "Continue by calling control_shared_app_window",
            ),
        ),
      );
      assert.equal(responseCreate, false);

      const functionOutput = await page.evaluate(() =>
        window.MAB_REALTIME_BRIDGE.outbound.find(
          (entry) =>
            entry.event?.item?.type === "function_call_output" &&
            entry.event?.item?.call_id === "call_completed_app_control",
        ),
      );
      assert.ok(functionOutput);
      assert.doesNotMatch(functionOutput.event.item.output, /SHOULD_NOT_REACH_MODEL/);
      assert.ok(functionOutput.event.item.output.length < 2500);
    },
    {
      config: {
        dryRunLocalTools: false,
        tokenUrl: "http://meeting.local/realtime/client-secret",
      },
    },
  );
});

test("Realtime worker results are posted to Meet chat and only briefly acknowledged by voice", async () => {
  await withRealtimeBridge(
    async (page) => {
      const delivery = await page.evaluate(() => {
        window.__MAB_MEET_FIXTURE = { chatMessages: [] };
        window.addEventListener("meeting-avatar-meet-chat-send", (event) => {
          window.__MAB_MEET_FIXTURE.chatMessages.push({ text: event.detail.text });
        });
        return window.MAB_REALTIME_CLIENT.injectWorkerResult({
          id: "job_codex_settings",
          status: "completed",
          task: "打开 Codex 设置",
          result: "Codex 设置页面已经打开，当前可见 General 和 Account 设置。",
          context: {
            meeting_session_id: "current_session",
          },
        });
      });

      assert.equal(delivery.meetChat?.ok, true);
      assert.equal(delivery.policy.channel, "meet_chat");
      assert.equal(delivery.meetingEvent.type, "worker_result.completed");
      assert.equal(delivery.meetingEvent.visibility, "meet_chat");
      assert.equal(delivery.meetingEvent.interruptible, true);

      const state = await page.evaluate(() => ({
        chatMessages: window.__MAB_MEET_FIXTURE.chatMessages,
        outbound: window.MAB_REALTIME_BRIDGE.outbound,
        meetingEvents: window.MAB_REALTIME_BRIDGE.meetingEvents,
      }));
      assert.equal(state.chatMessages.length, 1);
      assert.match(state.chatMessages[0].text, /Codex 设置页面已经打开/);
      assert.ok(
        state.meetingEvents.some(
          (event) => event.type === "worker_result.completed" && event.visibility === "meet_chat",
        ),
      );

      const systemMessage = state.outbound
        .map((entry) => entry.event?.item)
        .find((item) => item?.type === "message" && item?.role === "system");
      const voiceText = systemMessage?.content?.[0]?.text || "";
      assert.match(voiceText, /完整结果我已经发到 Meet chat/);
      assert.doesNotMatch(voiceText, /General 和 Account/);
    },
    { config: { sessionId: "current_session" } },
  );
});

test("Realtime app-control worker results are posted to Meet chat without voice confirmation", async () => {
  await withRealtimeBridge(
    async (page) => {
      const delivery = await page.evaluate(() => {
        window.__MAB_MEET_FIXTURE = { chatMessages: [] };
        window.MAB_REALTIME_BRIDGE.protection.activeResponseId = "resp_current_turn";
        window.addEventListener("meeting-avatar-meet-chat-send", (event) => {
          window.__MAB_MEET_FIXTURE.chatMessages.push({ text: event.detail.text });
        });
        return window.MAB_REALTIME_CLIENT.injectWorkerResult({
          id: "app_control_1",
          status: "completed",
          mode: "app_control",
          task: "用 Pencil 画个圆",
          result: "Pencil 里已经画好了圆。",
          context: {
            session_kind: "meeting_app_control",
            meeting_session_id: "current_session",
            source: "meeting-realtime-shared-app-control",
            app_control_job_id: "app_control_1",
          },
        });
      });

      assert.equal(delivery.meetChat?.ok, true);
      assert.equal(delivery.policy.channel, "meet_chat");
      assert.equal(delivery.policy.autoRespond, false);
      assert.equal(delivery.policy.reason, "app_control_result_sent_to_meet_chat");
      assert.equal(delivery.interrupt.skipped, true);
      assert.equal(delivery.meetingEvent.type, "worker_result.completed");
      assert.equal(delivery.meetingEvent.visibility, "meet_chat");
      assert.equal(delivery.meetingEvent.detail.interruptedResponse, false);
      assert.equal(delivery.itemChannel, "");
      assert.equal(delivery.responseChannel, "");

      const state = await page.evaluate(() => ({
        chatMessages: window.__MAB_MEET_FIXTURE.chatMessages,
        outbound: window.MAB_REALTIME_BRIDGE.outbound,
        meetingEvents: window.MAB_REALTIME_BRIDGE.meetingEvents,
        protection: window.MAB_REALTIME_BRIDGE.protection,
      }));
      assert.equal(state.chatMessages.length, 1);
      assert.match(state.chatMessages[0].text, /Pencil 里已经画好了圆/);
      assert.equal(
        state.outbound.some((entry) => entry.event?.type === "response.cancel"),
        false,
      );
      assert.equal(
        state.outbound.some((entry) => entry.event?.type === "response.create"),
        false,
      );
      assert.equal(
        state.outbound.some(
          (entry) =>
            entry.event?.type === "conversation.item.create" &&
            entry.event?.item?.metadata?.source === "worker_result",
        ),
        false,
      );
      assert.equal(state.protection.cancelledResponses, 0);
      assert.ok(
        state.meetingEvents.some(
          (event) =>
            event.type === "worker_result.completed" &&
            event.visibility === "meet_chat" &&
            event.reason === "app_control_result_sent_to_meet_chat",
        ),
      );
    },
    { config: { sessionId: "current_session" } },
  );
});

test("Realtime app-control worker results forward KWWK cursor feedback", async () => {
  await withRealtimeBridge(
    async (page) => {
      const delivery = await page.evaluate(() => {
        window.__MAB_MEET_FIXTURE = { chatMessages: [] };
        window.__kwwkCursorFeedback = [];
        window.__kwwkHostCursorForwarded = false;
        window.MAB_KWWK_CURSOR_FEEDBACK = (input) => {
          window.__kwwkCursorFeedback.push(input);
          return input;
        };
        window.MAB_HOST_UPDATE_KWWK_CURSOR_FEEDBACK = async (input) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          window.__kwwkHostCursorForwarded = true;
          window.__kwwkHostCursorInput = input;
          return { ok: true };
        };
        window.addEventListener("meeting-avatar-meet-chat-send", (event) => {
          window.__MAB_MEET_FIXTURE.chatMessages.push({ text: event.detail.text });
        });
        return window.MAB_REALTIME_CLIENT.injectWorkerResult({
          id: "app_control_cursor",
          status: "completed",
          mode: "app_control",
          task: "点击当前共享窗口里的按钮",
          result: "Clicked.",
          resultEnvelope: {
            result: JSON.stringify({
              ok: true,
              status: "completed",
              summary: "Clicked.",
              actions: ["click"],
              backendResult: {
                metadata: {
                  cursor: {
                    schema: "oneesama.kwwk-cursor-events.v1",
                    events: [{ kind: "cursor.click", normalizedX: 0.4, normalizedY: 0.6 }],
                  },
                },
              },
            }),
          },
          context: {
            session_kind: "meeting_app_control",
            meeting_session_id: "current_session",
            source: "meeting-realtime-shared-app-control",
            app_control_job_id: "app_control_cursor",
          },
        });
      });

      assert.equal(delivery.policy.reason, "app_control_result_sent_to_meet_chat");
      const state = await page.evaluate(() => ({
        cursorFeedback: window.__kwwkCursorFeedback,
        hostForwarded: window.__kwwkHostCursorForwarded,
        hostInput: window.__kwwkHostCursorInput,
        timeline: window.MAB_REALTIME_BRIDGE.timeline,
      }));
      assert.deepEqual(state.cursorFeedback.at(-1), {
        kind: "click",
        label: "完成",
        x: 0.4,
        y: 0.6,
      });
      assert.equal(state.hostForwarded, true);
      assert.deepEqual(state.hostInput, {
        kind: "click",
        label: "完成",
        x: 0.4,
        y: 0.6,
      });
      assert.equal(
        state.timeline.some(
          (entry) => entry.type === "kwwk_cursor_feedback_host" && entry.detail?.ok === true,
        ),
        true,
      );
    },
    { config: { sessionId: "current_session" } },
  );
});

test("Realtime app-control structured state-only worker results stay silent inside executor contract", async () => {
  await withRealtimeBridge(
    async (page) => {
      const delivery = await page.evaluate(() => {
        window.__MAB_MEET_FIXTURE = { chatMessages: [] };
        window.MAB_REALTIME_BRIDGE.protection.activeResponseId = "resp_current_turn";
        window.addEventListener("meeting-avatar-meet-chat-send", (event) => {
          window.__MAB_MEET_FIXTURE.chatMessages.push({ text: event.detail.text });
        });
        return window.MAB_REALTIME_CLIENT.injectWorkerResult({
          id: "app_control_state_only",
          status: "completed",
          mode: "app_control",
          task: "在当前共享的 Pencil 画布上随便涂两笔。",
          result: "Captured shared app state.",
          resultEnvelope: {
            result: {
              ok: true,
              status: "completed",
              summary: "Captured shared app state.",
              actions: ["state"],
            },
          },
          context: {
            session_kind: "meeting_app_control",
            meeting_session_id: "current_session",
            source: "meeting-realtime-shared-app-control",
            app_control_job_id: "app_control_state_only",
          },
        });
      });

      assert.equal(delivery.meetChat, null);
      assert.equal(delivery.policy.channel, "silent");
      assert.equal(delivery.policy.autoRespond, false);
      assert.equal(delivery.policy.reason, "app_control_executor_running");
      assert.equal(delivery.interrupt.skipped, true);
      assert.equal(delivery.meetingEvent.type, "app_control.running");
      assert.equal(delivery.meetingEvent.visibility, "silent");
      assert.equal(delivery.meetingEvent.detail.interruptedResponse, false);
      assert.equal(delivery.itemChannel, "");
      assert.equal(delivery.responseChannel, "");

      const state = await page.evaluate(() => ({
        chatMessages: window.__MAB_MEET_FIXTURE.chatMessages,
        outbound: window.MAB_REALTIME_BRIDGE.outbound,
        jobs: window.MAB_REALTIME_BRIDGE.turnPolicy.appControlJobs,
        protection: window.MAB_REALTIME_BRIDGE.protection,
      }));
      assert.equal(state.chatMessages.length, 0);
      assert.equal(
        state.outbound.some((entry) => entry.event?.type === "response.cancel"),
        false,
      );
      assert.equal(
        state.outbound.some(
          (entry) =>
            entry.event?.type === "conversation.item.create" &&
            entry.event?.item?.metadata?.source === "app_control" &&
            entry.event?.item?.content?.[0]?.text?.includes(
              "Continue by calling control_shared_app_window",
            ),
        ),
        false,
      );
      assert.equal(
        state.outbound.some(
          (entry) =>
            entry.event?.type === "response.create" &&
            entry.event?.metadata?.source === "app_control" &&
            entry.event?.response?.instructions?.includes(
              "continue by calling control_shared_app_window",
            ),
        ),
        false,
      );
      assert.equal(state.protection.cancelledResponses, 0);
      assert.equal(state.jobs.app_control_state_only.status, "running");
      assert.equal(state.jobs.app_control_state_only.visibility, "silent");
      assert.equal(state.jobs.app_control_state_only.reason, "app_control_executor_running");
    },
    { config: { sessionId: "current_session" } },
  );
});

test("Realtime worker results from a different meeting session stay silent", async () => {
  await withRealtimeBridge(
    async (page) => {
      const delivery = await page.evaluate(() => {
        window.MAB_REALTIME_BRIDGE.protection.activeResponseId = "resp_current_session";
        return window.MAB_REALTIME_CLIENT.injectWorkerResult({
          id: "job_other_session",
          status: "completed",
          task: "other meeting task",
          result: "这个结果属于另一个会议。",
          context: {
            meeting_session_id: "other_session",
          },
        });
      });

      assert.equal(delivery.suppressed, true);
      assert.equal(delivery.reason, "worker_result_session_mismatch");
      assert.equal(delivery.policy.channel, "silent");
      assert.equal(delivery.meetingEvent.type, "worker_result.suppressed");
      assert.equal(delivery.meetingEvent.interruptible, false);

      const state = await page.evaluate(() => ({
        outbound: window.MAB_REALTIME_BRIDGE.outbound,
        protection: window.MAB_REALTIME_BRIDGE.protection,
        meetingEvents: window.MAB_REALTIME_BRIDGE.meetingEvents,
      }));
      assert.equal(
        state.outbound.some((entry) => entry.event?.type === "response.cancel"),
        false,
      );
      assert.equal(
        state.outbound.some((entry) => entry.event?.type === "response.create"),
        false,
      );
      assert.equal(state.protection.cancelledResponses, 0);
      assert.ok(
        state.meetingEvents.some(
          (event) =>
            event.type === "worker_result.suppressed" &&
            event.reason === "worker_result_session_mismatch",
        ),
      );
    },
    {
      config: {
        sessionId: "current_session",
      },
    },
  );
});

test("Realtime worker results without meeting session provenance stay silent", async () => {
  await withRealtimeBridge(
    async (page) => {
      const delivery = await page.evaluate(() =>
        window.MAB_REALTIME_CLIENT.injectWorkerResult({
          id: "job_missing_session",
          status: "completed",
          task: "unscoped worker result",
          result: "这个结果没有会议归属。",
        }),
      );

      assert.equal(delivery.suppressed, true);
      assert.equal(delivery.reason, "worker_result_session_missing");
      assert.equal(delivery.policy.channel, "silent");
      assert.equal(delivery.meetingEvent.type, "worker_result.suppressed");

      const state = await page.evaluate(() => ({
        outbound: window.MAB_REALTIME_BRIDGE.outbound,
        meetingEvents: window.MAB_REALTIME_BRIDGE.meetingEvents,
      }));
      assert.equal(
        state.outbound.some((entry) => entry.event?.type === "response.create"),
        false,
      );
      assert.ok(
        state.meetingEvents.some(
          (event) =>
            event.type === "worker_result.suppressed" &&
            event.reason === "worker_result_session_missing",
        ),
      );
    },
    {
      config: {
        sessionId: "current_session",
      },
    },
  );
});
