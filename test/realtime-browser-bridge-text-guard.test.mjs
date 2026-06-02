import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { buildRealtimeBrowserInitScript } from "../packages/core/src/realtime/realtime-browser-init-builder.ts";

test("Realtime bridge blocks untagged user text turns from internal streams", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      content: buildRealtimeBrowserInitScript({
        mode: "mock",
        agentRuntime: "agents-sdk",
        autoConnect: false,
        forwardMeetAudioToRealtime: true,
        includeParticipantAudio: false,
        captureMeetAudioForTranscript: false,
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(() => {
      const wireEvents = [];
      window.addEventListener("meeting-avatar-realtime-event", (event) => {
        wireEvents.push(event.detail);
      });
      const blocked = window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "internal text should not become user speech" }],
        },
      });
      const allowed = window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          metadata: { source: "manual_text_turn" },
          content: [{ type: "input_text", text: "explicit operator text turn" }],
        },
      });
      const captionBlocked = window.MAB_REALTIME_CLIENT.sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          metadata: { source: "meet_caption_observer" },
          content: [{ type: "input_text", text: "caption text is diagnostics only" }],
        },
      });
      return {
        allowed,
        blocked,
        captionBlocked,
        blockedCount: window.MAB_REALTIME_BRIDGE.connection.blockedUserTextEvents,
        blockedTimeline: window.MAB_REALTIME_BRIDGE.timeline.filter(
          (entry) => entry.type === "realtime_user_text_blocked",
        ),
        outbound: window.MAB_REALTIME_BRIDGE.outbound.map((entry) => entry.event),
        wireEvents,
      };
    });

    assert.equal(result.blocked, "blocked-untrusted-user-text");
    assert.equal(result.allowed, "custom-event");
    assert.equal(result.captionBlocked, "blocked-untrusted-user-text");
    assert.equal(result.blockedCount, 2);
    assert.equal(result.blockedTimeline.length, 2);
    assert.equal(result.outbound.length, 1);
    assert.equal(result.outbound[0].item.metadata.source, "manual_text_turn");
    assert.equal(result.wireEvents.length, 1);
    assert.equal(result.wireEvents[0].item.metadata, undefined);
  } finally {
    await browser.close();
  }
});

test("Realtime bridge observes Meet caption turns without using them as model input", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      content: buildRealtimeBrowserInitScript({
        mode: "mock",
        agentRuntime: "agents-sdk",
        autoConnect: false,
        botName: "Onee Sama",
        forwardMeetAudioToRealtime: true,
        includeParticipantAudio: false,
        captureMeetAudioForTranscript: false,
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      const wireEvents = [];
      window.addEventListener("meeting-avatar-realtime-event", (event) => {
        wireEvents.push(event.detail);
      });
      const skipped = window.MAB_REALTIME_CLIENT.observeCaptionSpeakerSignal({
        ts: "2026-05-27T02:10:00.000Z",
        speaker: "Peng Xiao",
        text: "现在还是不理我",
        streamId: "caption-1",
        source: "google-meet-caption-dom",
      });
      return {
        skipped,
        responsesRequested: window.MAB_REALTIME_BRIDGE.responsesRequested,
        captionTurnsObserved: window.MAB_REALTIME_BRIDGE.connection.captionTurnsObserved,
        hasMisleadingInjectedCaptionMetric: Object.keys(window.MAB_REALTIME_BRIDGE.connection).some(
          (key) => key.toLowerCase().includes("caption") && key.toLowerCase().includes("inject"),
        ),
        lastCaptionTurnText: window.MAB_REALTIME_BRIDGE.connection.lastCaptionTurnText,
        lastCaptionTurnTextChars: window.MAB_REALTIME_BRIDGE.connection.lastCaptionTurnTextChars,
        outbound: window.MAB_REALTIME_BRIDGE.outbound.map((entry) => entry.event),
        wireEvents,
        timeline: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type.startsWith("meet_caption_turn"))
          .map((entry) => entry.type),
      };
    });

    assert.equal(result.skipped.skipped, true);
    assert.equal(result.skipped.reason, "caption_turn_speaker_signal_only");
    assert.deepEqual(result.skipped.speakerSignal, {
      name: "Peng Xiao",
      streamId: "caption-1",
    });
    assert.equal(result.responsesRequested, 0);
    assert.equal(result.captionTurnsObserved, 1);
    assert.equal(result.hasMisleadingInjectedCaptionMetric, false);
    assert.equal(result.lastCaptionTurnText, "");
    assert.equal(result.lastCaptionTurnTextChars, "现在还是不理我".length);
    assert.deepEqual(result.timeline, ["meet_caption_turn_observed"]);
    assert.equal(result.outbound.length, 0);
    assert.equal(result.wireEvents.length, 0);
  } finally {
    await browser.close();
  }
});

test("Realtime bridge does not resurrect caption fallback for duplicate streams", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      content: buildRealtimeBrowserInitScript({
        mode: "mock",
        agentRuntime: "agents-sdk",
        autoConnect: false,
        botName: "Onee Sama",
        forwardMeetAudioToRealtime: true,
        includeParticipantAudio: false,
        captureMeetAudioForTranscript: false,
        sendSessionUpdateOnConnect: false,
      }),
    });

    const result = await page.evaluate(async () => {
      window.MAB_REALTIME_CLIENT.observeCaptionSpeakerSignal({
        ts: "2026-05-27T13:43:33.548Z",
        speaker: "Peng Xiao",
        text: "No. Hello. Hello.",
        streamId: "caption-1",
      });
      const duplicate = window.MAB_REALTIME_CLIENT.observeCaptionSpeakerSignal({
        ts: "2026-05-27T13:43:33.548Z",
        speaker: "Peng Xiao",
        text: "No. Hello. Hello.",
        streamId: "caption-2",
      });
      return {
        duplicate,
        responsesRequested: window.MAB_REALTIME_BRIDGE.responsesRequested,
        captionTurnsObserved: window.MAB_REALTIME_BRIDGE.connection.captionTurnsObserved,
        hasMisleadingInjectedCaptionMetric: Object.keys(window.MAB_REALTIME_BRIDGE.connection).some(
          (key) => key.toLowerCase().includes("caption") && key.toLowerCase().includes("inject"),
        ),
        outbound: window.MAB_REALTIME_BRIDGE.outbound.map((entry) => entry.event),
      };
    });

    assert.equal(result.duplicate.skipped, true);
    assert.equal(result.duplicate.reason, "caption_turn_speaker_signal_only");
    assert.equal(result.responsesRequested, 0);
    assert.equal(result.captionTurnsObserved, 2);
    assert.equal(result.hasMisleadingInjectedCaptionMetric, false);
    assert.equal(result.outbound.filter((event) => event.type === "response.create").length, 0);
  } finally {
    await browser.close();
  }
});
