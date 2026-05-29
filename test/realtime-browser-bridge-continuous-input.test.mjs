import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime bridge keeps Meet input continuous while output audio plays", async () => {
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
        label: "continuous-input-test-audio",
      });
      await sleep(50);

      const inbound = (type) => {
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-realtime-server-event", {
            detail: { type, response: { id: "resp_continuous_input" } },
          }),
        );
      };

      inbound("response.created");
      inbound("output_audio_buffer.started");
      inbound("response.output_audio.done");
      inbound("response.done");
      await sleep(100);
      const gateWhileOutputActive = window.MAB_REALTIME_BRIDGE.connection.realtimeInputGateOpen;
      const outputActiveWhileDone = window.MAB_REALTIME_BRIDGE.protection.outputAudioActive;

      inbound("output_audio_buffer.stopped");
      await sleep(100);
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
          .filter((entry) => entry.type === "realtime_output_audio_completion_deferred")
          .map((entry) => entry.detail.reason),
        gateEvents: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type === "realtime_input_gate")
          .map((entry) => ({ open: entry.detail.open, reason: entry.detail.reason })),
      };
    });

    assert.equal(result.gateWhileOutputActive, true);
    assert.equal(result.outputActiveWhileDone, true);
    assert.equal(result.gateAfterOutputStopped, true);
    assert.equal(result.outputActiveAfterStopped, false);
    assert.ok(result.deferredReasons.includes("response.output_audio.done"));
    assert.ok(result.deferredReasons.includes("response.done"));
    assert.equal(
      result.gateEvents.some((event) => event.open === false),
      false,
      "bot output must not close the Meet input gate",
    );
  } finally {
    await browser.close();
  }
});

test("Realtime bridge clears stale output audio when the stopped event is missing", async () => {
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
        outputAudioDoneFallbackMs: 60,
        outputAudioStaleFallbackMs: 200,
      }),
    });

    const result = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const inbound = (type) => {
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-realtime-server-event", {
            detail: { type, response: { id: "resp_missing_stopped" } },
          }),
        );
      };

      inbound("response.created");
      inbound("output_audio_buffer.started");
      inbound("response.output_audio.done");
      inbound("response.done");
      const activeBeforeFallback = window.MAB_REALTIME_BRIDGE.protection.outputAudioActive;
      await sleep(140);
      inbound("input_audio_buffer.speech_started");
      await sleep(20);

      return {
        activeBeforeFallback,
        protection: window.MAB_REALTIME_BRIDGE.protection,
        gateAfterFallbackSpeech: window.MAB_REALTIME_BRIDGE.connection.realtimeInputGateOpen,
        syntheticSpeechActive:
          window.MAB_AVATAR_AUDIO_BUS?.debugState?.().syntheticSpeechActive ?? false,
        clearReasons: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type === "realtime_output_audio_cleared")
          .map((entry) => entry.detail.reason),
        speechAfterFallback: window.MAB_REALTIME_BRIDGE.timeline.find(
          (entry) => entry.type === "realtime_input_speech_started",
        )?.detail,
      };
    });

    assert.equal(result.activeBeforeFallback, true);
    assert.equal(result.protection.outputAudioActive, false);
    assert.ok(result.protection.lastOutputAudioStoppedAt);
    assert.equal(result.gateAfterFallbackSpeech, true);
    assert.equal(result.syntheticSpeechActive, false);
    assert.ok(result.clearReasons.includes("response.done_fallback"));
    assert.equal(result.speechAfterFallback.cancelSkipped, true);
    assert.equal(result.speechAfterFallback.reason, "no_output_audio_active");
  } finally {
    await browser.close();
  }
});

test("Realtime bridge clears output audio state during connection cleanup", async () => {
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

    const result = await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("meeting-avatar-realtime-server-event", {
          detail: { type: "output_audio_buffer.started" },
        }),
      );
      const activeBeforeCleanup = window.MAB_REALTIME_BRIDGE.protection.outputAudioActive;
      window.MAB_REALTIME_CLIENT.disconnect("data_channel_close");
      return {
        activeBeforeCleanup,
        protection: window.MAB_REALTIME_BRIDGE.protection,
        clearReasons: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type === "realtime_output_audio_cleared")
          .map((entry) => entry.detail.reason),
      };
    });

    assert.equal(result.activeBeforeCleanup, true);
    assert.equal(result.protection.outputAudioActive, false);
    assert.ok(result.clearReasons.includes("realtime_connection_data_channel_close"));
  } finally {
    await browser.close();
  }
});
