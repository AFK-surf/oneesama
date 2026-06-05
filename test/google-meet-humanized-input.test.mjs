import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  computeScreenPoint,
  generateHumanizedTrajectory,
  resolveMeetUIInteractionDetails,
} from "../packages/core/src/meeting/google-meet-humanized-input.ts";

const okRunner = (command, args) => {
  if (command === "cliclick" && args[0] === "p:.") return { status: 0, stdout: "10,20\n" };
  return { status: 0, stdout: "" };
};

const missingRunner = () => ({
  status: null,
  error: new Error("not found"),
});

const linuxOkRunner = (command) => {
  if (command === "cueboard-xtest-input") return { status: 0, stdout: '{"xtest":true}\n' };
  if (command === "xdotool") return { status: 0, stdout: "X=10\nY=20\nSCREEN=0\nWINDOW=1\n" };
  return { status: 0, stdout: "" };
};

test("Meet UI interaction defaults to auto macOS humanized input", () => {
  const details = resolveMeetUIInteractionDetails({}, "darwin", okRunner);
  assert.equal(details.mode, "humanized");
  assert.equal(details.backend, "cliclick");
  assert.equal(details.requested, "auto");
});

test("Meet UI interaction can still force synthetic input for diagnostics", () => {
  const details = resolveMeetUIInteractionDetails(
    { MAB_MEET_UI_INTERACTION_MODE: "synthetic" },
    "darwin",
    okRunner,
  );
  assert.equal(details.mode, "synthetic");
  assert.equal(details.backend, "playwright");
});

test("Meet UI interaction defaults to Linux XTEST input when DISPLAY is available", () => {
  const details = resolveMeetUIInteractionDetails({ DISPLAY: ":99" }, "linux", linuxOkRunner);
  assert.equal(details.mode, "humanized");
  assert.equal(details.backend, "xtest");
  assert.equal(details.requested, "auto");
});

test("Meet UI interaction falls back on Linux when XTEST is unavailable", () => {
  const details = resolveMeetUIInteractionDetails({}, "linux", missingRunner);
  assert.equal(details.mode, "synthetic");
  assert.equal(details.backend, "playwright");
  assert.match(details.reason, /DISPLAY is not set/);
});

test("Meet UI interaction can select macOS humanized input", () => {
  const details = resolveMeetUIInteractionDetails(
    { MAB_MEET_UI_INTERACTION_MODE: "humanized" },
    "darwin",
    okRunner,
  );
  assert.equal(details.mode, "humanized");
  assert.equal(details.backend, "cliclick");
});

test("Meet UI interaction fails fast when requested humanized input is unavailable", () => {
  assert.throws(
    () =>
      resolveMeetUIInteractionDetails(
        { MAB_MEET_UI_INTERACTION_MODE: "humanized" },
        "darwin",
        missingRunner,
      ),
    /requires macOS input/,
  );
});

test("Humanized trajectory starts and ends on the requested points", () => {
  const points = generateHumanizedTrajectory({ x: 10, y: 20 }, { x: 300, y: 180 }, 1234);
  assert.deepEqual(points[0], { x: 10, y: 20, t: 0 });
  assert.equal(Math.round(points.at(-1).x), 300);
  assert.equal(Math.round(points.at(-1).y), 180);
  assert.ok(points.length >= 25);
});

test("Screen point computation accounts for browser chrome", () => {
  const point = computeScreenPoint(
    { x: 100, y: 120, width: 80, height: 40 },
    {
      screenX: 50,
      screenY: 60,
      outerWidth: 1000,
      outerHeight: 800,
      innerWidth: 980,
      innerHeight: 720,
      devicePixelRatio: 1,
    },
  );
  assert.deepEqual(point, { x: 200, y: 270 });
});
