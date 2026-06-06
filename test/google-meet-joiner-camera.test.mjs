import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vite-plus/test";
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
    source.indexOf(preJoinCall) < source.indexOf("clicked = await clickMeetJoinButton"),
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

  const recappiSource = [
    "const realtimeMeetAudioInputSource = realtimeRecappiAudioInput",
    '? "recappi_process_audio"',
  ];
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
    recappiSource.every((snippet) => source.includes(snippet)),
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

test("WebDriver handoff installs Meet runtime with CDP before script-tag fallback", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");
  const helperName = "async function installRuntimeInitScriptForPage";
  const cdpMethod = 'cdp.send("Runtime.evaluate"';
  const cspBypass = "allowUnsafeEvalBlockedByCSP: true";
  const fallback = ".addScriptTag({ content: script.content })";
  const call =
    "await installRuntimeInitScriptForPage(page, script, { diagnostics, webDriverPreJoined });";

  assert.ok(
    source.includes(helperName),
    "WebDriver joins need a dedicated current-page runtime installer",
  );
  assert.ok(
    source.includes(cdpMethod) && source.includes(cspBypass),
    "late runtime install must use CDP Runtime.evaluate with CSP unsafe-eval bypass",
  );
  assert.ok(
    source.includes(fallback),
    "script-tag fallback should remain for non-Meet or non-CDP diagnostic pages",
  );
  assert.ok(source.includes(call), "runtime init loop should use the shared late-install helper");
  assert.ok(
    source.indexOf(cdpMethod) < source.indexOf(fallback),
    "CDP install must run before the Trusted Types-sensitive script-tag fallback",
  );
});

test("Realtime avatar joins do not default to Chrome built-in fake camera", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");

  assert.ok(
    source.includes("function shouldUseChromeFakeMediaDevice"),
    "joiner should centralize Chrome fake media device policy",
  );
  assert.ok(
    source.includes("if (input.installAvatar) return false;"),
    "avatar joins should rely on avatar runtime tracks, not Chrome's green fake camera",
  );
  assert.ok(
    source.includes("useFakeMediaDevice: shouldUseChromeFakeMediaDevice"),
    "launcher args should receive the avatar-aware fake media policy",
  );
  assert.ok(
    source.includes("--use-file-for-fake-audio-capture") &&
      source.indexOf("if (input.installAvatar) return false;") <
        source.indexOf("--use-file-for-fake-audio-capture"),
    "explicit synthetic-audio diagnostics may still request Chrome fake media only outside avatar joins",
  );
});

test("WebDriver realtime avatar joins pass prejoin avatar runtime into admission lane", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");

  assert.ok(
    source.includes("preJoinRuntimeScripts:") &&
      source.includes("installRealtimeBridge: false") &&
      source.includes("installScreenShareBridge: false"),
    "WebDriver prejoin install should pass only the avatar media runtime before admission",
  );
  assert.ok(
    source.includes("requirePreJoinRuntimeScripts: installAvatar"),
    "avatar joins should fail before Join if prejoin media runtime is not ready",
  );
  assert.ok(
    source.includes("turnOffMicBeforeJoin: !installAvatar") &&
      source.includes("turnOffCameraBeforeJoin: !installAvatar"),
    "avatar joins must keep Meet mic/camera enabled so avatar tracks are published",
  );
  assert.ok(
    source.indexOf("const avatarConfig = await buildMeetAvatarConfig") <
      source.indexOf("webDriverSession = await runWebDriverJoinLane"),
    "avatar config must be available before WebDriver starts Meet admission",
  );
});

test("WebDriver Meet hard blocks retry without losing the hard-block reason", async () => {
  const source = await readFile("packages/core/src/meeting/google-meet-joiner.ts", "utf8");

  assert.ok(
    source.includes('boundedEnvInt("MAB_MEET_WEBDRIVER_HARD_BLOCK_RETRIES", 2, 0, 3)'),
    "WebDriver hard-block retries should default to two bounded fresh attempts",
  );
  assert.ok(
    source.includes('diagnostics.record("webdriver_hard_block_retry"'),
    "hard-block retries should be visible in diagnostics",
  );
  assert.ok(
    source.includes("emitStatus: (webdriverStatus, message, detail = {})") &&
      source.includes("...detail"),
    "WebDriver lane stage timing details should be preserved in top-level diagnostics",
  );
  assert.ok(
    source.includes('webDriverFailure?.status !== "hard_blocked"'),
    "generic WebDriver error statuses must not overwrite a prior hard_blocked status",
  );
  assert.ok(
    source.includes('error: failure.status === "hard_blocked" ? "cannot_join_meeting"'),
    "terminal hard-block failures should surface as cannot_join_meeting, not generic error",
  );
});
