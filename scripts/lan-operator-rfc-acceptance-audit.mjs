#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { LOCAL_OPERATOR_GATES, normalizeLocalOperatorGate } from "./local-operator-gates.mjs";

const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-rfc-acceptance-audit-latest.json";
const DEFAULT_MAX_AGE_HOURS = 72;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sloEntry(report, id) {
  return (report?.slo?.entries || []).find((entry) => entry.id === id) || null;
}

function suiteEntry(report, gate, id) {
  return (report?.gates?.[gate]?.entries || []).find((entry) => entry.id === id) || null;
}

function compactObject(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    output[key] = value;
  }
  return output;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function sloFailureIds(report) {
  if (Array.isArray(report?.sloFailures)) return report.sloFailures;
  if (Array.isArray(report?.slo?.failures)) {
    return report.slo.failures.map((failure) => failure?.id || String(failure));
  }
  return [];
}

function artifactFailureDetail(report) {
  const providerFailure = report?.providerFailure || report?.provider?.failure || {};
  const hostAppPublisher = report?.visual?.publisherEvidence?.hostApp || {};
  const micEvidence = report?.audio || report?.spokenInput || {};
  const runtimeVoice = report?.runtimeStatus?.debug?.voice || {};
  const micSelection = micEvidence?.micDeviceSelection || {};
  const availableDevices = Array.isArray(micEvidence?.availableDevices)
    ? micEvidence.availableDevices
    : Array.isArray(micSelection?.availableDevices)
      ? micSelection.availableDevices
      : [];
  const detail = compactObject({
    gate: stringOrNull(report?.gate),
    ok: typeof report?.ok === "boolean" ? report.ok : null,
    acceptanceSatisfied:
      typeof report?.acceptanceSatisfied === "boolean" ? report.acceptanceSatisfied : null,
    acceptanceBlocker: stringOrNull(report?.acceptanceBlocker),
    blocker: stringOrNull(report?.blocker),
    blockerSource: stringOrNull(report?.blockerSource),
    reason: stringOrNull(report?.reason),
    requiredFix: stringOrNull(report?.requiredFix),
    command: stringOrNull(report?.command),
    message: stringOrNull(report?.message),
    discoveryError: stringOrNull(report?.discoveryError),
    activeBrowserRecordError: stringOrNull(report?.activeBrowserRecordError),
    missingEnv: Array.isArray(report?.missingEnv) ? report.missingEnv : [],
    checkedSources: Array.isArray(report?.checkedSources) ? report.checkedSources : [],
    providerFailureBlocker: stringOrNull(providerFailure?.blocker),
    providerFailureCategory: stringOrNull(providerFailure?.category),
    sloFailures: sloFailureIds(report),
    providerEventCounts: report?.providerEventCounts || null,
    realMicrophoneRequired:
      typeof micEvidence?.realMicrophoneRequired === "boolean"
        ? micEvidence.realMicrophoneRequired
        : null,
    realMicrophoneEvidenceOk:
      typeof micEvidence?.realMicrophoneEvidenceOk === "boolean"
        ? micEvidence.realMicrophoneEvidenceOk
        : null,
    selectedMicLabel:
      stringOrNull(micEvidence?.selectedDeviceLabel) ||
      stringOrNull(runtimeVoice?.deviceLabel) ||
      stringOrNull(micSelection?.selectedLabel),
    selectedMicDeviceId:
      stringOrNull(micEvidence?.selectedDeviceId) ||
      stringOrNull(runtimeVoice?.deviceId) ||
      stringOrNull(micSelection?.selectedDeviceId),
    requestedMicLabel:
      stringOrNull(micEvidence?.requestedMicLabel) || stringOrNull(micSelection?.requestedLabel),
    requestedMicDeviceId:
      stringOrNull(micEvidence?.requestedMicDeviceId) ||
      stringOrNull(micSelection?.requestedDeviceId),
    inputEnergyThreshold: numberOrNull(micEvidence?.inputEnergyThreshold),
    maxInputEnergy: numberOrNull(micEvidence?.maxInputEnergy),
    inputEnergySamplesAboveThreshold: numberOrNull(micEvidence?.inputEnergySamplesAboveThreshold),
    availableMicLabels: availableDevices
      .map((device) => String(device?.label || ""))
      .filter(Boolean),
    micDeviceSelectionBlocker: stringOrNull(micSelection?.blocker),
    hostSourceMode: stringOrNull(report?.visual?.hostSourceMode),
    hostCaptureStatus: stringOrNull(report?.visual?.hostCaptureStatus),
    hostCaptureError: stringOrNull(report?.visual?.hostCaptureError),
    hostDisplayCaptureFailureCategory: stringOrNull(
      report?.visual?.hostDisplayCaptureFailureCategory,
    ),
    hostDisplayCaptureRequiredFix: stringOrNull(report?.visual?.hostDisplayCaptureRequiredFix),
    hostDisplayCaptureRequired:
      typeof report?.visual?.hostDisplayCaptureRequired === "boolean"
        ? report.visual.hostDisplayCaptureRequired
        : null,
    hostCaptureAttemptCount: Number.isFinite(Number(hostAppPublisher?.captureAttemptCount))
      ? Number(hostAppPublisher.captureAttemptCount)
      : null,
    browserChannel: stringOrNull(report?.args?.browserChannel),
    browserExecutablePath: stringOrNull(report?.args?.browserExecutablePath),
    manualDisplayCapturePicker:
      typeof report?.args?.manualDisplayCapturePicker === "boolean"
        ? report.args.manualDisplayCapturePicker
        : null,
  });
  return Object.keys(detail).length > 0 ? detail : null;
}

