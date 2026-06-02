import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";
import { realtimeToolSchemas } from "../packages/core/src/realtime/realtime-contract.ts";

const controlTool = realtimeToolSchemas.find((tool) => tool.name === "control_shared_app_window");
const shareTool = realtimeToolSchemas.find((tool) => tool.name === "share_existing_app_window");

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

test("Realtime app-control dry-run state result stays inside the executor loop", async () => {
  await withRealtimeBridge(async (page) => {
    await dispatchToolCall(page, "call_state_probe", {
      applicationName: "Pencil",
      instruction: "draw a snake mockup",
      operations: [{ kind: "state" }],
    });

    const stateCall = await page.evaluate(() =>
      window.MAB_REALTIME_BRIDGE.workspaceTools.calls.find(
        (call) => call.callId === "call_state_probe",
      ),
    );
    assert.equal(stateCall.result.ok, true);
    assert.deepEqual(stateCall.result.actions, ["state"]);
    assert.match(stateCall.result.summary, /executor running/);
    assert.equal(stateCall.delivery.policy.channel, "silent");
    assert.equal(stateCall.delivery.policy.reason, "app_control_executor_running");
    assert.equal(stateCall.delivery.responseChannel, "");
    assert.equal(stateCall.delivery.meetingEvent.type, "app_control.running");
    assert.equal(stateCall.delivery.meetingEvent.visibility, "silent");
    assert.equal(stateCall.delivery.meetingEvent.turnId, "call_state_probe");

    const foregroundFollowup = await page.evaluate(() =>
      window.MAB_REALTIME_BRIDGE.connection.sentDataChannelMessages
        .map((entry) => {
          try {
            return typeof entry.payload === "string" ? JSON.parse(entry.payload) : entry.payload;
          } catch {
            return entry.payload;
          }
        })
        .some(
          (event) =>
            event.type === "response.create" &&
            event.response?.instructions?.includes("Continue by calling control_shared_app_window"),
        ),
    );
    assert.equal(
      foregroundFollowup,
      false,
      "state-only app-control result must not ask the foreground model for primitive operations",
    );
    const functionOutput = await page.evaluate(() =>
      window.MAB_REALTIME_BRIDGE.connection.sentDataChannelMessages
        .map((entry) => {
          try {
            return typeof entry.payload === "string" ? JSON.parse(entry.payload) : entry.payload;
          } catch {
            return entry.payload;
          }
        })
        .find(
          (event) =>
            event.type === "conversation.item.create" &&
            event.item?.type === "function_call_output" &&
            event.item?.call_id === "call_state_probe",
        ),
    );
    const visibleOutput = JSON.parse(functionOutput.item.output);
    assert.equal(visibleOutput.status, "running");
    assert.match(visibleOutput.summary, /observing, planning, acting, or verifying/);
    assert.doesNotMatch(visibleOutput.summary, /Continue by calling/);

    await dispatchToolCall(page, "call_direct_ops", {
      applicationName: "Pencil",
      windowId: 12345,
      instruction: "draw a snake mockup",
      operations: [
        { kind: "click", x: 40, y: 40 },
        { kind: "drag", from_x: 120, from_y: 120, to_x: 240, to_y: 120 },
        { kind: "type_text", text: "Score: 000" },
      ],
    });

    const directCall = await page.evaluate(() =>
      window.MAB_REALTIME_BRIDGE.workspaceTools.calls.find(
        (call) => call.callId === "call_direct_ops",
      ),
    );
    assert.equal(directCall.result.ok, true);
    assert.deepEqual(directCall.result.actions, ["click", "drag", "type_text"]);
    assert.match(directCall.result.summary, /executed low-level app-control operations/i);
    assert.equal(directCall.delivery.policy.channel, "voice");
    assert.equal(directCall.delivery.meetingEvent.type, "app_control.completed");
    assert.equal(directCall.delivery.meetingEvent.interruptible, true);
  });
});

test("Realtime app-control queued result stays silent until job completion event", async () => {
  await withRealtimeBridge(
    async (page) => {
      await page.route("http://meeting.local/tools/control_shared_app_window", async (route) => {
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
          body: JSON.stringify({
            ok: true,
            status: "queued",
            jobId: "app_job_queued",
          }),
        });
      });

      await dispatchToolCall(page, "call_queued_app_control", {
        applicationName: "Pencil",
        instruction: "draw a snake mockup",
        operations: [{ kind: "click", x: 40, y: 40 }],
      });

      const queuedCall = await page.evaluate(() =>
        window.MAB_REALTIME_BRIDGE.workspaceTools.calls.find(
          (call) => call.callId === "call_queued_app_control",
        ),
      );
      assert.equal(queuedCall.result.status, "queued");
      assert.equal(queuedCall.delivery.policy.channel, "silent");
      assert.equal(queuedCall.delivery.policy.reason, "app_control_async_accepted");
      assert.equal(queuedCall.delivery.responseChannel, "");
      assert.equal(queuedCall.delivery.meetingEvent.type, "app_control.accepted");
      assert.equal(queuedCall.delivery.meetingEvent.jobId, "app_job_queued");

      const appControlJob = await page.evaluate(
        () => window.MAB_REALTIME_BRIDGE.turnPolicy.appControlJobs.app_job_queued,
      );
      assert.equal(appControlJob.status, "accepted");
      assert.equal(appControlJob.visibility, "silent");
    },
    {
      config: {
        dryRunLocalTools: false,
        forwardMeetAudioToRealtime: false,
        includeParticipantAudio: false,
        tokenUrl: "http://meeting.local/realtime/client-secret",
      },
    },
  );
});

