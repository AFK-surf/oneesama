import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeStatusSnapshot,
  createRuntimeEvent,
  defaultRuntimeDiagnosticsConfig,
  validateRuntimeSessionConfig,
} from "../packages/core/src/avatar-runtime/contracts.ts";

function baseConfig(overrides = {}) {
  return {
    sessionId: "runtime-test-session",
    botName: "Hiyori",
    surfaceKind: "local_browser",
    conversationTransport: "mock",
    inputPolicy: {
      audioInputs: ["synthetic"],
      textInputs: ["local_text"],
    },
    outputPolicy: {
      audioOutputs: ["avatar_bus_only"],
      videoOutputs: ["dom_canvas"],
    },
    capabilities: [
      {
        name: "local_dialog",
        description: "Local dialog bridge",
        enabled: true,
      },
    ],
    ...overrides,
  };
}

test("surface and transport aliases normalize independently", () => {
  const result = validateRuntimeSessionConfig(
    baseConfig({
      surfaceKind: "local",
      conversationTransport: "webrtc",
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.config.surfaceKind, "local_browser");
  assert.equal(result.config.conversationTransport, "agents_sdk");
});

test("google_meet rejects local_mic and local_speaker", () => {
  const result = validateRuntimeSessionConfig(
    baseConfig({
      surfaceKind: "google_meet",
      inputPolicy: {
        audioInputs: ["local_mic"],
        textInputs: ["meet_chat"],
      },
      outputPolicy: {
        audioOutputs: ["local_speaker"],
        videoOutputs: ["meet_camera"],
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /google_meet runtime must not use local_mic/);
  assert.match(result.errors.join("\n"), /google_meet runtime must not use local_speaker/);
  assert.equal(result.events[0].event, "runtime_session_validation_rejected");
  assert.equal(result.events[0].redaction, "summarized");
});

test("local_browser rejects continuous local_mic plus local_speaker without explicitLoopGuard", () => {
  const unsafe = validateRuntimeSessionConfig(
    baseConfig({
      inputPolicy: {
        audioInputs: ["local_mic"],
        textInputs: ["local_text"],
        continuousMic: true,
      },
      outputPolicy: {
        audioOutputs: ["local_speaker"],
        videoOutputs: ["dom_canvas"],
      },
    }),
  );

  assert.equal(unsafe.ok, false);
  assert.deepEqual(unsafe.errors, [
    "local_browser runtime must reject continuous local_mic + local_speaker without explicitLoopGuard",
  ]);

  const guarded = validateRuntimeSessionConfig(
    baseConfig({
      inputPolicy: {
        audioInputs: ["local_mic"],
        textInputs: ["local_text"],
        continuousMic: true,
        explicitLoopGuard: "headphones_required",
      },
      outputPolicy: {
        audioOutputs: ["local_speaker"],
        videoOutputs: ["dom_canvas"],
      },
    }),
  );

  assert.equal(guarded.ok, true);
});

test("diagnostics reject trace defaults and status snapshots hide trace unless explicitly requested", () => {
  const rejected = validateRuntimeSessionConfig(
    baseConfig({
      diagnostics: {
        eventLogEnabled: true,
        defaultStatusView: "trace",
        redactByDefault: true,
      },
    }),
  );

  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join("\n"), /defaultStatusView must not be trace/);
  assert.equal(rejected.config.diagnostics.defaultStatusView, "summary");
  assert.equal(
    defaultRuntimeDiagnosticsConfig({ defaultStatusView: "trace" }).defaultStatusView,
    "summary",
  );

  const valid = validateRuntimeSessionConfig(baseConfig());
  assert.equal(valid.ok, true);
  const event = createRuntimeEvent(valid.config, {
    phase: "init",
    event: "trace_probe",
    severity: "debug",
    summary: "Trace probe",
  });
  const defaultSnapshot = buildRuntimeStatusSnapshot({
    config: valid.config,
    events: [event],
  });

  assert.equal(defaultSnapshot.view, "summary");
  assert.equal(Object.hasOwn(defaultSnapshot, "trace"), false);
});

test("capability names and tool names must be unique within a session", () => {
  const result = validateRuntimeSessionConfig(
    baseConfig({
      capabilities: [
        {
          name: "share_screen",
          toolName: "share_screen",
          description: "Meet share",
          enabled: true,
        },
        {
          name: "share_screen",
          toolName: "embedded_share_screen",
          description: "Embedded share",
          enabled: true,
        },
        {
          name: "local_preview",
          toolName: "share_screen",
          description: "Local preview",
          enabled: true,
        },
      ],
    }),
  );

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /surface capability name must be unique within a runtime session: share_screen/,
  );
  assert.match(
    result.errors.join("\n"),
    /surface capability toolName must be unique within a runtime session: share_screen/,
  );
  assert.deepEqual(result.events[0].detail.duplicateCapabilityNames, ["share_screen"]);
  assert.deepEqual(result.events[0].detail.duplicateToolNames, ["share_screen"]);
});

test("malformed policy and capability shapes reject instead of throwing during freeze", () => {
  const result = validateRuntimeSessionConfig({
    sessionId: "runtime-test-session",
    botName: "Hiyori",
    surfaceKind: "local_browser",
    conversationTransport: "mock",
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /surface capabilities must be an array/);
  assert.match(result.errors.join("\n"), /inputPolicy\.audioInputs must be an array/);
  assert.match(result.errors.join("\n"), /inputPolicy\.textInputs must be an array/);
  assert.match(result.errors.join("\n"), /outputPolicy\.audioOutputs must be an array/);
  assert.match(result.errors.join("\n"), /outputPolicy\.videoOutputs must be an array/);
  assert.equal(result.events[0].event, "runtime_session_validation_rejected");
  assert.equal(result.events[0].redaction, "summarized");
});

test("validated sessions freeze capabilities and policies", () => {
  const result = validateRuntimeSessionConfig(baseConfig());

  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.config), true);
  assert.equal(Object.isFrozen(result.config.capabilities), true);
  assert.equal(Object.isFrozen(result.config.capabilities[0]), true);
  assert.equal(Object.isFrozen(result.config.inputPolicy.audioInputs), true);
  assert.equal(Object.isFrozen(result.config.outputPolicy.audioOutputs), true);
  assert.throws(
    () =>
      result.config.capabilities.push({ name: "late_tool", description: "late", enabled: true }),
    /object is not extensible|read only|Cannot add property/,
  );
});