function artifactBlocker(report, fallback) {
  const providerFailure = report?.providerFailure || report?.provider?.failure || {};
  const [firstSloFailure] = sloFailureIds(report);
  return (
    stringOrNull(report?.acceptanceBlocker) ||
    stringOrNull(report?.blocker) ||
    stringOrNull(report?.blockerSource) ||
    stringOrNull(report?.reason) ||
    stringOrNull(providerFailure?.blocker) ||
    stringOrNull(firstSloFailure) ||
    stringOrNull(fallback)
  );
}

function checkRequiredSlo(report, id) {
  const entry = sloEntry(report, id);
  expect(entry, `missing SLO entry ${id}`);
  expect(entry.required === true, `${id} must be required`);
  expect(entry.ok === true, `${id} must pass`);
}

function checkGate(report, gate) {
  expect(report?.ok === true, "ok must be true");
  expect(report?.functionalOk === true, "functionalOk must be true");
  expect(report?.slo?.ok === true, "slo.ok must be true");
  expect(normalizeLocalOperatorGate(report?.gate) === gate, `gate must be ${gate}`);
}

function checkOpenAiLive(report, gate) {
  expect(report?.ok === true, "ok must be true");
  expect(report?.acceptanceSatisfied === true, "acceptanceSatisfied must be true");
  expect(normalizeLocalOperatorGate(report?.gate) === gate, `gate must be ${gate}`);
  checkRequiredSlo(report, "openai_realtime_live_transport_selected");
  checkRequiredSlo(report, "openai_realtime_session_created_observed");
}

