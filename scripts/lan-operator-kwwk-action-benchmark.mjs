#!/usr/bin/env node
/* eslint-disable max-lines */
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { chromium } from "playwright";

import { ensureAppControlHelperBinary } from "../packages/core/src/meeting/app-control-helper.ts";
import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import { attachLanAcceptanceSlo } from "./lan-operator-acceptance-slo.mjs";
import { runKwwkPhaseBlockerMatrix } from "./lan-operator-kwwk-blocker-probes.mjs";
import { runHardCancelProbe, spawnHelper } from "./lan-operator-kwwk-helper-process.mjs";
import {
  callHelperWithKwwkProgress,
  compactInFlightProgress,
} from "./lan-operator-kwwk-progress-stream.mjs";
import {
  configureMicrophoneDevice,
  lanOperatorVoiceBrowserLaunchArgs,
  lanOperatorVoiceOperatorPageUrl,
} from "./lan-operator-voice-acceptance.mjs";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-kwwk-action-latest.json";
const EXPECTED_TOOL = "kwwk_computer_use";
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 0,
    timeoutMs: 30_000,
    jsonOut: DEFAULT_JSON_OUT,
    headed: false,
    app: process.env.MAB_LAN_KWWK_ACTION_APP || "TextEdit",
    instruction: process.env.MAB_LAN_KWWK_ACTION_INSTRUCTION || "",
    mutationMarker: process.env.MAB_LAN_KWWK_ACTION_MARKER || "",
    inputMode: "synthetic_voice",
    minInputEnergy: null,
    micDeviceId: process.env.MAB_LAN_OPERATOR_MIC_DEVICE_ID || "",
    micLabel: process.env.MAB_LAN_OPERATOR_MIC_LABEL || "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--app") args.app = argv[++index];
    else if (arg === "--instruction") args.instruction = argv[++index];
    else if (arg === "--mutation-marker") args.mutationMarker = argv[++index];
    else if (arg === "--real-mic") args.inputMode = "real_mic";
    else if (arg === "--input-mode") args.inputMode = argv[++index];
    else if (arg === "--min-input-energy") args.minInputEnergy = Number(argv[++index]);
    else if (arg === "--mic-device-id") args.micDeviceId = String(argv[++index] || "");
    else if (arg === "--mic-label") args.micLabel = String(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!["synthetic_voice", "real_mic"].includes(args.inputMode)) {
    throw new Error("--input-mode must be synthetic_voice or real_mic");
  }
  if (args.minInputEnergy == null) {
    args.minInputEnergy = args.inputMode === "real_mic" ? 0.02 : 0;
  }
  if (!Number.isFinite(args.minInputEnergy) || args.minInputEnergy < 0) {
    throw new Error("--min-input-energy must be a non-negative number");
  }
  return args;
}

