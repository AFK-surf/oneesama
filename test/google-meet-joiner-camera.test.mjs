import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

import { ensureMeetCameraOff } from "../packages/core/src/meeting/meet-camera-controls.ts";

test("ensureMeetCameraOff clicks the visible Meet camera toggle only when camera is on", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const events = [];
  try {
    await page.setContent(`
      <!doctype html>
      <button id="camera" aria-label="Turn off camera">videocam Turn off camera</button>
      <script>
        document.getElementById("camera").addEventListener("click", (event) => {
          event.currentTarget.dataset.clicked = "true";
          event.currentTarget.setAttribute("aria-label", "Turn on camera");
          event.currentTarget.textContent = "videocam_off Turn on camera";
        });
      </script>
    `);

    const first = await ensureMeetCameraOff(
      page,
      { record: (type, detail) => events.push({ type, detail }) },
      "test_pre_join",
    );
    assert.equal(first.ok, true);
    assert.equal(first.clicked, true);
    assert.match(first.label, /Turn off camera/);
    assert.equal(await page.locator("#camera").getAttribute("data-clicked"), "true");

    const second = await ensureMeetCameraOff(page, null, "test_already_off");
    assert.equal(second.ok, true);
    assert.equal(second.clicked, false);
    assert.equal(second.reason, "already_off");
    assert.match(second.label, /Turn on camera/);

    assert.equal(events[0].type, "meet_camera_off");
    assert.equal(events[0].detail.stage, "test_pre_join");
  } finally {
    await browser.close();
  }
});

test("caption-only Meet joins force camera off before and after admission", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");
  const preJoinCall =
    'if (!installAvatar) await ensureMeetCameraOff(page, diagnostics, "pre_join");';
  const postAdmissionCall =
    'if (!installAvatar) await ensureMeetCameraOff(page, diagnostics, "post_admission");';

  assert.ok(source.includes(preJoinCall), "join flow must disable fake camera before join");
  assert.ok(
    source.includes(postAdmissionCall),
    "join flow must re-check fake camera after admission",
  );
  assert.ok(
    source.indexOf(preJoinCall) < source.indexOf("let clicked = await clickMeetJoinButton"),
    "camera must be disabled before clicking the Meet join button",
  );
  assert.ok(
    source.indexOf(postAdmissionCall) < source.indexOf("const avatarRendererStart"),
    "camera must be re-checked before final join state is captured",
  );
});

test("Meet joins mute local playback by default while keeping an escape hatch", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");

  assert.ok(
    source.includes(
      "await installMeetLocalPlaybackMute(page, diagnostics, input.muteLocalPlayback !== false);",
    ),
    "Meet page media playback should be muted unless explicitly disabled for debugging",
  );
});
