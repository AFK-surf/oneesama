import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import {
  buildMeetingAgentRealtimeSessionConfig,
  defaultMeetingAgentRealtimeTools,
  meetingAgentRealtimeToolsForRequest,
} from "../apps/meeting-agent/src/realtime-config-tools.ts";
import {
  meetingAgentControlRequestRejected,
  realtimeToolRouteRejected,
} from "../apps/meeting-agent/src/internal-control-guard.ts";
import { createTSAppControlToolHandler } from "../apps/meeting-agent/src/app-control-routes.ts";
import { validateRealtimeRuntimePlacementForJoin } from "../apps/meeting-agent/src/realtime-placement-guard.ts";

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "timed out waiting for condition");
}

test("TS meeting-agent join rejects inline Realtime SDK", () => {
  const result = validateRealtimeRuntimePlacementForJoin("inline", true);

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /inline Realtime SDK on Meet has been removed/);
});

test("TS meeting-agent join rejects inline Realtime SDK despite stale emergency override", () => {
  process.env.ONEESAMA_OPENAI_REALTIME_ALLOW_INLINE_MEET_SDK = "1";
  try {
    const result = validateRealtimeRuntimePlacementForJoin("inline", true);

    assert.equal(result.ok, false);
    assert.match(result.error, /inline Realtime SDK on Meet has been removed/);
  } finally {
    delete process.env.ONEESAMA_OPENAI_REALTIME_ALLOW_INLINE_MEET_SDK;
  }
});

test("TS meeting-agent join defaults to sidecar placement", () => {
  const result = validateRealtimeRuntimePlacementForJoin("", true);

  assert.equal(result.ok, true);
  assert.equal(result.realtimeRuntimePlacement, "sidecar");
});

test("TS meeting-agent realtime config uses live-safe default tool surface", () => {
  const names = new Set(defaultMeetingAgentRealtimeTools().map((tool) => tool.name));

  assert.ok(names.has("share_existing_app_window"));
  assert.ok(names.has("kwwk_computer_use"));
  assert.equal(names.has("control_shared_app_window"), false);
  assert.equal(names.has("open_shared_browser_surface"), false);
  assert.equal(names.has("create_shared_workspace"), false);
  assert.equal(names.has("control_shared_browser_surface"), false);
  assert.equal(names.has("stop_shared_browser_surface"), false);
});

test("TS meeting-agent realtime session uses the same live-safe tool surface", () => {
  const session = buildMeetingAgentRealtimeSessionConfig({ botName: "Onee Sama" });
  const names = new Set(session.tools.map((tool) => tool.name));

  assert.ok(names.has("share_existing_app_window"));
  assert.ok(names.has("kwwk_computer_use"));
  assert.equal(names.has("control_shared_app_window"), false);
  assert.equal(names.has("open_shared_browser_surface"), false);
  assert.equal(names.has("create_shared_workspace"), false);
  assert.equal(names.has("control_shared_browser_surface"), false);
  assert.equal(names.has("stop_shared_browser_surface"), false);
});

test("TS meeting-agent realtime session honors caller-supplied live-safe tool subsets", () => {
  const session = buildMeetingAgentRealtimeSessionConfig({
    botName: "Onee Sama",
    tools: [
      { type: "function", name: "kwwk_computer_use" },
      { type: "function", name: "open_shared_browser_surface" },
    ],
  });
  const names = session.tools.map((tool) => tool.name);

  assert.deepEqual(names, ["kwwk_computer_use"]);
});

test("TS meeting-agent client-secret mint filters caller-supplied stale tools", () => {
  const names = new Set(
    meetingAgentRealtimeToolsForRequest([
      { type: "function", name: "open_shared_browser_surface" },
      { type: "function", name: "control_shared_browser_surface" },
    ]).map((tool) => tool.name),
  );

  assert.equal(names.size, 0);
  assert.equal(names.has("open_shared_browser_surface"), false);
  assert.equal(names.has("control_shared_browser_surface"), false);
});

test("TS meeting-agent client-secret mint preserves caller-supplied live-safe tool subsets", () => {
  const names = meetingAgentRealtimeToolsForRequest([
    { type: "function", name: "share_existing_app_window" },
    { type: "function", name: "kwwk_computer_use" },
    { type: "function", name: "control_shared_app_window" },
    { type: "function", name: "github_search" },
  ]).map((tool) => tool.name);

  assert.deepEqual(names, ["share_existing_app_window", "kwwk_computer_use"]);
});

