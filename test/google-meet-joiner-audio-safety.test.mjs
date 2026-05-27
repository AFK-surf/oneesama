import assert from "node:assert/strict";
import test from "node:test";

import { buildGoogleMeetChromiumArgs } from "../packages/core/src/meeting/google-meet-launch-args.ts";

test("Google Meet launcher avoids host audio devices by default", () => {
  const args = buildGoogleMeetChromiumArgs({});

  assert.ok(args.includes("--use-fake-ui-for-media-stream"));
  assert.ok(args.includes("--use-fake-device-for-media-stream"));
  assert.ok(args.includes("--mute-audio"));
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
