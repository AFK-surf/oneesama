import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { argValue as resolveArgValue, resolveRealMeetUrl } from "./real-meet-url-resolver.mjs";
import {
  compactJsonForDiagnostics,
  realMeetUIInteractionJoinFields,
} from "./real-meet-synthetic-speaker-helpers.mjs";
import {
  appControlActionSemanticsPass,
  appControlStatusHasCompactBlocker,
} from "./real-meet-app-control-semantics.mjs";

const LIVE_MODEL_FIRST_LATENCY_SLO_MS = 2500;
const DEFAULT_APP_CONTROL_TARGET_LABEL = "Chromium";
const DEFAULT_APP_CONTROL_TARGET_TITLE = "Oneesama KWWK App Control Target";

export {
  appControlActionSemanticsPass,
  appControlActionsHaveNonObserveAction,
  appControlInstructionNeedsNonObserveAction,
  appControlStatusHasCompactBlocker,
} from "./real-meet-app-control-semantics.mjs";

function envMs(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim());
}

function envFlagFrom(env, name) {
  return /^(1|true|yes|on)$/i.test(String(env?.[name] || "").trim());
}

export function realMeetAppControlManagedTargetConfig(env = process.env) {
  const rawEnabled = String(env.MAB_REAL_MEET_APP_CONTROL_MANAGED_TARGET || "").trim();
  const explicitApplication = String(env.MAB_REAL_MEET_APP_CONTROL_APPLICATION || "").trim();
  const enabled = rawEnabled
    ? envFlagFrom(env, "MAB_REAL_MEET_APP_CONTROL_MANAGED_TARGET")
    : !explicitApplication;
  const targetLabel = String(
    env.MAB_REAL_MEET_APP_CONTROL_TARGET_LABEL || DEFAULT_APP_CONTROL_TARGET_LABEL,
  ).trim();
  const windowTitle = String(
    env.MAB_REAL_MEET_APP_CONTROL_WINDOW_TITLE || DEFAULT_APP_CONTROL_TARGET_TITLE,
  ).trim();
  return {
    enabled,
    applicationName: explicitApplication || "Google Chrome for Testing",
    windowTitle: windowTitle || DEFAULT_APP_CONTROL_TARGET_TITLE,
    targetLabel: targetLabel || DEFAULT_APP_CONTROL_TARGET_LABEL,
  };
}

function requireRealMeetUrl() {
  return (
    envFlag("MAB_REQUIRE_REAL_MEET_URL") ||
    envFlag("MAB_REAL_MEET_REQUIRED") ||
    process.argv.includes("--require-real-meet-url")
  );
}

function argValue(name) {
  return resolveArgValue(process.argv, name);
}

async function writeJsonOutIfRequested(output) {
  const jsonOut = argValue("--json-out");
  if (!jsonOut) return;
  await writeFile(jsonOut, `${output}\n`);
}

async function emitJsonResult(result, { error = false } = {}) {
  const output = JSON.stringify(result, null, 2);
  await writeJsonOutIfRequested(output);
  if (error) console.error(output);
  else console.log(output);
}

async function skipMissingRealMeetUrl(label, command, options = {}) {
  const strict = options.strict ?? requireRealMeetUrl();
  const emit = options.emit !== false;
  const setExitCode = options.setExitCode !== false;
  const resolution = options.resolution || {};
  const result = {
    ok: false,
    skipped: !strict,
    diagnosticOnly: !strict,
    acceptanceSatisfied: false,
    reason: "missing_env",
    missingEnv: ["MAB_REAL_MEET_URL"],
    checkedSources: resolution.checkedSources || [],
    discoveryError: resolution.discoveryError || "",
    activeBrowserRecordError: resolution.activeBrowserRecordError || "",
    command,
    message: `Set MAB_REAL_MEET_URL, pass --real-meet-url, or keep a meeting-agent session active so /join/status exposes the real Meet URL to run the ${label}.`,
  };
  if (emit && strict) await emitJsonResult(result, { error: true });
  else if (emit) await emitJsonResult(result);
  if (strict && setExitCode) process.exitCode = 1;
  return result;
}

async function fetchJson(url, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.headers) Object.assign(headers, options.headers);
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const compactBody = compactJsonForDiagnostics(body);
    const error = new Error(
      `HTTP ${response.status} ${url}: ${JSON.stringify(compactBody).slice(0, 1200)}`,
    );
    error.body = body;
    error.compactBody = compactBody;
    error.status = response.status;
    error.url = url;
    throw error;
  }
  return body;
}

async function postJson(url, body) {
  return await fetchJson(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, probe, timeoutMs, intervalMs = 1000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await probe();
    if (last?.done) return last;
    await sleep(intervalMs);
  }
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.last = last;
  throw error;
}

export function normalizeAppControlStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase();
}

export function appControlStatusIsSuccess(status) {
  return ["completed", "done"].includes(normalizeAppControlStatus(status));
}

export function appControlStatusIsFailure(status) {
  return ["failed", "blocked", "timeout", "error", "stale", "canceled", "cancelled"].includes(
    normalizeAppControlStatus(status),
  );
}

function appControlStatusIsTerminal(status) {
  const normalized = normalizeAppControlStatus(status);
  return appControlStatusIsSuccess(normalized) || appControlStatusIsFailure(normalized);
}