export const LOCAL_RFC_ACCEPTANCE_ARTIFACTS = [
  {
    id: "local_voice",
    category: "local_diagnostic",
    path: "/tmp/oneesama-realtime-local-voice-latest.json",
    required: true,
    check: (report) => {
      checkGate(report, LOCAL_OPERATOR_GATES.voice);
      checkRequiredSlo(report, "assistant_audio_playback_observed");
      checkRequiredSlo(report, "local_operator_surface_reachability_observed");
    },
  },
  {
    id: "local_voice_real_mic",
    category: "human_device",
    path: "/tmp/oneesama-realtime-local-voice-real-mic-latest.json",
    required: true,
    check: (report) => {
      checkGate(report, LOCAL_OPERATOR_GATES.voice);
      expect(report?.audio?.realMicrophoneRequired === true, "real microphone must be required");
      expect(
        report?.audio?.realMicrophoneEvidenceOk === true,
        "real microphone evidence must pass",
      );
      checkRequiredSlo(report, "operator_voice_real_microphone_energy_observed");
    },
  },
  {
    id: "local_host_visual",
    category: "local_diagnostic",
    path: "/tmp/oneesama-realtime-local-host-visual-stream-latest.json",
    required: true,
    check: (report) => {
      checkGate(report, LOCAL_OPERATOR_GATES.hostVisual);
      checkRequiredSlo(report, "operator_composed_track_live");
      checkRequiredSlo(report, "host_visual_avatar_renderer_source_observed");
    },
  },
  {
    id: "local_tool_routing",
    category: "local_diagnostic",
    path: "/tmp/oneesama-realtime-local-tool-routing-latest.json",
    required: true,
    check: (report) => {
      checkGate(report, LOCAL_OPERATOR_GATES.toolRouting);
      checkRequiredSlo(report, "canonical_tool_boundary_observed");
    },
  },
  {
    id: "local_kwwk_action",
    category: "local_diagnostic",
    path: "/tmp/oneesama-realtime-local-kwwk-action-latest.json",
    required: true,
    check: (report) => {
      checkGate(report, LOCAL_OPERATOR_GATES.kwwkAction);
      checkRequiredSlo(report, "kwwk_phase_blocker_matrix_observed");
      checkRequiredSlo(report, "kwwk_app_mutation_verified");
      checkRequiredSlo(report, "operator_final_response_after_verified_action_ms");
      checkRequiredSlo(report, "kwwk_compact_followup_observed");
    },
  },
  {
    id: "local_spoken_kwwk_action",
    category: "human_device",
    path: "/tmp/oneesama-realtime-local-kwwk-action-real-mic-latest.json",
    required: true,
    check: (report) => {
      checkGate(report, LOCAL_OPERATOR_GATES.kwwkAction);
      expect(
        report?.spokenInput?.realMicrophoneRequired === true,
        "spoken KWWK must require real microphone",
      );
      expect(
        report?.spokenInput?.realMicrophoneEvidenceOk === true,
        "spoken KWWK real microphone evidence must pass",
      );
      checkRequiredSlo(report, "spoken_app_control_real_microphone_observed");
      checkRequiredSlo(report, "kwwk_app_mutation_verified");
      checkRequiredSlo(report, "kwwk_compact_followup_observed");
    },
  },
  {
    id: "local_debug_panel",
    category: "local_diagnostic",
    path: "/tmp/oneesama-realtime-local-debug-panel-latest.json",
    required: true,
    check: (report) => {
      checkGate(report, LOCAL_OPERATOR_GATES.debugPanel);
      checkRequiredSlo(report, "debug_panel_sections_visible");
      checkRequiredSlo(report, "debug_failure_layers_observed");
    },
  },
  {
    id: "local_slo_suite",
    category: "local_diagnostic",
    path: "/tmp/oneesama-realtime-local-slo-suite-latest.json",
    required: true,
    check: (report) => {
      expect(report?.ok === true, "Local SLO suite ok must be true");
      expect(report?.perceivedUx?.ok === true, "Local perceived UX suite must pass");
      expect(
        numberOrNull(report?.perceivedUx?.firstFeedbackP95Ms) !== null,
        "first feedback p95 must be measured",
      );
      for (const gate of [
        LOCAL_OPERATOR_GATES.voice,
        LOCAL_OPERATOR_GATES.hostVisual,
        LOCAL_OPERATOR_GATES.toolRouting,
        LOCAL_OPERATOR_GATES.kwwkAction,
        LOCAL_OPERATOR_GATES.debugPanel,
      ]) {
        expect(report?.gates?.[gate]?.ok === true, `${gate} aggregate must pass`);
      }
      expect(
        suiteEntry(report, LOCAL_OPERATOR_GATES.kwwkAction, "warm_simple_app_action_verified_ms")
          ?.ok === true,
        "warm KWWK action SLO must pass",
      );
    },
  },
  {
    id: "local_host_visual_display_capture",
    category: "host_visual",
    path: "/tmp/oneesama-realtime-local-host-visual-stream-display-latest.json",
    required: true,
    check: (report) => {
      checkGate(report, LOCAL_OPERATOR_GATES.hostVisual);
      expect(
        report?.visual?.hostSourceMode === "display_capture",
        "hostSourceMode must be display_capture",
      );
      expect(report?.visual?.hostCaptureStatus === "live", "hostCaptureStatus must be live");
      checkRequiredSlo(report, "host_visual_display_capture_source_observed");
    },
  },
  {
    id: "openai_realtime_text_live",
    category: "live_provider",
    path: "/tmp/oneesama-realtime-local-openai-live-latest.json",
    required: true,
    check: (report) => checkOpenAiLive(report, LOCAL_OPERATOR_GATES.openaiLive),
  },
  {
    id: "openai_realtime_voice_live",
    category: "live_provider",
    path: "/tmp/oneesama-realtime-local-openai-voice-live-latest.json",
    required: true,
    check: (report) => {
      checkOpenAiLive(report, LOCAL_OPERATOR_GATES.openaiVoiceLive);
      checkRequiredSlo(report, "openai_realtime_voice_chunks_forwarded");
    },
  },
  {
    id: "openai_realtime_tool_live",
    category: "live_provider",
    path: "/tmp/oneesama-realtime-local-openai-tool-live-latest.json",
    required: true,
    check: (report) => {
      checkOpenAiLive(report, LOCAL_OPERATOR_GATES.openaiToolLive);
      checkRequiredSlo(report, "openai_realtime_kwwk_tool_selected");
      checkRequiredSlo(report, "openai_realtime_tool_result_delivered");
    },
  },
];

