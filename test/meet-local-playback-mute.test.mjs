import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import { installMeetLocalPlaybackMute } from "../packages/core/src/meeting/meet-local-playback-mute.ts";

test("Meet local playback mute silences existing and newly added media elements", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body><audio></audio></body></html>");

    const installed = await installMeetLocalPlaybackMute(page, null, true);
    const result = await page.evaluate(async () => {
      const video = document.createElement("video");
      document.body.append(video);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return Array.from(document.querySelectorAll("audio,video")).map((element) => ({
        muted: element.muted,
        defaultMuted: element.defaultMuted,
        volume: element.volume,
        marked: element.dataset.meetingAvatarLocalPlaybackMuted,
      }));
    });

    assert.equal(installed.ok, true);
    assert.equal(result.length, 2);
    for (const element of result) {
      assert.equal(element.muted, true);
      assert.equal(element.defaultMuted, true);
      assert.equal(element.volume, 0);
      assert.equal(element.marked, "true");
    }
  } finally {
    await browser.close();
  }
});

test("Meet local playback mute leaves media elements alone when disabled", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body><audio></audio></body></html>");

    const installed = await installMeetLocalPlaybackMute(page, null, false);
    const result = await page.evaluate(() => {
      const audio = document.querySelector("audio");
      return {
        muted: audio?.muted,
        defaultMuted: audio?.defaultMuted,
        volume: audio?.volume,
        marked: audio?.dataset.meetingAvatarLocalPlaybackMuted || "",
      };
    });

    assert.equal(installed.ok, true);
    assert.equal(installed.skipped, true);
    assert.equal(installed.reason, "disabled_for_audio_capture");
    assert.equal(result.muted, false);
    assert.equal(result.defaultMuted, false);
    assert.equal(result.volume, 1);
    assert.equal(result.marked, "");
  } finally {
    await browser.close();
  }
});
