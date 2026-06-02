import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import {
  compactJoinStatusActive,
  compactJoinStatusRealtimeBridge,
  compactJoinStatusWorkerResultBridge,
  compactRuntimeState,
  evaluateRealtimeBridgeState,
  evaluateWorkerResultBridgeState,
  evaluateMeetPageState,
  publishMeetingAwarenessToPage,
} from "../packages/core/src/meeting/google-meet-joiner-runtime-state.ts";

function many(count, build) {
  return Array.from({ length: count }, (_, index) => build(index));
}

test("Google Meet runtime diagnostics preserve Realtime SDK history tail", () => {
  const compact = compactRuntimeState({
    avatarReady: null,
    avatarAudio: null,
    realtimeBridge: {
      mode: "agents-sdk",
      connected: true,
      connecting: false,
      feedback: { status: "ready", blockers: [] },
      contextHealth: {
        enabled: true,
        itemsCount: 3,
        tokenEstimate: 42,
        lastHistoryTail: [
          { type: "message", role: "user", text: "分享一下 Chrome 浏览器窗口。" },
          { type: "function_call", role: "", name: "share_existing_app_window" },
        ],
        latestFunctionalTurn: {
          observed: true,
          intent: "share",
          toolCalled: true,
          fakeExecution: false,
        },
        compactCount: 1,
        lastCompactAt: "2026-06-01T05:00:00.000Z",
        lastRefreshAt: "2026-06-01T05:00:01.000Z",
        lastRefreshReason: "history_updated",
      },
      session: {},
      connection: {},
      protection: {},
      inbound: [],
      transcripts: {},
      workerResults: [],
      outbound: [],
      timeline: [],
      errors: [],
      avatarTools: null,
      workerTools: null,
      meetTools: null,
      workspaceTools: null,
    },
    workerResultBridge: null,
    localDialog: null,
    captions: null,
    screenShare: null,
  });

  assert.deepEqual(compact.realtime.contextHealth.lastHistoryTail, [
    { type: "message", role: "user", text: "分享一下 Chrome 浏览器窗口。" },
    { type: "function_call", role: "", name: "share_existing_app_window" },
  ]);
  assert.equal(compact.realtime.contextHealth.latestFunctionalTurn.intent, "share");
  assert.equal(compact.realtime.contextHealth.latestFunctionalTurn.toolCalled, true);
});

test("Google Meet join status compactor preserves bridge keys while tailing noisy arrays", () => {
  const realtimeBridge = compactJoinStatusRealtimeBridge({
    mode: "agents-sdk",
    responsesRequested: 7,
    connection: {
      connected: true,
      sentDataChannelMessages: many(25, (index) => ({ payload: `payload-${index}` })),
    },
    contextHealth: {
      lastHistoryTail: many(25, (index) => ({ text: `history-${index}` })),
      latestFunctionalTurn: { intent: "control", toolCalled: true },
    },
    workerResults: many(25, (index) => ({ id: `worker-result-${index}` })),
    inbound: many(25, (index) => ({ id: `inbound-${index}` })),
    outbound: many(25, (index) => ({ id: `outbound-${index}` })),
    timeline: many(25, (index) => ({ id: `timeline-${index}` })),
    turnPolicy: {
      decisions: many(25, (index) => ({ callId: `decision-${index}` })),
      events: many(25, (index) => ({ id: `event-${index}` })),
      manualFunctionalTurns: many(25, (index) => ({ id: `manual-${index}` })),
      appControlJobs: Object.fromEntries(
        many(25, (index) => [`job_${index}`, { id: `job_${index}` }]),
      ),
    },
    workerTools: {
      calls: many(25, (index) => ({ name: "delegate_to_worker", callId: `worker-${index}` })),
      errors: many(25, (index) => ({ message: `worker-error-${index}` })),
    },
    meetTools: {
      calls: many(25, (index) => ({ name: "send_meet_chat", callId: `meet-${index}` })),
      errors: [],
    },
    workspaceTools: {
      calls: many(25, (index) => ({ name: "kwwk_computer_use", callId: `workspace-${index}` })),
      errors: [],
    },
    avatarTools: {
      calls: many(25, (index) => ({ name: "update_avatar_state", callId: `avatar-${index}` })),
      errors: [],
    },
  });
  const workerResultBridge = compactJoinStatusWorkerResultBridge({
    enabled: true,
    delivered: many(25, (index) => ({ id: `delivery-${index}` })),
    errors: many(25, (index) => ({ message: `delivery-error-${index}` })),
  });

  assert.equal(realtimeBridge.responsesRequested, 7);
  assert.equal(realtimeBridge.connection.sentDataChannelMessages.length, 20);
  assert.equal(realtimeBridge.connection.sentDataChannelMessages[0].payload, "payload-5");
  assert.equal(realtimeBridge.contextHealth.lastHistoryTail.length, 20);
  assert.equal(realtimeBridge.contextHealth.lastHistoryTail[0].text, "history-5");
  assert.equal(realtimeBridge.contextHealth.latestFunctionalTurn.intent, "control");
  assert.equal(realtimeBridge.workerResults.length, 20);
  assert.equal(realtimeBridge.workerResults[0].id, "worker-result-5");
  assert.equal(realtimeBridge.workerTools.calls.length, 20);
  assert.equal(realtimeBridge.workerTools.calls[0].callId, "worker-5");
  assert.equal(realtimeBridge.meetTools.calls[0].callId, "meet-5");
  assert.equal(realtimeBridge.workspaceTools.calls[0].callId, "workspace-5");
  assert.equal(realtimeBridge.avatarTools.calls[0].callId, "avatar-5");
  assert.equal(realtimeBridge.turnPolicy.decisions[0].callId, "decision-5");
  assert.deepEqual(Object.keys(realtimeBridge.turnPolicy.appControlJobs)[0], "job_5");
  assert.equal(workerResultBridge.delivered.length, 20);
  assert.equal(workerResultBridge.delivered[0].id, "delivery-5");
});

