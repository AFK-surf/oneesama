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
import { validateRealtimeRuntimePlacementForJoin } from "../apps/meeting-agent/src/realtime-placement-guard.ts";

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

  const visible = realtimeToolRouteRejected("kwwk_computer_use", tools);
  assert.equal(visible, null);
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
  const workspaceFallback = source.indexOf("handleWorkspaceTool(toolName, body)");

  assert.ok(controlRoute > 0, "kwwk_computer_use must not fall through to workspace tools");
  assert.ok(
    controlRoute < workspaceFallback,
    "kwwk_computer_use handler must run before workspace fallback",
  );
  assert.match(source, /"POST \/screen-share\/apps"/);
  assert.match(source, /joiner\.listShareableApps\(\)/);
  assert.match(source, /"POST \/screen-share\/app"/);
  assert.match(source, /joiner\.presentAppShare\(/);
  assert.match(appControlSource, /function queueTSAppControlJob/);
  assert.match(appControlSource, /void runQueuedTSAppControlJob\(job\)/);
  assert.match(appControlSource, /compactMeetingAgentAppControlResult\(rpc\.result \|\| \{\}\)/);
  assert.match(appControlSource, /reports\.create\(\{\s*id: job\.id/s);
  assert.match(appControlSource, /session_kind: "meeting_app_control"/);
  assert.match(appControlSource, /meeting_session_id: appControlSessionIdFromBodyOrStatus/);
});
