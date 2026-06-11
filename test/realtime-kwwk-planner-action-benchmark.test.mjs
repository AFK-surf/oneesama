import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vite-plus/test";

import {
  buildKWWKPlannerActionReport,
  evaluatePlannerActionCase,
} from "../scripts/realtime-kwwk-planner-action-benchmark.mjs";

test("KWWK planner/action gate scores deterministic fixture plans", () => {
  const testCase = {
    id: "type-text",
    instruction: "输入 hello",
    fixture: { kind: "text-input", value: "" },
    expectedOperations: [{ kind: "type_text", text: "hello" }],
  };
  const score = evaluatePlannerActionCase(testCase, {
    ok: true,
    operations: [{ kind: "type_text", text: "hello" }],
    planner: {
      provider: "model_first_local_fixture",
      modelUsed: true,
      modelName: "tiny-planner-action-fixture",
      normalizeMs: 1,
      modelLatencyMs: 0,
      actionKinds: ["type_text"],
    },
  });

  assert.equal(score.ok, true);
  assert.equal(score.verifier.operationsMatch, true);
  assert.equal(score.verifier.modelFirst, true);
  assert.equal(score.verifier.modelUsed, true);
  assert.equal(score.verifier.modelNamePresent, true);
  assert.equal(score.verifier.mode, "fixture");
  assert.equal(score.verifier.state.passed, true);
  assert.deepEqual(score.verifier.state.evidenceKinds, ["text_appeared"]);
  assert.deepEqual(score.verifier.state.preState, { kind: "text-input", value: "" });
  assert.deepEqual(score.verifier.state.postState, { kind: "text-input", value: "hello" });
  assert.deepEqual(score.actionTelemetry, [
    {
      kind: "type_text",
      target: { textLength: 5 },
      durationMs: 0,
      success: true,
      source: "fixture_plan",
    },
  ]);
  assert.deepEqual(score.latencySegments, {
    schema: "oneesama.kwwk-app-control-timings.v1",
    normalizeMs: 1,
    observeMs: 0,
    planMs: 1,
    executeMs: 0,
    verifyMs: 0,
    totalMs: 0,
    source: "fixture_plan",
  });
});