test("Google Meet join status compactor truncates bridge payloads and preserves active app-control jobs", () => {
  const hugePayload = "huge-payload-token".repeat(500);
  const realtimeBridge = compactJoinStatusRealtimeBridge({
    connection: {
      sentDataChannelMessages: many(25, (index) => ({
        id: `sent-${index}`,
        payload: index === 24 ? hugePayload : `payload-${index}`,
      })),
    },
    outbound: many(25, (index) => ({
      id: `outbound-${index}`,
      event: {
        item: {
          text: index === 24 ? hugePayload : `outbound-${index}`,
        },
      },
    })),
    turnPolicy: {
      appControlJobs: Object.fromEntries([
        [
          "old_running_job",
          {
            id: "old_running_job",
            status: "running",
            updatedAt: "2026-06-02T00:00:00.000Z",
            result: hugePayload,
          },
        ],
        ...many(25, (index) => [
          `completed_job_${index}`,
          {
            id: `completed_job_${index}`,
            status: "completed",
            updatedAt: `2026-06-02T00:${String(index).padStart(2, "0")}:00.000Z`,
          },
        ]),
      ]),
    },
  });

  assert.equal(realtimeBridge.connection.sentDataChannelMessages.length, 20);
  assert.equal(realtimeBridge.outbound.length, 20);
  assert.equal(realtimeBridge.connection.sentDataChannelMessages.at(-1).payload.length, 803);
  assert.equal(JSON.stringify(realtimeBridge).includes(hugePayload), false);
  assert.equal(Object.keys(realtimeBridge.turnPolicy.appControlJobs).length, 20);
  assert.ok(realtimeBridge.turnPolicy.appControlJobs.old_running_job);
  assert.equal(realtimeBridge.turnPolicy.appControlJobs.completed_job_5, undefined);
  assert.ok(realtimeBridge.turnPolicy.appControlJobs.completed_job_24);
});

test("Google Meet join status compactor keeps newest severe app-control jobs", () => {
  const appControlJobs = Object.fromEntries([
    ...many(25, (index) => [
      `old_running_${index}`,
      {
        id: `old_running_${index}`,
        status: "running",
        updatedAt: `2026-06-02T00:${String(index).padStart(2, "0")}:00.000Z`,
      },
    ]),
    [
      "new_timeout_blocker",
      {
        id: "new_timeout_blocker",
        status: "timeout",
        blocker: "app_control_timeout",
        updatedAt: "2026-06-02T01:00:00.000Z",
      },
    ],
    [
      "new_failed_blocker",
      {
        id: "new_failed_blocker",
        status: "failed",
        error: "permission_required",
        updatedAt: "2026-06-02T01:01:00.000Z",
      },
    ],
    [
      "new_started_job",
      {
        id: "new_started_job",
        status: "started",
        updatedAt: "2026-06-02T01:02:00.000Z",
      },
    ],
    [
      "new_accepted_job",
      {
        id: "new_accepted_job",
        status: "accepted",
        updatedAt: "2026-06-02T01:03:00.000Z",
      },
    ],
  ]);
  const realtimeBridge = compactJoinStatusRealtimeBridge({
    turnPolicy: { appControlJobs },
  });
  const jobs = realtimeBridge.turnPolicy.appControlJobs;

  assert.equal(Object.keys(jobs).length, 20);
  assert.ok(jobs.new_timeout_blocker);
  assert.ok(jobs.new_failed_blocker);
  assert.ok(jobs.new_started_job);
  assert.ok(jobs.new_accepted_job);
  assert.equal(jobs.old_running_0, undefined);
});

