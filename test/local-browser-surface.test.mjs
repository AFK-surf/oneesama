import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chromium } from "playwright";

import {
  buildLocalBrowserRuntimeSessionConfig,
  createLocalBrowserSurfaceServer,
} from "../packages/core/src/avatar-runtime/local-browser-surface.ts";
import { validateRuntimeSessionConfig } from "../packages/core/src/avatar-runtime/contracts.ts";

test("local browser surface config is text-only and loop-safe by default", () => {
  const config = buildLocalBrowserRuntimeSessionConfig({
    sessionId: "local-browser-contract-test",
    botName: "Local Oneesama",
  });
  const validation = validateRuntimeSessionConfig(config);

  assert.equal(validation.ok, true);
  assert.equal(validation.config.surfaceKind, "local_browser");
  assert.equal(validation.config.conversationTransport, "mock");
  assert.deepEqual(validation.config.inputPolicy.audioInputs, ["synthetic"]);
  assert.deepEqual(validation.config.inputPolicy.textInputs, ["local_text"]);
  assert.equal(validation.config.inputPolicy.continuousMic, false);
  assert.deepEqual(validation.config.outputPolicy.audioOutputs, ["avatar_bus_only"]);
  assert.deepEqual(validation.config.outputPolicy.videoOutputs, ["dom_canvas"]);
  assert.equal(validation.config.outputPolicy.allowLocalSpeaker, false);
});

test("local browser surface runs avatar dialog without Google Meet", async () => {
  const surface = createLocalBrowserSurfaceServer({
    port: 0,
    sessionId: "local-browser-smoke",
    botName: "Local Oneesama",
    avatar: {
      disableLive2D: true,
    },
    handleTurn: async (request) => ({
      ok: true,
      status: "completed",
      provider: "local-browser-test",
      responseText: `本地回复:${request.utterance}`,
      job: {
        id: "job_local_browser_test",
        provider: "local-browser-test",
        status: "completed",
        result: `本地回复:${request.utterance}`,
      },
    }),
  });
  const { url } = await surface.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(
      () => window.MAB_LOCAL_BROWSER_SURFACE?.state?.ready === true,
      null,
      {
        timeout: 10_000,
      },
    );
    const result = await page.evaluate(() =>
      window.MAB_LOCAL_BROWSER_SURFACE.sendText("不用 Meet 直接跑一下"),
    );
    assert.equal(result.ok, true);
    const avatarMediaStream = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const tracks = stream.getTracks().map((track) => ({
        kind: track.kind,
        id: track.id,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
      }));
      stream.getTracks().forEach((track) => track.stop());
      return {
        tracks,
        media: window.MAB_AVATAR_MEDIA,
        readyMedia: window.MAB_AVATAR_READY?.mediaOverride,
      };
    });

    await page.waitForFunction(
      () => window.MAB_LOCAL_DIALOG?.lastTurn?.status === "completed",
      null,
      { timeout: 5_000 },
    );
    const state = await page.evaluate(() => ({
      ready: window.MAB_AVATAR_READY,
      localSurfaceReady: window.MAB_LOCAL_BROWSER_SURFACE?.state?.ready,
      localDialog: window.MAB_LOCAL_DIALOG,
      avatarState: window.MAB_AVATAR_STATE,
      avatarAudio: window.MAB_AVATAR_AUDIO,
      videoPaused: document.querySelector("video")?.paused,
      videoTrackCount: document.querySelector("video")?.srcObject?.getVideoTracks?.().length || 0,
      transcriptText: document.getElementById("transcript")?.textContent || "",
    }));

    assert.equal(state.ready.ok, true);
    assert.equal(state.ready.rendererMode, "fallback");
    assert.equal(state.ready.fallbackReason, "disabled_by_config");
    assert.deepEqual(avatarMediaStream.tracks.map((track) => track.kind).sort(), [
      "audio",
      "video",
    ]);
    assert.ok(avatarMediaStream.media.getUserMediaCalls >= 1, JSON.stringify(avatarMediaStream));
    assert.ok(
      avatarMediaStream.media.videoGetUserMediaCalls >= 1,
      JSON.stringify(avatarMediaStream),
    );
    assert.ok(
      avatarMediaStream.media.returnedVideoTrackCount >= 1,
      JSON.stringify(avatarMediaStream),
    );
    assert.equal(avatarMediaStream.readyMedia.ok, true);
    assert.ok(
      avatarMediaStream.media.patchedTargets.includes("MediaDevices.prototype.getUserMedia"),
      JSON.stringify(avatarMediaStream.media),
    );
    assert.equal(state.localSurfaceReady, true);
    assert.equal(state.videoPaused, false);
    assert.equal(state.videoTrackCount, 1);
    assert.equal(state.localDialog.utterancesReceived, 1);
    assert.equal(state.localDialog.responsesSpoken, 1);
    assert.equal(state.localDialog.tts.routedToAvatarBus, true);
    assert.equal(state.localDialog.lastTurn.provider, "local-browser-test");
    assert.match(state.localDialog.lastTurn.responseText, /不用 Meet/);
    assert.ok(state.avatarAudio.injectedTones >= 1, JSON.stringify(state.avatarAudio));
    assert.ok(
      state.avatarState.updates.some(
        (update) => update.kind === "action" && update.action === "speak",
      ),
      JSON.stringify(state.avatarState),
    );
    assert.match(state.transcriptText, /本地回复/);

    const status = await (await fetch(new URL("/runtime/status", url))).json();
    assert.equal(status.ok, true);
    assert.equal(status.snapshot.surfaceKind, "local_browser");
    assert.equal(status.snapshot.conversationTransport, "mock");
    assert.deepEqual(status.inputPolicy.audioInputs, ["synthetic"]);
    assert.deepEqual(status.outputPolicy.audioOutputs, ["avatar_bus_only"]);
    assert.equal(status.outputPolicy.allowLocalSpeaker, false);
    assert.deepEqual(status.initScripts.categories, ["avatar", "local_dialog"]);
  } finally {
    await browser.close();
    await surface.close();
  }
});
