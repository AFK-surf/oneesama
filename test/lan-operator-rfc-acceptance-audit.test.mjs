import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";

import {
  LOCAL_RFC_ACCEPTANCE_ARTIFACTS,
  auditLanRfcAcceptanceArtifacts,
} from "../scripts/lan-operator-rfc-acceptance-audit.mjs";

function writeJson(dir, name, payload) {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

function slo(id, extra = {}) {
  return { id, required: true, ok: true, actual: 1, threshold: 1, ...extra };
}

function gateReport(gate, entries = []) {
  return { ok: true, functionalOk: true, gate, slo: { ok: true, entries } };
}

function payloadFor(id) {
  switch (id) {
    case "local_voice":
      return gateReport("local_voice", [
        slo("assistant_audio_playback_observed"),
        slo("local_operator_surface_reachability_observed"),
      ]);
    case "local_voice_real_mic":
      return {
        ...gateReport("local_voice", [
          slo("assistant_audio_playback_observed"),
          slo("local_operator_surface_reachability_observed"),
          slo("operator_voice_real_microphone_energy_observed"),
        ]),
        audio: {
          realMicrophoneRequired: true,
          realMicrophoneEvidenceOk: true,
          inputEnergyThreshold: 0.02,
          maxInputEnergy: 0.08,
          inputEnergySamplesAboveThreshold: 3,
        },
      };
    case "local_host_visual":
      return gateReport("local_host_visual", [
        slo("operator_composed_track_live"),
        slo("host_visual_avatar_renderer_source_observed"),
      ]);
    case "local_tool_routing":
      return gateReport("local_tool_routing", [slo("canonical_tool_boundary_observed")]);
    case "local_kwwk_action":
      return gateReport("local_kwwk_action", [
        slo("kwwk_phase_blocker_matrix_observed"),
        slo("kwwk_app_mutation_verified"),
        slo("operator_final_response_after_verified_action_ms"),
        slo("kwwk_compact_followup_observed"),
      ]);
    case "local_spoken_kwwk_action":
      return {
        ...gateReport("local_kwwk_action", [
          slo("spoken_app_control_real_microphone_observed"),
          slo("kwwk_app_mutation_verified"),
          slo("kwwk_compact_followup_observed"),
        ]),
        spokenInput: {
          realMicrophoneRequired: true,
          realMicrophoneEvidenceOk: true,
          inputEnergyThreshold: 0.02,
          maxInputEnergy: 0.09,
          inputEnergySamplesAboveThreshold: 4,
        },
      };
    case "local_debug_panel":
      return gateReport("local_debug_panel", [
        slo("debug_panel_sections_visible"),
        slo("debug_failure_layers_observed"),
      ]);
    case "local_slo_suite":
      return {
        ok: true,
        perceivedUx: { ok: true, firstFeedbackP95Ms: 120 },
        gates: {
          local_voice: { ok: true, entries: [] },
          local_host_visual: { ok: true, entries: [] },
          local_tool_routing: { ok: true, entries: [] },
          local_kwwk_action: {
            ok: true,
            entries: [{ id: "warm_simple_app_action_verified_ms", ok: true }],
          },
          local_debug_panel: { ok: true, entries: [] },
        },
      };
    case "local_host_visual_display_capture":
      return {
        ...gateReport("local_host_visual", [slo("host_visual_display_capture_source_observed")]),
        visual: { hostSourceMode: "display_capture", hostCaptureStatus: "live" },
      };
    case "openai_realtime_text_live":
      return openAiReport("local_openai_realtime_live", []);
    case "openai_realtime_voice_live":
      return openAiReport("local_openai_realtime_voice_live", [
        slo("openai_realtime_voice_chunks_forwarded"),
      ]);
    case "openai_realtime_tool_live":
      return openAiReport("local_openai_realtime_tool_live", [
        slo("openai_realtime_kwwk_tool_selected"),
        slo("openai_realtime_tool_result_delivered"),
      ]);
    default:
      throw new Error(`missing fixture for ${id}`);
  }
}

function openAiReport(gate, extraEntries) {
  return {
    ok: true,
    acceptanceSatisfied: true,
    gate,
    slo: {
      ok: true,
      entries: [
        slo("openai_realtime_live_transport_selected"),
        slo("openai_realtime_session_created_observed"),
        ...extraEntries,
      ],
    },
  };
}

function fixtureArtifacts(
  dir,
  ids = LOCAL_RFC_ACCEPTANCE_ARTIFACTS.map((artifact) => artifact.id),
) {
  mkdirSync(dir, { recursive: true });
  return LOCAL_RFC_ACCEPTANCE_ARTIFACTS.map((artifact) => {
    if (!ids.includes(artifact.id)) {
      return { ...artifact, path: join(dir, `${artifact.id}-missing.json`) };
    }
    return { ...artifact, path: writeJson(dir, artifact.id, payloadFor(artifact.id)) };
  });
}

test("local RFC acceptance audit passes complete evidence", () => {
  const dir = join(process.env.TEST_TMPDIR || "/tmp", `oneesama-local-rfc-audit-${Date.now()}`);
  const report = auditLanRfcAcceptanceArtifacts({
    artifacts: fixtureArtifacts(dir),
    now: Date.now(),
    maxAgeHours: 0,
  });

  assert.equal(report.ok, true);
  assert.equal(report.artifactCount, LOCAL_RFC_ACCEPTANCE_ARTIFACTS.length);
  assert.equal(report.requiredFailures.length, 0);
  assert.equal(report.nextActions.length, 0);
  assert.equal(report.nextActionCount, 0);
  assert.equal(report.categories.host_visual.passed, 1);
  assert.equal(report.categories.human_device.passed, 2);
  assert.equal(report.categories.live_provider.passed, 3);
});

test("local RFC acceptance audit keeps live evidence failures explicit", () => {
  const dir = join(
    process.env.TEST_TMPDIR || "/tmp",
    `oneesama-local-rfc-audit-missing-${Date.now()}`,
  );
  const localOnlyIds = [
    "local_voice",
    "local_voice_real_mic",
    "local_host_visual",
    "local_tool_routing",
    "local_kwwk_action",
    "local_spoken_kwwk_action",
    "local_debug_panel",
    "local_slo_suite",
  ];
  const report = auditLanRfcAcceptanceArtifacts({
    artifacts: fixtureArtifacts(dir, localOnlyIds),
    now: Date.now(),
    maxAgeHours: 0,
  });

  assert.equal(report.ok, false);
  assert.equal(report.passed, localOnlyIds.length);
  assert.equal(report.categories.local_diagnostic.passed, 6);
  assert.equal(report.categories.human_device.passed, 2);
  assert.ok(
    report.requiredFailures.some((entry) => entry.id === "local_host_visual_display_capture"),
  );
  assert.ok(report.requiredFailures.some((entry) => entry.id === "openai_realtime_text_live"));
  assert.equal(report.nextActions.length, report.requiredFailures.length);
  assert.ok(
    report.nextActions
      .find((entry) => entry.id === "local_host_visual_display_capture")
      ?.commands.some((entry) =>
        /acceptance:realtime-local-host-visual-stream:display/.test(entry.command),
      ),
  );
  assert.ok(
    report.nextActions
      .find((entry) => entry.id === "openai_realtime_text_live")
      ?.prerequisites.some((entry) => /valid MAB_OPENAI_API_KEY/.test(entry)),
  );
});

test("local RFC acceptance audit surfaces failed artifact blockers", () => {
  const dir = join(
    process.env.TEST_TMPDIR || "/tmp",
    `oneesama-local-rfc-audit-blocker-${Date.now()}`,
  );
  const artifacts = fixtureArtifacts(dir);
  const openAiText = artifacts.find((artifact) => artifact.id === "openai_realtime_text_live");
  openAiText.path = writeJson(dir, "openai_realtime_text_live-invalid-key", {
    ok: false,
    acceptanceSatisfied: false,
    gate: "local_openai_realtime_live",
    acceptanceBlocker: "openai_realtime_api_key_invalid",
    providerFailure: {
      category: "invalid_api_key",
      blocker: "openai_realtime_api_key_invalid",
    },
    providerEventCounts: { error: 1, "response.failed": 1 },
    sloFailures: [
      "openai_realtime_session_created_observed",
      "openai_realtime_provider_text_response_observed",
    ],
  });

  const report = auditLanRfcAcceptanceArtifacts({
    artifacts,
    now: Date.now(),
    maxAgeHours: 0,
  });
  const failure = report.requiredFailures.find((entry) => entry.id === "openai_realtime_text_live");

  assert.equal(report.ok, false);
  assert.equal(report.failed, 1);
  assert.equal(failure.blocker, "openai_realtime_api_key_invalid");
  assert.equal(failure.failureDetail.providerFailureCategory, "invalid_api_key");
  assert.deepEqual(failure.failureDetail.sloFailures, [
    "openai_realtime_session_created_observed",
    "openai_realtime_provider_text_response_observed",
  ]);
  assert.ok(
    report.nextActions
      .find((entry) => entry.id === "openai_realtime_text_live")
      ?.commands.some((entry) => entry.command === "vp run acceptance:realtime-local-openai-live"),
  );
});

test("local RFC acceptance audit uses SLO failure as fallback blocker", () => {
  const dir = join(
    process.env.TEST_TMPDIR || "/tmp",
    `oneesama-local-rfc-audit-slo-blocker-${Date.now()}`,
  );
  const artifacts = fixtureArtifacts(dir);
  const displayCapture = artifacts.find(
    (artifact) => artifact.id === "local_host_visual_display_capture",
  );
  displayCapture.path = writeJson(dir, "local_host_visual_display_capture-failed", {
    ok: false,
    functionalOk: false,
    gate: "local_host_visual",
    sloFailures: ["host_visual_display_capture_source_observed"],
    visual: {
      hostSourceMode: "diagnostic_canvas",
      hostCaptureStatus: "failed",
      hostCaptureError: "NotSupportedError: Not supported",
      hostDisplayCaptureFailureCategory: "display_capture_unsupported_runtime",
      hostDisplayCaptureRequiredFix:
        "Run the strict display gate in headed Chrome/Chromium on the host Mac.",
      hostDisplayCaptureRequired: true,
      publisherEvidence: {
        hostApp: {
          captureAttemptCount: 1,
        },
      },
    },
  });

  const report = auditLanRfcAcceptanceArtifacts({
    artifacts,
    now: Date.now(),
    maxAgeHours: 0,
  });
  const failure = report.requiredFailures.find(
    (entry) => entry.id === "local_host_visual_display_capture",
  );

  assert.equal(report.ok, false);
  assert.equal(failure.blocker, "host_visual_display_capture_source_observed");
  assert.equal(failure.failureDetail.hostSourceMode, "diagnostic_canvas");
  assert.equal(failure.failureDetail.hostCaptureStatus, "failed");
  assert.equal(failure.failureDetail.hostCaptureError, "NotSupportedError: Not supported");
  assert.equal(
    failure.failureDetail.hostDisplayCaptureFailureCategory,
    "display_capture_unsupported_runtime",
  );
  assert.match(failure.failureDetail.hostDisplayCaptureRequiredFix, /headed Chrome\/Chromium/);
  assert.equal(failure.failureDetail.hostDisplayCaptureRequired, true);
  assert.equal(failure.failureDetail.hostCaptureAttemptCount, 1);
  assert.deepEqual(failure.failureDetail.sloFailures, [
    "host_visual_display_capture_source_observed",
  ]);
  const action = report.nextActions.find(
    (entry) => entry.id === "local_host_visual_display_capture",
  );
  assert.ok(action);
  assert.equal(action.failureDetail.hostCaptureAttemptCount, 1);
  assert.equal(
    action.failureDetail.hostDisplayCaptureFailureCategory,
    "display_capture_unsupported_runtime",
  );
  assert.ok(
    action.commands.some(
      (entry) =>
        entry.command === "vp run acceptance:realtime-local-host-visual-stream:display" &&
        entry.where === "host_mac",
    ),
  );
  assert.ok(
    action.commands.some(
      (entry) =>
        entry.command === "vp run acceptance:realtime-local-host-visual-stream:display:manual" &&
        entry.where === "host_mac",
    ),
  );
  assert.ok(
    action.commands.some(
      (entry) =>
        entry.command === "vp run acceptance:realtime-local-host-visual-stream:display:native" &&
        entry.where === "host_mac",
    ),
  );
});

test("local RFC acceptance audit gives actionable real-mic recovery steps", () => {
  const dir = join(
    process.env.TEST_TMPDIR || "/tmp",
    `oneesama-local-rfc-audit-real-mic-${Date.now()}`,
  );
  const artifacts = fixtureArtifacts(dir);
  const realMicVoice = artifacts.find((artifact) => artifact.id === "local_voice_real_mic");
  realMicVoice.path = writeJson(dir, "local_voice_real_mic-low-energy", {
    ok: false,
    functionalOk: false,
    gate: "local_voice",
    blocker: "real_microphone_input_energy_below_threshold",
    audio: {
      realMicrophoneRequired: true,
      realMicrophoneEvidenceOk: false,
      selectedDeviceLabel: "Default - Steam Streaming Microphone (Virtual)",
      selectedDeviceId: "default",
      inputEnergyThreshold: 0.02,
      maxInputEnergy: 0.004,
      inputEnergySamplesAboveThreshold: 0,
      availableDevices: [
        { deviceId: "default", label: "Default - Steam Streaming Microphone (Virtual)" },
        { deviceId: "built-in", label: "MacBook Pro Microphone" },
      ],
    },
    sloFailures: ["operator_voice_real_microphone_energy_observed"],
  });

  const report = auditLanRfcAcceptanceArtifacts({
    artifacts,
    now: Date.now(),
    maxAgeHours: 0,
  });
  const failure = report.requiredFailures.find((entry) => entry.id === "local_voice_real_mic");
  const action = report.nextActions.find((entry) => entry.id === "local_voice_real_mic");

  assert.equal(report.ok, false);
  assert.equal(failure.blocker, "real_microphone_input_energy_below_threshold");
  assert.equal(
    failure.failureDetail.selectedMicLabel,
    "Default - Steam Streaming Microphone (Virtual)",
  );
  assert.equal(failure.failureDetail.maxInputEnergy, 0.004);
  assert.deepEqual(failure.failureDetail.availableMicLabels, [
    "Default - Steam Streaming Microphone (Virtual)",
    "MacBook Pro Microphone",
  ]);
  assert.equal(action.summary, "Real microphone input energy is below threshold.");
  assert.ok(
    action.prerequisites.some((entry) =>
      /Current selected input is Default - Steam Streaming Microphone/.test(entry),
    ),
  );
  assert.ok(
    action.commands.some(
      (entry) =>
        /MAB_LAN_OPERATOR_MIC_LABEL/.test(entry.command) &&
        /acceptance:realtime-local-voice:real-mic/.test(entry.command),
    ),
  );
  assert.ok(
    action.commands.some(
      (entry) =>
        entry.command === "vp run preflight:realtime-local-real-mic" && entry.where === "host_mac",
    ),
  );
});
