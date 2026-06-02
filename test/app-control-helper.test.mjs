import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "vite-plus/test";

async function callAppControlHelper(t, requests, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oneesama-app-control-helper-test-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "packages/core/src/meeting/app-control-helper.ts", "--stdio"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.env,
        ONEESAMA_APP_CONTROL_HELPER: join(dir, "helper"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  child.stdin.end();
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, 0, stderr.join(""));

  const lines = stdout.join("").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, requests.length);
  return lines.map((line) => JSON.parse(line));
}

test(
  "app-control helper serves stdio JSON-RPC on macOS",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      { jsonrpc: "2.0", id: "1", method: "list_apps", params: {} },
    ]);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, "1");
    assert.equal(response.result.ok, true);
    assert.ok(Array.isArray(response.result.applications));
  },
);

test(
  "app-control helper materializes native foreground cursor overlay",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "native-cursor",
          method: "app_control.native_cursor_overlay_probe",
          params: { kind: "click", label: "test-probe" },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_CURSOR_BOOTSTRAP_MS: "1",
          ONEESAMA_KWWK_CURSOR_PRE_MS: "1",
          ONEESAMA_KWWK_CURSOR_HOLD_MS: "1",
          ONEESAMA_KWWK_CURSOR_DWELL_MS: "1",
          ONEESAMA_KWWK_CURSOR_APPROACH_MS: "12",
          ONEESAMA_KWWK_CURSOR_APPROACH_STEP_MS: "4",
          ONEESAMA_KWWK_CURSOR_DRAG_MS: "12",
          ONEESAMA_KWWK_CURSOR_DRAG_STEP_MS: "4",
        },
      },
    );

    const evidence = response.result.nativeForegroundCursor;
    assert.equal(response.result.ok, true);
    assert.equal(evidence.schema, "oneesama.kwwk-native-foreground-cursor.v1");
    assert.equal(evidence.source, "cueboard_bridge_computer_use_port");
    assert.equal(evidence.evidenceMode, "native_ns_panel");
    assert.equal(evidence.materialized, true);
    assert.equal(evidence.visible, true);
    assert.equal(evidence.nonActivating, true);
    assert.equal(evidence.ignoresMouseEvents, true);
    assert.equal(evidence.transparent, true);
    assert.ok(evidence.windowNumber > 0);
    assert.equal(evidence.animation.style, "cueboard_style_ease_in_out");
    assert.equal(evidence.animation.approach.enabled, true);
    assert.ok(evidence.animation.approach.frameCount >= 2);
    assert.ok(evidence.animation.approach.pathLength > 0);
    assert.equal(evidence.animation.approach.easing, "arc_length_smoothstep");
    assert.equal(evidence.animation.approach.pathPlanner, "cueboard_action_overlay_bezier");
    assert.equal(
      evidence.animation.approach.pathPlannerSource,
      "bridge/cueboard/ActionOverlayBezierPath.swift",
    );
    assert.equal(
      evidence.animation.approach.bezier.schema,
      "oneesama.kwwk-cueboard-bezier-plan.v1",
    );
    assert.equal(evidence.animation.approach.bezier.planner, "cueboard_action_overlay_bezier");
    assert.equal(evidence.animation.approach.bezier.controlPointCount, 5);
    assert.ok(evidence.animation.approach.bezier.sampleCount >= 2);
    assert.equal(evidence.animation.approach.bezier.turnBound.passed, true);
    assert.ok(evidence.animation.approach.bezier.candidatePool.total > 0);
  },
);

