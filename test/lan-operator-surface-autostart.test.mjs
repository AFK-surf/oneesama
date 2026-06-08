import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  buildLanOperatorSurfaceAutostartUrls,
  launchLanOperatorSurfaceAutostartUrls,
  parseLanOperatorSurfaceAutostartConfig,
} from "../packages/core/src/operator/lan-operator-surface-autostart.ts";

test("LAN operator autostart defaults to the real operator UI plus avatar publisher", () => {
  const config = parseLanOperatorSurfaceAutostartConfig([], {});
  const urls = buildLanOperatorSurfaceAutostartUrls("http://127.0.0.1:18913", config);

  assert.equal(config.openBrowser, true);
  assert.equal(config.openOperator, true);
  assert.equal(config.autoAvatarPublisher, true);
  assert.equal(config.avatarPreset, "fallback-canvas");
  assert.deepEqual(
    urls.map((entry) => entry.kind),
    ["operator", "avatar_publisher"],
  );
  assert.equal(new URL(urls[0].url).pathname, "/operator");
  const avatarUrl = new URL(urls[1].url);
  assert.equal(avatarUrl.pathname, "/host-visual");
  assert.equal(avatarUrl.searchParams.get("avatar"), "1");
  assert.equal(avatarUrl.searchParams.get("sourceId"), "avatar");
  assert.equal(avatarUrl.searchParams.get("kind"), "avatar");
  assert.equal(avatarUrl.searchParams.get("avatarPreset"), "fallback-canvas");
});

test("LAN operator autostart can be disabled or configured for tests", () => {
  assert.deepEqual(
    buildLanOperatorSurfaceAutostartUrls(
      "http://127.0.0.1:18913",
      parseLanOperatorSurfaceAutostartConfig(["--no-open"], {}),
    ),
    [],
  );

  const envDisabled = parseLanOperatorSurfaceAutostartConfig([], {
    MAB_LAN_OPERATOR_OPEN_BROWSER: "0",
  });
  assert.equal(envDisabled.openBrowser, false);
  assert.equal(envDisabled.openOperator, false);
  assert.equal(envDisabled.autoAvatarPublisher, false);

  const videoConfig = parseLanOperatorSurfaceAutostartConfig(
    ["--avatar-preset", "oneesama-video"],
    {},
  );
  const urls = buildLanOperatorSurfaceAutostartUrls("http://127.0.0.1:18913", videoConfig);
  assert.equal(videoConfig.avatarPreset, "oneesama-video");
  assert.equal(new URL(urls[1].url).searchParams.get("avatarPreset"), "oneesama-video");
});

test("LAN operator autostart launcher uses native open commands without blocking", () => {
  const calls = [];
  const launches = launchLanOperatorSurfaceAutostartUrls(
    [{ kind: "avatar_publisher", url: "http://127.0.0.1:18913/host-visual?avatar=1" }],
    {
      platform: "darwin",
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return { unref: () => undefined };
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "open");
  assert.deepEqual(calls[0].args, ["http://127.0.0.1:18913/host-visual?avatar=1"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(launches[0].launched, true);
});
