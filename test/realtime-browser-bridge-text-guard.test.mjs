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
        agentRuntime: "raw",
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
      return {
        allowed,
        blocked,
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
    assert.equal(result.blockedCount, 1);
    assert.equal(result.blockedTimeline.length, 1);
    assert.equal(result.outbound.length, 1);
    assert.equal(result.outbound[0].item.metadata.source, "manual_text_turn");
    assert.equal(result.wireEvents.length, 1);
    assert.equal(result.wireEvents[0].item.metadata, undefined);
  } finally {
    await browser.close();
  }
});

test("Realtime bridge accepts debounced Meet caption turns as live user speech", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      content: buildRealtimeBrowserInitScript({
        mode: "mock",
        agentRuntime: "raw",
        autoConnect: false,
        botName: "Onee Sama",
        captionTurnDebounceMs: 50,
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
      const scheduled = window.MAB_REALTIME_CLIENT.injectCaptionTurn({
        ts: "2026-05-27T02:10:00.000Z",
        speaker: "Peng Xiao",
        text: "现在还是不理我",
        streamId: "caption-1",
        source: "google-meet-caption-dom",
      });
      const botSkipped = window.MAB_REALTIME_CLIENT.injectCaptionTurn({
        ts: "2026-05-27T02:10:01.000Z",
        speaker: "Onee Sama",
        text: "我自己的回声不该触发",
        streamId: "caption-2",
        source: "google-meet-caption-dom",
      });
      await new Promise((resolve) => setTimeout(resolve, 320));
      return {
        scheduled,
        botSkipped,
        responsesRequested: window.MAB_REALTIME_BRIDGE.responsesRequested,
        captionTurnsInjected: window.MAB_REALTIME_BRIDGE.connection.captionTurnsInjected,
        outbound: window.MAB_REALTIME_BRIDGE.outbound.map((entry) => entry.event),
        wireEvents,
        timeline: window.MAB_REALTIME_BRIDGE.timeline
          .filter((entry) => entry.type.startsWith("meet_caption_turn"))
          .map((entry) => entry.type),
      };
    });

    assert.equal(result.scheduled.scheduled, true);
    assert.equal(result.botSkipped.skipped, true);
    assert.equal(result.botSkipped.reason, "bot_caption_turn");
    assert.equal(result.responsesRequested, 1);
    assert.equal(result.captionTurnsInjected, 1);
    assert.deepEqual(result.timeline, [
      "meet_caption_turn_scheduled",
      "meet_caption_turn_injected",
    ]);
    assert.equal(result.outbound.length, 2);
    assert.equal(result.outbound[0].item.metadata.source, "meet_caption_observer");
    assert.equal(result.outbound[0].item.content[0].text, "现在还是不理我");
    assert.equal(result.outbound[1].type, "response.create");
    assert.equal(result.wireEvents.length, 2);
    assert.equal(result.wireEvents[0].item.metadata, undefined);
  } finally {
    await browser.close();
  }
});
