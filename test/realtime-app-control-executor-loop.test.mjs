import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";
import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";
import { realtimeToolSchemas } from "../packages/core/src/realtime/realtime-contract.ts";

const controlTool = realtimeToolSchemas.find((tool) => tool.name === "kwwk_computer_use");

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
            name: "kwwk_computer_use",
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

const liveToolConfig = {
  sessionId: "current_app_control_session",
  dryRunLocalTools: false,
  forwardMeetAudioToRealtime: false,
  includeParticipantAudio: false,
  tokenUrl: "http://meeting.local/realtime/client-secret",
};

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
    assert.equal(Object.hasOwn(stateCall.result.arguments || {}, "operations"), false);
    assert.equal(stateCall.delivery.policy.channel, "silent");
    assert.equal(stateCall.delivery.policy.reason, "app_control_executor_running");
    assert.equal(stateCall.delivery.responseChannel, "");
    assert.equal(stateCall.delivery.meetingEvent.type, "app_control.running");

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
            event.response?.instructions?.includes("Continue by calling kwwk_computer_use"),
        ),
    );
    assert.equal(foregroundFollowup, false);

    await dispatchToolCall(page, "call_direct_ops", {
      applicationName: "Pencil",
      windowId: 12345,
      instruction: "draw a snake mockup",
      operations: [
        { kind: "click", x: 40, y: 40 },
        { kind: "drag", from_x: 120, from_y: 120, to_x: 240, to_y: 120 },
        { kind: "type_text", text: "Score: 000" },
      ],
      context: { operations: [{ kind: "click", x: 1, y: 2 }] },
    });

    const directCall = await page.evaluate(() =>
      window.MAB_REALTIME_BRIDGE.workspaceTools.calls.find(
        (call) => call.callId === "call_direct_ops",
      ),
    );
    assert.equal(Object.hasOwn(directCall.result.arguments || {}, "operations"), false);
    assert.equal(Object.hasOwn(directCall.result.arguments?.context || {}, "operations"), false);
    assert.equal(directCall.delivery.policy.reason, "app_control_executor_running");

    const strippedEvents = await page.evaluate(() =>
      window.MAB_REALTIME_BRIDGE.timeline
        .filter((entry) => entry.type === "realtime_app_control_foreground_operations_stripped")
        .map((entry) => entry.detail),
    );
    assert.ok(
      strippedEvents.some(
        (detail) =>
          detail.name === "kwwk_computer_use" &&
          detail.operations === 4 &&
          detail.topLevel === true &&
          detail.context === true,
      ),
    );
  });
});

test("Realtime app-control queued result stays silent until job completion event", async () => {
  await withRealtimeBridge(
    async (page) => {
      const postedBodies = [];
      await page.route("http://meeting.local/tools/kwwk_computer_use", async (route) => {
        postedBodies.push(route.request().postDataJSON());
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ ok: true, status: "queued", jobId: "app_job_queued" }),
        });
      });

      await dispatchToolCall(page, "call_queued_app_control", {
        applicationName: "Pencil",
        instruction: "draw a snake mockup",
        operations: [{ kind: "click", x: 40, y: 40 }],
        context: { operations: [{ kind: "click", x: 1, y: 2 }] },
      });

      const queuedCall = await page.evaluate(() =>
        window.MAB_REALTIME_BRIDGE.workspaceTools.calls.find(
          (call) => call.callId === "call_queued_app_control",
        ),
      );
      assert.equal(queuedCall.delivery.policy.reason, "app_control_async_accepted");
      assert.equal(queuedCall.delivery.meetingEvent.type, "app_control.accepted");
      assert.equal(postedBodies[0].session_id, "current_app_control_session");
      assert.equal(Object.hasOwn(postedBodies[0], "operations"), false);
      assert.equal(Object.hasOwn(postedBodies[0].context || {}, "operations"), false);
    },
    { config: liveToolConfig },
  );
});

test("Realtime app-control cursor feedback uses native helper cursor coordinates", async () => {
  await withRealtimeBridge(
    async (page) => {
      await page.evaluate(() => {
        window.__kwwkCursorFeedback = [];
        window.MAB_KWWK_CURSOR_FEEDBACK = (input) => {
          window.__kwwkCursorFeedback.push(input);
          return input;
        };
      });
      await page.route("http://meeting.local/tools/kwwk_computer_use", async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({
            ok: true,
            status: "completed",
            actions: ["click"],
            backendResult: {
              metadata: {
                cursor: {
                  schema: "oneesama.kwwk-cursor-events.v1",
                  events: [{ kind: "cursor.click", normalizedX: 0.25, normalizedY: 0.75 }],
                },
                actionTelemetry: [
                  {
                    kind: "click",
                    target: { targetRole: "button", targetLabel: "Send" },
                    durationMs: 12,
                    success: true,
                    source: "kwwk",
                  },
                ],
              },
            },
          }),
        });
      });

      await dispatchToolCall(page, "call_cursor_feedback", {
        applicationName: "Pencil",
        instruction: "点击第二个按钮",
      });

      const latest = await page.evaluate(() => window.__kwwkCursorFeedback.at(-1));
      assert.equal(latest.kind, "click");
      assert.equal(latest.label, "完成");
      assert.equal(latest.x, 0.25);
      assert.equal(latest.y, 0.75);
      const telemetry = await page.evaluate(() => window.MAB_REALTIME_BRIDGE.kwwkAppControl);
      assert.deepEqual(telemetry.lastActionKinds, ["click"]);
      assert.equal(telemetry.actionTelemetry[0].durationMs, 12);
      assert.equal(
        await page.evaluate(() =>
          window.MAB_REALTIME_BRIDGE.timeline.some(
            (entry) => entry.type === "realtime_app_control_action_telemetry",
          ),
        ),
        true,
      );
    },
    { config: liveToolConfig },
  );
});