export const LAN_RFC_ACCEPTANCE_ARTIFACTS = LOCAL_RFC_ACCEPTANCE_ARTIFACTS;

function categorySummary(results) {
  const categories = {};
  for (const result of results) {
    const summary = categories[result.category] || {
      total: 0,
      passed: 0,
      failed: 0,
      missing: 0,
    };
    summary.total += 1;
    if (result.status === "passed") summary.passed += 1;
    else if (result.status === "missing") summary.missing += 1;
    else summary.failed += 1;
    categories[result.category] = summary;
  }
  return categories;
}

function command(label, value, where = "repo") {
  return compactObject({ label, command: value, where });
}

function actionTemplate(id) {
  const templates = {
    local_voice: {
      summary: "Refresh local voice loop evidence.",
      prerequisites: ["Run from the host Mac development checkout."],
      commands: [command("Run Gate 1 local voice", "vp run acceptance:realtime-local-voice")],
    },
    local_voice_real_mic: {
      summary: "Collect real microphone Local Voice Loop evidence.",
      prerequisites: [
        "Run on the host Mac in headed Chromium/Chrome.",
        "Grant microphone permission when prompted.",
        "Speak a short prompt after the Local Operator Surface opens.",
      ],
      commands: [
        command(
          "Run real-mic local voice gate",
          "vp run acceptance:realtime-local-voice:real-mic",
          "host_mac",
        ),
      ],
    },
    local_host_visual: {
      summary: "Refresh local Host Visual Stream evidence.",
      prerequisites: ["Run from the host Mac development checkout."],
      commands: [
        command("Run Gate 2 local visual", "vp run acceptance:realtime-local-host-visual-stream"),
      ],
    },
    local_tool_routing: {
      summary: "Refresh local tool-routing evidence.",
      prerequisites: ["Run from the host Mac development checkout."],
      commands: [
        command("Run Gate 3 tool routing", "vp run benchmark:realtime-local-tool-routing"),
      ],
    },
    local_kwwk_action: {
      summary: "Refresh local KWWK action evidence.",
      prerequisites: ["Run from the host Mac development checkout with KWWK/CU helper available."],
      commands: [command("Run Gate 4 KWWK action", "vp run benchmark:realtime-local-kwwk-action")],
    },
    local_spoken_kwwk_action: {
      summary: "Collect real microphone spoken KWWK action evidence.",
      prerequisites: [
        "Run on the host Mac in headed Chromium/Chrome.",
        "Grant microphone permission when prompted.",
        "Speak the displayed bounded app-control command after the surface opens.",
      ],
      commands: [
        command(
          "Run real-mic spoken KWWK action gate",
          "vp run acceptance:realtime-local-kwwk-action:real-mic",
          "host_mac",
        ),
      ],
    },
    local_debug_panel: {
      summary: "Refresh local dense Debug Panel evidence.",
      prerequisites: ["Run from the host Mac development checkout."],
      commands: [command("Run Gate 5 debug panel", "vp run benchmark:realtime-local-debug-panel")],
    },
    local_slo_suite: {
      summary: "Refresh the local SLO suite aggregate.",
      prerequisites: ["Run after the five local gate reports are fresh."],
      commands: [command("Run local SLO suite", "vp run benchmark:realtime-local-slo-suite")],
    },
    local_host_visual_display_capture: {
      summary: "Collect real display/app capture Host Visual Stream evidence.",
      prerequisites: [
        "Run on the host Mac in headed Chrome/Chromium, not on the operator computer.",
        "Grant macOS Screen Recording permission to the exact browser app used by the gate, then quit and relaunch that browser.",
        "The host-app source must report display_capture and captureStatus live.",
      ],
      commands: [
        command(
          "Run headed strict display capture gate",
          "vp run acceptance:realtime-local-host-visual-stream:display",
          "host_mac",
        ),
        command(
          "Override auto-selected capture source",
          "MAB_LAN_OPERATOR_DISPLAY_CAPTURE_SOURCE='Entire screen' vp run acceptance:realtime-local-host-visual-stream:display",
          "host_mac",
        ),
        command(
          "Run with system Chrome permission identity",
          "MAB_LAN_OPERATOR_BROWSER_CHANNEL=chrome vp run acceptance:realtime-local-host-visual-stream:display",
          "host_mac",
        ),
        command(
          "Run with native screencapture WebRTC fallback",
          "vp run acceptance:realtime-local-host-visual-stream:display:native",
          "host_mac",
        ),
        command(
          "Run with manual browser picker",
          "vp run acceptance:realtime-local-host-visual-stream:display:manual",
          "host_mac",
        ),
      ],
    },
    openai_realtime_text_live: {
      summary: "Collect strict live OpenAI Realtime text evidence.",
      prerequisites: ["Set a valid MAB_OPENAI_API_KEY or OPENAI_API_KEY."],
      commands: [command("Run live text gate", "vp run acceptance:realtime-local-openai-live")],
    },
    openai_realtime_voice_live: {
      summary: "Collect strict live OpenAI Realtime voice evidence.",
      prerequisites: ["Set a valid MAB_OPENAI_API_KEY or OPENAI_API_KEY."],
      commands: [
        command("Run live voice gate", "vp run acceptance:realtime-local-openai-voice-live"),
      ],
    },
    openai_realtime_tool_live: {
      summary: "Collect strict live OpenAI Realtime tool evidence.",
      prerequisites: ["Set a valid MAB_OPENAI_API_KEY or OPENAI_API_KEY."],
      commands: [
        command("Run live tool gate", "vp run acceptance:realtime-local-openai-tool-live"),
      ],
    },
  };
  return (
    templates[id] || {
      summary: "Refresh or inspect this required RFC artifact.",
      prerequisites: ["Open the child artifact path and inspect its blocker/failureDetail."],
      commands: [],
    }
  );
}