export function realMeetAppControlEvidencePasses(value = {}) {
  const appControl =
    value.appControl && typeof value.appControl === "object" ? value.appControl : value;
  const expectedSessionId = firstNonEmpty(value.expectedSessionId, value.sessionId);
  return (
    ((appControlStatusIsSuccess(appControl.status) && appControl.ok === true) ||
      appControlStatusHasCompactBlocker(appControl)) &&
    appControlActionSemanticsPass(appControl, { instruction: value.instruction }) &&
    realMeetAppControlRealtimeEvidencePasses(value.joinStatus || value.realtimeEvidence || {}, {
      expectedSessionId,
    })
  );
}

function compactCursorEvent(event = {}) {
  return {
    kind: String(event.kind || "").slice(0, 64),
    normalizedX: Number.isFinite(Number(event.normalizedX)) ? Number(event.normalizedX) : null,
    normalizedY: Number.isFinite(Number(event.normalizedY)) ? Number(event.normalizedY) : null,
    coordinateSpaceId: String(event.coordinateSpaceId || "").slice(0, 80),
    nativeForegroundCursor: Boolean(event.nativeForegroundCursor),
  };
}

function collectCursorEvents(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectCursorEvents(entry, depth + 1));
  const ownEvents = [];
  if (
    (value.schema === "oneesama.kwwk-cursor-events.v1" ||
      value.schema === "oneesama.kwwk-cursor-artifact.v1") &&
    Array.isArray(value.events)
  ) {
    ownEvents.push(...value.events);
  }
  return [
    ...ownEvents,
    ...[
      "cursor",
      "kwwkCursor",
      "metadata",
      "backendResult",
      "workerResult",
      "result",
      "artifact",
    ].flatMap((key) => collectCursorEvents(value[key], depth + 1)),
  ];
}

function compactCursorEvidence(...values) {
  const events = values.flatMap((value) => collectCursorEvents(value)).map(compactCursorEvent);
  const eventKinds = events.map((event) => event.kind).filter(Boolean);
  const firstObject = values.find((value) => value && typeof value === "object") || {};
  const artifact =
    firstObject.artifact && typeof firstObject.artifact === "object" ? firstObject.artifact : {};
  const snapshot =
    firstObject.snapshot && typeof firstObject.snapshot === "object" ? firstObject.snapshot : {};
  const latest =
    firstObject.latest && typeof firstObject.latest === "object"
      ? firstObject.latest
      : artifact.latest && typeof artifact.latest === "object"
        ? artifact.latest
        : snapshot;
  return {
    available:
      events.length > 0 ||
      values.some((value) => value && typeof value === "object" && value.available === true),
    eventCount: events.length,
    eventKinds: Array.from(new Set(eventKinds)).slice(0, 20),
    events: events.slice(-8),
    hasPointerAction: eventKinds.some((kind) => /cursor\.(click|double_click|drag)/.test(kind)),
    hasClick: eventKinds.some((kind) => /cursor\.(click|double_click)/.test(kind)),
    hasNativeForegroundCursor: events.some((event) => event.nativeForegroundCursor),
    latestVisible: latest?.visible === true,
    latestKind: String(latest?.kind || "").slice(0, 64),
    styles: artifact.styles || firstObject.styles || {},
    schema: String(artifact.schema || firstObject.schema || ""),
  };
}

function compactHudCell(cell = {}) {
  return {
    key: String(cell.key || "").slice(0, 48),
    label: String(cell.label || "").slice(0, 80),
    value: String(cell.value || "").slice(0, 80),
    level: String(cell.level || "").slice(0, 32),
  };
}