test(
  "app-control helper deterministically plans common KWWK instructions",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const responses = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "tab-next",
        method: "app_control.plan_instruction",
        params: { instruction: "让他切换 tab" },
      },
      {
        jsonrpc: "2.0",
        id: "tab-prev",
        method: "app_control.plan_instruction",
        params: { instruction: "切到上一个标签页" },
      },
      {
        jsonrpc: "2.0",
        id: "type",
        method: "app_control.plan_instruction",
        params: { instruction: "输入 hello" },
      },
      {
        jsonrpc: "2.0",
        id: "refresh",
        method: "app_control.plan_instruction",
        params: { instruction: "刷新页面" },
      },
      {
        jsonrpc: "2.0",
        id: "enter",
        method: "app_control.plan_instruction",
        params: { instruction: "按回车确认" },
      },
      {
        jsonrpc: "2.0",
        id: "escape",
        method: "app_control.plan_instruction",
        params: { instruction: "关闭弹窗" },
      },
      {
        jsonrpc: "2.0",
        id: "scroll",
        method: "app_control.plan_instruction",
        params: { instruction: "滚动一下" },
      },
      {
        jsonrpc: "2.0",
        id: "search",
        method: "app_control.plan_instruction",
        params: { instruction: "搜索 oneesama", target: { applicationName: "Chrome" } },
      },
      {
        jsonrpc: "2.0",
        id: "observe",
        method: "app_control.plan_instruction",
        params: { instruction: "看一下当前状态" },
      },
      {
        jsonrpc: "2.0",
        id: "observe-title-report",
        method: "app_control.plan_instruction",
        params: {
          instruction:
            "Observe the currently shared browser window and report the visible page title or blocker. Do not type, click, navigate, or change the page.",
        },
      },
    ]);

    const byId = new Map(responses.map((response) => [response.id, response.result]));
    assert.deepEqual(byId.get("tab-next").operations, [{ kind: "press_key", key: "control+tab" }]);
    assert.deepEqual(byId.get("tab-prev").operations, [
      { kind: "press_key", key: "control+shift+tab" },
    ]);
    assert.deepEqual(byId.get("type").operations, [{ kind: "type_text", text: "hello" }]);
    assert.deepEqual(byId.get("refresh").operations, [{ kind: "press_key", key: "command+r" }]);
    assert.deepEqual(byId.get("enter").operations, [{ kind: "press_key", key: "return" }]);
    assert.deepEqual(byId.get("escape").operations, [{ kind: "press_key", key: "escape" }]);
    assert.deepEqual(byId.get("scroll").operations, [{ kind: "scroll", direction: "down" }]);
    assert.deepEqual(byId.get("search").operations, [
      { kind: "press_key", key: "command+l" },
      { kind: "type_text", text: "oneesama" },
      { kind: "press_key", key: "return" },
    ]);
    assert.deepEqual(byId.get("observe").operations, [{ kind: "state" }]);
    assert.deepEqual(byId.get("observe-title-report").operations, [{ kind: "state" }]);
    for (const result of byId.values()) {
      assert.equal(result.ok, true);
      assert.equal(result.planner.provider, "deterministic");
      assert.equal(result.planner.modelUsed, false);
      assert.equal(typeof result.planner.normalizeMs, "number");
      assert.deepEqual(
        result.planner.actionKinds,
        result.operations.map((operation) => operation.kind),
      );
    }
  },
);

test(
  "app-control helper blocks unsupported deterministic plans",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "unsupported",
        method: "app_control.plan_instruction",
        params: { instruction: "讲个笑话" },
      },
    ]);
    assert.equal(response.result.ok, false);
    assert.equal(response.result.status, "blocked");
    assert.equal(response.result.blocker, "instruction_not_directly_executable");
    assert.deepEqual(response.result.operations, []);
  },
);