test("TS meeting-agent internal control guard rejects cross-origin browser callers", () => {
  const rejected = meetingAgentControlRequestRejected({
    headers: {
      origin: "https://attacker.example",
      host: "127.0.0.1:8781",
    },
  });

  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error, "cross_origin_internal_control_forbidden");
});

test("TS meeting-agent internal control guard allows same-origin callers", () => {
  const rejected = meetingAgentControlRequestRejected({
    headers: {
      origin: "http://127.0.0.1:8781",
      host: "127.0.0.1:8781",
    },
  });

  assert.equal(rejected, null);
});

test("TS meeting-agent internal control guard allows cross-origin callers with internal key", () => {
  const rejected = meetingAgentControlRequestRejected(
    {
      headers: {
        origin: "https://trusted-dashboard.example",
        host: "127.0.0.1:8781",
        "x-oneesama-internal-key": "secret",
      },
    },
    { internalAuthKey: "secret" },
  );

  assert.equal(rejected, null);
});

test("TS meeting-agent /tools route rejects hidden stale workspace tools", () => {
  const tools = defaultMeetingAgentRealtimeTools();

  const hidden = realtimeToolRouteRejected("github_search", tools);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error, "hidden_realtime_tool_not_exposed");

  const legacyAppControl = realtimeToolRouteRejected("control_shared_app_window", tools);
  assert.equal(legacyAppControl.status, 404);
  assert.equal(legacyAppControl.body.error, "hidden_realtime_tool_not_exposed");

  const visible = realtimeToolRouteRejected("kwwk_computer_use", tools);
  assert.equal(visible, null);
});

test("TS app-control handler runs wait-mode KWWK direct operation with compact target fallback", async () => {
  const calls = [];
  const reports = { create: () => null };
  const handler = createTSAppControlToolHandler({
    config: {},
    reports,
    runDirectAppControl: async (body, status) => {
      calls.push({ body, status });
      return { ok: true, provider: "kwwk", status: "completed", summary: "clicked Got it" };
    },
  });
  const status = {
    active: {
      sessionId: "meet_session",
      screenShare: {
        applicationName: "Chrome",
        title: "Chrome",
        windowId: 2190,
      },
    },
  };

  const result = await handler(
    { session_id: "meet_session", instruction: "click Got it", wait: true },
    status,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.instruction, "click Got it");
  assert.equal(result.ok, true);
  assert.equal(result.provider, "kwwk");
  assert.equal(result.screenShare.applicationName, "Chrome");
  assert.equal(result.screenShare.windowId, 2190);
});

test("TS app-control handler sanitizes injected direct runner input and compact result", async () => {
  const calls = [];
  const reports = { create: () => null };
  const handler = createTSAppControlToolHandler({
    config: {},
    reports,
    runDirectAppControl: async (body) => {
      calls.push(body);
      return {
        ok: true,
        provider: "kwwk",
        status: "blocked",
        summary: "raw runner result should be compacted",
        screenShare: {
          applicationName: "Chrome",
          realtimeBridge: "SHOULD_NOT_REACH_RESULT".repeat(200),
        },
      };
    },
  });

  const result = await handler(
    {
      instruction: "click Got it",
      wait: true,
      operations: [{ kind: "click", x: 10, y: 20 }],
      context: {
        keep: "small",
        operations: [{ kind: "drag" }],
        realtimeBridge: "SHOULD_NOT_REACH_RUNNER".repeat(200),
        workerResultBridge: "SHOULD_NOT_REACH_RUNNER".repeat(200),
      },
    },
    {
      active: {
        screenShare: {
          applicationName: "Chrome",
          title: "Chrome",
          windowId: 2190,
        },
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].operations, undefined);
  assert.equal(calls[0].context.keep, "small");
  assert.equal(calls[0].context.operations, undefined);
  assert.equal(calls[0].context.realtimeBridge, undefined);
  assert.equal(calls[0].context.workerResultBridge, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.screenShare.applicationName, "Chrome");
  assert.equal(result.screenShare.realtimeBridge, undefined);
});

test("TS app-control handler rejects delegate mode before injected direct runner", async () => {
  let calls = 0;
  const reports = { create: () => null };
  const handler = createTSAppControlToolHandler({
    config: {},
    reports,
    runDirectAppControl: async () => {
      calls += 1;
      return { ok: true, provider: "kwwk", status: "completed" };
    },
  });

  const result = await handler({ instruction: "delegate this", executionMode: "delegate" });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "ts_delegate_app_control_unavailable");
});