function microphoneEnergyRecoveryCommands(result) {
  const commands = [];
  const base =
    result.id === "local_spoken_kwwk_action"
      ? "vp run acceptance:realtime-local-kwwk-action:real-mic"
      : "vp run acceptance:realtime-local-voice:real-mic";
  commands.push(
    command("Run real-mic preflight", "vp run preflight:realtime-local-real-mic", "host_mac"),
  );
  commands.push(command("Run real-mic gate after selecting a real input", base, "host_mac"));
  commands.push(
    command(
      "Select a microphone by label",
      `MAB_LAN_OPERATOR_MIC_LABEL="<real mic label>" ${base}`,
      "host_mac",
    ),
  );
  commands.push(
    command(
      "Select a microphone by browser device id",
      `MAB_LAN_OPERATOR_MIC_DEVICE_ID="<browser audioinput id>" ${base}`,
      "host_mac",
    ),
  );
  return commands;
}

function enhanceActionForBlocker(action, result) {
  if (result.blocker !== "real_microphone_input_energy_below_threshold") return action;
  const selected = result.failureDetail?.selectedMicLabel;
  const labels = Array.isArray(result.failureDetail?.availableMicLabels)
    ? result.failureDetail.availableMicLabels
    : [];
  return {
    ...action,
    summary: "Real microphone input energy is below threshold.",
    prerequisites: [
      "Connect or enable a real microphone on the host Mac.",
      "Set macOS Sound Input to that real microphone, or pass MAB_LAN_OPERATOR_MIC_LABEL / MAB_LAN_OPERATOR_MIC_DEVICE_ID.",
      selected
        ? `Current selected input is ${selected}.`
        : "Confirm headed Chromium/Chrome exposes a non-virtual audioinput.",
      labels.length > 0
        ? `Current browser audioinput labels: ${labels.join(", ")}.`
        : "Open the child artifact and inspect audio.availableDevices or spokenInput.micDeviceSelection.availableDevices.",
      "Speak after the Local Operator Surface opens; the gate only passes after max input energy crosses the configured threshold.",
    ],
    commands: microphoneEnergyRecoveryCommands(result),
  };
}