test("KWWK planner/action report is not backend or real-room evidence", () => {
  const expectedCaseCount = 14;
  const report = buildKWWKPlannerActionReport(
    { timeoutMs: 30_000 },
    {
      ok: true,
      exitCode: 0,
      durationMs: 12,
      resultsById: {
        "next-tab-zh": plan([{ kind: "press_key", key: "control+tab" }]),
        "previous-tab-zh": plan([{ kind: "press_key", key: "control+shift+tab" }]),
        "type-text-zh": plan([{ kind: "type_text", text: "hello" }]),
        "browser-search-en": plan([
          { kind: "press_key", key: "command+l" },
          { kind: "type_text", text: "oneesama" },
          { kind: "press_key", key: "return" },
        ]),
        "scroll-zh": plan([{ kind: "scroll", direction: "down", elementIndex: 0 }]),
        "observe-zh": plan([{ kind: "state" }]),
        "observe-title-report-en": plan([{ kind: "state" }]),
        "second-button-fixture": plan([
          { kind: "click", x: 150, y: 35, targetRole: "button", targetLabel: "Send" },
        ]),
        "screenshot-button-fallback-fixture": plan([
          { kind: "click", x: 260, y: 120, targetRole: "button", targetLabel: "发送" },
        ]),
        "double-click-button-fixture": plan([
          { kind: "double_click", x: 140, y: 65, targetRole: "button", targetLabel: "发送" },
        ]),
        "ax-preferred-over-screenshot-fixture": plan([
          { kind: "click", x: 90, y: 50, targetRole: "button", targetLabel: "发送" },
        ]),
        "second-button-ambiguous-fixture": blockedPlan("blocked_ambiguous_target"),
        "permission-missing-fixture": blockedPlan("blocked_permission"),
        "background-delegation": blockedPlan("needs_background_agent", "needs_background_agent"),
      },
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.gate, "kwwk_planner_action");
  assert.equal(report.acceptanceGateScope, "kwwk_planner_action");
  assert.equal(report.realAppExecution, false);
  assert.equal(report.meetRoomRequired, false);
  assert.equal(report.liveMacOSFixture.skipped, true);
  assert.equal(report.liveBrowserFixture.skipped, true);
  assert.deepEqual(report.timings.normalizeMs, Array(expectedCaseCount).fill(0));
  assert.deepEqual(report.timings.observeMs, Array(expectedCaseCount).fill(0));
  assert.deepEqual(report.timings.planMs, Array(expectedCaseCount).fill(0));
  assert.deepEqual(report.timings.executeMs, Array(expectedCaseCount).fill(0));
  assert.deepEqual(report.timings.verifyMs, Array(expectedCaseCount).fill(0));
  assert.ok(report.timings.actionDurationMs.every((durationMs) => durationMs === 0));
  assert.equal(
    report.cases.find((testCase) => testCase.id === "second-button-ambiguous-fixture").verifier
      .blockerMatch,
    true,
  );
  const permissionCase = report.cases.find(
    (testCase) => testCase.id === "permission-missing-fixture",
  );
  assert.equal(permissionCase.verifier.blockerMatch, true);
  assert.equal(permissionCase.verifier.state.assertion, "permission_blocked_without_action");
  assert.deepEqual(permissionCase.verifier.state.evidenceKinds, ["explicit_blocker"]);
  assert.equal(
    report.cases.find((testCase) => testCase.id === "background-delegation").verifier.statusMatch,
    true,
  );
  const typeCase = report.cases.find((testCase) => testCase.id === "type-text-zh");
  assert.equal(typeCase.verifier.state.assertion, "text_inserted");
  assert.deepEqual(typeCase.verifier.state.evidenceKinds, ["text_appeared"]);
  assert.equal(typeCase.verifier.state.liveApp, false);
  assert.equal(typeCase.verifier.state.postState.value, "hello");
  const tabCase = report.cases.find((testCase) => testCase.id === "next-tab-zh");
  assert.deepEqual(tabCase.verifier.state.evidenceKinds, ["tab_title_changed"]);
  const scrollCase = report.cases.find((testCase) => testCase.id === "scroll-zh");
  assert.equal(scrollCase.verifier.state.assertion, "scroll_position_changed");
  assert.deepEqual(scrollCase.verifier.state.evidenceKinds, ["scroll_position_changed"]);
  assert.notEqual(
    scrollCase.verifier.state.preState.scrollY,
    scrollCase.verifier.state.postState.scrollY,
  );
  const buttonCase = report.cases.find((testCase) => testCase.id === "second-button-fixture");
  assert.deepEqual(buttonCase.actionTelemetry[0], {
    kind: "click",
    target: { targetRole: "button", targetLabel: "Send", x: 150, y: 35 },
    durationMs: 0,
    success: true,
    source: "fixture_plan",
  });
  const screenshotCase = report.cases.find(
    (testCase) => testCase.id === "screenshot-button-fallback-fixture",
  );
  assert.equal(screenshotCase.verifier.state.assertion, "button_clicked");
  assert.deepEqual(screenshotCase.verifier.state.evidenceKinds, ["button_state_changed"]);
  assert.equal(screenshotCase.verifier.state.postState.clickedLabel, "发送");
  const doubleClickCase = report.cases.find(
    (testCase) => testCase.id === "double-click-button-fixture",
  );
  assert.deepEqual(doubleClickCase.operations[0], {
    kind: "double_click",
    x: 140,
    y: 65,
    targetRole: "button",
    targetLabel: "发送",
  });
  assert.deepEqual(doubleClickCase.actionTelemetry[0], {
    kind: "double_click",
    target: { targetRole: "button", targetLabel: "发送", x: 140, y: 65 },
    durationMs: 0,
    success: true,
    source: "fixture_plan",
  });
  const axPreferredCase = report.cases.find(
    (testCase) => testCase.id === "ax-preferred-over-screenshot-fixture",
  );
  assert.equal(axPreferredCase.verifier.state.postState.clickedLabel, "发送");
  assert.deepEqual(axPreferredCase.operations[0], {
    kind: "click",
    x: 90,
    y: 50,
    targetRole: "button",
    targetLabel: "发送",
  });
});

test("KWWK planner/action report can include optional live macOS fixture evidence", () => {
  const resultsById = {};
  for (const testCase of [
    ["next-tab-zh", [{ kind: "press_key", key: "control+tab" }]],
    ["previous-tab-zh", [{ kind: "press_key", key: "control+shift+tab" }]],
    ["type-text-zh", [{ kind: "type_text", text: "hello" }]],
    [
      "browser-search-en",
      [
        { kind: "press_key", key: "command+l" },
        { kind: "type_text", text: "oneesama" },
        { kind: "press_key", key: "return" },
      ],
    ],
    ["scroll-zh", [{ kind: "scroll", direction: "down", elementIndex: 0 }]],
    ["observe-zh", [{ kind: "state" }]],
    ["observe-title-report-en", [{ kind: "state" }]],
    [
      "second-button-fixture",
      [{ kind: "click", x: 150, y: 35, targetRole: "button", targetLabel: "Send" }],
    ],
    [
      "screenshot-button-fallback-fixture",
      [{ kind: "click", x: 260, y: 120, targetRole: "button", targetLabel: "发送" }],
    ],
    [
      "double-click-button-fixture",
      [{ kind: "double_click", x: 140, y: 65, targetRole: "button", targetLabel: "发送" }],
    ],
    [
      "ax-preferred-over-screenshot-fixture",
      [{ kind: "click", x: 90, y: 50, targetRole: "button", targetLabel: "发送" }],
    ],
  ]) {
    resultsById[testCase[0]] = plan(testCase[1]);
  }
  resultsById["second-button-ambiguous-fixture"] = blockedPlan("blocked_ambiguous_target");
  resultsById["permission-missing-fixture"] = blockedPlan("blocked_permission");
  resultsById["background-delegation"] = blockedPlan(
    "needs_background_agent",
    "needs_background_agent",
  );

  const report = buildKWWKPlannerActionReport(
    { timeoutMs: 30_000, includeLiveMacOSFixture: true },
    {
      ok: true,
      exitCode: 0,
      durationMs: 42,
      resultsById,
      liveMacOSFixture: {
        ok: true,
        skipped: false,
        blocker: "",
        durationMs: 10,
        cases: [
          {
            id: "live-native-tab-switch",
            ok: true,
            realAppExecution: true,
            assertion: "tab_title_changed",
            evidenceKinds: ["tab_title_changed"],
          },
          {
            id: "live-native-type-text",
            ok: true,
            realAppExecution: true,
            assertion: "text_inserted",
            evidenceKinds: ["text_appeared", "focused_element_text"],
          },
        ],
      },
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.realAppExecution, true);
  assert.equal(report.evidenceMode, "model_first_helper_plan_fixture_and_live_macos_fixture");
  assert.equal(report.liveMacOSFixture.skipped, false);
  assert.equal(report.liveMacOSFixture.cases.length, 2);
  assert.equal(report.liveBrowserFixture.skipped, true);
});

test("KWWK planner/action report can include optional live browser fixture evidence", () => {
  const resultsById = {};
  for (const testCase of [
    ["next-tab-zh", [{ kind: "press_key", key: "control+tab" }]],
    ["previous-tab-zh", [{ kind: "press_key", key: "control+shift+tab" }]],
    ["type-text-zh", [{ kind: "type_text", text: "hello" }]],
    [
      "browser-search-en",
      [
        { kind: "press_key", key: "command+l" },
        { kind: "type_text", text: "oneesama" },
        { kind: "press_key", key: "return" },
      ],
    ],
    ["scroll-zh", [{ kind: "scroll", direction: "down", elementIndex: 0 }]],
    ["observe-zh", [{ kind: "state" }]],
    ["observe-title-report-en", [{ kind: "state" }]],
    [
      "second-button-fixture",
      [{ kind: "click", x: 150, y: 35, targetRole: "button", targetLabel: "Send" }],
    ],
    [
      "screenshot-button-fallback-fixture",
      [{ kind: "click", x: 260, y: 120, targetRole: "button", targetLabel: "发送" }],
    ],
    [
      "double-click-button-fixture",
      [{ kind: "double_click", x: 140, y: 65, targetRole: "button", targetLabel: "发送" }],
    ],
    [
      "ax-preferred-over-screenshot-fixture",
      [{ kind: "click", x: 90, y: 50, targetRole: "button", targetLabel: "发送" }],
    ],
  ]) {
    resultsById[testCase[0]] = plan(testCase[1]);
  }
  resultsById["second-button-ambiguous-fixture"] = blockedPlan("blocked_ambiguous_target");
  resultsById["permission-missing-fixture"] = blockedPlan("blocked_permission");
  resultsById["background-delegation"] = blockedPlan(
    "needs_background_agent",
    "needs_background_agent",
  );

  const report = buildKWWKPlannerActionReport(
    { timeoutMs: 30_000, includeLiveBrowserFixture: true },
    {
      ok: true,
      exitCode: 0,
      durationMs: 12,
      resultsById,
      liveBrowserFixture: {
        ok: true,
        skipped: false,
        blocker: "",
        durationMs: 100,
        cases: [
          {
            id: "live-browser-tab-switch",
            ok: true,
            realAppExecution: true,
            assertion: "browser_tab_title_changed",
            evidenceKinds: ["browser_window_title_changed", "helper_observed_window_title"],
          },
        ],
      },
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.realAppExecution, true);
  assert.equal(report.evidenceMode, "model_first_helper_plan_fixture_and_live_browser_fixture");
  assert.equal(report.liveMacOSFixture.skipped, true);
  assert.equal(report.liveBrowserFixture.skipped, false);
  assert.equal(report.liveBrowserFixture.cases.length, 1);
});

test(
  "KWWK planner/action benchmark runs the helper fixture on macOS",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneesama-kwwk-planner-action-test-"));
    const jsonOut = join(dir, "report.json");
    try {
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/realtime-kwwk-planner-action-benchmark.mjs",
          "--json-out",
          jsonOut,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, ONEESAMA_APP_CONTROL_HELPER: join(dir, "helper") },
        },
      );
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const report = JSON.parse(await readFile(jsonOut, "utf8"));
      assert.equal(report.ok, true);
      assert.equal(report.gate, "kwwk_planner_action");
      assert.equal(report.cases.length, 14);
      assert.ok(report.cases.every((testCase) => testCase.planner.modelUsed === true));
      assert.ok(
        report.cases.every((testCase) =>
          String(testCase.planner.provider || "").startsWith("model_first_"),
        ),
      );
      assert.ok(report.cases.every((testCase) => testCase.verifier.operationsMatch === true));
      assert.ok(report.cases.every((testCase) => testCase.verifier.mode === "fixture"));
      assert.ok(report.cases.every((testCase) => testCase.verifier.state.passed === true));
      assert.ok(report.cases.every((testCase) => Array.isArray(testCase.actionTelemetry)));
      assert.ok(
        report.cases.every((testCase) => testCase.latencySegments?.source === "fixture_plan"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

function plan(operations) {
  return {
    ok: true,
    operations,
    planner: {
      provider: "model_first_local_fixture",
      modelUsed: true,
      modelName: "tiny-planner-action-fixture",
      normalizeMs: 0,
      modelLatencyMs: 0,
      actionKinds: operations.map((operation) => operation.kind),
    },
  };
}

function blockedPlan(blocker, status = "blocked") {
  return {
    ok: false,
    status,
    blocker,
    operations: [],
    planner: {
      provider: "model_first_local_fixture",
      modelUsed: true,
      modelName: "tiny-planner-action-fixture",
      normalizeMs: 0,
      modelLatencyMs: 0,
      actionKinds: [],
    },
  };
}
