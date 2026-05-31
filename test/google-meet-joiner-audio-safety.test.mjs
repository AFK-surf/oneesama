import assert from "node:assert/strict";
import test from "node:test";

import { defaultGoogleMeetRealtimeTools } from "../packages/core/src/meeting/google-meet-joiner.ts";
import { buildGoogleMeetChromiumArgs } from "../packages/core/src/meeting/google-meet-launch-args.ts";

test("Google Meet launcher avoids host audio devices by default", () => {
  const args = buildGoogleMeetChromiumArgs({});

  assert.ok(args.includes("--use-fake-ui-for-media-stream"));
  assert.ok(args.includes("--use-fake-device-for-media-stream"));
  assert.ok(args.includes("--disable-features=AudioServiceOutOfProcess"));
  assert.equal(args.includes("--mute-audio"), false);
});

test("Google Meet launcher preserves caller-supplied Chromium args", () => {
  const args = buildGoogleMeetChromiumArgs({
    avatarUseSwiftShader: true,
    browserExtraArgs: "--foo  --bar",
    chromiumExtraArgs: "--baz",
  });

  assert.ok(args.includes("--use-angle=swiftshader"));
  assert.ok(args.includes("--enable-unsafe-swiftshader"));
  assert.ok(args.includes("--foo"));
  assert.ok(args.includes("--bar"));
  assert.ok(args.includes("--baz"));
});

test("Google Meet joiner default realtime surface hides demo browser tools", () => {
  const names = new Set(defaultGoogleMeetRealtimeTools().map((tool) => tool.name));

  assert.ok(names.has("share_existing_app_window"));
  assert.ok(names.has("control_shared_app_window"));
  assert.equal(names.has("open_shared_browser_surface"), false);
  assert.equal(names.has("create_shared_workspace"), false);
  assert.equal(names.has("control_shared_browser_surface"), false);
  assert.equal(names.has("stop_shared_browser_surface"), false);
});