test("Realtime feedback surfaces stale app-control jobs before generic output blockers", async () => {
  await withRealtimeBridge(
    async (page) => {
      await page.route("http://meeting.local/tools/control_shared_app_window", async (route) => {
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
          body: JSON.stringify({
            ok: true,
            status: "queued",
            jobId: "app_job_stale",
          }),
        });
      });

      await dispatchToolCall(page, "call_stale_app_control", {
        applicationName: "Pencil",
        instruction: "draw a snake mockup",
        operations: [{ kind: "click", x: 40, y: 40 }],
      });

      await page.evaluate(() => {
        const job = window.MAB_REALTIME_BRIDGE.turnPolicy.appControlJobs.app_job_stale;
        job.updatedAt = new Date(Date.now() - 90000).toISOString();
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-realtime-server-event", {
            detail: { type: "session.updated" },
          }),
        );
      });

      await page.waitForFunction(() =>
        window.MAB_REALTIME_BRIDGE.feedback?.blockers?.includes("app_control_job_stale"),
      );

      const feedback = await page.evaluate(() => window.MAB_REALTIME_BRIDGE.feedback);
      assert.equal(feedback.status, "tool_blocked");
      assert.equal(feedback.checks.appControlJobsPending, 1);
      assert.equal(feedback.checks.appControlJobsStale, 1);
      assert.equal(feedback.failureMatrix.toolTurns.status, "blocked");
      assert.equal(feedback.failureMatrix.toolTurns.reason, "app_control_job_stale");
      assert.equal(feedback.failureMatrix.audioOutput.status, "blocked");
      assert.ok(!feedback.blockers.includes("remote_audio_not_attached"));
    },
    {
      config: {
        dryRunLocalTools: false,
        forwardMeetAudioToRealtime: false,
        includeParticipantAudio: false,
        tokenUrl: "http://meeting.local/realtime/client-secret",
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
                      summary:
                        "Captured shared app state. Continue with concrete click/type_text/press_key/scroll/drag operations.",
                      actions: ["state"],
                    },
                  }
                : {
                    ok: true,
                    status: "completed",
                    job_id: "app_job_done",
                    result: { summary: "queued job finished" },
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
  await withRealtimeBridge(async (page) => {
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
  });
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

test("Realtime app-control state-only worker results stay silent inside executor contract", async () => {
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
          result:
            "Captured shared app state. Continue with concrete click/type_text/press_key/scroll/drag operations.",
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

test("Realtime app-share success stays silent after verified active share evidence", async () => {
  await withRealtimeBridge(
    async (page) => {
      await page.route("http://meeting.local/screen-share/app", async (route) => {
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
          body: JSON.stringify({
            ok: true,
            screenShare: { active: true },
            postcheck: { screenShare: { active: true } },
          }),
        });
      });

      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-realtime-server-event", {
            detail: {
              type: "response.function_call_arguments.done",
              name: "share_existing_app_window",
              call_id: "call_share_codex",
              arguments: JSON.stringify({ applicationName: "Codex" }),
            },
          }),
        );
      });

      await page.waitForFunction(() =>
        window.MAB_REALTIME_BRIDGE?.meetTools?.calls?.some(
          (call) => call.callId === "call_share_codex",
        ),
      );

      const responseCreate = await page.evaluate(() =>
        window.MAB_REALTIME_BRIDGE.outbound.some(
          (entry) =>
            entry.event?.type === "response.create" &&
            entry.event?.response?.instructions?.includes("screen-share"),
        ),
      );
      assert.equal(responseCreate, false);

      const shareCall = await page.evaluate(() =>
        window.MAB_REALTIME_BRIDGE.meetTools.calls.find(
          (call) => call.callId === "call_share_codex",
        ),
      );
      assert.equal(shareCall.delivery.policy.channel, "visual_only");
      assert.equal(shareCall.delivery.responseChannel, "");
      assert.equal(shareCall.delivery.meetingEvent.type, "tool_result.visual_only");
      assert.equal(shareCall.delivery.meetingEvent.visibility, "visual_only");
    },
    {
      tools: shareTool ? [shareTool] : [],
      config: {
        dryRunLocalTools: false,
        tokenUrl: "http://meeting.local/realtime/client-secret",
      },
    },
  );
});
