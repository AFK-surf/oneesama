import assert from "node:assert/strict";
import test from "node:test";

import { getRuntimeConfig } from "../packages/core/src/env.ts";
import { buildAvatarInitScript } from "../packages/core/src/avatar/init-script-builder.ts";

test("avatar runtime config uses resilient Hiyori model URLs", () => {
  const config = getRuntimeConfig({});

  assert.match(config.avatarModelUrl, /fastly\.jsdelivr\.net\/gh\/Live2D\/CubismWebSamples@develop/);
  assert.ok(
    config.avatarModelFallbackUrls.some((url) =>
      url.includes("raw.githubusercontent.com/Live2D/CubismWebSamples/develop"),
    ),
  );
});

test("avatar runtime config defaults to VRM renderer", () => {
  const config = getRuntimeConfig({});

  assert.equal(config.avatarRenderer, "vrm");
  assert.match(config.avatarVRMModelUrl, /\.vrm$/);
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
