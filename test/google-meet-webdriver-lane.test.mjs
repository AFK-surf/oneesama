import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

import { resolveChromeBinary } from "../packages/core/src/meeting/google-meet-webdriver-lane.ts";

test("WebDriver Chrome binary resolver preserves macOS app paths with spaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "oneesama-chrome-path-"));
  const chromeBinary = join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
  await mkdir(dirname(chromeBinary), { recursive: true });
  await writeFile(chromeBinary, "#!/bin/sh\n");

  try {
    assert.equal(
      resolveChromeBinary({
        MAB_CHROMIUM_EXECUTABLE: chromeBinary,
        MEET_CHROMEDRIVER_CHROME_BINARY: "/does/not/exist/google-chrome",
      }),
      chromeBinary,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WebDriver join lane dispatches input through the selected backend", async () => {
  const sourcePath = fileURLToPath(
    new URL("../packages/core/src/meeting/google-meet-webdriver-lane.ts", import.meta.url),
  );
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));

  assert.doesNotMatch(source, /await xtestKey\("Escape"\)/);
  assert.match(source, /function moveToAndClickMac/);
  assert.match(source, /options\.interactionDetails\.backend/);
  assert.match(source, /webDriverNameInputMode: options\.interactionDetails\.backend/);
});

test("WebDriver macOS humanized clicks use screen points rather than Retina pixels", async () => {
  const sourcePath = fileURLToPath(
    new URL("../packages/core/src/meeting/google-meet-webdriver-lane.ts", import.meta.url),
  );
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));

  assert.match(source, /backend === "cliclick"[\s\S]+metrics\.devicePixelRatio = 1/);
});

test("WebDriver macOS humanized input activates Chrome before OS-level input", async () => {
  const sourcePath = fileURLToPath(
    new URL("../packages/core/src/meeting/google-meet-webdriver-lane.ts", import.meta.url),
  );
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));

  assert.match(source, /function activateChromeForMacInput/);
  assert.match(source, /tell application "Google Chrome" to activate/);
  assert.match(source, /activateChromeForMacInput\("click"\)/);
  assert.match(source, /activateChromeForMacInput\("paste"\)/);
  assert.match(source, /activateChromeForMacInput\(`key:\$\{key\}`\)/);
  assert.match(
    source,
    /macInputForegroundGuard: options\.interactionDetails\.backend === "cliclick"/,
  );
});

test("WebDriver join lane installs avatar runtime before navigating to Meet", async () => {
  const sourcePath = fileURLToPath(
    new URL("../packages/core/src/meeting/google-meet-webdriver-lane.ts", import.meta.url),
  );
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));

  assert.match(source, /preJoinRuntimeScripts\?: WebDriverPreJoinRuntimeScript\[\]/);
  assert.match(source, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.ok(
    source.indexOf("preJoinRuntimeInstall = await installPreJoinRuntimeScripts") <
      source.indexOf("await driver.get(options.meetURL)"),
    "avatar runtime must be installed before Meet navigation",
  );
  assert.ok(
    source.indexOf("preJoinRuntimeInstall = await verifyPreJoinRuntimeScripts") <
      source.indexOf("const realGoogleMeetUrlOpened"),
    "avatar runtime readiness should be checked before prejoin actions",
  );
  assert.match(source, /prejoin_runtime_not_ready/);
  assert.match(source, /window\.MAB_AVATAR_READY/);
  assert.match(source, /MAB_AVATAR_BOOT_ERROR/);
});

test("WebDriver join lane installs page-surface evasion before navigating to Meet", async () => {
  const sourcePath = fileURLToPath(
    new URL("../packages/core/src/meeting/google-meet-webdriver-lane.ts", import.meta.url),
  );
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));

  assert.match(source, /MAB_WEBDRIVER_EVASION/);
  assert.match(source, /Object\.defineProperty\(target, "webdriver"/);
  assert.match(source, /Navigator\.prototype/);
  assert.match(source, /webdriver_evasion_installed/);
  assert.match(source, /webdriver_evasion_ready/);
  assert.match(source, /webdriver_evasion_not_ready/);
  assert.ok(
    source.indexOf("const webdriverEvasionInstalled = await installWebDriverEvasionScript") <
      source.indexOf("await driver.get(options.meetURL)"),
    "WebDriver evasion should be installed before Meet navigation",
  );
  assert.ok(
    source.indexOf("webdriverEvasion = await readWebDriverEvasionState") <
      source.indexOf("const failedPreJoinRuntime"),
    "WebDriver evasion should be verified before prejoin actions",
  );
});

