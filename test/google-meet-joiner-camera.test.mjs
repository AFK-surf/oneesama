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

test("Realtime Meet joins keep local playback unmuted for audio capture by default", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");
  const baseSource = await readFile("packages/core/src/meeting/google-meet-joiner-base.ts", "utf8");

  assert.ok(
    baseSource.includes(
      "function shouldMuteMeetLocalPlayback(input: GoogleMeetJoinInput): boolean {",
    ),
    "Meet local playback mute policy should be explicit",
  );
  assert.ok(
    baseSource.includes("input.autoConnectRealtime === true"),
    "Realtime sessions should be treated separately from passive meeting joins",
  );
  assert.ok(
    baseSource.includes("input.includeParticipantAudio === true"),
    "Realtime audio capture sessions must keep Meet media available",
  );
  assert.ok(
    source.includes(
      "await installMeetLocalPlaybackMute(page, diagnostics, shouldMuteMeetLocalPlayback(input));",
    ),
    "Join flow should use the explicit local playback mute policy",
  );
});

test("Meet avatar camera defaults avoid 1080p chroma-key CPU burn", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");
  const envSource = await readFile("packages/core/src/env.ts", "utf8");

  assert.ok(
    source.includes("config.avatarCanvasWidth || 1280"),
    "Meet avatar canvas should default to the native 720p video asset width",
  );
  assert.ok(
    source.includes("config.avatarCanvasHeight || 720"),
    "Meet avatar canvas should default to the native 720p video asset height",
  );
  assert.ok(
    envSource.includes("MAB_AVATAR_CAPTURE_FPS || 12"),
    "video avatar capture should default to a CPU-safe live frame rate",
  );
  assert.ok(
    envSource.includes("oneesama-video-idle-loop-subtle-alpha.webm") &&
      envSource.includes("oneesama-video-speaking-loop-slit-alpha.webm"),
    "live video avatar should default to offline-keyed alpha clips",
  );
  assert.ok(
    source.includes("mimeType: videoMimeType(relativePath)") &&
      source.includes("enabled: !videoUsesAlpha"),
    "alpha video clips should bypass runtime chroma keying",
  );
  assert.ok(
    source.includes("maxProcessingWidth: 640") && source.includes("maxProcessingHeight: 360"),
    "non-alpha chroma-key fallback should process a downscaled matte instead of full 720p frames",
  );
  assert.ok(
    source.includes("videoCrossfadeMs: 0"),
    "live video avatar should avoid double chroma work during state transitions",
  );
});

test("Realtime Recappi Meet joins keep raw audio on native server VAD", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");

  const recappiSource = "const realtimeMeetAudioInputSource = realtimeRecappiAudioInput";
  const recappiConfig = "meetAudioInputSource: realtimeMeetAudioInputSource";
  const oldTranscriptGate = ["gateRealtimeResponsesOn", "InputTranscription"].join("");
  const oldTranscriptFlag = ["responseAfter", "InputTranscription"].join("");

  assert.ok(
    !source.includes(oldTranscriptGate),
    "Recappi Realtime joins must not route raw audio through a transcript gate",
  );
  assert.ok(
    !source.includes(oldTranscriptFlag),
    "browser runtime must not request responses from transcript-derived events",
  );
  assert.ok(
    source.includes(recappiSource),
    "Recappi joins must select the process audio tap as the Realtime input source",
  );
  assert.ok(
    source.includes(recappiConfig),
    "Recappi joins must pass the selected process audio tap source into the browser runtime",
  );
  assert.ok(
    source.indexOf("buildRealtimeSessionConfig") <
      source.indexOf("const runtimeInitScripts = buildAvatarRuntimeInitScripts"),
    "native Realtime session config must be built before the browser init script",
  );
});