test("TS app-control handler queues default KWWK operation and reports terminal result", async () => {
  const reports = [];
  const handler = createTSAppControlToolHandler({
    config: {},
    reports: { create: (input) => reports.push(input) },
    runDirectAppControl: async () => ({
      ok: true,
      provider: "kwwk",
      status: "completed",
      summary: "queued operation finished",
    }),
  });

  const queued = await handler(
    {
      instruction: "click Got it",
      applicationName: "Chrome",
    },
    { active: { sessionId: "meet_session" } },
  );

  assert.equal(queued.ok, true);
  assert.equal(queued.status, "queued");
  assert.match(queued.job_id, /^ts_app_control_/);
  await waitFor(() => reports.length === 1);
  const status = await handler({ job_id: queued.job_id });

  assert.equal(status.ok, true);
  assert.equal(status.status, "completed");
  assert.equal(status.result.summary, "queued operation finished");
  assert.equal(reports[0].status, "completed");
  assert.equal(reports[0].context.session_kind, "meeting_app_control");
  assert.equal(reports[0].context.meeting_session_id, "meet_session");
});

test("TS app-control handler serializes queued KWWK operations", async () => {
  const starts = [];
  const resolvers = [];
  const reports = [];
  const handler = createTSAppControlToolHandler({
    config: {},
    reports: { create: (input) => reports.push(input) },
    runDirectAppControl: async (body) =>
      await new Promise((resolve) => {
        starts.push(body.instruction);
        resolvers.push(() =>
          resolve({
            ok: true,
            provider: "kwwk",
            status: "completed",
            summary: `${body.instruction} finished`,
          }),
        );
      }),
  });

  const first = await handler({ instruction: "first queued op", applicationName: "Chrome" });
  const second = await handler({ instruction: "second queued op", applicationName: "Chrome" });

  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  await waitFor(() => starts.length === 1);
  assert.deepEqual(starts, ["first queued op"]);
  resolvers[0]();
  await waitFor(() => starts.length === 2);
  assert.deepEqual(starts, ["first queued op", "second queued op"]);
  resolvers[1]();
  await waitFor(() => reports.length === 2);
});

test("TS meeting-agent wires live-safe Realtime tool routes to concrete handlers", () => {
  const source = readFileSync(
    new URL("../apps/meeting-agent/src/index.ts", import.meta.url),
    "utf8",
  );
  const appControlSource = readFileSync(
    new URL("../apps/meeting-agent/src/app-control-routes.ts", import.meta.url),
    "utf8",
  );
  const controlRoute = source.indexOf('toolName === "kwwk_computer_use"');
  const legacyControlRoute = source.indexOf('toolName === "control_shared_app_window"');
  const workspaceFallback = source.indexOf("handleWorkspaceTool(toolName, body)");

  assert.ok(controlRoute > 0, "kwwk_computer_use must not fall through to workspace tools");
  assert.equal(legacyControlRoute, -1, "legacy app-control tool must not be routed");
  assert.ok(
    controlRoute < workspaceFallback,
    "kwwk_computer_use handler must run before workspace fallback",
  );
  assert.match(source, /"POST \/screen-share\/apps"/);
  assert.match(source, /joiner\.listShareableApps\(\)/);
  assert.match(source, /"POST \/screen-share\/app"/);
  assert.match(source, /joiner\.presentAppShare\(/);
  assert.match(appControlSource, /function queueTSAppControlJob/);
  assert.match(appControlSource, /then\(\(\) => runQueuedTSAppControlJob\(job\)\)/);
  assert.match(appControlSource, /method: "kwwk\.cu\.execute"/);
  assert.doesNotMatch(appControlSource, /app_control\.control_shared_app_window/);
  assert.match(appControlSource, /compactMeetingAgentAppControlResult\(rpc\.result \|\| \{\}\)/);
  assert.match(appControlSource, /reports\.create\(\{\s*id: job\.id/s);
  assert.match(appControlSource, /session_kind: "meeting_app_control"/);
  assert.match(appControlSource, /meeting_session_id: appControlSessionIdFromBodyOrStatus/);
});
