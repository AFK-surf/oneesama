import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { getRuntimeConfig } from "../packages/core/src/env.ts";
import { buildAvatarInitScript } from "../packages/core/src/avatar/init-script-builder.ts";

test("avatar runtime config uses resilient Hiyori model URLs", () => {
  const config = getRuntimeConfig({});

  assert.match(
    config.avatarModelUrl,
    /fastly\.jsdelivr\.net\/gh\/Live2D\/CubismWebSamples@develop/,
  );
  assert.ok(
    config.avatarModelFallbackUrls.some((url) =>
      url.includes("raw.githubusercontent.com/Live2D/CubismWebSamples/develop"),
    ),
  );
});

test("avatar runtime config defaults to video renderer", () => {
  const config = getRuntimeConfig({});

  assert.equal(config.avatarRenderer, "video");
  assert.match(config.avatarVRMModelUrl, /\.vrm$/);
});

test("runtime config defaults Realtime Google Meet joins to sidecar placement", () => {
  const config = getRuntimeConfig({});

  assert.equal(config.openaiRealtimeAgentRuntime, "agents-sdk");
  assert.equal(config.openaiRealtimeRuntimePlacement, "sidecar");
});

test("runtime config keeps meeting-agent control API on loopback by default", () => {
  assert.equal(getRuntimeConfig({}).meetingHost, "127.0.0.1");
  assert.equal(getRuntimeConfig({ MAB_MEETING_HOST: "0.0.0.0" }).meetingHost, "0.0.0.0");
});

test("runtime config still preserves explicit inline Realtime placement for non-Meet diagnostics", () => {
  const config = getRuntimeConfig({
    MAB_OPENAI_REALTIME_RUNTIME_PLACEMENT: "inline",
  });

  assert.equal(config.openaiRealtimeRuntimePlacement, "inline");
});

test("avatar init script does not bundle VRM dependencies by default", () => {
  const script = buildAvatarInitScript();

  assert.doesNotMatch(script, /MAB_AVATAR_INLINE_VRM_DEPS/);
  assert.doesNotMatch(script, /MABAvatarVRMDepsBundle/);
});

test("avatar init script includes model fallback URLs", () => {
  const script = buildAvatarInitScript({
    modelUrl: "https://example.invalid/Hiyori.model3.json",
    modelFallbackUrls: ["https://example.test/fallback.model3.json"],
  });

  assert.match(script, /modelFallbackUrls/);
  assert.match(script, /example\.test\/fallback\.model3\.json/);
  assert.match(script, /loadLive2DModelWithFallback/);
});

test("avatar init script can defer heavy renderer startup until after join", () => {
  const script = buildAvatarInitScript({
    deferRendererUntilExplicitStart: true,
  });

  assert.match(script, /deferRendererUntilExplicitStart/);
  assert.match(script, /MAB_AVATAR_START_RENDERER/);
  assert.match(script, /avatar renderer deferred until explicit start/);
});

test("avatar init script hardens media overrides for Meet camera capture", () => {
  const script = buildAvatarInitScript({
    deferRendererUntilExplicitStart: true,
  });

  assert.match(script, /MAB_AVATAR_MEDIA/);
  assert.match(script, /MediaDevices\.prototype\.getUserMedia/);
  assert.match(script, /navigator\.webkitGetUserMedia/);
  assert.match(script, /videoGetUserMediaCalls/);
  assert.match(script, /returnedVideoTrackCount/);
  assert.match(script, /lastReturnedTracks/);
});

test("avatar media override starts before Meet DOMContentLoaded camera probes", async () => {
  const script = buildAvatarInitScript({
    deferRendererUntilExplicitStart: true,
  });

  assert.doesNotMatch(script, /DOMContentLoaded/);
  assert.match(script, /document\.documentElement \|\| document\.head \|\| document\.body/);
  assert.match(script, /MAB_AVATAR_BOOT_ERROR/);
  assert.match(script, /start\(\)\.catch/);
});

test("avatar audio bus exposes a PCM enqueue API for Realtime sidecar output", () => {
  const script = buildAvatarInitScript();

  assert.match(script, /enqueuePcmFrames/);
  assert.match(script, /routedPcmChunks/);
  assert.match(script, /lastPcmRoute/);
});

test("avatar init script bundles VRM dependencies for Meet pages", () => {
  const script = buildAvatarInitScript({
    avatarRenderer: "vrm",
  });

  assert.match(script, /MAB_AVATAR_INLINE_VRM_DEPS/);
  assert.match(script, /MAB_AVATAR_THREE_VRM_DEPS/);
  assert.match(script, /VRMLoaderPlugin/);
});

test("avatar init script skips VRM dependency bundle for explicit Live2D renderer", () => {
  const script = buildAvatarInitScript({
    avatarRenderer: "live2d",
  });

  assert.doesNotMatch(script, /MAB_AVATAR_INLINE_VRM_DEPS/);
  assert.doesNotMatch(script, /MABAvatarVRMDepsBundle/);
});
