/* eslint-disable max-lines */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "vite-plus/test";

const plannerEnvKeys = [
  "ONEESAMA_KWWK_CU_PLANNER_PROVIDER",
  "ONEESAMA_KWWK_PLANNER_PROVIDER",
  "MAB_KWWK_CU_PLANNER_PROVIDER",
  "MAB_KWWK_PLANNER_PROVIDER",
  "ONEESAMA_KWWK_CU_PLANNER_MODEL",
  "ONEESAMA_KWWK_PLANNER_MODEL",
  "MAB_KWWK_CU_PLANNER_MODEL",
  "MAB_KWWK_PLANNER_MODEL",
  "ONEESAMA_KWWK_CU_PLANNER_REASONING_EFFORT",
  "ONEESAMA_KWWK_PLANNER_REASONING_EFFORT",
  "MAB_KWWK_CU_PLANNER_REASONING_EFFORT",
  "MAB_KWWK_PLANNER_REASONING_EFFORT",
  "ONEESAMA_KWWK_CU_PLANNER_SERVICE_TIER",
  "ONEESAMA_KWWK_PLANNER_SERVICE_TIER",
  "MAB_KWWK_CU_PLANNER_SERVICE_TIER",
  "MAB_KWWK_PLANNER_SERVICE_TIER",
];