test(
  "app-control helper maps Realtime labeled target wording to observed AX buttons",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const responses = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "labelled-click",
        method: "app_control.plan_instruction",
        params: {
          instruction:
            'Click the visible target labeled "Chromium" in the currently shared Chrome window.',
          observation: {
            accessibilityTrusted: true,
            accessibility: [
              {
                role: "AXButton",
                label: "Reload",
                enabled: true,
                visible: true,
                frame: { x: 77, y: 46, width: 34, height: 34 },
              },
              {
                role: "AXPopUpButton",
                label: "Chromium",
                enabled: true,
                visible: true,
                frame: { x: 1403, y: 46, width: 34, height: 34 },
              },
            ],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: "colon-click",
        method: "app_control.plan_instruction",
        params: {
          instruction: "在当前共享的 Chrome 窗口里点击可见目标：Click Chromium。",
          observation: {
            accessibilityTrusted: true,
            accessibility: [
              {
                role: "AXButton",
                label: "Reload",
                enabled: true,
                visible: true,
                frame: { x: 77, y: 46, width: 34, height: 34 },
              },
              {
                role: "AXPopUpButton",
                label: "Chromium",
                enabled: true,
                visible: true,
                frame: { x: 1403, y: 46, width: 34, height: 34 },
              },
            ],
          },
        },
      },
    ]);

    for (const response of responses) {
      assert.equal(response.result.ok, true);
      assert.deepEqual(response.result.operations, [
        {
          kind: "click",
          targetLabel: "Chromium",
          targetRole: "AXPopUpButton",
          x: 1420,
          y: 63,
        },
      ]);
      assert.deepEqual(response.result.planner.actionKinds, ["click"]);
    }
  },
);

test(
  "app-control helper exposes optional planner model config without using it for deterministic plans",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "config",
          method: "app_control.plan_instruction",
          params: { instruction: "输入 hello" },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_PLANNER_PROVIDER: "openai",
          ONEESAMA_KWWK_PLANNER_MODEL: "gpt-5.3-codex-spark",
          ONEESAMA_KWWK_PLANNER_TIMEOUT_MS: "777",
          ONEESAMA_KWWK_PLANNER_MAX_ACTIONS: "4",
        },
      },
    );

    assert.equal(response.result.ok, true);
    assert.equal(response.result.planner.modelUsed, false);
    assert.deepEqual(response.result.planner.optionalModel, {
      provider: "openai",
      model: "gpt-5.3-codex-spark",
      timeoutMs: 777,
      maxActions: 4,
    });
  },
);

test(
  "app-control helper can use local optional planner operations behind validation",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "local-model",
          method: "app_control.plan_instruction",
          params: { instruction: "用小模型规划这个可见操作" },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_PLANNER_PROVIDER: "local",
          ONEESAMA_KWWK_PLANNER_MODEL: "tiny-planner-fixture",
          ONEESAMA_KWWK_PLANNER_LOCAL_PLAN_JSON: JSON.stringify({
            operations: [{ kind: "press_key", key: "return" }],
          }),
        },
      },
    );

    assert.equal(response.result.ok, true);
    assert.equal(response.result.planner.provider, "deterministic+local_model");
    assert.equal(response.result.planner.modelUsed, true);
    assert.equal(response.result.planner.modelName, "tiny-planner-fixture");
    assert.equal(typeof response.result.planner.modelLatencyMs, "number");
    assert.deepEqual(response.result.operations, [{ kind: "press_key", key: "return" }]);
    assert.deepEqual(response.result.planner.actionKinds, ["press_key"]);
  },
);

test(
  "app-control helper validates local optional planner operations before returning them",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "local-model-invalid",
          method: "app_control.plan_instruction",
          params: { instruction: "用小模型规划这个危险操作" },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_PLANNER_PROVIDER: "local",
          ONEESAMA_KWWK_PLANNER_MODEL: "tiny-planner-fixture",
          ONEESAMA_KWWK_PLANNER_LOCAL_PLAN_JSON: JSON.stringify({
            operations: [{ kind: "shell", command: "rm -rf /tmp/nope" }],
          }),
        },
      },
    );

    assert.equal(response.result.ok, false);
    assert.equal(response.result.status, "blocked");
    assert.equal(response.result.planner.modelUsed, true);
    assert.equal(response.result.planner.modelName, "tiny-planner-fixture");
    assert.equal(response.result.blocker, "unsupported_operation:shell");
    assert.deepEqual(response.result.operations, []);
  },
);