test("WebDriver join lane warms Meet origin before the formal room navigation", async () => {
  const sourcePath = fileURLToPath(
    new URL("../packages/core/src/meeting/google-meet-webdriver-lane.ts", import.meta.url),
  );
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));

  assert.match(source, /async function warmUpMeetBeforeAdmission/);
  assert.match(source, /prejoin_warmup_start/);
  assert.match(source, /prejoin_warmup_complete/);
  assert.ok(
    source.indexOf("await warmUpMeetBeforeAdmission(driver, options)") <
      source.indexOf("await driver.get(options.meetURL)"),
    "Meet origin warm-up should happen before the formal room navigation",
  );
});

test("WebDriver join lane refreshes a prejoin hard-block once before failing", async () => {
  const sourcePath = fileURLToPath(
    new URL("../packages/core/src/meeting/google-meet-webdriver-lane.ts", import.meta.url),
  );
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));

  assert.match(source, /function preJoinHardBlockRefreshLimit/);
  assert.match(source, /async function refreshPreJoinHardBlock/);
  assert.match(source, /prejoin_hard_block_refresh_start/);
  assert.match(source, /prejoin_hard_block_refresh_complete/);
  assert.match(
    source,
    /if \(state === "hard_blocked"\)[\s\S]+await refreshPreJoinHardBlock[\s\S]+await writeEvidence\(options, \{\s+guestNameInputVisible: false/,
  );
});

test("WebDriver avatar lane can keep Meet microphone and camera enabled", async () => {
  const sourcePath = fileURLToPath(
    new URL("../packages/core/src/meeting/google-meet-webdriver-lane.ts", import.meta.url),
  );
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));

  assert.match(source, /turnOffMicBeforeJoin\?: boolean/);
  assert.match(source, /turnOffCameraBeforeJoin\?: boolean/);
  assert.match(source, /options\.turnOffMicBeforeJoin !== false/);
  assert.match(source, /options\.turnOffCameraBeforeJoin !== false/);
});

test("WebDriver avatar lane waits for Meet media plumbing before joining", async () => {
  const sourcePath = fileURLToPath(
    new URL("../packages/core/src/meeting/google-meet-webdriver-lane.ts", import.meta.url),
  );
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));

  assert.match(source, /MEET_PREJOIN_AVATAR_MEDIA_READY_WAIT_MS/);
  assert.match(source, /window\.MAB_AVATAR_MEDIA/);
  assert.match(source, /videoGetUserMediaCalls > 0/);
  assert.match(source, /returnedVideoTrackCount > 0/);
  assert.match(source, /avatar_media_ready/);
  assert.match(source, /avatar_media_wait_timeout/);
  assert.ok(
    source.indexOf("const avatarMediaReadiness = await waitForAvatarMediaReady") <
      source.indexOf("const joinedFromPrejoin = await clickJoinButton"),
    "avatar media readiness should be checked before clicking the Meet join button",
  );
});

test("WebDriver join lane emits stage timing diagnostics", async () => {
  const sourcePath = fileURLToPath(
    new URL("../packages/core/src/meeting/google-meet-webdriver-lane.ts", import.meta.url),
  );
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));

  assert.match(source, /elapsedMs: Date\.now\(\) - laneStartedAt/);
  assert.match(source, /webdriver_driver_ready/);
  assert.match(source, /prejoin_navigation_complete/);
  assert.match(source, /guest_name_filled/);
  assert.match(source, /join_button_clicked/);
  assert.match(source, /admission_wait_start/);
});