function compactHudEvidence(value = {}) {
  const cells = Array.isArray(value.cells) ? value.cells.map(compactHudCell).slice(0, 12) : [];
  const signals = Array.isArray(value.signals)
    ? value.signals.map(compactHudCell).slice(0, 12)
    : [];
  const visibleText = cells.map((cell) => `${cell.key} ${cell.label} ${cell.value}`).join("\n");
  return {
    available: value.available === true || cells.length > 0 || signals.length > 0,
    cells,
    signals,
    visibleText,
    noisySpeechOrConnectionVisible:
      /听语音|说话|讲话|开口|等待输入|listening|speaking|没音频|没开口|没出声|连接中/i.test(
        visibleText,
      ) || cells.some((cell) => ["rt", "audio", "speak"].includes(cell.key)),
  };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function compactAppControlTimingEvidence(value = {}, result = {}) {
  const backendResult =
    value.backendResult && typeof value.backendResult === "object"
      ? value.backendResult
      : result.backendResult && typeof result.backendResult === "object"
        ? result.backendResult
        : {};
  const metadata =
    backendResult.metadata && typeof backendResult.metadata === "object"
      ? backendResult.metadata
      : value.metadata && typeof value.metadata === "object"
        ? value.metadata
        : result.metadata && typeof result.metadata === "object"
          ? result.metadata
          : {};
  const timings =
    metadata.timings && typeof metadata.timings === "object"
      ? metadata.timings
      : backendResult.timings && typeof backendResult.timings === "object"
        ? backendResult.timings
        : {};
  const planner =
    metadata.planner && typeof metadata.planner === "object"
      ? metadata.planner
      : backendResult.planner && typeof backendResult.planner === "object"
        ? backendResult.planner
        : value.planner && typeof value.planner === "object"
          ? value.planner
          : {};
  const observeMs = firstFiniteNumber(timings.observeMs, timings.observe_ms);
  const planMs = firstFiniteNumber(timings.planMs, timings.plan_ms, planner.latencyMs);
  const modelPlannerMs = firstFiniteNumber(
    timings.modelPlannerMs,
    timings.model_planner_ms,
    planner.modelLatencyMs,
  );
  const executeMs = firstFiniteNumber(timings.executeMs, timings.execute_ms);
  const cursorMs = firstFiniteNumber(timings.cursorMs, timings.cursor_ms);
  const verifyMs = firstFiniteNumber(timings.verifyMs, timings.verify_ms);
  const directToolReceiveToVerifiedActionMs = firstFiniteNumber(
    timings.toolReceiveToVerifiedActionMs,
    timings.tool_receive_to_verified_action_ms,
    timings.totalMs,
    timings.total_ms,
  );
  const summedToolReceiveToVerifiedActionMs =
    directToolReceiveToVerifiedActionMs ??
    [observeMs, planMs, executeMs, cursorMs, verifyMs].reduce(
      (sum, segmentMs) => sum + (segmentMs ?? 0),
      0,
    );
  const toolReceiveToVerifiedActionMs =
    summedToolReceiveToVerifiedActionMs > 0 ? summedToolReceiveToVerifiedActionMs : null;
  const timing = {
    available: toolReceiveToVerifiedActionMs !== null || modelPlannerMs !== null,
    durationMs: firstFiniteNumber(
      value.duration_ms,
      value.durationMs,
      result.duration_ms,
      result.durationMs,
      backendResult.durationMs,
      backendResult.duration_ms,
    ),
    observeMs,
    planMs,
    modelPlannerMs,
    executeMs,
    cursorMs,
    verifyMs,
    toolReceiveToVerifiedActionMs,
    modelUsed: planner.modelUsed === true,
    provider: String(planner.provider || metadata.provider || backendResult.provider || ""),
    modelName: String(planner.modelName || planner.model || metadata.modelName || ""),
  };
  timing.withinWarmSlo =
    timing.toolReceiveToVerifiedActionMs !== null &&
    timing.toolReceiveToVerifiedActionMs <= LIVE_MODEL_FIRST_LATENCY_SLO_MS;
  return timing;
}

export function compactAppControlEvidence(value = {}) {
  const result = value.result && typeof value.result === "object" ? value.result : {};
  const screenShare =
    value.screenShare && typeof value.screenShare === "object" ? value.screenShare : {};
  const timing = compactAppControlTimingEvidence(value, result);
  return {
    ok: value.ok === true,
    status: String(value.status || ""),
    error: String(value.error || result.error || ""),
    blocker: String(value.blocker || result.blocker || ""),
    jobId: String(value.job_id || value.jobId || result.job_id || result.jobId || ""),
    provider: String(value.provider || result.provider || ""),
    summary: String(value.summary || result.summary || "").slice(0, 500),
    actions: Array.isArray(value.actions)
      ? value.actions.slice(0, 12)
      : Array.isArray(result.actions)
        ? result.actions.slice(0, 12)
        : [],
    screenShare: {
      active: screenShare.active === true,
      applicationName: String(screenShare.applicationName || screenShare.appName || ""),
      title: String(screenShare.title || screenShare.windowTitle || ""),
      windowId: Number(screenShare.windowId || screenShare.windowID || 0),
      processId: Number(screenShare.processId || screenShare.pid || 0),
    },
    cursor: compactCursorEvidence(value),
    timing,
    rawChars: JSON.stringify(value).length,
  };
}

function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function buildRealMeetAppControlLiveLatencySummary(suite = []) {
  const samples = suite
    .map((testCase) => ({
      id: testCase.id || "",
      kind: testCase.kind || "",
      acceptanceSatisfied: testCase.acceptanceSatisfied === true,
      timing: testCase.final?.appControl?.timing || testCase.appControl?.timing || {},
    }))
    .map((sample) => {
      sample.toolReceiveToVerifiedActionMs = finiteNumber(
        sample.timing.toolReceiveToVerifiedActionMs,
      );
      sample.modelPlannerMs = finiteNumber(sample.timing.modelPlannerMs);
      sample.modelUsed = sample.timing.modelUsed === true;
      sample.withinWarmSlo = sample.timing.withinWarmSlo === true;
      sample.provider = String(sample.timing.provider || "");
      sample.modelName = String(sample.timing.modelName || "");
      return sample;
    });
  const executableSamples = samples.filter((sample) => sample.acceptanceSatisfied);
  const measuredSamples = executableSamples.filter(
    (sample) => sample.toolReceiveToVerifiedActionMs !== null,
  );
  const warmP95Ms = percentile(
    measuredSamples.map((sample) => sample.toolReceiveToVerifiedActionMs),
    95,
  );
  return {
    schema: "oneesama.real-meet-app-control-live-latency.v1",
    ok:
      executableSamples.length > 0 &&
      measuredSamples.length === executableSamples.length &&
      measuredSamples.every((sample) => sample.withinWarmSlo),
    warmSloMs: LIVE_MODEL_FIRST_LATENCY_SLO_MS,
    warmP95Ms,
    sampleCount: samples.length,
    measuredSampleCount: measuredSamples.length,
    missingTimingCount: executableSamples.length - measuredSamples.length,
    samples,
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function latestToolCall(calls, name) {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (String(call?.name || call?.toolName || "") === name) return call;
  }
  return undefined;
}

function toolCallJobId(call = {}) {
  const result = call.result && typeof call.result === "object" ? call.result : {};
  const nestedResult = result.result && typeof result.result === "object" ? result.result : {};
  const job = result.job && typeof result.job === "object" ? result.job : {};
  const report = result.report && typeof result.report === "object" ? result.report : {};
  return firstNonEmpty(
    result.job_id,
    result.jobId,
    nestedResult.job_id,
    nestedResult.jobId,
    job.id,
    job.jobId,
    report.id,
    report.jobId,
  );
}

function toolCallOutputDelivered(bridge = {}, call = {}) {
  const delivery = call.delivery && typeof call.delivery === "object" ? call.delivery : {};
  if (delivery.suppressed === true) return false;
  if (delivery.outputChannel || delivery.handledOutputChannel) return true;
  const decisions = Array.isArray(bridge?.turnPolicy?.decisions) ? bridge.turnPolicy.decisions : [];
  return decisions.some((decision) => {
    const decisionCallId = String(decision?.callId || decision?.call_id || "");
    return (
      decisionCallId &&
      decisionCallId === String(call.callId || call.call_id || "") &&
      decision?.suppressed !== true &&
      Boolean(decision?.outputChannel)
    );
  });
}

export function compactRealMeetAppControlJoinStatus(status = {}) {
  const directActive = status?.active || {};
  const runtimeActive = status?.runtime?.active || {};
  const directActiveHasRuntimeEvidence = Boolean(
    directActive?.realtimeBridge ||
    directActive?.meetPage ||
    directActive?.realtimeSidecar ||
    directActive?.realtimeRuntimePlacement ||
    directActive?.realtime_runtime_placement ||
    directActive?.realtimeSdkOwner ||
    directActive?.realtime_sdk_owner,
  );
  const active = directActiveHasRuntimeEvidence ? directActive : runtimeActive || directActive;
  const bridge = active?.realtimeBridge || {};
  const connection = bridge?.connection || {};
  const meetPage = active?.meetPage || {};
  const meetSurface = meetPage?.realtimeSurface || {};
  const calls = [
    ...(Array.isArray(bridge?.meetTools?.calls) ? bridge.meetTools.calls : []),
    ...(Array.isArray(bridge?.workspaceTools?.calls) ? bridge.workspaceTools.calls : []),
    ...(Array.isArray(bridge?.workerTools?.calls) ? bridge.workerTools.calls : []),
    ...(Array.isArray(bridge?.avatarTools?.calls) ? bridge.avatarTools.calls : []),
  ];
  const appControlCall = latestToolCall(calls, "kwwk_computer_use") || {};
  const latestFunctionalTurn =
    bridge?.feedback?.checks?.latestFunctionalTurn ||
    bridge?.contextHealth?.latestFunctionalTurn ||
    {};
  return {
    ok: status?.ok === true,
    activeSessionId: active.sessionId || active.session_id || "",
    realtimeRuntimePlacement:
      active.realtimeRuntimePlacement || active.realtime_runtime_placement || "",
    realtimeSdkOwner: active.realtimeSdkOwner || active.realtime_sdk_owner || "",
    sidecarActive: active.realtimeSidecar?.active === true,
    sidecarPageCount: Number(active.realtimeSidecar?.pageCount || 0),
    sdkOwnerPageCount: Number(active.realtimeSidecar?.sdkOwnerPageCount || 0),
    diagnosticsPath: active.diagnosticsPath || "",
    meetSurface: {
      runtimePlacement: meetSurface.runtimePlacement || "",
      pageRole: meetSurface.pageRole || "",
      sdkOwner: meetSurface.sdkOwner || "",
      sdkSuppressedOnMeetSurface: meetSurface.sdkSuppressedOnMeetSurface === true,
      hasSDKGlobal: meetSurface.hasSDKGlobal === true,
      bundleGlobal: String(meetSurface.bundleGlobal || ""),
    },
    avatarHud: compactHudEvidence(meetPage.avatarHud || {}),
    kwwkCursor: compactCursorEvidence(meetPage.kwwkCursor || {}),
    realtime: {
      connected: bridge.connected === true,
      openaiSessionId: connection.openaiSessionId || "",
      sdkConnected: bridge?.agentRuntime?.sdkConnected === true,
      latestFunctionalTurnFakeExecution:
        bridge?.feedback?.checks?.latestFunctionalTurnFakeExecution === true ||
        latestFunctionalTurn.fakeExecution === true,
    },
    toolTelemetry: {
      appControlCalled: Boolean(appControlCall.name || appControlCall.toolName),
      appControlCallId: appControlCall.callId || appControlCall.call_id || "",
      appControlJobId: toolCallJobId(appControlCall),
      functionOutputDelivered: toolCallOutputDelivered(bridge, appControlCall),
    },
  };
}

export function realMeetAppControlRealtimeEvidencePasses(evidence = {}, options = {}) {
  const expectedSessionId = firstNonEmpty(options.expectedSessionId, options.sessionId);
  return (
    evidence.ok === true &&
    (!expectedSessionId || evidence.activeSessionId === expectedSessionId) &&
    evidence.realtimeRuntimePlacement === "sidecar" &&
    evidence.realtimeSdkOwner === "sidecar" &&
    evidence.sidecarActive === true &&
    evidence.sidecarPageCount === 1 &&
    evidence.sdkOwnerPageCount === 1 &&
    evidence.meetSurface?.runtimePlacement === "sidecar" &&
    evidence.meetSurface?.pageRole === "meet-surface" &&
    evidence.meetSurface?.sdkOwner === "sidecar" &&
    evidence.meetSurface?.sdkSuppressedOnMeetSurface === true &&
    evidence.meetSurface?.hasSDKGlobal === false &&
    !evidence.meetSurface?.bundleGlobal &&
    evidence.realtime?.connected === true &&
    Boolean(evidence.realtime?.openaiSessionId) &&
    evidence.realtime?.latestFunctionalTurnFakeExecution !== true &&
    evidence.toolTelemetry?.appControlCalled === true &&
    Boolean(evidence.toolTelemetry?.appControlJobId) &&
    evidence.toolTelemetry?.functionOutputDelivered === true
  );
}

function actionKinds(value = {}) {
  const appControl =
    value.appControl && typeof value.appControl === "object" ? value.appControl : value;
  return Array.isArray(appControl.actions)
    ? appControl.actions.map((action) => String(action || "").toLowerCase())
    : [];
}

function appControlHasPointerAction(value = {}) {
  return actionKinds(value).some((action) => ["click", "double_click", "drag"].includes(action));
}

function appControlHasKeyboardOnlyAction(value = {}) {
  const actions = actionKinds(value);
  return (
    actions.includes("press_key") &&
    !actions.some((action) => ["click", "double_click", "drag"].includes(action))
  );
}

export function realMeetAppControlSuiteCasePasses(value = {}) {
  const kind = String(value.kind || value.caseKind || "").trim();
  const final = value.final || {};
  const appControl = final.appControl || value.appControl || {};
  const joinStatus = final.joinStatus || value.joinStatus || {};
  const base = realMeetAppControlEvidencePasses({
    appControl,
    joinStatus,
    expectedSessionId: value.expectedSessionId || value.sessionId,
    instruction: value.instruction,
  });
  if (!base) return false;
  const hudQuiet = joinStatus.avatarHud?.noisySpeechOrConnectionVisible !== true;
  if (!hudQuiet) return false;
  if (kind === "keyboard") {
    return (
      appControlHasKeyboardOnlyAction({ appControl }) &&
      appControl.cursor?.hasPointerAction !== true &&
      appControl.cursor?.eventCount === 0 &&
      joinStatus.kwwkCursor?.eventCount === 0
    );
  }
  if (kind === "pointer") {
    return (
      appControlHasPointerAction({ appControl }) &&
      appControl.cursor?.hasPointerAction === true &&
      joinStatus.kwwkCursor?.hasPointerAction === true &&
      joinStatus.kwwkCursor?.styles?.persistentCursor === true
    );
  }
  return base;
}

async function startManagedRealMeetAppControlTarget(config) {
  if (!config.enabled) return null;
  let browser = null;
  const windowTitle = `${config.windowTitle} ${Date.now()}`;
  try {
    browser = await chromium.launch({
      headless: false,
      args: [
        "--new-window",
        "--window-size=980,680",
        "--window-position=48,72",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    const context = await browser.newContext({ viewport: { width: 980, height: 680 } });
    const page = await context.newPage();
    const targetLabel = config.targetLabel || DEFAULT_APP_CONTROL_TARGET_LABEL;
    await page.setContent(
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(windowTitle)}</title>
    <style>
      html, body { margin: 0; min-height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fb; color: #172033; }
      main { min-height: 100vh; display: grid; place-items: center; }
      section { width: min(720px, calc(100vw - 96px)); border: 1px solid #d4d9e5; border-radius: 8px; background: #ffffff; padding: 40px; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12); }
      h1 { margin: 0 0 18px; font-size: 32px; font-weight: 700; letter-spacing: 0; }
      button { appearance: none; border: 2px solid #1d4ed8; border-radius: 6px; background: #2563eb; color: white; font: inherit; font-size: 26px; font-weight: 700; padding: 18px 28px; min-width: 220px; cursor: pointer; }
      button:focus { outline: 4px solid #93c5fd; outline-offset: 4px; }
      p { margin: 20px 0 0; font-size: 16px; color: #475569; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>${escapeHtml(windowTitle)}</h1>
        <button id="chromium-target" type="button">${escapeHtml(targetLabel)}</button>
        <p>Stable app-control acceptance target.</p>
      </section>
    </main>
    <script>
      document.getElementById("chromium-target").addEventListener("click", () => {
        document.body.dataset.clicked = "true";
      });
    </script>
  </body>
</html>`,
      { waitUntil: "domcontentloaded" },
    );
    await page.bringToFront();
    await page.waitForTimeout(500);
    return {
      ...config,
      windowTitle,
      async close() {
        await browser?.close().catch(() => {});
      },
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    throw error;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function defaultRealMeetAppControlSuiteCases(
  applicationName,
  targetLabel = DEFAULT_APP_CONTROL_TARGET_LABEL,
) {
  const keyboardInstruction =
    process.env.MAB_REAL_MEET_APP_CONTROL_KEYBOARD_INSTRUCTION || "Press Escape";
  const pointerInstruction =
    process.env.MAB_REAL_MEET_APP_CONTROL_POINTER_INSTRUCTION || `Click ${targetLabel}`;
  return [
    {
      id: "keyboard-escape",
      kind: "keyboard",
      instruction: keyboardInstruction,
      appControlText:
        process.env.MAB_REAL_MEET_APP_CONTROL_KEYBOARD_TEXT ||
        `请通过 Realtime 工具对当前共享的 ${applicationName} 窗口执行一个键盘操作：${keyboardInstruction}`,
    },
    {
      id: "pointer-visible-click",
      kind: "pointer",
      instruction: pointerInstruction,
      appControlText:
        process.env.MAB_REAL_MEET_APP_CONTROL_POINTER_TEXT ||
        `请通过 Realtime 工具点击当前共享的 ${applicationName} 窗口里的可见目标：${pointerInstruction}`,
    },
  ];
}

async function startRealMeetAppControlSession({
  meetingAgentUrl,
  sessionId,
  meetUrl,
  applicationName,
  windowTitle = "",
  processId = 0,
}) {
  await postJson(`${meetingAgentUrl}/join/stop`, {
    reason: "real_meet_app_control_smoke_preflight",
  }).catch(() => {});
  const join = await postJson(`${meetingAgentUrl}/join/google-meet`, {
    sessionId,
    session_id: sessionId,
    meetUrl,
    meeting_url: meetUrl,
    botName: process.env.MAB_REAL_MEET_BOT_NAME || "Onee Sama App Control",
    display_name: process.env.MAB_REAL_MEET_BOT_NAME || "Onee Sama App Control",
    dryRun: false,
    dry_run: false,
    disableLive2D: process.env.MAB_REAL_MEET_DISABLE_LIVE2D !== "0",
    installWorkerResultBridge: true,
    install_worker_result_bridge: true,
    installRealtimeBridge: true,
    install_realtime_bridge: true,
    realtimeBridgeMode: process.env.MAB_REAL_MEET_REALTIME_MODE || "agents-sdk",
    realtime_bridge_mode: process.env.MAB_REAL_MEET_REALTIME_MODE || "agents-sdk",
    autoConnectRealtime: true,
    auto_connect_realtime: true,
    sendRealtimeSessionUpdate: true,
    send_realtime_session_update: true,
    includeParticipantAudio: false,
    include_participant_audio: false,
    forwardMeetAudioToRealtime: true,
    forward_meet_audio_to_realtime: true,
    ...realMeetUIInteractionJoinFields("macos_app_control_humanized"),
    captureCaptions: false,
    capture_captions: false,
  });
  const share = await postJson(`${meetingAgentUrl}/screen-share/app`, {
    session_id: sessionId,
    windowTitle,
    processId,
    ...(!windowTitle && !processId ? { applicationName } : {}),
  });
  return { join, share };
}

function appControlJobIdFromResult(value = {}) {
  return String(
    value.jobId || value.job_id || value.appControlJobId || value.app_control_job_id || "",
  );
}

async function prewarmRealMeetAppControlTarget({
  meetingAgentUrl,
  sessionId,
  applicationName,
  windowTitle = "",
  processId = 0,
}) {
  const attempts = envMs("MAB_REAL_MEET_APP_CONTROL_TARGET_PREWARM_ATTEMPTS", 3);
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await postJson(`${meetingAgentUrl}/tools/kwwk_computer_use`, {
      session_id: sessionId,
      applicationName,
      windowTitle,
      processId,
      wait: true,
      instruction: "Return the current app state for KWWK Computer Use warmup.",
      context: {
        source: "real_meet_app_control_target_prewarm",
        prewarm: true,
        cursor: "do_not_start_foreground_cursor_session",
      },
    });
    const compact = compactAppControlEvidence(result);
    last = {
      ok: compact.ok === true && appControlStatusIsSuccess(compact.status),
      attempt,
      attempts,
      jobId: appControlJobIdFromResult(result) || compact.jobId,
      status: compact.status,
      blocker: compact.blocker,
      timing: compact.timing,
      result: compact,
    };
    if (last.ok) return last;
    if (!/timeout|unavailable/i.test(String(compact.blocker || compact.error || ""))) return last;
    await sleep(800);
  }
  return last || { ok: false, attempts, error: "target_prewarm_not_attempted" };
}

async function runRealtimeAppControlTurn({
  meetingAgentUrl,
  sessionId,
  applicationName,
  instruction,
  appControlText,
  timeoutMs,
  caseKind = "",
  previousJobIds = new Set(),
}) {
  let jobId = "";
  const textTurn = await postJson(`${meetingAgentUrl}/realtime/text-turn`, {
    session_id: sessionId,
    text: appControlText,
    instructions: [
      "This is the real-room app-control acceptance turn.",
      "Call kwwk_computer_use exactly once for the user's request.",
      "Do not answer with progress text before the tool call.",
    ].join("\n"),
  });
  const final = await waitFor(
    "real Meet app-control job",
    async () => {
      const joinStatus = await fetchJson(`${meetingAgentUrl}/join/status`).catch((error) => ({
        ok: false,
        error: String(error?.message || error),
      }));
      const compactJoinStatus = compactRealMeetAppControlJoinStatus(joinStatus);
      const observedJobId = compactJoinStatus.toolTelemetry.appControlJobId || "";
      if (observedJobId && !previousJobIds.has(observedJobId)) jobId = observedJobId;
      const status = jobId
        ? await postJson(`${meetingAgentUrl}/tools/kwwk_computer_use`, {
            job_id: jobId,
          })
        : {
            ok: false,
            status: "pending",
            error: "realtime_app_control_job_not_observed",
          };
      return {
        done: Boolean(jobId) && appControlStatusIsTerminal(status.status),
        appControl: compactAppControlEvidence(status),
        status,
        joinStatus: compactJoinStatus,
      };
    },
    timeoutMs,
    1500,
  );
  if (caseKind === "pointer" && final.appControl?.cursor?.hasPointerAction === true) {
    const cursorWaitMs = envMs("MAB_REAL_MEET_APP_CONTROL_CURSOR_WAIT_MS", 20_000);
    try {
      const cursorJoinStatus = await waitFor(
        "real Meet audience cursor artifact",
        async () => {
          const joinStatus = await fetchJson(`${meetingAgentUrl}/join/status`).catch((error) => ({
            ok: false,
            error: String(error?.message || error),
          }));
          const compactJoinStatus = compactRealMeetAppControlJoinStatus(joinStatus);
          return {
            done: compactJoinStatus.kwwkCursor?.hasPointerAction === true,
            joinStatus: compactJoinStatus,
          };
        },
        cursorWaitMs,
        1000,
      );
      final.joinStatus = cursorJoinStatus.joinStatus;
      final.cursorWait = {
        ok: true,
        timeoutMs: cursorWaitMs,
      };
    } catch (error) {
      if (error?.last?.joinStatus) final.joinStatus = error.last.joinStatus;
      final.cursorWait = {
        ok: false,
        timeoutMs: cursorWaitMs,
        error: String(error?.message || error),
      };
    }
  }
  const ok = realMeetAppControlEvidencePasses({
    appControl: final.appControl,
    joinStatus: final.joinStatus,
    expectedSessionId: sessionId,
    instruction,
  });
  return {
    ok,
    acceptanceSatisfied: ok,
    sessionId,
    applicationName,
    instruction,
    appControlText,
    textTurn,
    final,
  };
}

export async function runRealMeetAppControlSmokeMain(options = {}) {
  const emit = options.emit !== false;
  const setExitCode = options.setExitCode !== false;
  const realMeetUrl = await resolveRealMeetUrl();
  const meetUrl = realMeetUrl.meetUrl || "";
  if (!meetUrl) {
    return await skipMissingRealMeetUrl(
      "real Meet app-control smoke",
      "MAB_REAL_MEET_URL=https://meet.google.com/... npm run benchmark:realtime-real-app-control",
      { emit, setExitCode, resolution: realMeetUrl },
    );
  }
  const meetingAgentUrl = (process.env.MAB_MEETING_AGENT_URL || "http://127.0.0.1:8781").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = envMs("MAB_REAL_MEET_APP_CONTROL_WAIT_MS", 180_000);
  const sessionId = process.env.MAB_REAL_MEET_SESSION_ID || `real_meet_app_control_${Date.now()}`;
  const targetConfig = realMeetAppControlManagedTargetConfig();
  const applicationName = targetConfig.applicationName;
  const instruction =
    process.env.MAB_REAL_MEET_APP_CONTROL_INSTRUCTION ||
    "Observe the currently shared browser window and report the visible page title or blocker. Do not type, click, navigate, or change the page.";
  const appControlText =
    process.env.MAB_REAL_MEET_APP_CONTROL_TEXT ||
    `请通过 Realtime 工具操作当前共享的 ${applicationName} 窗口：${instruction}`;
  let jobId = "";
  let managedTarget = null;
  let targetPrewarm = null;
  try {
    managedTarget = await startManagedRealMeetAppControlTarget(targetConfig);
    const { join, share } = await startRealMeetAppControlSession({
      meetingAgentUrl,
      sessionId,
      meetUrl,
      applicationName,
      windowTitle:
        managedTarget?.windowTitle || process.env.MAB_REAL_MEET_APP_CONTROL_WINDOW_TITLE || "",
      processId: managedTarget?.processId || 0,
    });
    targetPrewarm = await prewarmRealMeetAppControlTarget({
      meetingAgentUrl,
      sessionId,
      applicationName,
      windowTitle:
        managedTarget?.windowTitle || process.env.MAB_REAL_MEET_APP_CONTROL_WINDOW_TITLE || "",
      processId: managedTarget?.processId || 0,
    });
    if (!targetPrewarm.ok) {
      throw Object.assign(new Error("real Meet app-control target prewarm failed"), {
        last: { targetPrewarm },
      });
    }
    const turn = await runRealtimeAppControlTurn({
      meetingAgentUrl,
      sessionId,
      applicationName,
      instruction,
      appControlText,
      timeoutMs,
    });
    const final = turn.final;
    jobId = final.appControl?.jobId || final.joinStatus?.toolTelemetry?.appControlJobId || "";
    const ok = turn.ok;
    const result = {
      ok,
      acceptanceSatisfied: ok,
      meetUrl,
      meetUrlSource: realMeetUrl.source || "",
      sessionId,
      applicationName,
      instruction,
      appControlText,
      managedTarget: managedTarget
        ? {
            enabled: true,
            applicationName: managedTarget.applicationName,
            windowTitle: managedTarget.windowTitle,
            processId: managedTarget.processId,
            targetLabel: managedTarget.targetLabel,
          }
        : { enabled: false },
      targetPrewarm,
      join,
      share: compactAppControlEvidence(share),
      textTurn: turn.textTurn,
      final,
    };
    if (emit) await emitJsonResult(result);
    if (!ok && setExitCode) process.exitCode = 1;
    return result;
  } catch (error) {
    const result = {
      ok: false,
      acceptanceSatisfied: false,
      meetUrl,
      sessionId,
      applicationName,
      instruction,
      jobId,
      error: String(error?.message || error),
      errorBody: error?.compactBody || compactJsonForDiagnostics(error?.body || null),
      last: error?.last || null,
    };
    if (emit) await emitJsonResult(result, { error: true });
    if (setExitCode) process.exitCode = 1;
    return result;
  } finally {
    await postJson(`${meetingAgentUrl}/join/stop`, {
      reason: "real_meet_app_control_smoke_done",
    }).catch(() => {});
    await managedTarget?.close?.();
  }
}

export async function runRealMeetAppControlSuiteMain(options = {}) {
  const emit = options.emit !== false;
  const setExitCode = options.setExitCode !== false;
  const realMeetUrl = await resolveRealMeetUrl();
  const meetUrl = realMeetUrl.meetUrl || "";
  if (!meetUrl) {
    return await skipMissingRealMeetUrl(
      "real Meet app-control suite",
      "MAB_REAL_MEET_URL=https://meet.google.com/... npm run benchmark:realtime-real-app-control:suite",
      { emit, setExitCode, resolution: realMeetUrl },
    );
  }
  const meetingAgentUrl = (process.env.MAB_MEETING_AGENT_URL || "http://127.0.0.1:8781").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = envMs("MAB_REAL_MEET_APP_CONTROL_WAIT_MS", 180_000);
  const sessionId =
    process.env.MAB_REAL_MEET_SESSION_ID || `real_meet_app_control_suite_${Date.now()}`;
  const targetConfig = realMeetAppControlManagedTargetConfig();
  const applicationName = targetConfig.applicationName;
  const cases = defaultRealMeetAppControlSuiteCases(applicationName, targetConfig.targetLabel);
  const previousJobIds = new Set();
  let managedTarget = null;
  let targetPrewarm = null;
  try {
    managedTarget = await startManagedRealMeetAppControlTarget(targetConfig);
    const { join, share } = await startRealMeetAppControlSession({
      meetingAgentUrl,
      sessionId,
      meetUrl,
      applicationName,
      windowTitle:
        managedTarget?.windowTitle || process.env.MAB_REAL_MEET_APP_CONTROL_WINDOW_TITLE || "",
      processId: managedTarget?.processId || 0,
    });
    targetPrewarm = await prewarmRealMeetAppControlTarget({
      meetingAgentUrl,
      sessionId,
      applicationName,
      windowTitle:
        managedTarget?.windowTitle || process.env.MAB_REAL_MEET_APP_CONTROL_WINDOW_TITLE || "",
      processId: managedTarget?.processId || 0,
    });
    if (targetPrewarm.jobId) previousJobIds.add(targetPrewarm.jobId);
    if (!targetPrewarm.ok) {
      throw Object.assign(new Error("real Meet app-control target prewarm failed"), {
        last: { targetPrewarm },
      });
    }
    const suite = [];
    for (const testCase of cases) {
      const turn = await runRealtimeAppControlTurn({
        meetingAgentUrl,
        sessionId,
        applicationName,
        instruction: testCase.instruction,
        appControlText: testCase.appControlText,
        timeoutMs,
        caseKind: testCase.kind,
        previousJobIds,
      });
      const jobId =
        turn.final?.appControl?.jobId ||
        turn.final?.joinStatus?.toolTelemetry?.appControlJobId ||
        "";
      if (jobId) previousJobIds.add(jobId);
      const caseResult = {
        ...testCase,
        ...turn,
        ok: realMeetAppControlSuiteCasePasses({
          ...testCase,
          ...turn,
          expectedSessionId: sessionId,
        }),
      };
      caseResult.acceptanceSatisfied = caseResult.ok;
      suite.push(caseResult);
      if (!caseResult.ok) break;
    }
    const actionAcceptanceSatisfied =
      suite.length === cases.length && suite.every((testCase) => testCase.acceptanceSatisfied);
    const liveModelFirstLatency = buildRealMeetAppControlLiveLatencySummary(suite);
    const ok = actionAcceptanceSatisfied && liveModelFirstLatency.ok;
    const result = {
      ok,
      acceptanceSatisfied: ok,
      actionAcceptanceSatisfied,
      meetUrl,
      meetUrlSource: realMeetUrl.source || "",
      sessionId,
      applicationName,
      managedTarget: managedTarget
        ? {
            enabled: true,
            applicationName: managedTarget.applicationName,
            windowTitle: managedTarget.windowTitle,
            processId: managedTarget.processId,
            targetLabel: managedTarget.targetLabel,
          }
        : { enabled: false },
      targetPrewarm,
      join,
      share: compactAppControlEvidence(share),
      liveModelFirstLatency,
      suite: suite.map((testCase) => ({
        id: testCase.id,
        kind: testCase.kind,
        ok: testCase.ok === true,
        acceptanceSatisfied: testCase.acceptanceSatisfied === true,
        instruction: testCase.instruction,
        appControlText: testCase.appControlText,
        textTurn: testCase.textTurn,
        final: testCase.final,
      })),
    };
    if (emit) await emitJsonResult(result, { error: !ok });
    if (!ok && setExitCode) process.exitCode = 1;
    return result;
  } catch (error) {
    const result = {
      ok: false,
      acceptanceSatisfied: false,
      meetUrl,
      sessionId,
      applicationName,
      cases,
      error: String(error?.message || error),
      errorBody: error?.compactBody || compactJsonForDiagnostics(error?.body || null),
      last: error?.last || null,
    };
    if (emit) await emitJsonResult(result, { error: true });
    if (setExitCode) process.exitCode = 1;
    return result;
  } finally {
    await postJson(`${meetingAgentUrl}/join/stop`, {
      reason: "real_meet_app_control_suite_done",
    }).catch(() => {});
    await managedTarget?.close?.();
  }
}