test(
  "app-control helper writes local planner trace artifacts outside SDK history",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const tracePath = join(tmpdir(), `oneesama-kwwk-plan-trace-${Date.now()}.json`);
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "trace-plan",
          method: "app_control.plan_instruction",
          params: {
            instruction: "输入 hello",
            traceOutput: tracePath,
          },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_PLANNER_PROVIDER: "local",
          ONEESAMA_KWWK_PLANNER_MODEL: "tiny-planner-fixture",
        },
      },
    );

    assert.equal(response.result.ok, true);
    assert.equal(response.result.traceArtifact, tracePath);
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    assert.equal(trace.schema, "oneesama.kwwk-app-control-trace.v1");
    assert.equal(trace.method, "app_control.plan_instruction");
    assert.equal(trace.planner.provider, "deterministic");
    assert.equal(trace.planner.modelUsed, false);
    assert.equal(trace.planner.optionalModel.provider, "local");
    assert.equal(trace.planner.optionalModel.model, "tiny-planner-fixture");
    assert.equal(trace.planner.validation.ok, true);
  },
);

test(
  "app-control helper validates planner/model operations before execution",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const responses = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "shell",
        method: "app_control.validate_plan",
        params: { operations: [{ kind: "shell", command: "rm -rf /tmp/nope" }] },
      },
      {
        jsonrpc: "2.0",
        id: "network",
        method: "app_control.validate_plan",
        params: { operations: [{ kind: "fetch_url", url: "https://example.test" }] },
      },
      {
        jsonrpc: "2.0",
        id: "filesystem",
        method: "app_control.validate_plan",
        params: { operations: [{ kind: "write_file", path: "/tmp/nope", content: "no" }] },
      },
      {
        jsonrpc: "2.0",
        id: "missing-text",
        method: "app_control.validate_plan",
        params: { operations: [{ kind: "type_text" }] },
      },
      {
        jsonrpc: "2.0",
        id: "missing-double-click-point",
        method: "app_control.validate_plan",
        params: { operations: [{ kind: "double_click", x: 10 }] },
      },
      {
        jsonrpc: "2.0",
        id: "valid",
        method: "app_control.validate_plan",
        params: { operations: [{ kind: "press_key", key: "return" }] },
      },
    ]);
    const byId = new Map(responses.map((response) => [response.id, response.result]));

    assert.equal(byId.get("shell").ok, false);
    assert.equal(byId.get("shell").blocker, "unsupported_operation:shell");
    assert.equal(byId.get("network").ok, false);
    assert.equal(byId.get("network").blocker, "unsupported_operation:fetch_url");
    assert.equal(byId.get("filesystem").ok, false);
    assert.equal(byId.get("filesystem").blocker, "unsupported_operation:write_file");
    assert.equal(byId.get("missing-text").ok, false);
    assert.equal(byId.get("missing-text").blocker, "type_text_requires_text");
    assert.equal(byId.get("missing-double-click-point").ok, false);
    assert.equal(byId.get("missing-double-click-point").blocker, "double_click_requires_x_y");
    assert.equal(byId.get("valid").ok, true);
    assert.deepEqual(byId.get("valid").validation.actionKinds, ["press_key"]);
  },
);

test(
  "app-control helper blocks over-budget planner/model operations",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "budget",
          method: "app_control.validate_plan",
          params: {
            operations: [
              { kind: "press_key", key: "tab" },
              { kind: "press_key", key: "tab" },
              { kind: "press_key", key: "tab" },
            ],
          },
        },
      ],
      { env: { ONEESAMA_KWWK_PLANNER_MAX_ACTIONS: "2" } },
    );

    assert.equal(response.result.ok, false);
    assert.equal(response.result.blocker, "planner_action_budget_exceeded");
    assert.equal(response.result.validation.maxActions, 2);
    assert.equal(response.result.validation.receivedActions, 3);
  },
);

test(
  "app-control helper resolves button targets from AX-like observation fixtures",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "second-button",
        method: "app_control.plan_instruction",
        params: {
          instruction: "点第二个按钮",
          observation: {
            accessibility: [
              { role: "button", label: "Cancel", frame: { x: 10, y: 20, width: 80, height: 30 } },
              { role: "button", label: "Send", frame: { x: 110, y: 20, width: 80, height: 30 } },
            ],
          },
        },
      },
    ]);

    assert.equal(response.result.ok, true);
    assert.deepEqual(response.result.operations, [
      {
        kind: "click",
        x: 150,
        y: 35,
        targetRole: "button",
        targetLabel: "Send",
      },
    ]);
    assert.deepEqual(response.result.planner.actionKinds, ["click"]);
  },
);

