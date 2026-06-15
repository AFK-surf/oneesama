import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { buildLegacySurfaceBridge } from "../packages/core/src/operator/web/useLegacySurfaceBridge.ts";

function runtime(overrides = {}) {
  return {
    debug: {
      visual: {
        composition: {
          focusedSourceId: "host-app",
          layoutRevision: 4,
          sourceRects: { "host-app": { x: 0, y: 0, width: 1, height: 1 } },
        },
        sources: [],
      },
      kwwk: { currentJobId: "job-1", status: "running" },
      toolRouting: {
        callId: "call-1",
        itemId: "item-1",
        actualTool: "kwwk_computer_use",
      },
      timeline: { currentTurnId: "turn-1" },
      output: { assistantText: { lastResponseId: "resp-1" }, assistantAudio: {} },
      ...overrides.debug,
    },
    providerConfig: { selectedTransport: "openai_realtime" },
    cancelTool: () => undefined,
    downloadReport: async () => undefined,
    markInteresting: () => undefined,
    sendEngineControl: () => undefined,
    switchProvider: async () => null,
    ...overrides,
  };
}

function voice(overrides = {}) {
  return {
    chunksSent: 0,
    devices: [],
    energy: 0,
    localVadActive: false,
    localVadEnabled: false,
    micOn: false,
    muted: false,
    selectedDeviceId: "",
    syntheticVoiceReady: true,
    refreshDevices: async () => [],
    sendSyntheticVoiceChunk: () => true,
    setLocalVadEnabled: () => undefined,
    setSelectedDeviceId: () => undefined,
    setVoiceMuted: () => undefined,
    startMic: async () => undefined,
    stopMic: () => undefined,
    ...overrides,
  };
}

test("legacy surface bridge exposes live-gate compatibility methods", () => {
  const sent = [];
  const voiceCalls = [];
  const runtimeCalls = [];
  const surface = buildLegacySurfaceBridge({
    realtime: {
      wsOpen: true,
      send: (message) => {
        sent.push(message);
        return true;
      },
      sendText: (text) => sent.push({ type: "text", text }),
    },
    runtime: runtime({
      cancelTool: (reason) => runtimeCalls.push(["cancelTool", reason]),
      sendEngineControl: (type, detail) => runtimeCalls.push(["sendEngineControl", type, detail]),
    }),
    voice: voice({
      sendSyntheticVoiceChunk: (input) => {
        voiceCalls.push(["sendSyntheticVoiceChunk", input]);
        return true;
      },
      setVoiceMuted: (muted, reason) => voiceCalls.push(["setVoiceMuted", muted, reason]),
      stopMic: (reason) => voiceCalls.push(["stopMic", reason]),
    }),
  });

  assert.equal(surface.state.ready, true);
  assert.equal(surface.sendSyntheticVoiceChunk({ sequence: 1 }), true);
  assert.deepEqual(voiceCalls[0], ["sendSyntheticVoiceChunk", { sequence: 1 }]);
  assert.equal(surface.state.voiceChunksSent, 1);

  assert.equal(surface.emitKwwkJobState({ status: "completed" }).status, "running");
  assert.equal(sent.at(-1).type, "kwwk_job_state");
  assert.deepEqual(sent.at(-1).kwwk, { status: "completed" });

  assert.equal(surface.submitToolResult({ output: { ok: true } }), true);
  assert.deepEqual(sent.at(-1), {
    type: "conversation_tool_result",
    callId: "call-1",
    itemId: "item-1",
    toolName: "kwwk_computer_use",
    jobId: "job-1",
    turnId: "turn-1",
    responseId: "resp-1",
    output: { ok: true },
  });

  assert.deepEqual(surface.stopMicrophone("spoken_kwwk_action_ready"), {
    ok: true,
    capture: { status: "idle", lastEnergy: 0, availableDeviceCount: 0, deviceId: "" },
  });
  assert.deepEqual(voiceCalls.at(-1), ["stopMic", "spoken_kwwk_action_ready"]);

  assert.deepEqual(surface.setVoiceMuted(true), { ok: true, muted: true });
  assert.deepEqual(voiceCalls.at(-1), ["setVoiceMuted", true, "operator_muted"]);

  assert.equal(surface.sendEngineControl("connect", { detail: { reason: "test" } }), true);
  assert.deepEqual(runtimeCalls.at(-1), ["sendEngineControl", "connect", { reason: "test" }]);
});
