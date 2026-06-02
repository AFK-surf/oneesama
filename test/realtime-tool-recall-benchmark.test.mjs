import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { test } from "vite-plus/test";

import {
  benchmarkRuntimeEvidenceProfile,
  meetingAgentToolSurfaceMetadata,
  scoreCase,
  shouldUseBuiltinRecallHarness,
  withRealtimeBenchmarkLock,
} from "../scripts/realtime-tool-recall-benchmark.mjs";

test("Realtime tool recall fixtures cover KWWK positive and negative routing", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../scripts/fixtures/realtime-tool-recall-cases.json", import.meta.url),
      "utf8",
    ),
  );
  const cases = new Map(fixture.cases.map((entry) => [entry.id, entry]));

  for (const id of [
    "control_shared_browser_input_zh",
    "control_switch_account_zh",
    "control_switch_tab_zh",
    "control_chrome_stuck_zh",
  ]) {
    assert.ok(cases.get(id)?.expectedToolNames.includes("kwwk_computer_use"), id);
  }
  for (const id of ["negative_stop_share_zh", "negative_meeting_control_mute_zh"]) {
    const testCase = cases.get(id);
    assert.deepEqual(testCase.expectedToolNames, []);
    assert.ok(testCase.disallowedToolNames.includes("kwwk_computer_use"), id);
    assert.ok(testCase.disallowedToolNames.includes("control_shared_app_window"), id);
  }
  assert.ok(
    fixture.variants
      .find((variant) => variant.name === "share-control-only")
      .toolNames.includes("kwwk_computer_use"),
  );
});

test("Realtime tool recall report metadata says sidecar-control is dry-run tool recall evidence", () => {
  assert.deepEqual(benchmarkRuntimeEvidenceProfile("sidecar-control"), {
    evidenceMode: "sidecar_tool_recall",
    acceptanceGateScope: "sidecar_tool_recall",
    toolExecutionMode: "dry_run_local_tools",
    realAppExecution: false,
    note: "This benchmark proves sidecar tool recall, local wrapper telemetry, and function-output delivery semantics. By default it uses a built-in local harness with mock bridge transport and dry-run local tools, so it is not coupled to live service or upstream API health. Explicit live URLs still require SDK connection; use dedicated chain/live gates for real worker or app execution evidence.",
  });
});

test("Realtime tool recall defaults to builtin harness unless a live URL is explicit", () => {
  assert.equal(
    shouldUseBuiltinRecallHarness({
      runtime: "sidecar-control",
      meetingAgentUrlExplicit: false,
    }),
    true,
  );
  assert.equal(
    shouldUseBuiltinRecallHarness({
      runtime: "meet-page-csp",
      meetingAgentUrlExplicit: false,
    }),
    true,
  );
  assert.equal(
    shouldUseBuiltinRecallHarness({
      runtime: "sidecar-control",
      meetingAgentUrlExplicit: true,
    }),
    false,
  );
  assert.equal(
    shouldUseBuiltinRecallHarness({
      runtime: "raw-websocket",
      meetingAgentUrlExplicit: false,
    }),
    false,
  );
});

test("Realtime raw-websocket report metadata is diagnostic-only", () => {
  const profile = benchmarkRuntimeEvidenceProfile("raw-websocket");

  assert.equal(profile.acceptanceGateScope, "diagnostic_only");
  assert.equal(profile.toolExecutionMode, "no_local_tool_execution");
  assert.equal(profile.realAppExecution, false);
});

test("Realtime tool recall report metadata flags stale exposed tool surfaces", () => {
  const metadata = meetingAgentToolSurfaceMetadata({
    meetingAgentUrl: "http://127.0.0.1:8781",
    runtime: "sidecar-control",
    tools: [{ name: "kwwk_computer_use" }, { name: "control_shared_app_window" }],
  });

  assert.deepEqual(metadata, {
    url: "http://127.0.0.1:8781",
    runtimePlacement: "sidecar-control",
    exposedTools: ["kwwk_computer_use", "control_shared_app_window"],
    staleServiceSuspected: true,
  });
});

test("Realtime tool recall flags assistant text without expected tool as fake execution", () => {
  const score = scoreCase(
    { expectedToolNames: ["list_shareable_windows", "share_existing_app_window"] },
    { calls: [], assistantText: "好的，稍等一下，有结果我会马上告诉你。" },
  );

  assert.equal(score.ok, false);
  assert.equal(score.kind, "positive");
  assert.equal(score.reason, "assistant_text_without_expected_tool");
  assert.equal(score.fakeExecution, true);
});

test("Realtime tool recall passes when expected tool is called before or with assistant text", () => {
  const score = scoreCase(
    { expectedToolNames: ["list_shareable_windows", "share_existing_app_window"] },
    { calls: ["list_shareable_windows"], assistantText: "我先看一下可共享窗口。" },
  );

  assert.equal(score.ok, true);
  assert.equal(score.reason, "expected_tool_called");
  assert.equal(score.fakeExecution, false);
});

