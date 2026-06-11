import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  RECENT_RUNTIME_EVENT_LIMIT,
  foldRuntimeBody,
  foldRuntimeRawPayload,
  initialOperatorRuntimeViewState,
  providerSwitchFailed,
  providerSwitchStarted,
  providerSwitchSucceeded,
  runtimeRequestFailed,
  selectRuntimeProvider,
} from "../packages/core/src/operator/web/runtimeState.ts";

function providerConfig(selectedTransport = "openai_realtime") {
  return {
    providers: [
      {
        label: "OpenAI Realtime",
        transport: "openai_realtime",
        keyConfigured: true,
        selected: selectedTransport === "openai_realtime",
      },
      {
        label: "Gemini Live",
        transport: "gemini_live",
        keyConfigured: true,
        selected: selectedTransport === "gemini_live",
      },
    ],
    runtimeSwitchSupported: true,
    selectedLiveTransport: selectedTransport,
    selectedTransport,
  };
}

test("operator runtime state folds status body into one view state", () => {
  const initial = initialOperatorRuntimeViewState(providerConfig("gemini_live"));
  const events = Array.from({ length: RECENT_RUNTIME_EVENT_LIMIT + 3 }, (_, index) => ({
    event: `event_${index}`,
  }));
  const folded = foldRuntimeBody(
    {
      ...initial,
      runtimeError: "previous_error",
    },
    {
      snapshot: { health: "ready" },
      inputPolicy: { audioInputs: ["local_mic"] },
      outputPolicy: { audioOutputs: ["local_speaker"] },
      debug: {
        conversation: { status: "connected" },
        surfaceContext: { liveProviderConfig: providerConfig("openai_realtime") },
      },
      recentEvents: events,
    },
  );

  assert.deepEqual(folded.snapshot, { health: "ready" });
  assert.deepEqual(folded.inputPolicy, { audioInputs: ["local_mic"] });
  assert.deepEqual(folded.outputPolicy, { audioOutputs: ["local_speaker"] });
  assert.equal(folded.debug.conversation.status, "connected");
  assert.equal(folded.providerConfig?.selectedTransport, "openai_realtime");
  assert.equal(folded.runtimeError, "");
  assert.equal(folded.recentEvents.length, RECENT_RUNTIME_EVENT_LIMIT);
  assert.equal(folded.recentEvents[0].event, "event_3");
});

test("operator runtime state folds raw websocket payloads", () => {
  const folded = foldRuntimeRawPayload(initialOperatorRuntimeViewState(), {
    event: { event: "operator_voice_chunk_received" },
    debug: { voice: { chunksReceived: 1 } },
  });

  assert.deepEqual(folded.recentEvents, [{ event: "operator_voice_chunk_received" }]);
  assert.equal(folded.debug.voice.chunksReceived, 1);
});

test("operator runtime state tracks request and provider-switch failures", () => {
  const initial = initialOperatorRuntimeViewState();
  const failedRequest = runtimeRequestFailed(initial, new Error("runtime_down"));
  assert.equal(failedRequest.runtimeError, "runtime_down");

  const switching = providerSwitchStarted(failedRequest, "gemini_live");
  assert.deepEqual(switching.providerSwitch, {
    status: "switching",
    targetTransport: "gemini_live",
    lastError: "",
  });

  const failedSwitch = providerSwitchFailed(switching, "gemini_live", "missing_key");
  assert.equal(failedSwitch.runtimeError, "missing_key");
  assert.deepEqual(failedSwitch.providerSwitch, {
    status: "failed",
    targetTransport: "gemini_live",
    lastError: "missing_key",
  });
});

test("operator runtime state tracks active provider switch and selected provider", () => {
  const active = providerSwitchSucceeded(initialOperatorRuntimeViewState(), "openai_realtime");
  assert.deepEqual(active.providerSwitch, {
    status: "active",
    targetTransport: "openai_realtime",
    lastError: "",
  });

  assert.equal(
    selectRuntimeProvider(providerConfig("gemini_live"), "openai_realtime")?.transport,
    "gemini_live",
  );
  assert.equal(
    selectRuntimeProvider(
      {
        ...providerConfig(""),
        selectedLiveTransport: "",
        selectedTransport: "",
      },
      "openai_realtime",
    )?.transport,
    "openai_realtime",
  );
});
