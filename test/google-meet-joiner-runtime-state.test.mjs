import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import {
  compactRuntimeState,
  evaluateRealtimeBridgeState,
  evaluateWorkerResultBridgeState,
  evaluateMeetPageState,
  publishMeetingAwarenessToPage,
} from "../packages/core/src/meeting/google-meet-joiner-runtime-state.ts";

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
