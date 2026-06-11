import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { operatorRuntimeReducer } from "../packages/core/src/operator/web/operatorRuntimeReducer.ts";
import { initialOperatorRuntimeViewState } from "../packages/core/src/operator/web/runtimeState.ts";

test("operator runtime reducer folds status bodies and raw payloads", () => {
  const withBody = operatorRuntimeReducer(initialOperatorRuntimeViewState(), {
    type: "body",
    body: {
      snapshot: { health: "ready" },
      inputPolicy: { audioInputs: ["local_mic"] },
      outputPolicy: { audioOutputs: ["local_speaker"] },
      debug: {
        conversation: { status: "connected" },
        surfaceContext: {
          liveProviderConfig: {
            providers: [
              {
                label: "Gemini Live",
                transport: "gemini_live",
                keyConfigured: true,
                selected: true,
              },
            ],
            runtimeSwitchSupported: true,
            selectedLiveTransport: "gemini_live",
            selectedTransport: "gemini_live",
          },
        },
      },
      recentEvents: [{ event: "runtime.status" }],
    },
  });

  assert.equal(withBody.snapshot.health, "ready");
  assert.equal(withBody.debug.conversation.status, "connected");
  assert.equal(withBody.providerConfig?.selectedTransport, "gemini_live");
  assert.deepEqual(withBody.recentEvents, [{ event: "runtime.status" }]);

  const withRawPayload = operatorRuntimeReducer(withBody, {
    type: "raw_payload",
    payload: {
      event: { event: "operator_voice_chunk_received" },
      debug: { voice: { chunksReceived: 3 } },
    },
  });

  assert.equal(withRawPayload.debug.voice.chunksReceived, 3);
  assert.deepEqual(withRawPayload.recentEvents.at(-1), {
    event: "operator_voice_chunk_received",
  });
});

test("operator runtime reducer tracks request and provider switch lifecycle", () => {
  const failedRequest = operatorRuntimeReducer(initialOperatorRuntimeViewState(), {
    type: "request_failed",
    error: new Error("runtime_down"),
  });
  assert.equal(failedRequest.runtimeError, "runtime_down");

  const switching = operatorRuntimeReducer(failedRequest, {
    type: "provider_switch_started",
    targetTransport: "gemini_live",
  });
  assert.deepEqual(switching.providerSwitch, {
    status: "switching",
    targetTransport: "gemini_live",
    lastError: "",
  });

  const active = operatorRuntimeReducer(switching, {
    type: "provider_switch_succeeded",
    targetTransport: "gemini_live",
  });
  assert.deepEqual(active.providerSwitch, {
    status: "active",
    targetTransport: "gemini_live",
    lastError: "",
  });

  const failedSwitch = operatorRuntimeReducer(active, {
    type: "provider_switch_failed",
    targetTransport: "openai_realtime",
    error: "missing_key",
  });
  assert.equal(failedSwitch.runtimeError, "missing_key");
  assert.deepEqual(failedSwitch.providerSwitch, {
    status: "failed",
    targetTransport: "openai_realtime",
    lastError: "missing_key",
  });
});
