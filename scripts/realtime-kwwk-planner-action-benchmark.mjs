#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_KWWK_PLANNER_ACTION_CASES = [
  {
    id: "next-tab-zh",
    instruction: "让他切换 tab",
    fixture: { kind: "browser-tabs", activeIndex: 0, titles: ["Inbox", "Docs"] },
    expectedOperations: [{ kind: "press_key", key: "control+tab" }],
  },
  {
    id: "previous-tab-zh",
    instruction: "切到上一个标签页",
    fixture: { kind: "browser-tabs", activeIndex: 1, titles: ["Inbox", "Docs"] },
    expectedOperations: [{ kind: "press_key", key: "control+shift+tab" }],
  },
  {
    id: "type-text-zh",
    instruction: "输入 hello",
    fixture: { kind: "text-input", value: "" },
    expectedOperations: [{ kind: "type_text", text: "hello" }],
  },
  {
    id: "browser-search-en",
    instruction: "search oneesama",
    target: { applicationName: "Chrome" },
    fixture: { kind: "browser-search", addressBar: "", submitted: false },
    expectedOperations: [
      { kind: "press_key", key: "command+l" },
      { kind: "type_text", text: "oneesama" },
      { kind: "press_key", key: "return" },
    ],
  },
  {
    id: "scroll-zh",
    instruction: "滚动一下",
    fixture: { kind: "scroll-view", scrollY: 0 },
    expectedOperations: [{ kind: "scroll", direction: "down", elementIndex: 0 }],
  },
  {
    id: "observe-zh",
    instruction: "看一下当前状态",
    fixture: { kind: "observe", observed: false },
    expectedOperations: [{ kind: "state" }],
  },
  {
    id: "observe-title-report-en",
    instruction:
      "Observe the currently shared browser window and report the visible page title or blocker. Do not type, click, navigate, or change the page.",
    fixture: { kind: "observe", observed: false },
    expectedOperations: [{ kind: "state" }],
  },
  {
    id: "second-button-fixture",
    instruction: "点第二个按钮",
    observation: {
      accessibility: [
        { role: "button", label: "Cancel", frame: { x: 10, y: 20, width: 80, height: 30 } },
        { role: "button", label: "Send", frame: { x: 110, y: 20, width: 80, height: 30 } },
      ],
    },
    fixture: { kind: "button-grid", clickedLabel: "" },
    expectedOperations: [
      { kind: "click", x: 150, y: 35, targetRole: "button", targetLabel: "Send" },
    ],
  },
  {
    id: "screenshot-button-fallback-fixture",
    instruction: "点击发送按钮",
    observation: {
      screenshot: {
        elements: [
          { role: "button", label: "发送", frame: { x: 200, y: 100, width: 120, height: 40 } },
        ],
      },
    },
    fixture: { kind: "button-grid", clickedLabel: "" },
    expectedOperations: [
      { kind: "click", x: 260, y: 120, targetRole: "button", targetLabel: "发送" },
    ],
  },
  {
    id: "double-click-button-fixture",
    instruction: "双击发送按钮",
    observation: {
      accessibility: [
        { role: "button", label: "发送", frame: { x: 80, y: 40, width: 120, height: 50 } },
      ],
    },
    fixture: { kind: "button-grid", clickedLabel: "" },
    expectedOperations: [
      { kind: "double_click", x: 140, y: 65, targetRole: "button", targetLabel: "发送" },
    ],
  },
  {
    id: "ax-preferred-over-screenshot-fixture",
    instruction: "点击发送按钮",
    observation: {
      accessibility: [
        { role: "button", label: "发送", frame: { x: 40, y: 30, width: 100, height: 40 } },
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
    fixture: { kind: "button-grid", clickedLabel: "" },
    expectedOperations: [
      { kind: "click", x: 90, y: 50, targetRole: "button", targetLabel: "发送" },
    ],
  },
  {
    id: "second-button-ambiguous-fixture",
    instruction: "点第二个按钮",
    observation: {
      accessibility: [
        { role: "button", label: "Only", frame: { x: 10, y: 20, width: 80, height: 30 } },
      ],
    },
    expectedOk: false,
    expectedBlocker: "blocked_ambiguous_target",
    expectedOperations: [],
    fixture: { kind: "button-grid", clickedLabel: "" },
  },
  {
    id: "permission-missing-fixture",
    instruction: "点第二个按钮",
    observation: {
      accessibilityTrusted: false,
      permissionBlocker: "blocked_permission",
    },
    expectedOk: false,
    expectedBlocker: "blocked_permission",
    expectedOperations: [],
    fixture: { kind: "permission-missing", attempted: false },
  },
  {
    id: "background-delegation",
    instruction: "重新设计整个产品路线图并写一个实现计划",
    expectedOk: false,
    expectedStatus: "needs_background_agent",
    expectedBlocker: "needs_background_agent",
    expectedOperations: [],
    fixture: { kind: "delegation", delegated: false },
  },
];

function parseArgs(argv) {
  const args = {
    jsonOut: "",
    timeoutMs: 30_000,
    includeLiveMacOSFixture: false,
    includeLiveBrowserFixture: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json-out") args.jsonOut = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--include-live-macos-fixture") args.includeLiveMacOSFixture = true;
    else if (arg === "--include-live-browser-fixture") args.includeLiveBrowserFixture = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 30_000;
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/realtime-kwwk-planner-action-benchmark.mjs [options]

Options:
  --timeout-ms <n>      Overall benchmark timeout (default: 30000)
  --include-live-macos-fixture
                        Also run a temporary native macOS fixture app verifier
  --include-live-browser-fixture
                        Also run a headed browser tab-title verifier
  --json-out <path>     Write structured report
`);
}

function sameOperation(left, right) {
  const leftKeys = Object.keys(left).toSorted();
  const rightKeys = Object.keys(right).toSorted();
  if (leftKeys.join("\n") !== rightKeys.join("\n")) return false;
  return leftKeys.every((key) => String(left[key]) === String(right[key]));
}

function cloneFixtureState(state) {
  return JSON.parse(JSON.stringify(state || { kind: "none" }));
}

function applyFixtureOperation(state, operation) {
  const kind = String(operation?.kind || "");
  if (state.kind === "browser-tabs" && kind === "press_key") {
    const key = String(operation.key || "");
    const length = Math.max(1, Array.isArray(state.titles) ? state.titles.length : 1);
    if (key === "control+tab") state.activeIndex = (Number(state.activeIndex || 0) + 1) % length;
    if (key === "control+shift+tab") {
      state.activeIndex = (Number(state.activeIndex || 0) - 1 + length) % length;
    }
    state.activeTitle = state.titles?.[state.activeIndex] || "";
  } else if (state.kind === "text-input" && kind === "type_text") {
    state.value = `${state.value || ""}${String(operation.text || "")}`;
  } else if (state.kind === "browser-search") {
    if (kind === "press_key" && operation.key === "command+l") state.addressBarFocused = true;
    if (kind === "type_text" && state.addressBarFocused)
      state.addressBar = String(operation.text || "");
    if (kind === "press_key" && operation.key === "return") state.submitted = true;
  } else if (state.kind === "scroll-view" && kind === "scroll") {
    state.scrollY = Number(state.scrollY || 0) + (operation.direction === "up" ? -120 : 120);
  } else if (state.kind === "observe" && kind === "state") {
    state.observed = true;
  } else if (state.kind === "button-grid" && (kind === "click" || kind === "double_click")) {
    state.clickedLabel = String(operation.targetLabel || "");
    state.clicked = true;
  }
}

function verifyFixtureState(testCase, operations) {
  const preState = cloneFixtureState(testCase.fixture);
  const postState = cloneFixtureState(testCase.fixture);
  for (const operation of operations) applyFixtureOperation(postState, operation);
  let passed = true;
  let assertion = "no_state_change_required";
  let evidenceKinds = [];
  switch (postState.kind) {
    case "browser-tabs":
      assertion = "active_tab_changed";
      evidenceKinds = ["tab_title_changed"];
      passed = postState.activeIndex !== preState.activeIndex;
      break;
    case "text-input":
      assertion = "text_inserted";
      evidenceKinds = ["text_appeared"];
      passed = postState.value === "hello";
      break;
    case "browser-search":
      assertion = "search_submitted";
      evidenceKinds = ["focus_changed", "text_appeared", "button_state_changed"];
      passed = postState.addressBar === "oneesama" && postState.submitted === true;
      break;
    case "scroll-view":
      assertion = "scroll_position_changed";
      evidenceKinds = ["scroll_position_changed"];
      passed = Number(postState.scrollY) !== Number(preState.scrollY);
      break;
    case "observe":
      assertion = "state_observed";
      evidenceKinds = ["explicit_observation"];
      passed = postState.observed === true;
      break;
    case "button-grid": {
      assertion = testCase.expectedOk === false ? "blocked_before_click" : "button_clicked";
      evidenceKinds =
        testCase.expectedOk === false ? ["explicit_blocker"] : ["button_state_changed"];
      const expectedLabel = String(testCase.expectedOperations?.[0]?.targetLabel || "Send");
      passed =
        testCase.expectedOk === false
          ? postState.clicked !== true
          : postState.clickedLabel === expectedLabel;
      break;
    }
    case "delegation":
      assertion = "delegated_without_fixture_mutation";
      evidenceKinds = ["explicit_blocker"];
      passed =
        testCase.expectedStatus === "needs_background_agent" && postState.delegated === false;
      break;
    case "permission-missing":
      assertion = "permission_blocked_without_action";
      evidenceKinds = ["explicit_blocker"];
      passed = testCase.expectedBlocker === "blocked_permission" && postState.attempted === false;
      break;
  }
  return {
    mode: "fixture",
    liveApp: false,
    passed,
    assertion,
    evidenceKinds,
    preState,
    postState,
  };
}

function modelPlanForCase(testCase) {
  const status = testCase.expectedStatus || (testCase.expectedOk === false ? "blocked" : "planned");
  const blocker =
    testCase.expectedBlocker ||
    (status === "needs_background_agent" ? "needs_background_agent" : "");
  return {
    status,
    summary: `fixture model plan for ${testCase.id}`,
    blocker,
    operations: testCase.expectedOperations || [],
  };
}

const LIVE_MACOS_FIXTURE_CASES = [
  {
    id: "live-native-tab-switch",
    instruction: "让他切换 tab",
    assertion: "tab_title_changed",
    evidenceKinds: ["tab_title_changed"],
  },
  {
    id: "live-native-type-text",
    instruction: "输入 hello",
    assertion: "text_inserted",
    evidenceKinds: ["text_appeared", "focused_element_text"],
  },
];

function liveFixtureSwiftSource() {
  return String.raw`
import AppKit
import Foundation

final class FixtureController: NSObject, NSTextFieldDelegate {
  private var window: NSWindow!
  private var textField: NSTextField!
  private var monitor: Any?
  private var tabIndex = 0
  private let titles = ["KWWK Fixture One", "KWWK Fixture Two"]
  private let statePath = ProcessInfo.processInfo.environment["KWWK_FIXTURE_STATE_PATH"] ?? "/tmp/oneesama-kwwk-fixture-state.json"

  func start() {
    writePayload(["ready": false, "phase": "starting", "processId": Int(getpid())])
    let content = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 220))
    let label = NSTextField(labelWithString: "KWWK planner/action live fixture")
    label.frame = NSRect(x: 24, y: 154, width: 390, height: 24)
    textField = NSTextField(frame: NSRect(x: 24, y: 104, width: 390, height: 32))
    textField.placeholderString = "typed text appears here"
    textField.delegate = self
    content.addSubview(label)
    content.addSubview(textField)
    window = NSWindow(
      contentRect: NSRect(x: 160, y: 160, width: 460, height: 220),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    window.title = titles[tabIndex]
    window.contentView = content
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    window.makeFirstResponder(textField)
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
      guard let self else { return event }
      if event.keyCode == 48 && event.modifierFlags.contains(.control) {
        self.tabIndex = (self.tabIndex + 1) % self.titles.count
        self.window.title = self.titles[self.tabIndex]
        self.writeState()
        return nil
      }
      if event.keyCode == 9 && event.modifierFlags.contains(.command) {
        let pasted = NSPasteboard.general.string(forType: .string) ?? ""
        if !pasted.isEmpty {
          self.textField.stringValue = "\(self.textField.stringValue)\(pasted)"
          self.writeState()
        }
        return nil
      }
      return event
    }
    writeState()
  }

  func controlTextDidChange(_ notification: Notification) {
    writeState()
  }

  private func writeState() {
    let payload: [String: Any] = [
      "ready": true,
      "phase": "ready",
      "processId": Int(getpid()),
      "windowTitle": window?.title ?? "",
      "activeTabIndex": tabIndex,
      "text": textField?.stringValue ?? "",
      "focusedElement": "textField",
      "updatedAt": Int(Date().timeIntervalSince1970 * 1000)
    ]
    writePayload(payload)
  }

  private func writePayload(_ payload: [String: Any]) {
    do {
      let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
      try data.write(to: URL(fileURLWithPath: statePath), options: [.atomic])
    } catch {
      fputs("fixture_state_write_failed:\(error)\n", stderr)
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let controller = FixtureController()
controller.start()
app.run()
`;
}

async function compileSwiftFixture(dir) {
  const sourcePath = join(dir, "KWWKPlannerLiveFixture.swift");
  const binaryPath = join(dir, "KWWKPlannerLiveFixture");
  await writeFile(sourcePath, liveFixtureSwiftSource());
  const compile = spawn("/usr/bin/swiftc", [
    sourcePath,
    "-module-cache-path",
    join(tmpdir(), "oneesama-swift-module-cache"),
    "-o",
    binaryPath,
  ]);
  let stderr = "";
  compile.stderr.setEncoding("utf8");
  compile.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise((resolve) => {
    compile.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) {
    throw new Error(
      `fixture_compile_failed:${exit.code ?? exit.signal ?? "unknown"}:${stderr.trim()}`,
    );
  }
  return binaryPath;
}

async function readJSONFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function waitForFixtureState(statePath, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const state = await readJSONFile(statePath);
      lastState = state;
      if (!predicate || predicate(state)) return state;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(
    `fixture_state_timeout:${lastError}:last_state=${lastState ? JSON.stringify(lastState) : "none"}`,
  );
}

async function callHelperForLiveFixture(helper, request) {
  helper.stdin.write(`${JSON.stringify(request)}\n`);
  const line = await helper.nextLine();
  const response = JSON.parse(line);
  if (response.error) {
    throw new Error(`helper_error:${response.error.message || "unknown"}`);
  }
  return response.result || {};
}

async function spawnHelper(dir) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "packages/core/src/meeting/app-control-helper.ts", "--stdio"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        ONEESAMA_APP_CONTROL_HELPER: join(dir, "helper"),
        ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
        ONEESAMA_KWWK_CU_PLANNER_MODEL: "tiny-planner-action-fixture",
        ONEESAMA_KWWK_CURSOR_BOOTSTRAP_MS: "1",
        ONEESAMA_KWWK_CURSOR_PRE_MS: "1",
        ONEESAMA_KWWK_CURSOR_HOLD_MS: "1",
        ONEESAMA_KWWK_CURSOR_DWELL_MS: "1",
        ONEESAMA_KWWK_CURSOR_APPROACH_MS: "12",
        ONEESAMA_KWWK_CURSOR_APPROACH_STEP_MS: "4",
        ONEESAMA_KWWK_CURSOR_DRAG_MS: "12",
        ONEESAMA_KWWK_CURSOR_DRAG_STEP_MS: "4",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() || "";
    lines.push(...parts.filter(Boolean));
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    stdin: child.stdin,
    async nextLine(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const line = lines.shift();
        if (line) return line;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`helper_stdout_timeout:${stderr.trim()}`);
    },
    async close() {
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function runLiveMacOSFixture(args) {
  const started = performance.now();
  if (process.platform !== "darwin") {
    return {
      ok: false,
      skipped: true,
      blocker: "app_control_helper_requires_darwin",
      cases: [],
      durationMs: 0,
    };
  }
  const dir = await mkdtemp(join(tmpdir(), "oneesama-kwwk-live-fixture-"));
  const statePath = join(dir, "state.json");
  let app;
  let helper;
  let appStderr = "";
  const cases = [];
  try {
    const binary = await compileSwiftFixture(dir);
    app = spawn(binary, [], {
      env: { ...process.env, KWWK_FIXTURE_STATE_PATH: statePath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    app.stderr.setEncoding("utf8");
    app.stderr.on("data", (chunk) => {
      appStderr += chunk;
    });
    await waitForFixtureState(
      statePath,
      (state) => {
        if (app.exitCode !== null || app.signalCode !== null) {
          throw new Error(`fixture_app_exited:${app.exitCode ?? app.signalCode ?? "unknown"}`);
        }
        return state.ready === true;
      },
      Math.min(args.timeoutMs, 8000),
    );
    helper = await spawnHelper(dir);
    for (const testCase of LIVE_MACOS_FIXTURE_CASES) {
      const preState = await readJSONFile(statePath);
      const result = await callHelperForLiveFixture(helper, {
        jsonrpc: "2.0",
        id: testCase.id,
        method: "kwwk.cu.execute",
        params: {
          instruction: testCase.instruction,
          modelPlan: modelPlanForCase({
            id: testCase.id,
            expectedOperations:
              testCase.id === "live-native-tab-switch"
                ? [{ kind: "press_key", key: "control+tab" }]
                : [{ kind: "type_text", text: "hello" }],
          }),
          target: {
            processId: app.pid,
            applicationName: "KWWKPlannerLiveFixture",
          },
        },
      });
      let postState;
      try {
        postState = await waitForFixtureState(
          statePath,
          (state) => {
            if (testCase.id === "live-native-tab-switch") {
              return Number(state.activeTabIndex || 0) !== Number(preState.activeTabIndex || 0);
            }
            if (testCase.id === "live-native-type-text") {
              return String(state.text || "").includes("hello");
            }
            return true;
          },
          5000,
        );
      } catch (error) {
        const lastState = await readJSONFile(statePath).catch(() => ({}));
        cases.push({
          id: testCase.id,
          ok: false,
          instruction: testCase.instruction,
          assertion: testCase.assertion,
          evidenceKinds: testCase.evidenceKinds,
          realAppExecution: true,
          preState,
          postState: lastState,
          actions: result.actions || [],
          operations: result.operations || [],
          timings: result.metadata?.timings || {},
          blocker: error?.message || String(error),
        });
        throw error;
      }
      const passed =
        result.ok === true &&
        (testCase.id === "live-native-tab-switch"
          ? Number(postState.activeTabIndex || 0) !== Number(preState.activeTabIndex || 0)
          : String(postState.text || "").includes("hello"));
      cases.push({
        id: testCase.id,
        ok: passed,
        instruction: testCase.instruction,
        assertion: testCase.assertion,
        evidenceKinds: testCase.evidenceKinds,
        realAppExecution: true,
        preState,
        postState,
        actions: result.actions || [],
        operations: result.operations || [],
        timings: result.metadata?.timings || {},
        blocker: passed ? "" : result.blocker || "live_macos_fixture_post_state_mismatch",
      });
    }
    return {
      ok: cases.every((testCase) => testCase.ok),
      skipped: false,
      blocker: "",
      durationMs: Math.round(performance.now() - started),
      cases,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      blocker: `${error?.message || String(error)}${
        app ? `:fixture_app_exit=${app.exitCode ?? app.signalCode ?? "running"}` : ""
      }${appStderr.trim() ? `:${appStderr.trim()}` : ""}`,
      durationMs: Math.round(performance.now() - started),
      cases,
    };
  } finally {
    if (helper) await helper.close().catch(() => {});
    if (app && !app.killed) app.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runLiveBrowserFixture() {
  const started = performance.now();
  if (process.platform !== "darwin") {
    return {
      ok: false,
      skipped: true,
      blocker: "app_control_helper_requires_darwin",
      cases: [],
      durationMs: 0,
    };
  }
  const dir = await mkdtemp(join(tmpdir(), "oneesama-kwwk-live-browser-"));
  let browser;
  let helper;
  const cases = [];
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: false, args: ["--new-window"] });
    const context = await browser.newContext();
    const firstPage = await context.newPage();
    await firstPage.goto("data:text/html,<title>KWWK Browser One</title><h1>one</h1>");
    const secondPage = await context.newPage();
    await secondPage.goto("data:text/html,<title>KWWK Browser Two</title><h1>two</h1>");
    await firstPage.bringToFront();
    await firstPage.waitForTimeout(500);

    helper = await spawnHelper(dir);
    const applicationName =
      process.env.ONEESAMA_KWWK_LIVE_BROWSER_APPLICATION || "Google Chrome for Testing";
    const target = { applicationName, windowTitle: "KWWK Browser" };
    const preObserve = await callHelperForLiveFixture(helper, {
      jsonrpc: "2.0",
      id: "live-browser-observe-before",
      method: "kwwk.cu.execute",
      params: {
        instruction: "看一下当前状态",
        modelPlan: modelPlanForCase({
          id: "live-browser-observe-before",
          expectedOperations: [{ kind: "state" }],
        }),
        target,
      },
    });
    const preTitle = String(preObserve.metadata?.state?.window?.title || "");
    const action = await callHelperForLiveFixture(helper, {
      jsonrpc: "2.0",
      id: "live-browser-tab-switch",
      method: "kwwk.cu.execute",
      params: {
        instruction: "让他切换 tab",
        modelPlan: modelPlanForCase({
          id: "live-browser-tab-switch",
          expectedOperations: [{ kind: "press_key", key: "control+tab" }],
        }),
        target,
      },
    });
    await firstPage.waitForTimeout(500);
    const postObserve = await callHelperForLiveFixture(helper, {
      jsonrpc: "2.0",
      id: "live-browser-observe-after",
      method: "kwwk.cu.execute",
      params: {
        instruction: "看一下当前状态",
        modelPlan: modelPlanForCase({
          id: "live-browser-observe-after",
          expectedOperations: [{ kind: "state" }],
        }),
        target,
      },
    });
    const postTitle = String(postObserve.metadata?.state?.window?.title || "");
    const passed =
      preTitle.includes("KWWK Browser One") &&
      postTitle.includes("KWWK Browser Two") &&
      action.ok === true &&
      (action.operations || []).some(
        (operation) => operation?.kind === "press_key" && operation?.key === "control+tab",
      );
    cases.push({
      id: "live-browser-tab-switch",
      ok: passed,
      instruction: "让他切换 tab",
      assertion: "browser_tab_title_changed",
      evidenceKinds: ["browser_window_title_changed", "helper_observed_window_title"],
      realAppExecution: true,
      browserApplicationName: applicationName,
      preState: {
        windowTitle: preTitle,
        observedWindow: preObserve.metadata?.state?.window || {},
      },
      postState: {
        windowTitle: postTitle,
        observedWindow: postObserve.metadata?.state?.window || {},
      },
      actions: action.actions || [],
      operations: action.operations || [],
      timings: action.metadata?.timings || {},
      blocker: passed ? "" : action.blocker || "live_browser_tab_title_mismatch",
    });
    return {
      ok: cases.every((testCase) => testCase.ok),
      skipped: false,
      blocker: "",
      durationMs: Math.round(performance.now() - started),
      cases,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      blocker: error?.message || String(error),
      durationMs: Math.round(performance.now() - started),
      cases,
    };
  } finally {
    if (helper) await helper.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function actionTelemetryFromOperations(operations, source = "fixture_plan") {
  return operations.map((operation) => {
    const kind = String(operation?.kind || "");
    const target = {};
    for (const key of ["targetRole", "targetLabel", "key", "direction"]) {
      if (operation?.[key] !== undefined && String(operation[key] || "").trim()) {
        target[key] = String(operation[key]);
      }
    }
    for (const key of ["x", "y", "from_x", "from_y", "to_x", "to_y"]) {
      if (Number.isFinite(Number(operation?.[key]))) target[key] = Number(operation[key]);
    }
    if (kind === "type_text") target.textLength = String(operation?.text || "").length;
    return {
      kind,
      target,
      durationMs: Number(operation?.durationMs || 0),
      success: true,
      source,
    };
  });
}

function latencySegmentsFromResult(result, actionTelemetry) {
  const timings = result?.metadata?.timings || {};
  const normalizeMs = Number(result?.planner?.normalizeMs || timings.normalizeMs || 0);
  const planMs = Number(timings.planMs ?? result?.planner?.latencyMs ?? normalizeMs);
  const executeMs = Number(
    timings.executeMs ??
      actionTelemetry.reduce((total, entry) => total + Number(entry.durationMs || 0), 0),
  );
  return {
    schema: "oneesama.kwwk-app-control-timings.v1",
    normalizeMs: Number.isFinite(normalizeMs) ? normalizeMs : 0,
    observeMs: Number.isFinite(Number(timings.observeMs)) ? Number(timings.observeMs) : 0,
    planMs: Number.isFinite(planMs) ? planMs : 0,
    executeMs: Number.isFinite(executeMs) ? executeMs : 0,
    verifyMs: Number.isFinite(Number(timings.verifyMs)) ? Number(timings.verifyMs) : 0,
    totalMs: Number.isFinite(Number(timings.totalMs)) ? Number(timings.totalMs) : 0,
    source: timings.schema ? "helper_metadata" : "fixture_plan",
  };
}

export function evaluatePlannerActionCase(testCase, result) {
  const expectedOk = testCase.expectedOk !== false;
  const operations = Array.isArray(result?.operations) ? result.operations : [];
  const expectedOperations = testCase.expectedOperations || [];
  const operationsMatch =
    operations.length === expectedOperations.length &&
    operations.every((operation, index) => sameOperation(operation, expectedOperations[index]));
  const actionKinds = operations.map((operation) => String(operation.kind || ""));
  const expectedActionKinds = expectedOperations.map((operation) => String(operation.kind || ""));
  const planner = result?.planner || {};
  const actionTelemetry = Array.isArray(result?.metadata?.actionTelemetry)
    ? result.metadata.actionTelemetry
    : actionTelemetryFromOperations(operations);
  const latencySegments = latencySegmentsFromResult(result, actionTelemetry);
  const fixtureVerification = verifyFixtureState(testCase, operations);
  const statusMatch =
    !testCase.expectedStatus || String(result?.status || "") === String(testCase.expectedStatus);
  const modelFirst = String(planner.provider || "").startsWith("model_first_");
  const modelNamePresent = String(planner.modelName || "").trim().length > 0;
  const ok =
    result?.ok === expectedOk &&
    operationsMatch &&
    modelFirst &&
    planner.modelUsed === true &&
    modelNamePresent &&
    Array.isArray(planner.actionKinds) &&
    planner.actionKinds.join("\n") === actionKinds.join("\n") &&
    Number.isFinite(Number(planner.normalizeMs)) &&
    (expectedOk || String(result?.blocker || "") === String(testCase.expectedBlocker || "")) &&
    statusMatch &&
    fixtureVerification.passed;
  return {
    id: testCase.id,
    ok,
    instruction: testCase.instruction,
    expectedOperations,
    expectedOk,
    expectedBlocker: testCase.expectedBlocker || "",
    operations,
    actionTelemetry,
    latencySegments,
    actionKinds,
    expectedActionKinds,
    planner: {
      provider: planner.provider || "",
      modelUsed: planner.modelUsed === true,
      modelName: String(planner.modelName || ""),
      normalizeMs: Number(planner.normalizeMs || 0),
      modelLatencyMs: Number(planner.modelLatencyMs || 0),
      actionKinds: Array.isArray(planner.actionKinds) ? planner.actionKinds : [],
    },
    verifier: {
      mode: "fixture",
      operationsMatch,
      blockerMatch:
        expectedOk || String(result?.blocker || "") === String(testCase.expectedBlocker || ""),
      statusMatch,
      modelFirst,
      modelUsed: planner.modelUsed === true,
      modelNamePresent,
      state: fixtureVerification,
    },
    blocker: ok && statusMatch ? "" : "planner_action_fixture_mismatch",
  };
}

export function buildKWWKPlannerActionReport(args, runResult) {
  const cases = DEFAULT_KWWK_PLANNER_ACTION_CASES.map((testCase) =>
    evaluatePlannerActionCase(testCase, runResult.resultsById?.[testCase.id] || {}),
  );
  const includeLiveMacOSFixture = args.includeLiveMacOSFixture === true;
  const includeLiveBrowserFixture = args.includeLiveBrowserFixture === true;
  const liveMacOSFixture = runResult.liveMacOSFixture || {
    ok: false,
    skipped: !includeLiveMacOSFixture,
    blocker: includeLiveMacOSFixture ? "live_macos_fixture_missing" : "",
    cases: [],
    durationMs: 0,
  };
  const liveBrowserFixture = runResult.liveBrowserFixture || {
    ok: false,
    skipped: !includeLiveBrowserFixture,
    blocker: includeLiveBrowserFixture ? "live_browser_fixture_missing" : "",
    cases: [],
    durationMs: 0,
  };
  const liveEvidenceModes = [];
  if (includeLiveMacOSFixture) liveEvidenceModes.push("live_macos_fixture");
  if (includeLiveBrowserFixture) liveEvidenceModes.push("live_browser_fixture");
  const ok =
    runResult.ok === true &&
    cases.every((testCase) => testCase.ok) &&
    (!includeLiveMacOSFixture || liveMacOSFixture.ok === true) &&
    (!includeLiveBrowserFixture || liveBrowserFixture.ok === true);
  return {
    schema: "oneesama.kwwk-planner-action-report.v1",
    gate: "kwwk_planner_action",
    ok,
    generatedAt: new Date().toISOString(),
    evidenceMode:
      liveEvidenceModes.length > 0
        ? `model_first_helper_plan_fixture_and_${liveEvidenceModes.join("_and_")}`
        : "model_first_helper_plan_fixture",
    acceptanceGateScope: "kwwk_planner_action",
    backendProvider: "host_kwwk_app_control_helper_plan_instruction",
    meetRoomRequired: false,
    realAppExecution: includeLiveMacOSFixture || includeLiveBrowserFixture,
    timeoutMs: args.timeoutMs,
    durationMs: runResult.durationMs,
    timings: {
      totalMs: runResult.durationMs,
      helperRoundTripMs: runResult.durationMs,
      normalizeMs: cases.map((testCase) => testCase.planner.normalizeMs),
      observeMs: cases.map((testCase) => testCase.latencySegments.observeMs),
      planMs: cases.map((testCase) => testCase.latencySegments.planMs),
      executeMs: cases.map((testCase) => testCase.latencySegments.executeMs),
      verifyMs: cases.map((testCase) => testCase.latencySegments.verifyMs),
      actionDurationMs: cases.flatMap((testCase) =>
        testCase.actionTelemetry.map((entry) => Number(entry.durationMs || 0)),
      ),
    },
    environment: {
      platform: process.platform,
      upstreamAvailable: true,
    },
    cases,
    liveMacOSFixture,
    liveBrowserFixture,
    exitCode: runResult.exitCode,
    timedOut: runResult.timedOut === true,
    error: runResult.error || "",
  };
}

export async function runKWWKPlannerActionBenchmark(args) {
  const started = performance.now();
  if (process.platform !== "darwin") {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      error: "app_control_helper_requires_darwin",
      durationMs: Math.round(performance.now() - started),
      resultsById: {},
    };
  }
  const dir = await mkdtemp(join(tmpdir(), "oneesama-kwwk-planner-action-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "packages/core/src/meeting/app-control-helper.ts", "--stdio"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        ONEESAMA_APP_CONTROL_HELPER: join(dir, "helper"),
        ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
        ONEESAMA_KWWK_CU_PLANNER_MODEL: "tiny-planner-action-fixture",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), args.timeoutMs);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  for (const testCase of DEFAULT_KWWK_PLANNER_ACTION_CASES) {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: testCase.id,
        method: "kwwk.cu.plan",
        params: {
          instruction: testCase.instruction,
          target: testCase.target || {},
          observation: testCase.observation || {},
          modelPlan: modelPlanForCase(testCase),
        },
      })}\n`,
    );
  }
  child.stdin.end();
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const resultsById = {};
  for (const line of stdout.trim().split(/\r?\n/u).filter(Boolean)) {
    const response = JSON.parse(line);
    resultsById[response.id] = response.result || {};
  }
  const liveMacOSFixture = args.includeLiveMacOSFixture
    ? await runLiveMacOSFixture(args)
    : { ok: false, skipped: true, blocker: "", cases: [], durationMs: 0 };
  const liveBrowserFixture = args.includeLiveBrowserFixture
    ? await runLiveBrowserFixture(args)
    : { ok: false, skipped: true, blocker: "", cases: [], durationMs: 0 };
  return {
    ok:
      exit.code === 0 &&
      (!args.includeLiveMacOSFixture || liveMacOSFixture.ok === true) &&
      (!args.includeLiveBrowserFixture || liveBrowserFixture.ok === true),
    exitCode: exit.code,
    signal: exit.signal || "",
    timedOut: exit.signal === "SIGTERM",
    error: exit.code === 0 ? "" : stderr.trim() || "helper_failed",
    durationMs: Math.round(performance.now() - started),
    resultsById,
    liveMacOSFixture,
    liveBrowserFixture,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runResult = await runKWWKPlannerActionBenchmark(args);
  const report = buildKWWKPlannerActionReport(args, runResult);
  if (args.jsonOut) {
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `KWWK planner/action benchmark: ${report.ok ? "PASS" : "FAIL"} cases=${report.cases
      .map((testCase) => `${testCase.id}:${testCase.ok ? "pass" : "fail"}`)
      .join(",")}`,
  );
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`realtime-kwwk-planner-action-benchmark failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
