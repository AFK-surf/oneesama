import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime bridge keeps Meet input gated until output audio buffer stops", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      content: buildRealtimeBrowserInitScript({
        mode: "webrtc",
        agentRuntime: "raw",
        autoConnect: false,
        tokenUrl: "https://example.test/token",
        sdpUrl: "https://example.test/sdp",
        forwardMeetAudioToRealtime: true,
        includeParticipantAudio: true,
        captureMeetAudioForTranscript: false,
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      window.MAB_REALTIME_CLIENT.registerParticipantAudioStream(destination.stream, {
        label: "output-gate-test-audio",
      });
      await sleep(50);

      const inbound = (type) => {
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-realtime-server-event", {
            detail: { type, response: { id: "resp_output_gate" } },
          }),
        );
      };

      inbound("response.created");
      inbound("output_audio_buffer.started");
      inbound("response.output_audio.done");
      inbound("response.done");
      await sleep(1350);
      const gateWhileOutputActive = window.MAB_REALTIME_BRIDGE.connection.realtimeInputGateOpen;
      const outputActiveWhileDone = window.MAB_REALTIME_BRIDGE.protection.outputAudioActive;

      inbound("output_audio_buffer.stopped");
      await sleep(1350);
      const gateAfterOutputStopped = window.MAB_REALTIME_BRIDGE.connection.realtimeInputGateOpen;
      const outputActiveAfterStopped = window.MAB_REALTIME_BRIDGE.protection.outputAudioActive;

      oscillator.stop();
      await audioContext.close();
      return {
        gateWhileOutputActive,
        outputActiveWhileDone,
        gateAfterOutputStopped,
        outputActiveAfterStopped,
        deferredReasons: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type === "realtime_input_gate_open_deferred")
          .map((entry) => entry.detail.reason),
        gateEvents: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type === "realtime_input_gate")
          .map((entry) => ({ open: entry.detail.open, reason: entry.detail.reason })),
      };
    });

    assert.equal(result.gateWhileOutputActive, false);
    assert.equal(result.outputActiveWhileDone, true);
    assert.equal(result.gateAfterOutputStopped, true);
    assert.equal(result.outputActiveAfterStopped, false);
    assert.ok(result.deferredReasons.includes("response.output_audio.done"));
    assert.ok(result.deferredReasons.includes("response.done"));
    assert.deepEqual(result.gateEvents.at(-1), {
      open: true,
      reason: "output_audio_buffer.stopped",
    });
  } finally {
    await browser.close();
  }
});
