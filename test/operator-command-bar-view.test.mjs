import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  commandBarCanStopAction,
  commandBarView,
} from "../packages/core/src/operator/web/commandBarView.ts";

function providerConfig(selectedTransport = "openai_realtime") {
  return {
    providers: [
      {
        label: "OpenAI Realtime",
        transport: "openai_realtime",
        selected: selectedTransport === "openai_realtime",
        keyConfigured: true,
        keySource: "ONEESAMA_OPENAI_API_KEY",
        model: "gpt-realtime-2",
        runCommand: "MAB_LAN_OPERATOR_TRANSPORT=openai_realtime vp run dev:local-operator",
      },
      {
        label: "Gemini Live",
        transport: "gemini_live",
        selected: selectedTransport === "gemini_live",
        keyConfigured: false,
        keySource: "",
        model: "gemini-live",
        runCommand: "",
      },
    ],
    runtimeSwitchSupported: true,
    selectedLiveTransport: selectedTransport,
    selectedTransport,
  };
}

test("operator command bar view derives provider, connection, and button state", () => {
  const view = commandBarView(
    {
      debug: {
        conversation: { status: "connected" },
        output: { assistantText: { currentText: "speaking" } },
      },
      providerConfig: providerConfig("openai_realtime"),
      providerSwitch: { status: "idle", targetTransport: "", lastError: "" },
      selectedProvider: providerConfig("openai_realtime").providers[0],
      snapshot: { health: "ready" },
    },
    { status: "connecting", transport: "mock", wsOpen: true },
  );

  assert.equal(view.selectedTransport, "openai_realtime");
  assert.equal(view.providerModel, "gpt-realtime-2");
  assert.equal(view.providerKeySource, "ONEESAMA_OPENAI_API_KEY");
  assert.equal(view.connectionStatus, "connected");
  assert.equal(view.sessionTone, "ok");
  assert.equal(view.runtimeTone, "ok");
  assert.equal(view.eventsLabel, "ws open");
  assert.equal(view.eventsTone, "ok");
  assert.equal(view.connectButtonDisabled, true);
  assert.equal(view.stopReplyDisabled, false);
  assert.equal(view.copyEnvDisabled, false);
});

test("operator command bar view supports provider fallback and switching state", () => {
  const view = commandBarView(
    {
      debug: {},
      providerConfig: {
        ...providerConfig(""),
        selectedLiveTransport: "",
        selectedTransport: "",
        providers: [],
      },
      providerSwitch: { status: "switching", targetTransport: "gemini_live", lastError: "" },
      selectedProvider: null,
      snapshot: null,
    },
    { status: "not_connected", transport: "gemini_live", wsOpen: false },
  );

  assert.equal(view.selectedTransport, "gemini_live");
  assert.equal(view.providerStatus, "switching");
  assert.equal(view.providerModel, "gemini_live");
  assert.equal(view.providerKeySource, "no key source");
  assert.equal(view.health, "starting");
  assert.equal(view.runtimeTone, "warn");
  assert.equal(view.sessionTone, "idle");
  assert.equal(view.eventsLabel, "ws closed");
  assert.equal(view.copyEnvDisabled, true);
  assert.equal(view.connectButtonDisabled, true);
});

test("operator command bar view detects stoppable actions from tool state", () => {
  assert.equal(commandBarCanStopAction({ toolRouting: { status: "planning" } }), true);
  assert.equal(commandBarCanStopAction({ kwwk: { status: "verifying" } }), true);
  assert.equal(commandBarCanStopAction({ conversation: { control: { inFlight: 1 } } }), true);
  assert.equal(commandBarCanStopAction({ toolRouting: { status: "idle" } }), false);

  const view = commandBarView(
    {
      debug: { toolRouting: { status: "running" } },
      providerConfig: null,
      providerSwitch: { status: "idle", targetTransport: "", lastError: "" },
      selectedProvider: null,
      snapshot: { health: "degraded" },
    },
    { status: "failed", transport: "mock", wsOpen: true },
  );
  assert.equal(view.canStopAction, true);
  assert.equal(view.stopActionDisabled, false);
  assert.equal(view.sessionTone, "bad");
});