test("Google Meet join status compactor preserves late diagnostic keys in large payloads", () => {
  const noisyPayload = Object.fromEntries(many(80, (index) => [`filler_${index}`, index]));
  Object.assign(noisyPayload, {
    status: "blocked",
    blocker: "permission_required",
    error: "accessibility_permission_required",
    jobId: "app_control_late_keys",
    updatedAt: "2026-06-02T01:00:00.000Z",
  });
  const realtimeBridge = compactJoinStatusRealtimeBridge({
    outbound: [{ nested: noisyPayload }],
  });

  assert.equal(realtimeBridge.outbound[0].nested.status, "blocked");
  assert.equal(realtimeBridge.outbound[0].nested.blocker, "permission_required");
  assert.equal(realtimeBridge.outbound[0].nested.error, "accessibility_permission_required");
  assert.equal(realtimeBridge.outbound[0].nested.jobId, "app_control_late_keys");
  assert.equal(realtimeBridge.outbound[0].nested.updatedAt, "2026-06-02T01:00:00.000Z");
});

test("Google Meet join active status uses compact bridge payloads", () => {
  const hugePayload = "raw-bridge-payload".repeat(500);
  const active = compactJoinStatusActive(
    {
      sessionId: "meet_session",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      startedAt: "2026-06-02T00:00:00.000Z",
      realtimeSidecarPage: {},
      diagnostics: {
        jsonPath: "/tmp/diagnostics.json",
        screenshots: ["one.png"],
      },
      captions: {
        ok: true,
        count: 2,
        latest: { text: "hello" },
        browser: { containerFound: true, errors: [] },
      },
      realtimeBridge: {
        feedback: {
          status: "tool_blocked",
          blockers: ["app_control_job_blocked"],
        },
        outbound: many(25, (index) => ({
          payload: index === 24 ? hugePayload : `payload-${index}`,
        })),
        turnPolicy: {
          appControlJobs: {
            blocked_job: {
              id: "blocked_job",
              status: "failed",
              blocker: "permission_required",
              updatedAt: "2026-06-02T01:00:00.000Z",
              result: hugePayload,
            },
          },
        },
      },
      workerResultBridge: {
        delivered: many(25, (index) => ({ id: `delivery-${index}` })),
      },
    },
    { ok: true, role: "sidecar" },
  );

  assert.equal(active.sessionId, "meet_session");
  assert.equal(active.realtimeSidecar.role, "sidecar");
  assert.equal(active.captions.containerFound, true);
  assert.equal(active.realtimeBridge.outbound.length, 20);
  assert.equal(JSON.stringify(active.realtimeBridge).includes(hugePayload), false);
  assert.equal(active.realtimeBridge.feedback.status, "tool_blocked");
  assert.equal(
    active.realtimeBridge.turnPolicy.appControlJobs.blocked_job.blocker,
    "permission_required",
  );
  assert.equal(active.workerResultBridge.delivered.length, 20);
});

test("Google Meet page state records sidecar SDK negative probe", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.__name = (fn) => fn;
      window.MAB_REALTIME_BRIDGE = {
        runtimePlacement: "sidecar",
        realtimePageRole: "meet-surface",
        sdkOwner: "sidecar",
        agentRuntime: {
          sdkSuppressedOnMeetSurface: true,
          bundleGlobal: "",
        },
      };
      window.MAB_REALTIME_CLIENT = {
        runtimePlacement: "sidecar",
        realtimePageRole: "meet-surface",
        sdkOwner: "sidecar",
      };
    });
    await page.goto(
      "data:text/html,<main><button>Leave call</button><button>People</button><button>Chat</button></main>",
    );

    const state = await evaluateMeetPageState(page);

    assert.equal(state.ok, true);
    assert.equal(state.realtimeSurface.runtimePlacement, "sidecar");
    assert.equal(state.realtimeSurface.pageRole, "meet-surface");
    assert.equal(state.realtimeSurface.sdkOwner, "sidecar");
    assert.equal(state.realtimeSurface.sdkSuppressedOnMeetSurface, true);
    assert.equal(state.realtimeSurface.hasSDKGlobal, false);
    assert.equal(state.realtimeSurface.bundleGlobal, "");
  } finally {
    await browser.close();
  }
});

test("Realtime runtime state helpers do not fall back to the Meet page when sidecar is missing", async () => {
  assert.equal(await evaluateRealtimeBridgeState(null), null);
  assert.equal(await evaluateWorkerResultBridgeState(null), null);

  const publish = await publishMeetingAwarenessToPage(
    null,
    {
      ok: true,
      observedAt: "2026-06-02T00:00:00.000Z",
      participantCount: 1,
      participants: [],
      activeSpeaker: null,
      currentUser: null,
    },
    true,
  );

  assert.deepEqual(publish, {
    ok: false,
    skipped: true,
    reason: "realtime_sidecar_page_missing",
  });
});