function nextActionForFailure(result) {
  const template = actionTemplate(result.id);
  const action = compactObject({
    id: result.id,
    category: result.category,
    status: result.status,
    blocker: result.blocker || result.error || "",
    summary: template.summary,
    prerequisites: template.prerequisites || [],
    commands: template.commands || [],
    artifactPath: result.path,
    failureDetail: result.failureDetail || null,
  });
  return compactObject(enhanceActionForBlocker(action, result));
}

function readJsonArtifact(artifact, now, maxAgeMs) {
  if (!existsSync(artifact.path)) {
    return { status: "missing", error: "artifact_missing", blocker: "artifact_missing" };
  }
  const stat = statSync(artifact.path);
  const ageMs = Math.max(0, now - stat.mtimeMs);
  const data = JSON.parse(readFileSync(artifact.path, "utf8"));
  if (maxAgeMs > 0 && ageMs > maxAgeMs) {
    throw new Error(`artifact stale: ${Math.round(ageMs / 1000)}s old`);
  }
  try {
    artifact.check(data);
  } catch (error) {
    const message = String(error?.message || error);
    return compactObject({
      status: "failed",
      generatedAt: data.generatedAt || data.completedAt || "",
      ageMs: Math.round(ageMs),
      error: message,
      blocker: artifactBlocker(data, message),
      failureDetail: artifactFailureDetail(data),
    });
  }
  return {
    status: "passed",
    generatedAt: data.generatedAt || data.completedAt || "",
    ageMs: Math.round(ageMs),
  };
}

export function auditLanRfcAcceptanceArtifacts({
  artifacts = LAN_RFC_ACCEPTANCE_ARTIFACTS,
  now = Date.now(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
} = {}) {
  const maxAgeMs = Number(maxAgeHours) > 0 ? Number(maxAgeHours) * 60 * 60 * 1000 : 0;
  const results = artifacts.map((artifact) => {
    try {
      const result = readJsonArtifact(artifact, now, maxAgeMs);
      return {
        id: artifact.id,
        category: artifact.category,
        path: artifact.path,
        required: artifact.required !== false,
        ...result,
      };
    } catch (error) {
      return {
        id: artifact.id,
        category: artifact.category,
        path: artifact.path,
        required: artifact.required !== false,
        status: "failed",
        error: String(error?.message || error),
        blocker: String(error?.message || error),
      };
    }
  });
  const requiredFailures = results.filter(
    (result) => result.required && result.status !== "passed",
  );
  const nextActions = requiredFailures.map(nextActionForFailure);
  return {
    schema: "oneesama.local_rfc_acceptance_audit.v1",
    generatedAt: new Date(now).toISOString(),
    ok: requiredFailures.length === 0,
    artifactCount: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    missing: results.filter((result) => result.status === "missing").length,
    categories: categorySummary(results),
    requiredFailures,
    nextActionCount: nextActions.length,
    nextActions,
    results,
  };
}

function parseArgs(argv) {
  const args = {
    jsonOut: DEFAULT_JSON_OUT,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--max-age-hours") args.maxAgeHours = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: node --import tsx scripts/lan-operator-rfc-acceptance-audit.mjs [--json-out path] [--max-age-hours n]`,
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

export const auditLocalRfcAcceptanceArtifacts = auditLanRfcAcceptanceArtifacts;

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function runLanRfcAcceptanceAudit(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = auditLanRfcAcceptanceArtifacts({ maxAgeHours: args.maxAgeHours });
  writeJson(args.jsonOut, report);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        artifactCount: report.artifactCount,
        passed: report.passed,
        failed: report.failed,
        missing: report.missing,
        requiredFailures: report.requiredFailures.map((entry) =>
          compactObject({
            id: entry.id,
            status: entry.status,
            blocker: entry.blocker,
            error: entry.error,
          }),
        ),
        nextActions: report.nextActions.map((entry) =>
          compactObject({
            id: entry.id,
            summary: entry.summary,
            commands: entry.commands,
          }),
        ),
        jsonOut: args.jsonOut,
      },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (process.argv[1]?.endsWith("lan-operator-rfc-acceptance-audit.mjs")) {
  runLanRfcAcceptanceAudit();
}