function printHelp() {
  console.log(
    [
      `Usage: node --import tsx scripts/lan-operator-kwwk-action-benchmark.mjs [options]`,
      "",
      "Options:",
      "  --host <host>          Bind host (default: 127.0.0.1)",
      "  --port <port>          Bind port, 0 means random (default: 0)",
      "  --timeout-ms <n>       Benchmark timeout (default: 30000)",
      "  --app <name>           Target macOS app for fixture action (default: TextEdit)",
      "  --instruction <text>   Host action instruction (default: type <mutation-marker>)",
      "  --mutation-marker <s>  Text marker for the TextEdit mutation fixture",
      "  --real-mic             Require real microphone energy before routing the spoken command",
      "  --input-mode <mode>    synthetic_voice or real_mic (default: synthetic_voice)",
      "  --min-input-energy <n> Minimum RMS energy for real_mic mode (default: 0.02)",
      "  --mic-device-id <id>   Select an exact browser audioinput device id",
      "  --mic-label <text>     Select the first browser audioinput label containing text",
      `  --json-out <path>      Write structured report (default: ${DEFAULT_JSON_OUT})`,
      "  --headed               Run Chromium headed",
    ].join("\n"),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRuntimeStatus(url, predicate, timeoutMs) {
  const statusUrl = new URL("/runtime/status", url);
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(statusUrl)).json();
    lastBody = body;
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime_status_timeout: ${JSON.stringify(lastBody)}`);
}

async function fetchDebugReport(url) {
  const body = await (await fetch(new URL("/runtime/report", url))).json();
  return body.report || body;
}

function createSpokenInputEvidence(args) {
  return {
    inputMode: args.inputMode,
    realMicrophoneRequired: args.inputMode === "real_mic",
    inputEnergyThreshold: args.minInputEnergy,
    maxInputEnergy: 0,
    inputEnergySamplesAboveThreshold: 0,
    realMicrophoneEvidenceOk: args.inputMode !== "real_mic",
    semanticRecognition:
      args.inputMode === "real_mic"
        ? "diagnostic_command_fixture_after_real_mic_energy"
        : "synthetic_voice_chunk",
    commandText: args.instruction,
    operatorPageUrl: "",
    requestedMicDeviceId: args.micDeviceId || "",
    requestedMicLabel: args.micLabel || "",
    micDeviceSelection: null,
  };
}

function observeSpokenInputEnergy(evidence, body) {
  const energy = Number(body?.debug?.voice?.lastEnergy);
  if (!Number.isFinite(energy)) return evidence;
  evidence.maxInputEnergy = Math.max(Number(evidence.maxInputEnergy || 0), energy);
  if (energy >= Number(evidence.inputEnergyThreshold || 0)) {
    evidence.inputEnergySamplesAboveThreshold += 1;
  }
  evidence.realMicrophoneEvidenceOk =
    evidence.realMicrophoneRequired !== true ||
    (String(body?.debug?.voice?.captureMode || "") === "microphone_pcm16" &&
      String(body?.debug?.voice?.permissionState || "") === "granted" &&
      evidence.inputEnergySamplesAboveThreshold >= 1);
  return evidence;
}

function spokenKwwkBlocker(args, spokenInput, error) {
  if (
    spokenInput?.micDeviceSelection?.requested === true &&
    spokenInput?.micDeviceSelection?.ok === false
  ) {
    return "requested_microphone_device_not_found";
  }
  if (args.inputMode === "real_mic" && spokenInput?.realMicrophoneEvidenceOk !== true) {
    return "real_microphone_input_energy_below_threshold";
  }
  const message = String(error?.message || error || "");
  if (message.startsWith("runtime_status_timeout")) return "spoken_kwwk_tool_turn_not_completed";
  return "spoken_kwwk_action_failed";
}

export function lanOperatorKwwkActionTurnContextFromStatus(status) {
  const rows = Array.isArray(status?.debug?.timeline?.rows) ? status.debug.timeline.rows : [];
  const toolRow = [...rows]
    .reverse()
    .find((row) => row?.event === "tool_call_started" && row?.turnId && row?.responseId);
  return {
    turnId: String(toolRow?.turnId || "turn_lan_kwwk_action_1"),
    responseId: String(toolRow?.responseId || "response_lan_kwwk_action_1"),
  };
}

function appleScriptString(value) {
  return JSON.stringify(String(value || ""));
}

function textIncludesMarker(textValue, marker) {
  const markerText = String(marker || "").toLowerCase();
  return markerText
    ? String(textValue || "")
        .toLowerCase()
        .includes(markerText)
    : false;
}

async function readTextEditFixtureWindowText(fixture = null) {
  if (!fixture?.windowTitle) return "";
  const script = `
set targetWindowName to ${appleScriptString(fixture.windowTitle)}
tell application "System Events"
tell process "TextEdit"
if not (exists window targetWindowName) then return ""
set targetWindow to window targetWindowName
try
return value of text area 1 of scroll area 1 of targetWindow
on error
return ""
end try
end tell
end tell`;
  const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 3000 });
  return stdout;
}

async function activateTextEditFixture(fixture = null) {
  const windowTitle = fixture?.windowTitle || "";
  const args = ["-e", 'tell application "TextEdit" to activate'];
  if (windowTitle) {
    args.push(
      "-e",
      `set targetWindowName to ${appleScriptString(windowTitle)}`,
      "-e",
      'tell application "System Events"',
      "-e",
      'tell process "TextEdit"',
      "-e",
      "if exists window targetWindowName then",
      "-e",
      'perform action "AXRaise" of window targetWindowName',
      "-e",
      "try",
      "-e",
      "set focused of text area 1 of scroll area 1 of window targetWindowName to true",
      "-e",
      "end try",
      "-e",
      "try",
      "-e",
      "click text area 1 of scroll area 1 of window targetWindowName",
      "-e",
      "end try",
      "-e",
      "end if",
      "-e",
      "end tell",
      "-e",
      "end tell",
    );
  }
  await execFileAsync("osascript", args, { timeout: 3000 }).catch(() => {});
  await sleep(300);
}

async function saveTextEditFixture(fixture = null) {
  const windowTitle = fixture?.windowTitle || "";
  const args = [
    "-e",
    `set targetWindowName to ${appleScriptString(windowTitle)}`,
    "-e",
    'tell application "TextEdit" to activate',
  ];
  if (windowTitle) {
    args.push(
      "-e",
      'tell application "System Events"',
      "-e",
      'tell process "TextEdit"',
      "-e",
      "set frontmost to true",
      "-e",
      "if exists window targetWindowName then",
      "-e",
      'perform action "AXRaise" of window targetWindowName',
      "-e",
      "end if",
      "-e",
      "end tell",
      "-e",
      "delay 0.2",
      "-e",
      'keystroke "s" using command down',
      "-e",
      "end tell",
    );
  } else {
    args.push(
      "-e",
      'tell application "System Events"',
      "-e",
      'keystroke "s" using command down',
      "-e",
      "end tell",
    );
  }
  await execFileAsync("osascript", args, { timeout: 3000 });
  await sleep(500);
}

async function textEditFixtureWindowExists(fixture) {
  if (!fixture?.windowTitle) return false;
  const { stdout } = await execFileAsync(
    "osascript",
    [
      "-e",
      `set targetWindowName to ${appleScriptString(fixture.windowTitle)}`,
      "-e",
      'tell application "System Events"',
      "-e",
      'tell process "TextEdit"',
      "-e",
      "set windowExists to exists window targetWindowName",
      "-e",
      "end tell",
      "-e",
      "end tell",
      "-e",
      "return windowExists",
    ],
    { timeout: 3000 },
  );
  return stdout.trim() === "true";
}

async function closeTextEditFixtureWindow(fixture) {
  if (!fixture || !(await textEditFixtureWindowExists(fixture))) return false;
  await saveTextEditFixture(fixture);
  await execFileAsync(
    "osascript",
    [
      "-e",
      `set targetWindowName to ${appleScriptString(fixture.windowTitle || "")}`,
      "-e",
      'tell application "TextEdit" to activate',
      "-e",
      'tell application "System Events"',
      "-e",
      'tell process "TextEdit"',
      "-e",
      "set frontmost to true",
      "-e",
      "if exists window targetWindowName then",
      "-e",
      'perform action "AXRaise" of window targetWindowName',
      "-e",
      "end if",
      "-e",
      "end tell",
      "-e",
      'keystroke "w" using command down',
      "-e",
      "end tell",
    ],
    { timeout: 3000 },
  );
  await sleep(500);
  return true;
}

async function cleanupStaleTextEditFixtureWindows() {
  await execFileAsync(
    "osascript",
    [
      "-e",
      'tell application "TextEdit" to activate',
      "-e",
      'tell application "System Events"',
      "-e",
      'tell process "TextEdit"',
      "-e",
      "set targetNames to {}",
      "-e",
      "repeat with w in windows",
      "-e",
      "set windowName to name of w",
      "-e",
      'if windowName starts with "oneesama-kwwk-fixture-" then set end of targetNames to windowName',
      "-e",
      "end repeat",
      "-e",
      "repeat with targetName in targetNames",
      "-e",
      "if exists window targetName then",
      "-e",
      "set frontmost to true",
      "-e",
      'perform action "AXRaise" of window targetName',
      "-e",
      'keystroke "s" using command down',
      "-e",
      "delay 0.2",
      "-e",
      'keystroke "w" using command down',
      "-e",
      "delay 0.3",
      "-e",
      "end if",
      "-e",
      "end repeat",
      "-e",
      "end tell",
      "-e",
      "end tell",
    ],
    { timeout: 5000 },
  ).catch(() => {});
}

async function setupTextEditFixture(args) {
  if (process.platform !== "darwin" || args.app !== "TextEdit") return null;
  await cleanupStaleTextEditFixtureWindows();
  const marker = args.mutationMarker || `oneesama kwwk ${Date.now().toString(36)}`;
  const file = `/tmp/oneesama-kwwk-fixture-${Date.now().toString(36)}.txt`;
  const windowTitle = basename(file);
  await writeFile(file, "Oneesama KWWK fixture\n");
  await execFileAsync("open", ["-a", "TextEdit", file]);
  await sleep(1200);
  await activateTextEditFixture({ windowTitle });
  return {
    kind: "textedit_temp_file",
    app: "TextEdit",
    file,
    windowTitle,
    marker,
    operation: { kind: "type_text", text: marker },
    target: { applicationName: "TextEdit", windowTitle },
  };
}

async function cleanupTextEditFixture(fixture) {
  if (!fixture) return null;
  const cleanup = {
    file: fixture.file,
    savedTextIncludesMarker: false,
    closeRequested: false,
    errors: [],
  };
  try {
    if (await textEditFixtureWindowExists(fixture)) {
      cleanup.closeRequested = await closeTextEditFixtureWindow(fixture);
    }
  } catch (error) {
    cleanup.errors.push(`close_failed:${error?.message || error}`);
  }
  try {
    const savedText = await readFile(fixture.file, "utf8");
    cleanup.savedTextIncludesMarker = textIncludesMarker(savedText, fixture.marker);
  } catch (error) {
    cleanup.errors.push(`read_failed:${error?.message || error}`);
  }
  await unlink(fixture.file).catch((error) => {
    cleanup.errors.push(`unlink_failed:${error?.message || error}`);
  });
  return cleanup;
}

function createToolRoutingEngine(args) {
  const toolArguments = {
    instruction: args.instruction,
    target: { applicationName: args.app, windowTitle: args.windowTitle || undefined },
  };
  let toolCallEmitted = false;
  let connectedEmitted = false;
  return {
    id: "diagnostic_lan_kwwk_action_engine",
    receiveVoiceChunk(chunk) {
      const ts = new Date().toISOString();
      const turnId = `turn_lan_kwwk_action_${Number(chunk.sequence || 1)}`;
      const responseId = `response_lan_kwwk_action_${Number(chunk.sequence || 1)}`;
      const engineConnected = connectedEmitted
        ? []
        : [
            {
              id: "lan_kwwk_action_engine_connected",
              ts,
              sessionId: chunk.sessionId,
              type: "engine_connected",
              engineId: this.id,
            },
          ];
      connectedEmitted = true;
      if (toolCallEmitted) {
        return {
          result: {
            ok: true,
            engineId: this.id,
            ignored: true,
            reason: "tool_call_already_emitted",
          },
          events: engineConnected,
        };
      }
      if (
        args.inputMode === "real_mic" &&
        Number(chunk.energy || 0) < Number(args.minInputEnergy || 0)
      ) {
        return {
          result: {
            ok: true,
            engineId: this.id,
            ignored: true,
            reason: "below_real_mic_energy_threshold",
          },
          events: engineConnected,
        };
      }
      toolCallEmitted = true;
      return {
        result: { ok: true, engineId: this.id },
        events: [
          ...engineConnected,
          {
            id: "lan_kwwk_action_speech_started",
            ts,
            sessionId: chunk.sessionId,
            type: "speech_started",
            engineId: this.id,
            turnId,
          },
          {
            id: "lan_kwwk_action_transcript_completed",
            ts,
            sessionId: chunk.sessionId,
            type: "transcript_completed",
            engineId: this.id,
            turnId,
            text: args.instruction,
          },
          {
            id: "lan_kwwk_action_tool_started",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_call_started",
            engineId: this.id,
            turnId,
            responseId,
            itemId: "item_lan_kwwk_action",
            detail: {
              expectedTool: EXPECTED_TOOL,
              name: EXPECTED_TOOL,
              callId: "call_lan_kwwk_action",
            },
          },
          {
            id: "lan_kwwk_action_tool_completed",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_call_completed",
            engineId: this.id,
            turnId,
            responseId,
            itemId: "item_lan_kwwk_action",
            text: JSON.stringify(toolArguments),
            detail: {
              expectedTool: EXPECTED_TOOL,
              name: EXPECTED_TOOL,
              callId: "call_lan_kwwk_action",
            },
          },
          {
            id: "lan_kwwk_action_tool_result",
            ts,
            sessionId: chunk.sessionId,
            type: "tool_result_accepted",
            engineId: this.id,
            turnId,
            responseId,
            itemId: "item_lan_kwwk_action",
            text: JSON.stringify({ ok: true, jobId: "lan_kwwk_action_job", status: "running" }),
            detail: {
              expectedTool: EXPECTED_TOOL,
              name: EXPECTED_TOOL,
              callId: "call_lan_kwwk_action",
            },
          },
        ],
      };
    },
    receiveToolResult(input) {
      const ts = new Date().toISOString();
      const followUpText =
        String(input.status || "") === "completed"
          ? "Done. I verified the focused app update."
          : `I stopped at ${String(input.status || "unknown")}.`;
      return {
        result: { ok: true, engineId: this.id, accepted: true, inputMode: "tool_result" },
        events: [
          {
            id: "lan_kwwk_action_real_tool_result",
            ts,
            sessionId: input.sessionId,
            type: "tool_result_accepted",
            engineId: this.id,
            turnId: input.turnId,
            responseId: input.responseId,
            itemId: input.itemId,
            text: JSON.stringify(input.output || {}),
            detail: {
              inputMode: "tool_result",
              source: input.source,
              expectedTool: input.toolName || EXPECTED_TOOL,
              name: input.toolName || EXPECTED_TOOL,
              callId: input.callId,
              jobId: input.jobId || "",
              status: input.status,
              surfaceContext: input.surfaceContext || {},
            },
          },
          {
            id: "lan_kwwk_action_followup_completed",
            ts,
            sessionId: input.sessionId,
            type: "assistant_text_completed",
            engineId: this.id,
            turnId: input.turnId,
            responseId: input.responseId,
            itemId: input.itemId,
            text: followUpText,
            detail: {
              inputMode: "tool_result_followup",
              compact: true,
              source: input.source,
              expectedTool: input.toolName || EXPECTED_TOOL,
              name: input.toolName || EXPECTED_TOOL,
              callId: input.callId,
              jobId: input.jobId || "",
              status: input.status,
            },
          },
        ],
      };
    },
  };
}

function modelPlan(operation) {
  return {
    status: "planned",
    summary: "LAN KWWK action benchmark uses a deterministic host fixture mutation.",
    blocker: "",
    operations: [operation],
  };
}

function compactVerification(result) {
  const verification = result?.metadata?.verification;
  if (!verification || typeof verification !== "object") return null;
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  const compactChecks = checks.map((check) => ({
    name: String(check?.name || ""),
    passed: check?.passed === true ? true : check?.passed === false ? false : null,
  }));
  return {
    schema: String(verification.schema || "") || null,
    ok: verification.ok === true,
    status: String(verification.status || "") || null,
    reason: String(verification.reason || "") || null,
    blocker: String(verification.blocker || "") || null,
    checkCount: compactChecks.length,
    failedCheckCount: compactChecks.filter((check) => check.passed === false).length,
    checks: compactChecks,
  };
}

function resultPostStateAccessibilityLabels(result) {
  const labels = result?.metadata?.verification?.postState?.accessibilityLabels;
  return Array.isArray(labels) ? labels.map((label) => String(label || "")) : [];
}

function resultPreStateAccessibilityLabels(result) {
  const labels = result?.metadata?.verification?.preState?.accessibilityLabels;
  return Array.isArray(labels) ? labels.map((label) => String(label || "")) : [];
}

function labelsContainMarker(labels, marker) {
  return Array.isArray(labels) && labels.some((label) => textIncludesMarker(label, marker));
}

function compactHelperFixtureEvidence(args, result, fixtureText = "") {
  if (!args.mutationFixture) return null;
  const marker = args.mutationMarker || "";
  const labels = resultPostStateAccessibilityLabels(result);
  return {
    file: args.mutationFixture.file,
    marker,
    helperPostStateAccessibilityIncludesMarker: labels.some((label) =>
      textIncludesMarker(label, marker),
    ),
    helperPostStateAccessibilityLabelCount: labels.length,
    accessibilityTextIncludesMarker: textIncludesMarker(fixtureText, marker),
    accessibilityTextLength: String(fixtureText || "").length,
  };
}

function verificationCheckPassed(verification, name) {
  return Array.isArray(verification?.checks)
    ? verification.checks.some((check) => check.name === name && check.passed === true)
    : false;
}

function compactMutationEvidence(args, sample, fixtureEvidence = null) {
  const fixture = args.mutationFixture || {};
  const fixtureVerified =
    fixtureEvidence?.helperPostStateAccessibilityIncludesMarker === true ||
    fixtureEvidence?.nextSamplePreStateAccessibilityIncludesMarker === true ||
    fixtureEvidence?.accessibilityTextIncludesMarker === true ||
    fixtureEvidence?.savedTextIncludesMarker === true;
  const axVerified = verificationCheckPassed(sample.verification, "accessibility_label_contains");
  const verified = fixtureVerified || axVerified;
  const verificationSource =
    fixtureEvidence?.helperPostStateAccessibilityIncludesMarker === true
      ? "helper_post_state_accessibility_labels"
      : fixtureEvidence?.nextSamplePreStateAccessibilityIncludesMarker === true
        ? "next_sample_pre_state_accessibility_labels"
        : fixtureEvidence?.savedTextIncludesMarker === true
          ? "textedit_cleanup_saved_file"
          : fixtureEvidence
            ? "textedit_accessibility_or_saved_file"
            : "accessibility_label";
  return {
    kind: fixture.kind || "unknown",
    app: args.app,
    windowTitle: args.windowTitle || "",
    marker: args.mutationMarker || "",
    actionKind: args.operation?.kind || "",
    verified,
    verificationCheck: fixtureEvidence
      ? "fixture_text_contains_marker"
      : "accessibility_label_contains",
    verificationSource,
    helperPostStateAccessibilityIncludesMarker:
      fixtureEvidence?.helperPostStateAccessibilityIncludesMarker,
    helperPostStateAccessibilityLabelCount: fixtureEvidence?.helperPostStateAccessibilityLabelCount,
    nextSamplePreStateAccessibilityIncludesMarker:
      fixtureEvidence?.nextSamplePreStateAccessibilityIncludesMarker,
    accessibilityTextIncludesMarker: fixtureEvidence?.accessibilityTextIncludesMarker,
    savedTextIncludesMarker: fixtureEvidence?.savedTextIncludesMarker,
  };
}

function sampleExecutedMutation(sample) {
  const telemetry = sample?.result?.metadata?.actionTelemetry;
  return Array.isArray(telemetry)
    ? telemetry.some((entry) => entry?.kind === "type_text" && entry?.success === true)
    : false;
}

function applyNextSampleMutationEvidence(args, cold, warm) {
  if (!args.mutationMarker || !cold || !warm || cold.mutation?.verified === true) return;
  const warmPreLabels = resultPreStateAccessibilityLabels(warm.result);
  if (!labelsContainMarker(warmPreLabels, args.mutationMarker) || !sampleExecutedMutation(cold))
    return;
  const fixtureEvidence = {
    file: args.mutationFixture?.file,
    marker: args.mutationMarker,
    nextSamplePreStateAccessibilityIncludesMarker: true,
  };
  cold.mutation = {
    ...compactMutationEvidence(args, cold, fixtureEvidence),
    verified: true,
    verificationSource: "next_sample_pre_state_accessibility_labels",
    nextSamplePreStateAccessibilityIncludesMarker: true,
  };
}

function applyCleanupMutationEvidence(args, kwwkResult, mutationCleanup) {
  if (!args.mutationMarker || mutationCleanup?.savedTextIncludesMarker !== true) return;
  for (const phase of ["cold", "warm"]) {
    const sample = kwwkResult?.[phase];
    if (!sample || !sampleExecutedMutation(sample)) continue;
    const fixtureEvidence = {
      file: mutationCleanup.file,
      marker: args.mutationMarker,
      savedTextIncludesMarker: true,
    };
    sample.mutation = compactMutationEvidence(args, sample, fixtureEvidence);
    sample.ok = sample.result?.ok === true && sample.verification?.ok === true;
    sample.status = sample.ok ? "completed" : sample.status;
    sample.blocker = sample.ok ? "" : sample.blocker;
  }
  if (kwwkResult?.mutation) {
    kwwkResult.mutation.cold = kwwkResult.cold?.mutation || kwwkResult.mutation.cold || null;
    kwwkResult.mutation.warm = kwwkResult.warm?.mutation || kwwkResult.mutation.warm || null;
    kwwkResult.mutation.verified =
      kwwkResult.mutation.cold?.verified === true || kwwkResult.mutation.warm?.verified === true;
  }
  kwwkResult.ok =
    kwwkResult?.cold?.ok === true &&
    kwwkResult?.warm?.ok === true &&
    kwwkResult?.mutation?.verified === true;
  kwwkResult.status = kwwkResult.ok ? "completed" : kwwkResult.status;
  kwwkResult.blocker = kwwkResult.ok ? "" : kwwkResult.blocker;
}

function compactPhaseEvidence(result, sample) {
  const metadata = result?.metadata || {};
  const state = metadata.state || {};
  const planner = metadata.planner || {};
  const cursor = metadata.cursor || {};
  const actionTelemetry = Array.isArray(metadata.actionTelemetry) ? metadata.actionTelemetry : [];
  const actionKinds = Array.isArray(planner.actionKinds)
    ? planner.actionKinds
    : Array.isArray(result?.actions)
      ? result.actions
      : [];
  const successCount = actionTelemetry.filter((action) => action?.success === true).length;
  const firstActionTarget = actionTelemetry[0]?.target || {};
  return {
    observe: {
      status: state.ok === true ? "observed" : state.ok === false ? "blocked" : "unknown",
      durationMs: sample.timings.observeMs,
      summary: String(metadata.observationMode || "unknown"),
      detail: {
        observationMode: metadata.observationMode || null,
        stateSource: state.source || null,
        focusedApplication:
          state.focusedApplication?.applicationName || state.focusedApplication?.name || null,
        accessibilityTrusted: state.accessibilityTrusted ?? null,
        windowIncluded: state.windowIncluded ?? null,
      },
    },
    plan: {
      status: planner.validation?.ok === false ? "blocked" : "planned",
      durationMs: sample.timings.planMs,
      summary: actionKinds.join(", ") || String(planner.provider || "planner"),
      detail: {
        provider: planner.provider || null,
        modelName: planner.modelName || null,
        modelUsed: planner.modelUsed === true,
        modelLatencyMs: Number.isFinite(Number(planner.modelLatencyMs))
          ? Number(planner.modelLatencyMs)
          : null,
        maxActions: Number.isFinite(Number(planner.maxActions)) ? Number(planner.maxActions) : null,
        actionKinds,
        validationOk: planner.validation?.ok ?? null,
      },
    },
    execute: {
      status: sample.ok ? "executed" : "blocked",
      durationMs: sample.timings.executeMs,
      summary: `${successCount}/${actionTelemetry.length} actions succeeded`,
      detail: {
        actionCount: actionTelemetry.length,
        successCount,
        actionKinds,
        cursorPolicy: cursor.policy || null,
        pointerAction: cursor.pointerAction === true,
        cursorEventCount: Array.isArray(cursor.events) ? cursor.events.length : 0,
        executionSurface: firstActionTarget.executionSurface || actionTelemetry[0]?.source || null,
        corePackage: firstActionTarget.corePackage || null,
        coreTimings: firstActionTarget.coreTimings || null,
      },
    },
    verify: {
      status: sample.verification?.status || (sample.verification?.ok ? "passed" : "unknown"),
      durationMs: sample.timings.verifyMs,
      summary: sample.verification?.reason || sample.verification?.status || null,
      detail: {
        ok: sample.verification?.ok ?? null,
        checkCount: sample.verification?.checkCount ?? null,
        failedCheckCount: sample.verification?.failedCheckCount ?? null,
        checks: sample.verification?.checks || [],
      },
    },
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedCoordinate(value, fallback = 0.5) {
  const number = finiteNumber(value);
  if (number == null) return fallback;
  return Math.max(0, Math.min(1, number));
}

export function operatorCursorKindFromKwwkEvent(kind) {
  const text = String(kind || "").toLowerCase();
  if (text.includes("click") || text.includes("press")) return "click";
  if (text.includes("drag")) return "drag";
  if (text.includes("target") || text.includes("highlight")) return "target";
  if (text.includes("done")) return "done";
  if (text.includes("blocked")) return "blocked";
  return "move";
}

export function operatorCursorFromKwwkEvent(event, input = {}) {
  const normalizedX = finiteNumber(event?.normalizedX);
  const normalizedY = finiteNumber(event?.normalizedY);
  const rawX = finiteNumber(event?.x);
  const rawY = finiteNumber(event?.y);
  const x = normalizedCoordinate(
    normalizedX ?? (rawX != null && rawX >= 0 && rawX <= 1 ? rawX : null),
  );
  const y = normalizedCoordinate(
    normalizedY ?? (rawY != null && rawY >= 0 && rawY <= 1 ? rawY : null),
  );
  const label = String(event?.label || input.label || "").trim();
  return {
    x,
    y,
    kind: operatorCursorKindFromKwwkEvent(event?.kind || input.kind),
    label,
    sourceId: String(input.sourceId || "host-app"),
  };
}

export function operatorCursorsFromKwwkResult(result, input = {}) {
  const events = result?.metadata?.cursor?.events;
  if (!Array.isArray(events)) return [];
  return events
    .filter((event) => event && typeof event === "object")
    .map((event) => operatorCursorFromKwwkEvent(event, input));
}

function replayKwwkCursorEventsToOperator(surface, result, input = {}) {
  if (!surface?.emitKwwkCursor) return [];
  const cursors = operatorCursorsFromKwwkResult(result, input);
  for (const cursor of cursors) surface.emitKwwkCursor(cursor);
  return cursors;
}

async function runKwwkCursorReplayProbe(input) {
  const { args, page, binary, baseKwwkState, target, modelPlan: buildModelPlan, surface } = input;
  const jobId = "lan_kwwk_cursor_replay_probe";
  const operation = {
    kind: "scroll",
    direction: "down",
    pages: 1,
  };
  const helper = spawnHelper(binary, args.timeoutMs, operation, buildModelPlan);
  try {
    await page.evaluate((state) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(state), {
      ...baseKwwkState,
      jobId,
      status: "executing",
      target,
      action: { kind: "scroll", label: "cursor replay probe", status: "running" },
      phaseEvidence: {
        execute: {
          status: "running",
          durationMs: 0,
          summary: "helper pointer request running for cursor replay",
          detail: { source: "kwwk_cursor_replay_probe", helperRequestId: jobId },
        },
      },
    });
    const output = await callHelperWithKwwkProgress(
      helper,
      {
        jsonrpc: "2.0",
        id: jobId,
        method: "kwwk.cu.execute",
        params: {
          instruction: "scroll the target window once for LAN operator cursor replay evidence",
          target,
          includeScreenshot: false,
          modelPlan: buildModelPlan(operation),
          verification: { useLightObservation: true },
        },
      },
      {
        page,
        baseKwwkState,
        jobId,
        target,
        instruction: "cursor replay probe",
        operation,
      },
    );
    const result = output.response?.result || {};
    const cursors = replayKwwkCursorEventsToOperator(surface, result, {
      sourceId: "host-app",
      label: "cursor replay",
    });
    const stage = await page.evaluate(
      async (stageInput) => {
        if (stageInput.cursorCount > 0) {
          await new Promise((resolve) => requestAnimationFrame(() => resolve()));
          await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        }
        const artifact = window.MAB_LAN_OPERATOR_KWWK_CURSOR?.artifact?.() || {};
        const overlays = window.MAB_LAN_OPERATOR_SURFACE?.state?.overlays || [];
        return {
          cursorArtifactEventCount: Array.isArray(artifact.events) ? artifact.events.length : 0,
          cursorVisible: window.MAB_LAN_OPERATOR_KWWK_CURSOR?.snapshot?.()?.visible === true,
          remoteOverlayCount: overlays.filter((overlay) => overlay.remote === true).length,
        };
      },
      { cursorCount: cursors.length },
    );
    const ok = result.ok === true && cursors.length > 0 && stage.cursorVisible === true;
    await page.evaluate((state) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(state), {
      ...baseKwwkState,
      jobId,
      status: ok ? "completed" : "failed",
      blocker: ok ? "" : "kwwk_cursor_replay_probe_failed",
      target,
      action: { kind: "scroll", label: "cursor replay probe", status: ok ? "completed" : "failed" },
      actionCount: 1,
      phaseEvidence: {
        execute: {
          status: ok ? "executed" : "blocked",
          durationMs: output.durationMs,
          summary: `${cursors.length} helper cursor event(s) replayed`,
          detail: {
            source: "kwwk_cursor_replay_probe",
            cursorPolicy: result.metadata?.cursor?.policy || null,
            cursorEventCount: cursors.length,
            stage,
          },
        },
      },
    });
    return {
      ok,
      jobId,
      action: operation.kind,
      requestMs: output.durationMs,
      helperCursorEventCount: cursors.length,
      helperCursorEvents: cursors,
      stage,
      result,
    };
  } catch (error) {
    await page.evaluate((state) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(state), {
      ...baseKwwkState,
      jobId,
      status: "failed",
      blocker: String(error?.message || error),
      target,
      action: { kind: "scroll", label: "cursor replay probe", status: "failed" },
    });
    return { ok: false, jobId, action: operation.kind, error: String(error?.message || error) };
  } finally {
    await helper.closeHelper().catch(() => {});
  }
}

async function runKwwkAction(args, page, turnContext = {}, surface = null) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "app_control_helper_requires_darwin" };
  }
  const operation = args.operation || {
    kind: "type_text",
    text: args.mutationMarker || "oneesama kwwk",
  };
  const target = args.target || {
    applicationName: args.app,
    windowTitle: args.windowTitle || undefined,
  };
  const baseKwwkState = {
    turnId: String(turnContext.turnId || "turn_lan_kwwk_action_1"),
    responseId: String(turnContext.responseId || "response_lan_kwwk_action_1"),
  };
  const actionInputs = [
    { phase: "cold", jobId: "lan_kwwk_action_job_cold", setupMs: 0 },
    { phase: "warm", jobId: "lan_kwwk_action_job_warm", setupMs: 0 },
  ];
  await page.evaluate((input) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(input), {
    ...baseKwwkState,
    jobId: actionInputs[0].jobId,
    status: "queued",
    target,
  });
  await page.evaluate((input) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(input), {
    ...baseKwwkState,
    jobId: actionInputs[0].jobId,
    status: "observing",
    target,
  });
  const helperStartedAt = performance.now();
  const binary = await ensureAppControlHelperBinary();
  const helper = spawnHelper(binary, args.timeoutMs, operation, modelPlan);
  actionInputs[0].setupMs = Math.round(performance.now() - helperStartedAt);
  try {
    const samples = [];
    for (const actionInput of actionInputs) {
      await page.evaluate((input) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(input), {
        ...baseKwwkState,
        jobId: actionInput.jobId,
        status: "planning",
        target,
      });
      let response;
      let durationMs;
      try {
        if (args.mutationFixture) await activateTextEditFixture(args.mutationFixture);
        const output = await callHelperWithKwwkProgress(
          helper,
          {
            jsonrpc: "2.0",
            id: actionInput.jobId,
            method: "kwwk.cu.execute",
            params: {
              instruction: args.instruction,
              target,
              includeScreenshot: actionInput.phase === "cold",
              modelPlan: modelPlan(operation),
              verification: { useLightObservation: true },
            },
          },
          {
            page,
            baseKwwkState,
            jobId: actionInput.jobId,
            target,
            instruction: args.instruction,
            operation,
          },
        );
        response = output.response;
        durationMs = output.durationMs;
        actionInput.inFlightProgress = output.inFlightProgress;
      } catch (error) {
        await page.evaluate((input) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(input), {
          ...baseKwwkState,
          jobId: actionInput.jobId,
          status: "failed",
          blocker: String(error?.message || error),
          target,
        });
        return {
          ok: false,
          status: "failed",
          blocker: String(error?.message || error),
          durationMs: args.timeoutMs,
          cold: actionInput.phase === "cold" ? { ok: false, totalMs: args.timeoutMs } : null,
          warm: actionInput.phase === "warm" ? { ok: false, totalMs: args.timeoutMs } : null,
          result: null,
        };
      }
      const result = response?.result || {};
      const timings = result?.metadata?.timings || {};
      const fixtureText = args.mutationFixture
        ? await readTextEditFixtureWindowText(args.mutationFixture).catch(() => "")
        : "";
      const fixtureVerification = compactHelperFixtureEvidence(args, result, fixtureText);
      const verification = compactVerification(result);
      const actionKind = Array.isArray(result.actions) ? result.actions[0] : "";
      const sample = {
        phase: actionInput.phase,
        jobId: actionInput.jobId,
        ok: false,
        status: "failed",
        blocker: "",
        requestMs: durationMs,
        setupMs: actionInput.setupMs,
        totalMs: durationMs + actionInput.setupMs,
        timings: {
          observeMs: Number(timings.observeMs || 0),
          planMs: Number(timings.planMs || result?.metadata?.planner?.latencyMs || 0),
          executeMs: Number(timings.executeMs || 0),
          verifyMs: Number(timings.verifyMs || 0),
          helperTotalMs: Number(timings.totalMs || durationMs),
        },
        verification,
        mutation: null,
        fixtureVerification,
        phaseEvidence: null,
        inFlightProgress: actionInput.inFlightProgress || [],
        result,
      };
      sample.mutation = compactMutationEvidence(args, sample, fixtureVerification);
      sample.ok = result.ok === true && sample.verification?.ok === true;
      sample.status = sample.ok ? "completed" : result.status === "blocked" ? "blocked" : "failed";
      sample.blocker = sample.ok
        ? ""
        : result.blocker ||
          result.error ||
          sample.verification?.blocker ||
          (sample.mutation?.verified ? "" : "fixture_mutation_missing");
      sample.phaseEvidence = compactPhaseEvidence(result, sample);
      sample.operatorCursorEvents = replayKwwkCursorEventsToOperator(surface, result, {
        sourceId: "host-app",
        label: actionKind || operation.kind || "kwwk",
      });
      samples.push(sample);
      for (const [phase, statusName] of [
        ["observe", "observing"],
        ["plan", "planning"],
      ]) {
        await page.evaluate((input) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(input), {
          ...baseKwwkState,
          jobId: sample.jobId,
          status: statusName,
          actionCount: samples.length,
          target,
          timings: {
            observeMs: sample.timings.observeMs,
            planMs: sample.timings.planMs,
            executeMs: sample.timings.executeMs,
            verifyMs: sample.timings.verifyMs,
            totalMs: sample.totalMs,
          },
          phaseEvidence: { [phase]: sample.phaseEvidence[phase] },
        });
      }
      await page.evaluate((input) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(input), {
        ...baseKwwkState,
        jobId: sample.jobId,
        status: "executing",
        action: {
          kind: actionKind || operation.kind || "action",
          label: `${sample.phase}: ${args.instruction}`,
          status: sample.status,
        },
        actionCount: samples.length,
        target,
        phaseEvidence: { execute: sample.phaseEvidence.execute },
      });
      await page.evaluate((input) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(input), {
        ...baseKwwkState,
        jobId: sample.jobId,
        status: "verifying",
        actionCount: samples.length,
        target,
        timings: {
          observeMs: sample.timings.observeMs,
          planMs: sample.timings.planMs,
          executeMs: sample.timings.executeMs,
          verifyMs: sample.timings.verifyMs,
          totalMs: sample.totalMs,
        },
        verification: sample.verification,
        phaseEvidence: { verify: sample.phaseEvidence.verify },
      });
      await page.evaluate((input) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(input), {
        ...baseKwwkState,
        jobId: sample.jobId,
        status: sample.status,
        blocker: sample.blocker,
        actionCount: samples.length,
        target,
        timings: {
          observeMs: sample.timings.observeMs,
          planMs: sample.timings.planMs,
          executeMs: sample.timings.executeMs,
          verifyMs: sample.timings.verifyMs,
          totalMs: sample.totalMs,
        },
        verification: sample.verification,
        phaseEvidence: sample.phaseEvidence,
      });
    }
    const cold = samples.find((sample) => sample.phase === "cold") || null;
    const warm = samples.find((sample) => sample.phase === "warm") || null;
    applyNextSampleMutationEvidence(args, cold, warm);
    const hardCancel = await runHardCancelProbe({
      args,
      page,
      binary,
      baseKwwkState,
      target,
      operation,
      modelPlan,
    });
    const phaseBlockers = await runKwwkPhaseBlockerMatrix(args, binary, modelPlan);
    const kwwkResult = {
      cold,
      warm,
      hardCancel,
      phaseBlockers,
      inFlightProgress: compactInFlightProgress(cold, warm),
      mutation: {
        marker: args.mutationMarker || "",
        fixture: args.mutationFixture || null,
        cold: cold?.mutation || null,
        warm: warm?.mutation || null,
        verified: cold?.mutation?.verified === true || warm?.mutation?.verified === true,
      },
      mutationCleanup: null,
      result: { cold: cold?.result || null, warm: warm?.result || null },
    };
    const samplesOk = samples.every(
      (sample) => sample.ok === true && sample.verification?.ok === true,
    );
    const sampleStatus =
      samplesOk &&
      (!args.mutationMarker || kwwkResult.mutation?.verified === true) &&
      hardCancel?.ok === true
        ? "completed"
        : samples.find((sample) => sample.status !== "completed")?.status || "failed";
    const sampleBlocker = samples.find((sample) => sample.blocker)?.blocker || "";
    const finalSample = warm || cold;
    if (finalSample) {
      await page.evaluate((input) => window.MAB_LAN_OPERATOR_SURFACE.emitKwwkJobState(input), {
        ...baseKwwkState,
        jobId: finalSample.jobId,
        status: sampleStatus,
        blocker: sampleBlocker,
        actionCount: samples.length,
        target,
        timings: {
          observeMs: finalSample.timings.observeMs,
          planMs: finalSample.timings.planMs,
          executeMs: finalSample.timings.executeMs,
          verifyMs: finalSample.timings.verifyMs,
          totalMs: finalSample.totalMs,
        },
        verification: finalSample.verification,
        phaseEvidence: finalSample.phaseEvidence,
      });
    }
    const cursorReplayProbe = await runKwwkCursorReplayProbe({
      args,
      page,
      binary,
      baseKwwkState,
      target,
      modelPlan,
      surface,
    });
    kwwkResult.cursorReplayProbe = cursorReplayProbe;
    if (args.mutationFixture) {
      kwwkResult.mutationCleanup = await cleanupTextEditFixture(args.mutationFixture);
      applyCleanupMutationEvidence(args, kwwkResult, kwwkResult.mutationCleanup);
    }
    const ok =
      samplesOk &&
      (!args.mutationMarker || kwwkResult.mutation?.verified === true) &&
      hardCancel?.ok === true &&
      cursorReplayProbe.ok === true;
    const status = ok ? "completed" : cursorReplayProbe.ok === true ? sampleStatus : "failed";
    const blocker =
      sampleBlocker || (cursorReplayProbe.ok === true ? "" : "kwwk_cursor_replay_probe_failed");
    await page.evaluate((input) => window.MAB_LAN_OPERATOR_SURFACE.submitToolResult(input), {
      ...baseKwwkState,
      callId: "call_lan_kwwk_action",
      itemId: "item_lan_kwwk_action",
      toolName: EXPECTED_TOOL,
      jobId: cursorReplayProbe.jobId || warm?.jobId || cold?.jobId || "lan_kwwk_action_job",
      status,
      output: {
        ok,
        status,
        blocker,
        mutation: kwwkResult.mutation,
        cold,
        warm,
        hardCancel,
        cursorReplayProbe,
      },
      source: "kwwk",
    });
    return {
      ...kwwkResult,
      ok,
      status,
      blocker,
      durationMs: cold?.totalMs ?? null,
      warmDurationMs: warm?.totalMs ?? null,
    };
  } finally {
    await helper.closeHelper();
  }
}

function buildBenchmarkReport(input) {
  const {
    args,
    listenResult,
    runtimeStatus,
    debugReport,
    kwwkResult,
    mutationCleanup,
    spokenInput,
    startedAt,
    completedMs,
  } = input;
  const debug = runtimeStatus?.debug || {};
  const toolRouting = debug.toolRouting || {};
  const kwwk = debug.kwwk || {};
  const output = debug.output || {};
  const assistantText = output.assistantText || {};
  const compactFollowUpText = String(assistantText.completedText || "");
  const compactFollowUpDelivered =
    Number(debug.conversation?.eventCounts?.assistant_text_completed || 0) >= 1 &&
    compactFollowUpText.length > 0 &&
    compactFollowUpText.length <= 240;
  const timeline = debugReport?.timeline || debug.timeline?.rows || [];
  const turns = debugReport?.debug?.timeline?.turns || debug.timeline?.turns || [];
  const ok =
    runtimeStatus?.ok === true &&
    toolRouting.expectedTool === EXPECTED_TOOL &&
    toolRouting.actualTool === EXPECTED_TOOL &&
    toolRouting.functionOutputDelivered === true &&
    toolRouting.argumentSafety?.ok === true &&
    kwwkResult?.ok === true &&
    kwwk.status === "completed" &&
    kwwk.actionCount >= 1 &&
    kwwkResult?.cold?.verification?.ok === true &&
    kwwkResult?.warm?.verification?.ok === true &&
    kwwkResult?.hardCancel?.ok === true &&
    kwwkResult?.cursorReplayProbe?.ok === true &&
    kwwkResult?.inFlightProgress?.phaseCountBeforeResponse >= 3 &&
    kwwkResult?.mutation?.verified === true &&
    compactFollowUpDelivered &&
    (spokenInput?.realMicrophoneRequired !== true ||
      spokenInput?.realMicrophoneEvidenceOk === true);

  return {
    schema: "oneesama.lan_voice_acceptance.v1",
    gate: "local_kwwk_action",
    ok,
    functionalOk: ok,
    generatedAt: new Date().toISOString(),
    host: {
      url: listenResult?.url || "",
      lanAddress: listenResult?.host || "",
      trustedLanOperatorMode: true,
      lanModeExplicitlyEnabled: true,
    },
    operatorSurface: {
      id: runtimeStatus?.snapshot?.sessionId || "",
      voiceMode: "always_on",
    },
    spokenInput: spokenInput || null,
    tool: {
      expectedTool: toolRouting.expectedTool || "",
      actualTool: toolRouting.actualTool || "",
      callId: toolRouting.callId || "",
      argumentSafety: toolRouting.argumentSafety || null,
      functionOutputDelivered: toolRouting.functionOutputDelivered === true,
      canonicalBoundary: {
        schema: "oneesama.canonical_tool_boundary.v1",
        source: "conversation_engine_port",
        providerAgnostic: true,
        canonicalToolEventCount: timeline.filter((row) =>
          ["tool_call_started", "tool_call_completed", "tool_result_accepted"].includes(row?.event),
        ).length,
        providerRawEventLeakCount: 0,
        rawOperationsExposed: toolRouting.argumentSafety?.exposesRawOperations === true,
        coordinatesExposed: toolRouting.argumentSafety?.exposesCoordinates === true,
      },
    },
    kwwk: {
      jobId: kwwk.currentJobId || "",
      provider: "host_kwwk_helper",
      status: kwwk.status || "",
      blocker: kwwk.blocker || kwwkResult?.blocker || "",
      latestActionKind: kwwk.latestActionKind || (kwwk.actions || []).at(-1)?.kind || "",
      actionCount: kwwk.actionCount || 0,
      actions: (kwwk.actions || []).map((action) => action.kind),
      cursorEventCount: kwwk.cursorEventCount || 0,
      cursorPolicy:
        kwwk.phaseEvidence?.execute?.detail?.cursorPolicy ||
        kwwkResult?.warm?.phaseEvidence?.execute?.detail?.cursorPolicy ||
        kwwkResult?.cold?.phaseEvidence?.execute?.detail?.cursorPolicy ||
        "",
      observeMs: kwwk.timings?.observeMs ?? null,
      planMs: kwwk.timings?.planMs ?? null,
      executeMs: kwwk.timings?.executeMs ?? null,
      verifyMs: kwwk.timings?.verifyMs ?? null,
      totalMs: kwwkResult?.cold?.totalMs ?? kwwk.timings?.totalMs ?? kwwkResult?.durationMs ?? null,
      phaseEvidence:
        kwwk.phaseEvidence ||
        kwwkResult?.warm?.phaseEvidence ||
        kwwkResult?.cold?.phaseEvidence ||
        null,
      inFlightProgress: kwwkResult?.inFlightProgress || null,
      verification:
        kwwk.verification ||
        kwwkResult?.warm?.verification ||
        kwwkResult?.cold?.verification ||
        null,
      mutation: kwwkResult?.mutation || null,
      hardCancel: kwwkResult?.hardCancel || null,
      cursorReplayProbe: kwwkResult?.cursorReplayProbe || null,
      phaseBlockers: kwwkResult?.phaseBlockers || null,
      mutationCleanup: mutationCleanup || null,
      cold: kwwkResult?.cold || null,
      warm: kwwkResult?.warm || null,
      rawResult: kwwkResult?.result || null,
    },
    output: {
      assistantText,
      compactFollowUpDelivered,
      compactFollowUpText,
      compactFollowUpMaxChars: 240,
    },
    timeline,
    turns,
    debugReport,
    timings: {
      totalWallMs: Math.round(performance.now() - startedAt),
      completedMs,
    },
    args: {
      app: args.app,
      instruction: args.instruction,
      windowTitle: args.windowTitle || "",
      mutationMarker: args.mutationMarker || "",
      timeoutMs: args.timeoutMs,
      headed: args.headed,
      inputMode: args.inputMode,
      minInputEnergy: args.minInputEnergy,
      micDeviceId: args.micDeviceId,
      micLabel: args.micLabel,
    },
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  args.mutationMarker = args.mutationMarker || `oneesama kwwk ${Date.now().toString(36)}`;
  args.instruction = args.instruction || `type ${args.mutationMarker}`;
  const mutationFixture = await setupTextEditFixture(args);
  if (mutationFixture) {
    args.app = mutationFixture.app;
    args.windowTitle = mutationFixture.windowTitle;
    args.operation = mutationFixture.operation;
    args.target = mutationFixture.target;
    args.mutationFixture = {
      kind: mutationFixture.kind,
      app: mutationFixture.app,
      windowTitle: mutationFixture.windowTitle,
      file: mutationFixture.file,
    };
  } else {
    args.operation = { kind: "type_text", text: args.mutationMarker };
    args.target = { applicationName: args.app };
  }
  const startedAt = performance.now();
  const surface = createLanOperatorSurfaceServer({
    host: args.host,
    port: args.port,
    sessionId: `lan_kwwk_action_${Date.now().toString(36)}`,
    botName: "LAN Oneesama",
    conversationEngine: createToolRoutingEngine(args),
  });
  let browser = null;
  let context = null;
  let page = null;
  let report = null;
  let listenResult = null;
  let mutationCleanup = null;
  const spokenInput = createSpokenInputEvidence(args);
  try {
    listenResult = await surface.listen();
    spokenInput.operatorPageUrl = lanOperatorVoiceOperatorPageUrl(listenResult.url);
    browser = await chromium.launch({
      headless: !args.headed,
      args: lanOperatorVoiceBrowserLaunchArgs(listenResult.url, {
        inputMode: args.inputMode === "real_mic" ? "real_mic" : "fake_mic",
      }),
    });
    context = await browser.newContext({
      permissions: args.inputMode === "real_mic" ? ["microphone"] : [],
      viewport: { width: 1366, height: 860 },
    });
    page = await context.newPage();
    await page.goto(spokenInput.operatorPageUrl);
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: args.timeoutMs,
    });
    if (args.inputMode === "real_mic") {
      await page.evaluate(() => window.MAB_LAN_OPERATOR_SURFACE.configureLocalVad(false));
      spokenInput.micDeviceSelection = await configureMicrophoneDevice(page, args);
      if (
        spokenInput.micDeviceSelection?.requested === true &&
        spokenInput.micDeviceSelection?.ok === false
      ) {
        throw new Error(
          `microphone_device_selection_failed: ${JSON.stringify(spokenInput.micDeviceSelection)}`,
        );
      }
      await page.click("#voice-button");
    } else {
      await page.evaluate(() =>
        window.MAB_LAN_OPERATOR_SURFACE.sendSyntheticVoiceChunk({
          sequence: 1,
          sampleRate: 24000,
          channels: 1,
          durationMs: 20,
          energy: 0.42,
          source: "diagnostic_lan_kwwk_action_pcm16",
        }),
      );
    }
    const spokenReadyStatus = await waitForRuntimeStatus(
      listenResult.url,
      (body) => {
        observeSpokenInputEnergy(spokenInput, body);
        return (
          body.debug.toolRouting.status === "result_accepted" &&
          body.debug.toolRouting.functionOutputDelivered === true &&
          (args.inputMode !== "real_mic" || spokenInput.realMicrophoneEvidenceOk === true)
        );
      },
      args.timeoutMs,
    );
    if (args.inputMode === "real_mic") {
      await page.evaluate(() =>
        window.MAB_LAN_OPERATOR_SURFACE.stopMicrophone("spoken_kwwk_action_ready"),
      );
    }
    const turnContext = lanOperatorKwwkActionTurnContextFromStatus(spokenReadyStatus);
    spokenInput.turnContext = turnContext;
    const kwwkResult = await runKwwkAction(args, page, turnContext, surface);
    mutationCleanup = kwwkResult.mutationCleanup || null;
    const runtimeStatus = await waitForRuntimeStatus(
      listenResult.url,
      (body) =>
        (body.debug.kwwk.status === "completed" ||
          body.debug.kwwk.status === "blocked" ||
          body.debug.kwwk.status === "failed") &&
        Number(body.debug.conversation.eventCounts.tool_result_accepted || 0) >= 2 &&
        Number(body.debug.conversation.eventCounts.assistant_text_completed || 0) >= 1,
      args.timeoutMs,
    );
    const completedMs = Math.round(performance.now() - startedAt);
    await page.evaluate(() =>
      window.MAB_LAN_OPERATOR_SURFACE.markInterestingRun({ label: "lan_kwwk_action_benchmark" }),
    );
    const debugReport = await fetchDebugReport(listenResult.url);
    report = buildBenchmarkReport({
      args,
      listenResult,
      runtimeStatus,
      debugReport,
      kwwkResult,
      mutationCleanup,
      spokenInput,
      startedAt,
      completedMs,
    });
  } catch (error) {
    const runtimeStatus = surface.status("failed");
    const debugReport = listenResult
      ? await fetchDebugReport(listenResult.url).catch(() => null)
      : null;
    const blocker = spokenKwwkBlocker(args, spokenInput, error);
    report = {
      schema: "oneesama.lan_voice_acceptance.v1",
      gate: "local_kwwk_action",
      ok: false,
      functionalOk: false,
      generatedAt: new Date().toISOString(),
      error: String(error?.message || error),
      blocker,
      acceptanceBlocker: blocker,
      host: { url: listenResult?.url || "" },
      spokenInput,
      debugReport,
      runtimeStatus,
    };
  } finally {
    if (!mutationCleanup) await cleanupTextEditFixture(mutationFixture).catch(() => {});
    await context?.close().catch(() => undefined);
    await browser?.close();
    await surface.close();
  }

  report = attachLanAcceptanceSlo(report);
  await writeJson(args.jsonOut, report);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        functionalOk: report.functionalOk,
        sloOk: report.slo?.ok,
        sloFailures: report.slo?.failures?.map((failure) => failure.id) || [],
        blocker: report.blocker || report.acceptanceBlocker,
        jsonOut: args.jsonOut,
        gate: report.gate,
        inputMode: report.spokenInput?.inputMode,
        maxInputEnergy: report.spokenInput?.maxInputEnergy,
        cursorReplayProbeOk: report.kwwk?.cursorReplayProbe?.ok === true,
        cursorReplayProbeEventCount: report.kwwk?.cursorReplayProbe?.helperCursorEventCount || 0,
      },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
}

await run();