test("Realtime app-control awaits host cursor forwarding before returning", async () => {
  await withRealtimeBridge(
    async (page) => {
      await page.evaluate(() => {
        window.__kwwkHostCursorForwarded = false;
        window.MAB_HOST_UPDATE_KWWK_CURSOR_FEEDBACK = async (input) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          window.__kwwkHostCursorForwarded = true;
          window.__kwwkHostCursorInput = input;
          return { ok: true };
        };
      });
      await page.route("http://meeting.local/tools/kwwk_computer_use", async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({
            ok: true,
            status: "completed",
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
        });
      });

      await dispatchToolCall(page, "call_cursor_forwarded", {
        applicationName: "Pencil",
        instruction: "点击按钮",
      });

      assert.equal(await page.evaluate(() => window.__kwwkHostCursorForwarded), true);
      assert.deepEqual(await page.evaluate(() => window.__kwwkHostCursorInput), {
        kind: "click",
        label: "完成",
        x: 0.4,
        y: 0.6,
      });
      assert.equal(
        await page.evaluate(() =>
          window.MAB_REALTIME_BRIDGE.timeline.some(
            (entry) => entry.type === "kwwk_cursor_feedback_host" && entry.detail?.ok === true,
          ),
        ),
        true,
      );
    },
    { config: liveToolConfig },
  );
});

test("Realtime app-control keyboard-only results do not show cursor feedback", async () => {
  await withRealtimeBridge(
    async (page) => {
      await page.evaluate(() => {
        window.__kwwkCursorFeedback = [];
        window.MAB_KWWK_CURSOR_FEEDBACK = (input) => {
          window.__kwwkCursorFeedback.push(input);
          return input;
        };
      });
      await page.route("http://meeting.local/tools/kwwk_computer_use", async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({
            ok: true,
            status: "completed",
            actions: ["press_key"],
            backendResult: {
              metadata: {
                actionTelemetry: [
                  {
                    kind: "press_key",
                    target: { key: "escape" },
                    durationMs: 8,
                    success: true,
                    source: "kwwk",
                  },
                ],
              },
            },
          }),
        });
      });

      await dispatchToolCall(page, "call_keyboard_only", {
        applicationName: "Pencil",
        instruction: "Press Escape",
      });

      const cursorFeedback = await page.evaluate(() => window.__kwwkCursorFeedback);
      assert.deepEqual(cursorFeedback, []);
      const telemetry = await page.evaluate(() => window.MAB_REALTIME_BRIDGE.kwwkAppControl);
      assert.deepEqual(telemetry.lastActionKinds, ["press_key"]);
    },
    { config: liveToolConfig },
  );
});

test("Realtime app-control blocked HUD uses compact blocker copy", async () => {
  await withRealtimeBridge(
    async (page) => {
      const cases = [
        ["permission", { blocker: "accessibility_permission_required" }, "需要权限"],
        ["ambiguous", { blocker: "blocked_ambiguous_target" }, "目标不明确"],
        ["missing", { error: "shared_window_not_found" }, "找不到窗口"],
        ["failed", { error: "failed_execution" }, "操作失败"],
        ["delegate", { status: "needs_background_agent" }, "交给后台"],
        ["display", { blocker: "failed_verification", displayText: "验证失败" }, "验证失败"],
      ];
      await page.evaluate(() => {
        window.__avatarHudUpdates = [];
        window.MAB_AVATAR_CONTROLLER = {
          updateState(input = {}) {
            window.__avatarHudUpdates.push(input);
            return { ok: true };
          },
        };
      });
      await page.route("http://meeting.local/tools/kwwk_computer_use", async (route) => {
        const body = route.request().postDataJSON();
        const match = cases.find(([id]) => body.instruction === id);
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ ok: false, status: "failed", ...match?.[1] }),
        });
      });
      for (const [id, , expected] of cases) {
        await dispatchToolCall(page, `call_blocked_${id}`, {
          applicationName: "Pencil",
          instruction: id,
        });
        const latest = await page.evaluate(() => window.__avatarHudUpdates.at(-1));
        assert.equal(latest.status_kind, "blocked");
        assert.equal(latest.status_text, expected);
      }
    },
    { config: liveToolConfig },
  );
});

test("Realtime feedback surfaces stale app-control jobs before generic output blockers", async () => {
  await withRealtimeBridge(
    async (page) => {
      await page.route("http://meeting.local/tools/kwwk_computer_use", async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ ok: true, status: "queued", jobId: "app_job_stale" }),
        });
      });

      await dispatchToolCall(page, "call_stale_app_control", {
        applicationName: "Pencil",
        instruction: "draw a snake mockup",
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
      assert.equal(feedback.failureMatrix.toolTurns.reason, "app_control_job_stale");
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