test(
  "app-control helper resolves double-click targets from AX-like observation fixtures",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "double-click-button",
        method: "app_control.plan_instruction",
        params: {
          instruction: "双击发送按钮",
          observation: {
            accessibility: [
              { role: "button", label: "发送", frame: { x: 80, y: 40, width: 120, height: 50 } },
            ],
          },
        },
      },
    ]);

    assert.equal(response.result.ok, true);
    assert.deepEqual(response.result.operations, [
      {
        kind: "double_click",
        x: 140,
        y: 65,
        targetRole: "button",
        targetLabel: "发送",
      },
    ]);
    assert.deepEqual(response.result.planner.actionKinds, ["double_click"]);
  },
);

test(
  "app-control helper resolves button targets from screenshot fallback fixtures",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "screenshot-button",
        method: "app_control.plan_instruction",
        params: {
          instruction: "点击发送按钮",
          observation: {
            screenshot: {
              elements: [
                {
                  role: "button",
                  label: "发送",
                  frame: { x: 200, y: 100, width: 120, height: 40 },
                },
              ],
            },
          },
        },
      },
    ]);

    assert.equal(response.result.ok, true);
    assert.deepEqual(response.result.operations, [
      {
        kind: "click",
        x: 260,
        y: 120,
        targetRole: "button",
        targetLabel: "发送",
      },
    ]);
  },
);

test(
  "app-control helper prefers AX elements over screenshot fallback elements",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "ax-before-screenshot",
        method: "app_control.plan_instruction",
        params: {
          instruction: "点击发送按钮",
          observation: {
            accessibility: [
              {
                role: "button",
                label: "发送",
                frame: { x: 40, y: 30, width: 100, height: 40 },
              },
            ],
            screenshot: {
              elements: [
                {
                  role: "button",
                  label: "发送截图诱饵",
                  frame: { x: 240, y: 120, width: 160, height: 40 },
                },
              ],
            },
          },
        },
      },
    ]);

    assert.equal(response.result.ok, true);
    assert.deepEqual(response.result.operations, [
      {
        kind: "click",
        x: 90,
        y: 50,
        targetRole: "button",
        targetLabel: "发送",
      },
    ]);
  },
);

test(
  "app-control helper blocks ambiguous button targets from AX-like fixtures",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "missing-second-button",
        method: "app_control.plan_instruction",
        params: {
          instruction: "点第二个按钮",
          observation: {
            accessibility: [
              { role: "button", label: "Only", frame: { x: 10, y: 20, width: 80, height: 30 } },
            ],
          },
        },
      },
    ]);

    assert.equal(response.result.ok, false);
    assert.equal(response.result.status, "blocked");
    assert.equal(response.result.blocker, "blocked_ambiguous_target");
    assert.deepEqual(response.result.operations, []);
  },
);

test(
  "app-control helper reports permission blockers before target ambiguity",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "permission-missing",
        method: "app_control.plan_instruction",
        params: {
          instruction: "点第二个按钮",
          observation: {
            accessibilityTrusted: false,
            permissionBlocker: "blocked_permission",
          },
        },
      },
    ]);

    assert.equal(response.result.ok, false);
    assert.equal(response.result.status, "blocked");
    assert.equal(response.result.blocker, "blocked_permission");
    assert.deepEqual(response.result.operations, []);
  },
);

test(
  "app-control helper routes complex multi-step tasks to the background agent lane",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "background",
        method: "app_control.plan_instruction",
        params: { instruction: "重新设计整个产品路线图并写一个实现计划" },
      },
    ]);

    assert.equal(response.result.ok, false);
    assert.equal(response.result.status, "needs_background_agent");
    assert.equal(response.result.blocker, "needs_background_agent");
    assert.deepEqual(response.result.operations, []);
  },
);
