import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  FALLBACK_STAGE_SOURCES,
  stageFrameUrl,
  stageView,
} from "../packages/core/src/operator/web/stageView.ts";

test("operator stage view derives fallback sources and avatar frame urls", () => {
  const view = stageView({
    activeSourceId: "avatar",
    avatarPreset: "oneesama-video",
    debug: {},
    refreshKey: 3,
    token: "secret token",
  });

  assert.deepEqual(
    view.sourceTabs.map((source) => [source.id, source.label, source.stateLabel, source.active]),
    [
      ["avatar", "Avatar", "synthetic", true],
      ["host-app", "App view", "synthetic", false],
    ],
  );
  assert.equal(view.connectionStateLabel, "not_connected");
  assert.equal(view.trackCountLabel, "0");
  assert.equal(view.frames.length, 2);

  const avatarUrl = new URL(view.frames[0].src, "http://operator.local");
  assert.equal(avatarUrl.pathname, "/host-visual");
  assert.equal(avatarUrl.searchParams.get("embed"), "1");
  assert.equal(avatarUrl.searchParams.get("sourceId"), "avatar");
  assert.equal(avatarUrl.searchParams.get("avatar"), "1");
  assert.equal(avatarUrl.searchParams.get("avatarPreset"), "oneesama-video");
  assert.equal(avatarUrl.searchParams.get("refresh"), "3");
  assert.equal(avatarUrl.searchParams.get("token"), "secret token");

  const hostUrl = new URL(view.frames[1].src, "http://operator.local");
  assert.equal(hostUrl.searchParams.get("sourceId"), "host-app");
  assert.equal(hostUrl.searchParams.get("avatar"), null);
  assert.equal(view.telemetryRows.find((row) => row.label === "visual ws")?.value, "closed");
  assert.equal(view.telemetryRows.find((row) => row.label === "canvas")?.value, "0x0@0");
});

test("operator stage view derives visual sources, active fallback, and telemetry", () => {
  const view = stageView({
    activeSourceId: "missing",
    avatarPreset: "fallback-canvas",
    debug: {
      visual: {
        connectionState: "connected",
        receiverWebSocketState: "open",
        peerConnectionState: "stable",
        trackCount: 2,
        sources: [
          {
            id: "screen",
            label: "Main screen",
            kind: "desktop_app",
            state: "live",
            width: 1280,
            height: 720,
          },
          {
            id: "avatar",
            label: "Avatar",
            kind: "avatar",
            state: "ready",
            avatarPreset: "hiyori-live2d",
          },
        ],
        composition: {
          width: 1920,
          height: 1080,
          targetFps: 30,
          layoutRevision: 8,
          focusedSourceId: "screen",
          overlayCount: 2,
        },
      },
    },
    refreshKey: 0,
  });

  assert.equal(view.connectionStateLabel, "connected");
  assert.equal(view.trackCountLabel, "2");
  assert.deepEqual(
    view.sourceTabs.map((source) => [source.id, source.active]),
    [
      ["screen", true],
      ["avatar", false],
    ],
  );
  assert.equal(
    new URL(view.frames[1].src, "http://operator.local").searchParams.get("avatarPreset"),
    "hiyori-live2d",
  );
  assert.deepEqual(
    view.telemetryRows.map((row) => [row.label, row.value]),
    [
      ["visual ws", "open"],
      ["webrtc", "stable"],
      ["layout", "rev 8"],
      ["canvas", "1920x1080@30"],
      ["focus", "screen"],
      ["overlays", "2"],
    ],
  );
});

test("operator stage frame url uses source fields and defaults", () => {
  const url = new URL(
    stageFrameUrl({
      avatarPreset: "fallback-canvas",
      refreshKey: 4,
      source: { id: "window-1", label: "", kind: "", state: "live" },
    }),
    "http://operator.local",
  );

  assert.equal(url.pathname, "/host-visual");
  assert.equal(url.searchParams.get("sourceId"), "window-1");
  assert.equal(url.searchParams.get("label"), "window-1");
  assert.equal(url.searchParams.get("kind"), "desktop_app");
  assert.equal(url.searchParams.get("refresh"), "4");
});

test("operator stage fallback sources remain stable", () => {
  assert.deepEqual(
    FALLBACK_STAGE_SOURCES.map((source) => [source.id, source.label, source.kind, source.state]),
    [
      ["avatar", "Avatar", "avatar", "synthetic"],
      ["host-app", "App view", "desktop_app", "synthetic"],
    ],
  );
});