test("Realtime tool recall distinguishes silence from fake execution", () => {
  const score = scoreCase(
    { expectedToolNames: ["kwwk_computer_use"] },
    { calls: [], assistantText: "" },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "expected_tool_missing");
  assert.equal(score.fakeExecution, false);
});

test("Realtime tool recall scores SDK history replay as fake execution", () => {
  const score = scoreCase(
    { expectedToolNames: ["list_shareable_windows", "share_existing_app_window"] },
    {
      history: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "分享一下 Chrome 浏览器窗口。" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "还在共享处理中，请稍等一下。" }],
        },
      ],
    },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "assistant_text_without_expected_tool");
  assert.equal(score.fakeExecution, true);
});

test("Realtime tool recall passes SDK history replay with matching tool", () => {
  const score = scoreCase(
    { expectedToolNames: ["list_shareable_windows", "share_existing_app_window"] },
    {
      history: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "分享一下 Chrome 浏览器窗口。" }],
        },
        {
          type: "function_call",
          name: "list_shareable_windows",
          call_id: "call_share_windows",
        },
      ],
    },
  );

  assert.equal(score.ok, true);
  assert.equal(score.reason, "expected_tool_called");
  assert.equal(score.fakeExecution, false);
});

test("Realtime tool recall fails when sidecar Meet surface exposes SDK", () => {
  const score = scoreCase(
    { expectedToolNames: ["share_existing_app_window"] },
    {
      calls: ["share_existing_app_window"],
      assistantText: "",
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        sdkConnected: true,
        meetSurface: {
          hasSDKGlobal: true,
          sdkSuppressedOnMeetSurface: false,
        },
      },
    },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "meet_surface_sdk_global_present");
});

test("Realtime tool recall fails sidecar silence when SDK never connected", () => {
  const score = scoreCase(
    { expectedToolNames: ["share_existing_app_window"] },
    {
      calls: [],
      assistantText: "",
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        sdkConnected: false,
        meetSurface: {
          hasSDKGlobal: false,
          sdkSuppressedOnMeetSurface: true,
        },
      },
    },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "sidecar_sdk_not_connected");
});

test("Realtime tool recall rejects direct-routed sidecar calls when SDK never connected", () => {
  const score = scoreCase(
    { expectedToolNames: ["share_existing_app_window"] },
    {
      calls: ["share_existing_app_window"],
      assistantText: "",
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        sdkConnected: false,
        sdkConnectTimedOut: true,
        meetSurface: {
          hasSDKGlobal: false,
          sdkSuppressedOnMeetSurface: true,
        },
        wrapperTelemetry: [
          {
            name: "share_existing_app_window",
            callId: "manual_text_turn_share",
            hasResult: true,
          },
        ],
        functionCallOutputDelivery: { delivered: true, producedToolResult: true },
      },
    },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "sidecar_sdk_not_connected");
});

test("Realtime tool recall accepts builtin harness bridge connection without SDK connection", () => {
  const score = scoreCase(
    { expectedToolNames: ["kwwk_computer_use"] },
    {
      calls: ["kwwk_computer_use"],
      assistantText: "",
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        sdkConnectionRequired: false,
        sdkConnected: false,
        bridgeConnected: true,
        meetSurface: {
          hasSDKGlobal: false,
          sdkSuppressedOnMeetSurface: true,
        },
        wrapperTelemetry: [
          {
            name: "kwwk_computer_use",
            callId: "manual_text_turn_control",
            hasResult: true,
          },
        ],
        functionCallOutputDelivery: { delivered: true, producedToolResult: true },
      },
    },
  );

  assert.equal(score.ok, true);
  assert.equal(score.reason, "expected_tool_called");
});

test("Realtime tool recall fails sidecar runtime errors despite matching direct-routed calls", () => {
  const score = scoreCase(
    { expectedToolNames: ["kwwk_computer_use"] },
    {
      calls: ["kwwk_computer_use"],
      assistantText: "",
      errors: [{ message: "Realtime client secret request failed: status=500" }],
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        sdkConnected: false,
        sdkConnectTimedOut: true,
        meetSurface: {
          hasSDKGlobal: false,
          sdkSuppressedOnMeetSurface: true,
        },
        wrapperTelemetry: [
          {
            name: "kwwk_computer_use",
            callId: "manual_text_turn_control",
            hasResult: true,
          },
        ],
        functionCallOutputDelivery: { delivered: true, producedToolResult: true },
      },
    },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "sidecar_runtime_error");
});

test("Realtime tool recall fails when meet-page-csp runtime does not prove CSP", () => {
  const score = scoreCase(
    { expectedToolNames: ["share_existing_app_window"] },
    {
      calls: ["share_existing_app_window"],
      assistantText: "",
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        sdkConnected: true,
        requireStrictCsp: true,
        meetSurface: {
          hasSDKGlobal: false,
          sdkSuppressedOnMeetSurface: true,
          strictCspEnforced: false,
        },
      },
    },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "meet_page_csp_not_enforced");
});