async function callAppControlHelper(t, requests, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oneesama-app-control-helper-test-"));
  const env = { ...process.env };
  if (options.clearPlannerEnv) {
    for (const key of plannerEnvKeys) delete env[key];
  }
  if (options.fixturePlanner !== false) {
    env.ONEESAMA_KWWK_CU_PLANNER_PROVIDER = "local";
    env.ONEESAMA_KWWK_CU_PLANNER_MODEL = "tiny-app-control-helper-fixture";
  }
  Object.assign(env, options.env);
  env.ONEESAMA_APP_CONTROL_HELPER = join(dir, "helper");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "packages/core/src/meeting/app-control-helper.ts", "--stdio"],
    {
      cwd: process.cwd(),
      env,
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
  "app-control helper can prebuild the Swift helper binary without starting stdio",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneesama-app-control-helper-build-test-"));
    const report = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "packages/core/src/meeting/app-control-helper.ts",
          "--ensure-binary-json",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ONEESAMA_APP_CONTROL_HELPER: join(dir, "helper"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code !== 0) {
          reject(new Error(`ensure-binary-json exited ${code ?? signal}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout));
      });
    });

    assert.equal(report.ok, true);
    assert.equal(report.schema, "oneesama.app-control-helper-build.v1");
    assert.equal(report.current, true);
    assert.equal(report.sourceCount, 11);
    assert.match(report.binary, /helper$/);
    assert.equal(typeof report.durationMs, "number");
  },
);

test(
  "app-control helper exposes Cueboard-style CU control session lifecycle",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const responses = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "ping",
        method: "kwwk.cu.control",
        params: { control: "ping" },
      },
      {
        jsonrpc: "2.0",
        id: "permissions",
        method: "kwwk.cu.control",
        params: { control: "permissions-status" },
      },
      {
        jsonrpc: "2.0",
        id: "mode-help",
        method: "kwwk.cu.control",
        params: { control: "mode-help", mode: "foreground" },
      },
      {
        jsonrpc: "2.0",
        id: "planner-prewarm",
        method: "kwwk.cu.control",
        params: { control: "planner-prewarm" },
      },
      {
        jsonrpc: "2.0",
        id: "cursor-prewarm",
        method: "kwwk.cu.control",
        params: { control: "cursor-prewarm" },
      },
      {
        jsonrpc: "2.0",
        id: "status-before",
        method: "kwwk.cu.control",
        params: { control: "session-status" },
      },
      {
        jsonrpc: "2.0",
        id: "start",
        method: "kwwk.cu.control",
        params: {
          session: {
            op: "start",
            mode: "foreground",
            foreground: { apps: ["Chrome"], display: 1 },
          },
          session_id: "meet_session",
        },
      },
      {
        jsonrpc: "2.0",
        id: "status-running",
        method: "kwwk.cu.control",
        params: { control: "session-status" },
      },
      {
        jsonrpc: "2.0",
        id: "duplicate-start",
        method: "kwwk.cu.control",
        params: { session: { op: "start", mode: "background", background: {} } },
      },
      {
        jsonrpc: "2.0",
        id: "stop",
        method: "kwwk.cu.control",
        params: { session: { op: "stop" } },
      },
      {
        jsonrpc: "2.0",
        id: "status-after",
        method: "kwwk.cu.control",
        params: { control: "session-status" },
      },
    ]);
    const byId = new Map(responses.map((response) => [response.id, response.result]));

    assert.equal(byId.get("ping").schema, "oneesama.kwwk-cu-control.v1");
    assert.equal(byId.get("ping").source, "cueboard_bridge_computer_use_port");
    assert.equal(byId.get("ping").text, "pong");

    assert.equal(typeof byId.get("permissions").permissions.accessibilityTrusted, "boolean");
    assert.equal(typeof byId.get("permissions").permissions.screenRecordingTrusted, "boolean");
    assert.ok(Array.isArray(byId.get("permissions").permissions.missing));

    assert.equal(byId.get("mode-help").help.mode, "foreground");
    assert.ok(byId.get("mode-help").help.actions.includes("click"));
    assert.ok(byId.get("mode-help").help.foregroundActions.includes("get-app-state"));
    assert.ok(byId.get("mode-help").help.backgroundActions.includes("set-value"));

    assert.equal(byId.get("planner-prewarm").ok, true);
    assert.equal(byId.get("planner-prewarm").status, "ready");
    assert.equal(byId.get("planner-prewarm").planner.provider, "local");
    assert.equal(byId.get("planner-prewarm").planner.model, "tiny-app-control-helper-fixture");
    assert.equal(byId.get("planner-prewarm").planner.serviceTier, "");
    assert.equal(byId.get("planner-prewarm").plannerSchema.name, "kwwk_cu_plan");
    assert.equal(byId.get("planner-prewarm").plannerSchema.strict, true);
    assert.equal(byId.get("planner-prewarm").plannerSchema.valid, true);
    assert.ok(byId.get("planner-prewarm").plannerSchema.bytes > 0);
    assert.equal(byId.get("planner-prewarm").client.initialized, true);
    assert.equal(byId.get("planner-prewarm").modelPrewarm.ok, true);
    assert.equal(byId.get("planner-prewarm").modelPrewarm.modelUsed, true);
    assert.equal(byId.get("planner-prewarm").modelPrewarm.actionKinds.includes("press_key"), true);

    assert.equal(byId.get("cursor-prewarm").ok, true);
    assert.equal(byId.get("cursor-prewarm").status, "ready");
    assert.equal(byId.get("cursor-prewarm").nativeCursorPrewarm.preloaded, true);
    assert.equal(byId.get("cursor-prewarm").nativeCursorPrewarm.foregroundSessionStarted, false);
    assert.equal(byId.get("cursor-prewarm").nativeCursorPrewarm.materializedBeforeAction, false);
    assert.equal(byId.get("cursor-prewarm").nativeCursorPrewarm.renderSize, 28);
    assert.ok(byId.get("cursor-prewarm").nativeCursorPrewarm.hotspot.x > 0);
    assert.equal(
      byId.get("cursor-prewarm").nativeCursorPrewarm.bezier.planner,
      "cueboard_action_overlay_bezier",
    );

    assert.equal(byId.get("status-before").status, "idle");
    assert.equal(byId.get("status-before").mode, null);

    assert.equal(byId.get("start").ok, true);
    assert.equal(byId.get("start").status, "running");
    assert.equal(byId.get("start").text, "session started (mode=foreground)");
    assert.equal(byId.get("start").session.id, "meet_session");
    assert.equal(byId.get("start").session.mode, "foreground");
    assert.deepEqual(byId.get("start").session.foreground.apps, ["Chrome"]);
    assert.equal(byId.get("start").session.foreground.display, 1);
    assert.equal(typeof byId.get("start").session.startedAtMs, "number");

    assert.equal(byId.get("status-running").status, "running");
    assert.equal(byId.get("status-running").session.id, "meet_session");
    assert.equal(typeof byId.get("status-running").pid, "number");

    assert.equal(byId.get("duplicate-start").ok, false);
    assert.equal(byId.get("duplicate-start").status, "blocked");
    assert.equal(byId.get("duplicate-start").blocker, "session_already_active");
    assert.equal(byId.get("duplicate-start").session.id, "meet_session");

    assert.equal(byId.get("stop").ok, true);
    assert.equal(byId.get("stop").status, "stopped");
    assert.equal(byId.get("stop").session.id, "meet_session");

    assert.equal(byId.get("status-after").status, "idle");
    assert.equal(byId.get("status-after").mode, null);
  },
);

test(
  "app-control helper prewarms OpenRouter Gemini planner client",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "planner-prewarm",
          method: "kwwk.cu.control",
          params: { control: "planner-prewarm" },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "openrouter",
          ONEESAMA_KWWK_CU_PLANNER_MODEL: "google/gemini-3.5-flash",
          ONEESAMA_KWWK_CU_PLANNER_TIMEOUT_MS: "3000",
          ONEESAMA_OPENROUTER_API_KEY: "sk-or-test",
          ONEESAMA_OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
          ONEESAMA_OPENROUTER_HTTP_REFERER: "https://bridge.surf",
          ONEESAMA_OPENROUTER_X_TITLE: "Bridge Backend",
          ONEESAMA_KWWK_CU_PLANNER_MODEL_PREWARM: "0",
        },
      },
    );

    assert.equal(response.result.ok, true);
    assert.equal(response.result.status, "ready");
    assert.equal(response.result.planner.provider, "openrouter");
    assert.equal(response.result.planner.model, "google/gemini-3.5-flash");
    assert.equal(response.result.planner.timeoutMs, 3000);
    assert.equal(response.result.client.provider, "openrouter");
    assert.equal(response.result.client.endpointPath, "/chat/completions");
    assert.equal(response.result.client.baseURLConfigured, true);
    assert.equal(response.result.client.apiKeyConfigured, true);
    assert.equal(response.result.plannerSchema.name, "kwwk_cu_plan");
    assert.equal(response.result.plannerSchema.strict, true);
    assert.equal(response.result.plannerSchema.valid, true);
    assert.equal(response.result.modelPrewarm.status, "skipped");
    assert.equal(response.result.modelPrewarm.reason, "planner_model_prewarm_disabled");
  },
);

test(
  "app-control helper prewarms native Gemini planner client by default",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "planner-prewarm",
          method: "kwwk.cu.control",
          params: { control: "planner-prewarm" },
        },
      ],
      {
        clearPlannerEnv: true,
        fixturePlanner: false,
        env: {
          ONEESAMA_GEMINI_API_KEY: "gemini-test-key",
          ONEESAMA_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
          ONEESAMA_KWWK_CU_PLANNER_MODEL_PREWARM: "0",
        },
      },
    );

    assert.equal(response.result.ok, true);
    assert.equal(response.result.status, "ready");
    assert.equal(response.result.planner.provider, "gemini");
    assert.equal(response.result.planner.model, "gemini-3.5-flash");
    assert.equal(response.result.client.provider, "gemini");
    assert.equal(response.result.client.endpointPath, "/models/{model}:generateContent");
    assert.equal(response.result.client.baseURLConfigured, true);
    assert.equal(response.result.client.apiKeyConfigured, true);
    assert.equal(response.result.modelPrewarm.status, "skipped");
    assert.equal(response.result.modelPrewarm.reason, "planner_model_prewarm_disabled");
  },
);

test("app-control helper compiles a separate KWWK CU protocol Swift module", async () => {
  const protocolSource = await readFile(
    new URL("../packages/core/src/meeting/kwwk-cu-protocol.swift", import.meta.url),
    "utf8",
  );
  const runtimeSource = await readFile(
    new URL("../packages/core/src/meeting/kwwk-cu-runtime.swift", import.meta.url),
    "utf8",
  );
  const routerSource = await readFile(
    new URL("../packages/core/src/meeting/kwwk-cu-router.swift", import.meta.url),
    "utf8",
  );
  const plannerSource = await readFile(
    new URL("../packages/core/src/meeting/kwwk-cu-planner.swift", import.meta.url),
    "utf8",
  );
  const executorSource = await readFile(
    new URL("../packages/core/src/meeting/kwwk-cu-executor.swift", import.meta.url),
    "utf8",
  );
  const coreSource = await readFile(
    new URL("../packages/core/src/meeting/kwwk-cu-core.swift", import.meta.url),
    "utf8",
  );
  const observationSource = await readFile(
    new URL("../packages/core/src/meeting/kwwk-cu-observation.swift", import.meta.url),
    "utf8",
  );
  const cursorSource = await readFile(
    new URL("../packages/core/src/meeting/kwwk-cu-cursor.swift", import.meta.url),
    "utf8",
  );
  const verificationSource = await readFile(
    new URL("../packages/core/src/meeting/kwwk-cu-verification.swift", import.meta.url),
    "utf8",
  );
  const helperSource = await readFile(
    new URL("../packages/core/src/meeting/app-control-helper.swift", import.meta.url),
    "utf8",
  );
  const launcherSource = await readFile(
    new URL("../packages/core/src/meeting/app-control-helper.ts", import.meta.url),
    "utf8",
  );
  const kwwkSwiftSources = [
    ["protocol", protocolSource],
    ["runtime", runtimeSource],
    ["router", routerSource],
    ["planner", plannerSource],
    ["executor", executorSource],
    ["core", coreSource],
    ["observation", observationSource],
    ["cursor", cursorSource],
    ["verification", verificationSource],
  ];

  assert.match(protocolSource, /func cuControl\(params:/);
  assert.match(protocolSource, /func operationFromCUActionEnvelope/);
  assert.match(protocolSource, /oneesama\.kwwk-cu-control\.v1/);
  assert.match(protocolSource, /planner-prewarm/);
  assert.match(protocolSource, /cursor-prewarm/);
  assert.match(protocolSource, /cueboard_bridge_computer_use_port/);
  assert.doesNotMatch(helperSource, /func cuControl\(params:/);
  assert.doesNotMatch(helperSource, /func operationFromCUActionEnvelope/);
  assert.match(helperSource, /@main\s+struct AppControlHelperMain/);
  assert.doesNotMatch(helperSource, /enum HelperError/);
  assert.doesNotMatch(helperSource, /func resultFor\(method:/);
  assert.doesNotMatch(helperSource, /func handleLine/);
  assert.match(launcherSource, /kwwk-cu-runtime\.swift/);
  assert.match(launcherSource, /kwwk-cu-router\.swift/);
  assert.match(launcherSource, /kwwk-cu-protocol\.swift/);
  assert.match(launcherSource, /kwwk-cu-planner\.swift/);
  assert.match(launcherSource, /kwwk-cu-executor\.swift/);
  assert.match(launcherSource, /kwwk-cu-observation\.swift/);
  assert.match(launcherSource, /kwwk-cu-cursor\.swift/);
  assert.match(launcherSource, /kwwk-cu-verification\.swift/);
  assert.doesNotMatch(launcherSource, /kwwk-cu-input\.swift/);
  assert.match(launcherSource, /appControlHelperSourcePaths/);
  assert.match(runtimeSource, /enum HelperError/);
  assert.match(runtimeSource, /func text/);
  assert.match(runtimeSource, /func intValue/);
  assert.match(runtimeSource, /func doubleValue/);
  assert.match(runtimeSource, /func boolValue/);
  assert.match(runtimeSource, /func plannerConfig/);
  assert.match(runtimeSource, /func observationFromParams/);
  assert.match(routerSource, /func resultFor\(method:/);
  assert.match(routerSource, /case "kwwk\.cu\.execute"/);
  assert.match(routerSource, /case "kwwk\.cu\.action"/);
  assert.match(routerSource, /func errorCode/);
  assert.match(routerSource, /func handleLine/);
  assert.match(plannerSource, /func plannerModelSchema/);
  assert.match(plannerSource, /func plannerPrewarmPayload/);
  assert.match(plannerSource, /func plannerModelPrewarmProbe/);
  assert.match(plannerSource, /planner_model_prewarm_disabled/);
  assert.match(plannerSource, /func validatePlanOperations/);
  assert.match(plannerSource, /planner_action_budget_exceeded/);
  assert.match(plannerSource, /func compactPlannerContext/);
  assert.match(plannerSource, /func localPlannerFixture/);
  assert.match(plannerSource, /func openAIPlannerPlan/);
  assert.match(plannerSource, /func openRouterPlannerPlan/);
  assert.match(plannerSource, /func parseChatCompletionsPlannerObject/);
  assert.match(plannerSource, /func plannerHTTPErrorBlocker/);
  assert.match(plannerSource, /func plannerModelPlan/);
  assert.match(plannerSource, /func planInstruction/);
  assert.match(plannerSource, /func operationsFromInstruction/);
  assert.match(plannerSource, /func clickOperationsFromObservation/);
  assert.match(plannerSource, /func accessibilityElements/);
  assert.match(plannerSource, /func appControlInstructionHasStateIntent/);
  assert.match(plannerSource, /func appControlInstructionHasActionIntent/);
  assert.match(plannerSource, /func appControlInstructionNeedsBackgroundAgent/);
  assert.match(plannerSource, /blocked_planner_model_model_not_found|blocked_planner_model_/);
  assert.match(executorSource, /func operationsFromParams/);
  assert.match(executorSource, /func executeOperation/);
  assert.match(
    executorSource,
    /executeKWWKCUCoreOperation\(operation: operation, target: target\)/,
  );
  assert.doesNotMatch(executorSource, /CGEvent|AXUIElementPerformAction|cliclick|cghidEventTap/);
  assert.match(executorSource, /func cursorPolicyPayload/);
  assert.match(executorSource, /func actionTelemetryEntry/);
  assert.match(executorSource, /func appControlInstructionNeedsVisualObservation/);
  assert.match(executorSource, /func appControlShouldPreObserveBeforePlanning/);
  assert.match(executorSource, /preObservedBeforePlanning/);
  assert.match(executorSource, /plannerObservation/);
  assert.match(executorSource, /operations\.isEmpty && preObservedSnapshot == nil/);
  assert.match(executorSource, /func controlSharedAppWindow/);
  assert.match(executorSource, /func appControlTimingSegments/);
  assert.match(executorSource, /oneesama\.kwwk-app-control-timings\.v1/);
  assert.match(coreSource, /import KWWKComputerUseCore/);
  assert.match(coreSource, /executeKWWKCUCoreOperation/);
  assert.match(coreSource, /runAsync\(timeoutMs: kwwkCoreActionTimeoutMs\(\)\)/);
  assert.match(coreSource, /ONEESAMA_KWWK_CU_CORE_ACTION_TIMEOUT_MS/);
  assert.match(coreSource, /kwwk_core_action_timeout/);
  assert.match(coreSource, /executionSurface": "kwwk_computer_use_core"/);
  assert.match(observationSource, /func listRunningApps/);
  assert.match(observationSource, /func focusedApplicationPayload/);
  assert.match(observationSource, /func findWindow/);
  assert.match(observationSource, /func captureWindowScreenshot/);
  assert.match(observationSource, /func collectAccessibilityElements/);
  assert.match(observationSource, /func requireAccessibility/);
  assert.match(observationSource, /func activateTarget/);
  assert.match(observationSource, /func state\(params:/);
  assert.match(observationSource, /macos_screencapturekit/);
  assert.match(cursorSource, /final class KWWKForegroundCursorPanel: NSPanel/);
  assert.match(cursorSource, /final class KWWKForegroundCursorView: NSView/);
  assert.match(cursorSource, /cueboard_action_overlay_bezier/);
  assert.match(cursorSource, /func cursorCoordinateSpace\(target:/);
  assert.match(cursorSource, /func requireCursorCoordinateSpace\(target:/);
  assert.match(cursorSource, /func cursorEvent\(kind:/);
  assert.doesNotMatch(cursorSource, /func click\(target:/);
  assert.doesNotMatch(cursorSource, /func doubleClick\(target:/);
  assert.doesNotMatch(cursorSource, /func drag\(target:/);
  assert.doesNotMatch(cursorSource, /\.post\(tap: \.cghidEventTap\)/);
  assert.match(cursorSource, /func nativeCursorOverlayProbe/);
  assert.match(cursorSource, /func nativeCursorRenderProbe/);
  assert.match(cursorSource, /func nativeCursorPrewarmPayload/);
  assert.match(cursorSource, /oneesama\.kwwk-native-cursor-prewarm\.v1/);
  assert.match(cursorSource, /func showClickIndicator/);
  assert.match(verificationSource, /func verifyPostActionState/);
  assert.match(verificationSource, /oneesama\.kwwk-cu-verification\.v1/);
  assert.match(verificationSource, /failed_verification/);
  assert.match(executorSource, /verifyPostActionState/);
  for (const [label, source] of kwwkSwiftSources) {
    assert.doesNotMatch(source, /CGEvent/, `${label} must not implement local CGEvent app actions`);
    assert.doesNotMatch(
      source,
      /CGWarpMouseCursorPosition|CGDisplayMoveCursorToPoint/,
      `${label} must not move the system cursor outside KWWK core`,
    );
    assert.doesNotMatch(
      source,
      /\.post\(tap:\s*\.cghidEventTap\)|AXUIElementPerformAction|cliclick/,
      `${label} must not bypass KWWK core for app actions`,
    );
  }
  assert.doesNotMatch(helperSource, /func plannerModelSchema/);
  assert.doesNotMatch(helperSource, /func validatePlanOperations/);
  assert.doesNotMatch(helperSource, /func compactPlannerContext/);
  assert.doesNotMatch(helperSource, /func localPlannerFixture/);
  assert.doesNotMatch(helperSource, /func openAIPlannerPlan/);
  assert.doesNotMatch(helperSource, /func openRouterPlannerPlan/);
  assert.doesNotMatch(helperSource, /func parseChatCompletionsPlannerObject/);
  assert.doesNotMatch(helperSource, /func plannerHTTPErrorBlocker/);
  assert.doesNotMatch(helperSource, /func plannerModelPlan/);
  assert.doesNotMatch(helperSource, /func planInstruction/);
  assert.doesNotMatch(helperSource, /func operationsFromInstruction/);
  assert.doesNotMatch(helperSource, /func clickOperationsFromObservation/);
  assert.doesNotMatch(helperSource, /func accessibilityElements/);
  assert.doesNotMatch(helperSource, /func appControlInstructionHasStateIntent/);
  assert.doesNotMatch(helperSource, /func appControlInstructionHasActionIntent/);
  assert.doesNotMatch(helperSource, /func appControlInstructionNeedsBackgroundAgent/);
  assert.doesNotMatch(helperSource, /func operationsFromParams/);
  assert.doesNotMatch(helperSource, /func executeOperation/);
  assert.doesNotMatch(helperSource, /func actionTelemetryEntry/);
  assert.doesNotMatch(helperSource, /func controlSharedAppWindow/);
  assert.doesNotMatch(helperSource, /func appControlTimingSegments/);
  assert.doesNotMatch(helperSource, /func listRunningApps/);
  assert.doesNotMatch(helperSource, /func focusedApplicationPayload/);
  assert.doesNotMatch(helperSource, /func findWindow/);
  assert.doesNotMatch(helperSource, /func captureWindowScreenshot/);
  assert.doesNotMatch(helperSource, /func collectAccessibilityElements/);
  assert.doesNotMatch(helperSource, /func requireAccessibility/);
  assert.doesNotMatch(helperSource, /func activateTarget/);
  assert.doesNotMatch(helperSource, /func state\(params:/);
  assert.doesNotMatch(helperSource, /final class KWWKForegroundCursorPanel/);
  assert.doesNotMatch(helperSource, /final class KWWKForegroundCursorView/);
  assert.doesNotMatch(helperSource, /KWWKActionOverlayBezierPlanner/);
  assert.doesNotMatch(helperSource, /func cursorCoordinateSpace\(target:/);
  assert.doesNotMatch(helperSource, /func requireCursorCoordinateSpace\(target:/);
  assert.doesNotMatch(helperSource, /func cursorEvent\(kind:/);
  assert.doesNotMatch(helperSource, /func click\(target:/);
  assert.doesNotMatch(helperSource, /func doubleClick\(target:/);
  assert.doesNotMatch(helperSource, /func drag\(target:/);
  assert.doesNotMatch(helperSource, /func nativeCursorOverlayProbe/);
  assert.doesNotMatch(helperSource, /func nativeCursorRenderProbe/);
  assert.doesNotMatch(helperSource, /func showClickIndicator/);
  assert.doesNotMatch(helperSource, /func verifyPostActionState/);
});

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
  "app-control helper uses the local fixture planner for common KWWK instructions",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const responses = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "tab-next",
        method: "kwwk.cu.plan",
        params: { instruction: "让他切换 tab" },
      },
      {
        jsonrpc: "2.0",
        id: "tab-prev",
        method: "kwwk.cu.plan",
        params: { instruction: "切到上一个标签页" },
      },
      {
        jsonrpc: "2.0",
        id: "type",
        method: "kwwk.cu.plan",
        params: { instruction: "输入 hello" },
      },
      {
        jsonrpc: "2.0",
        id: "refresh",
        method: "kwwk.cu.plan",
        params: { instruction: "刷新页面" },
      },
      {
        jsonrpc: "2.0",
        id: "enter",
        method: "kwwk.cu.plan",
        params: { instruction: "按回车确认" },
      },
      {
        jsonrpc: "2.0",
        id: "escape",
        method: "kwwk.cu.plan",
        params: { instruction: "关闭弹窗" },
      },
      {
        jsonrpc: "2.0",
        id: "scroll",
        method: "kwwk.cu.plan",
        params: { instruction: "滚动一下" },
      },
      {
        jsonrpc: "2.0",
        id: "search",
        method: "kwwk.cu.plan",
        params: { instruction: "搜索 oneesama", target: { applicationName: "Chrome" } },
      },
      {
        jsonrpc: "2.0",
        id: "observe",
        method: "kwwk.cu.plan",
        params: { instruction: "看一下当前状态" },
      },
      {
        jsonrpc: "2.0",
        id: "observe-title-report",
        method: "kwwk.cu.plan",
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
    assert.equal(byId.get("scroll").ok, true);
    assert.equal(byId.get("scroll").blocker, "");
    assert.deepEqual(byId.get("search").operations, [
      { kind: "press_key", key: "command+l" },
      { kind: "type_text", text: "oneesama" },
      { kind: "press_key", key: "return" },
    ]);
    assert.deepEqual(byId.get("observe").operations, [{ kind: "state" }]);
    assert.deepEqual(byId.get("observe-title-report").operations, [{ kind: "state" }]);
    for (const result of byId.values()) {
      assert.equal(result.ok, true);
      assert.equal(result.planner.provider, "model_first_local_fixture");
      assert.equal(result.planner.modelUsed, true);
      assert.equal(result.planner.modelName, "tiny-app-control-helper-fixture");
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
        method: "kwwk.cu.plan",
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
        method: "kwwk.cu.plan",
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
        method: "kwwk.cu.plan",
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
  "app-control helper exposes model-first local planner config",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "config",
          method: "kwwk.cu.plan",
          params: { instruction: "输入 hello" },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
          ONEESAMA_KWWK_CU_PLANNER_MODEL: "tiny-config-fixture",
          ONEESAMA_KWWK_CU_PLANNER_TIMEOUT_MS: "777",
          ONEESAMA_KWWK_CU_PLANNER_MAX_ACTIONS: "4",
        },
      },
    );

    assert.equal(response.result.ok, true);
    assert.equal(response.result.planner.provider, "model_first_local_fixture");
    assert.equal(response.result.planner.modelUsed, true);
    assert.equal(response.result.planner.modelName, "tiny-config-fixture");
    assert.deepEqual(response.result.planner.modelConfig, {
      provider: "local",
      model: "tiny-config-fixture",
      timeoutMs: 777,
      maxActions: 4,
      reasoningEffort: "low",
      serviceTier: "",
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
          method: "kwwk.cu.plan",
          params: { instruction: "用小模型规划这个可见操作" },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
          ONEESAMA_KWWK_CU_PLANNER_MODEL: "tiny-planner-fixture",
          ONEESAMA_KWWK_CU_PLANNER_LOCAL_PLAN_JSON: JSON.stringify({
            operations: [{ kind: "press_key", key: "return" }],
          }),
        },
      },
    );

    assert.equal(response.result.ok, true);
    assert.equal(response.result.planner.provider, "model_first_local_fixture");
    assert.equal(response.result.planner.modelUsed, true);
    assert.equal(response.result.planner.modelName, "tiny-planner-fixture");
    assert.equal(typeof response.result.planner.modelLatencyMs, "number");
    assert.deepEqual(response.result.operations, [{ kind: "press_key", key: "return" }]);
    assert.deepEqual(response.result.planner.actionKinds, ["press_key"]);
  },
);

test(
  "app-control helper treats planner blocker none as empty",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "local-model-blocker-none",
          method: "kwwk.cu.plan",
          params: { instruction: "Return the current app state for KWWK warmup." },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
          ONEESAMA_KWWK_CU_PLANNER_MODEL: "tiny-planner-fixture",
          ONEESAMA_KWWK_CU_PLANNER_LOCAL_PLAN_JSON: JSON.stringify({
            status: "planned",
            summary: "Retrieving current application state.",
            blocker: "none",
            operations: [{ kind: "state" }],
          }),
        },
      },
    );

    assert.equal(response.result.ok, true);
    assert.equal(response.result.status, "planned");
    assert.equal(response.result.blocker, "");
    assert.deepEqual(response.result.operations, [{ kind: "state" }]);
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
          method: "kwwk.cu.plan",
          params: { instruction: "用小模型规划这个危险操作" },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
          ONEESAMA_KWWK_CU_PLANNER_MODEL: "tiny-planner-fixture",
          ONEESAMA_KWWK_CU_PLANNER_LOCAL_PLAN_JSON: JSON.stringify({
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
  "app-control helper preserves planner blockers during execute",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(
      t,
      [
        {
          jsonrpc: "2.0",
          id: "execute-blocked-planner",
          method: "kwwk.cu.execute",
          params: {
            instruction:
              "Press Escape in the currently shared Chrome window using the Realtime tool.",
            target: { applicationName: "Chrome" },
          },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
          ONEESAMA_KWWK_CU_PLANNER_MODEL: "tiny-planner-fixture",
          ONEESAMA_KWWK_CU_PLANNER_LOCAL_PLAN_JSON: JSON.stringify({
            status: "blocked",
            summary: "Planner model unavailable.",
            blocker: "blocked_planner_model_model_not_found",
            operations: [],
          }),
        },
      },
    );

    assert.equal(response.result.ok, false);
    assert.equal(response.result.status, "blocked");
    assert.equal(response.result.blocker, "blocked_planner_model_model_not_found");
    assert.deepEqual(response.result.actions, []);
    assert.deepEqual(response.result.operations, []);
    assert.equal(response.result.metadata.planner.modelUsed, true);
    assert.equal(response.result.metadata.planner.modelName, "tiny-planner-fixture");
    assert.equal(response.result.metadata.observationSkipped.reason, "final_planner_blocker");
    assert.equal(response.result.metadata.timings.observeMs, 0);
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
          method: "kwwk.cu.plan",
          params: {
            instruction: "输入 hello",
            traceOutput: tracePath,
          },
        },
      ],
      {
        env: {
          ONEESAMA_KWWK_CU_PLANNER_PROVIDER: "local",
          ONEESAMA_KWWK_CU_PLANNER_MODEL: "tiny-planner-fixture",
        },
      },
    );

    assert.equal(response.result.ok, true);
    assert.equal(response.result.traceArtifact, tracePath);
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    assert.equal(trace.schema, "oneesama.kwwk-app-control-trace.v1");
    assert.equal(trace.method, "kwwk.cu.plan");
    assert.equal(trace.planner.provider, "model_first_local_fixture");
    assert.equal(trace.planner.modelUsed, true);
    assert.equal(trace.planner.modelName, "tiny-planner-fixture");
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
    assert.equal(
      byId.get("missing-double-click-point").blocker,
      "double_click_requires_element_index_or_x_y",
    );
    assert.equal(byId.get("valid").ok, true);
    assert.deepEqual(byId.get("valid").validation.actionKinds, ["press_key"]);
  },
);

test(
  "app-control helper validates kwwk.cu.action operations before execution",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const responses = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "shell-action",
        method: "kwwk.cu.action",
        params: { operation: { kind: "shell", command: "rm -rf /tmp/nope" } },
      },
      {
        jsonrpc: "2.0",
        id: "cueboard-envelope-missing-key",
        method: "kwwk.cu.action",
        params: {
          action: {
            scope: "foreground",
            action: "press-key",
            args: {},
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: "cueboard-envelope-bad-scope",
        method: "kwwk.cu.action",
        params: {
          action: {
            scope: "remote",
            action: "click",
            args: { x: 1, y: 2 },
          },
        },
      },
    ]);
    const byId = new Map(responses.map((response) => [response.id, response.result]));

    assert.equal(byId.get("shell-action").ok, false);
    assert.equal(byId.get("shell-action").status, "blocked");
    assert.equal(byId.get("shell-action").blocker, "unsupported_operation:shell");
    assert.deepEqual(byId.get("shell-action").actions, []);
    assert.equal(byId.get("shell-action").metadata.validation.ok, false);

    assert.equal(byId.get("cueboard-envelope-missing-key").ok, false);
    assert.equal(byId.get("cueboard-envelope-missing-key").status, "blocked");
    assert.equal(byId.get("cueboard-envelope-missing-key").blocker, "press_key_requires_key");
    assert.equal(byId.get("cueboard-envelope-missing-key").metadata.validation.kind, "press_key");

    assert.equal(byId.get("cueboard-envelope-bad-scope").ok, false);
    assert.equal(byId.get("cueboard-envelope-bad-scope").status, "blocked");
    assert.equal(
      byId.get("cueboard-envelope-bad-scope").blocker,
      "unsupported_operation:unsupported_scope:remote",
    );
  },
);

test(
  "app-control helper verifies kwwk.cu.action post-state before success",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "verified-state-action",
        method: "kwwk.cu.action",
        params: { target: { applicationName: "Finder" }, operation: { kind: "state" } },
      },
    ]);

    assert.equal(response.result.ok, true);
    assert.equal(response.result.status, "completed");
    assert.deepEqual(response.result.actions, ["state"]);
    assert.equal(response.result.metadata.verification.schema, "oneesama.kwwk-cu-verification.v1");
    assert.equal(response.result.metadata.verification.ok, true);
    assert.equal(response.result.metadata.verification.status, "passed");
    assert.equal(response.result.metadata.verification.reason, "post_state_verified");
    assert.equal(response.result.metadata.cursor.schema, "oneesama.kwwk-cursor-events.v1");
    assert.equal(response.result.metadata.cursor.pointerAction, false);
    assert.equal(response.result.metadata.cursor.foregroundSessionStarted, false);
    assert.deepEqual(response.result.metadata.cursor.events, []);
    assert.equal(response.result.metadata.cursor.policy, "kwwk_core_background_action_no_pointer");
    assert.ok(
      response.result.metadata.verification.checks.some(
        (check) => check.name === "post_state_observed" && check.passed === true,
      ),
    );
  },
);

test(
  "app-control helper reports failed_verification instead of false success",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const [response] = await callAppControlHelper(t, [
      {
        jsonrpc: "2.0",
        id: "failed-verification",
        method: "kwwk.cu.action",
        params: {
          operation: { kind: "state" },
          target: { applicationName: "Finder" },
          verification: { expectedWindowTitleContains: "__oneesama_missing_title_probe__" },
        },
      },
    ]);

    assert.equal(response.result.ok, false);
    assert.equal(response.result.status, "failed");
    assert.equal(response.result.blocker, "failed_verification");
    assert.deepEqual(response.result.actions, ["state"]);
    assert.equal(response.result.metadata.verification.schema, "oneesama.kwwk-cu-verification.v1");
    assert.equal(response.result.metadata.verification.ok, false);
    assert.equal(response.result.metadata.verification.status, "failed");
    assert.equal(response.result.metadata.verification.blocker, "failed_verification");
    assert.ok(
      response.result.metadata.verification.checks.some(
        (check) => check.name === "window_title_contains" && check.passed === false,
      ),
    );
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
      { env: { ONEESAMA_KWWK_CU_PLANNER_MAX_ACTIONS: "2" } },
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
        method: "kwwk.cu.plan",
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
        method: "kwwk.cu.plan",
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
        method: "kwwk.cu.plan",
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
        method: "kwwk.cu.plan",
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
        method: "kwwk.cu.plan",
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
        method: "kwwk.cu.plan",
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
        method: "kwwk.cu.plan",
        params: { instruction: "重新设计整个产品路线图并写一个实现计划" },
      },
    ]);

    assert.equal(response.result.ok, false);
    assert.equal(response.result.status, "needs_background_agent");
    assert.equal(response.result.blocker, "needs_background_agent");
    assert.deepEqual(response.result.operations, []);
  },
);