test("Realtime tool recall fails app-control cases with terminal app-control failure", () => {
  const score = scoreCase(
    { expectedToolNames: ["kwwk_computer_use"] },
    {
      calls: ["kwwk_computer_use"],
      assistantText: "",
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        sdkConnected: true,
        meetSurface: {
          hasSDKGlobal: false,
          sdkSuppressedOnMeetSurface: true,
        },
        appControlTelemetry: [{ jobId: "app_control_1", status: "timeout" }],
      },
    },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "app_control_job_timeout");
});

test("Realtime tool recall fails raw SDK tool events without wrapper telemetry", () => {
  const score = scoreCase(
    { expectedToolNames: ["share_existing_app_window"] },
    {
      calls: ["share_existing_app_window"],
      assistantText: "",
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        sdkConnected: true,
        meetSurface: {
          hasSDKGlobal: false,
          sdkSuppressedOnMeetSurface: true,
        },
        rawSdkToolEvents: [{ name: "share_existing_app_window", callId: "call_share" }],
        wrapperTelemetry: [],
      },
    },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "raw_sdk_tool_event_without_wrapper_telemetry");
});

test("Realtime tool recall fails wrapper result without function_call_output evidence", () => {
  const score = scoreCase(
    { expectedToolNames: ["share_existing_app_window"] },
    {
      calls: ["share_existing_app_window"],
      assistantText: "",
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        sdkConnected: true,
        meetSurface: {
          hasSDKGlobal: false,
          sdkSuppressedOnMeetSurface: true,
        },
        rawSdkToolEvents: [{ name: "share_existing_app_window", callId: "call_share" }],
        wrapperTelemetry: [
          {
            name: "share_existing_app_window",
            callId: "call_share",
            hasResult: true,
          },
        ],
        functionCallOutputDelivery: { delivered: false, producedToolResult: true },
      },
    },
  );

  assert.equal(score.ok, false);
  assert.equal(score.reason, "function_call_output_missing");
});

test("Realtime tool recall passes sidecar telemetry with wrapper and output evidence", () => {
  const score = scoreCase(
    { expectedToolNames: ["share_existing_app_window"] },
    {
      calls: ["share_existing_app_window"],
      assistantText: "",
      bridgeRuntime: {
        runtimePlacement: "sidecar",
        sdkConnected: true,
        requireStrictCsp: true,
        meetSurface: {
          hasSDKGlobal: false,
          sdkSuppressedOnMeetSurface: true,
          strictCspEnforced: true,
        },
        rawSdkToolEvents: [{ name: "share_existing_app_window", callId: "call_share" }],
        wrapperTelemetry: [
          {
            name: "share_existing_app_window",
            callId: "call_share",
            hasResult: true,
          },
        ],
        functionCallOutputDelivery: { delivered: true, producedToolResult: true },
      },
    },
  );

  assert.equal(score.ok, true);
  assert.equal(score.reason, "expected_tool_called");
});

test("Realtime benchmark lock serializes concurrent local runs", async () => {
  const tempDir = await mkdtemp(pathJoin(tmpdir(), "oneesama-realtime-lock-test-"));
  const previousLockDir = process.env.MAB_REALTIME_BENCHMARK_LOCK_DIR;
  const previousWaitMs = process.env.MAB_REALTIME_BENCHMARK_LOCK_WAIT_MS;
  const previousPollMs = process.env.MAB_REALTIME_BENCHMARK_LOCK_POLL_MS;
  process.env.MAB_REALTIME_BENCHMARK_LOCK_DIR = pathJoin(tempDir, "benchmark.lock");
  process.env.MAB_REALTIME_BENCHMARK_LOCK_WAIT_MS = "2000";
  process.env.MAB_REALTIME_BENCHMARK_LOCK_POLL_MS = "10";
  let active = 0;
  let maxActive = 0;
  try {
    const run = (label) =>
      withRealtimeBenchmarkLock(label, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return label;
      });
    assert.deepEqual((await Promise.all([run("first"), run("second")])).toSorted(), [
      "first",
      "second",
    ]);
    assert.equal(maxActive, 1);
  } finally {
    if (previousLockDir === undefined) delete process.env.MAB_REALTIME_BENCHMARK_LOCK_DIR;
    else process.env.MAB_REALTIME_BENCHMARK_LOCK_DIR = previousLockDir;
    if (previousWaitMs === undefined) delete process.env.MAB_REALTIME_BENCHMARK_LOCK_WAIT_MS;
    else process.env.MAB_REALTIME_BENCHMARK_LOCK_WAIT_MS = previousWaitMs;
    if (previousPollMs === undefined) delete process.env.MAB_REALTIME_BENCHMARK_LOCK_POLL_MS;
    else process.env.MAB_REALTIME_BENCHMARK_LOCK_POLL_MS = previousPollMs;
    await rm(tempDir, { recursive: true, force: true });
  }
});
