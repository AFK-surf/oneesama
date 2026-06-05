/* eslint-disable max-lines */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Builder, By, Key, until, type WebDriver, type WebElement } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import {
  computeScreenPointForViewport,
  defaultCommandRunner,
  generateHumanizedClickPlan,
  parseXdotoolShellGeometry,
  xtestCommand,
  type HumanizedClickPlan,
  type CommandRunner,
  type PageWindowMetrics,
  type Point,
  type ScreenGeometry,
  type UIInteractionDetails,
} from "./google-meet-humanized-input.ts";

const SELECTORS = {
  micOff: [
    'button[aria-label*="Turn off microphone"]',
    'button[aria-label*="关闭麦克风"]',
    'button[data-is-muted="false"][aria-label*="microphone"], button[data-is-muted="false"][aria-label*="麦克风"]',
  ],
  cameraOff: [
    'button[aria-label*="Turn off camera"]',
    'button[aria-label*="关闭摄像头"]',
    'button[data-is-muted="false"][aria-label*="camera"], button[data-is-muted="false"][aria-label*="摄像头"]',
  ],
  joinButtons: [
    'button[aria-label*="Join now" i]',
    'button[aria-label*="Ask to join" i]',
    'button[aria-label*="加入"]',
    'button[aria-label*="申请加入"]',
  ],
  leaveButton: ['button[aria-label*="Leave call" i]', 'button[aria-label*="离开通话"]'],
  captionToggle: [
    'button[aria-label*="captions" i]',
    'button[aria-label*="caption" i]',
    'button[aria-label*="字幕"]',
  ],
};

const WEBDRIVER_EVASION_SCRIPT = `
(() => {
  const evidence = {
    installedAt: Date.now(),
    targets: [],
    errors: [],
    before: { webdriver: navigator.webdriver },
    after: null,
  };
  const installGetter = (target, label) => {
    try {
      if (!target) return;
      Object.defineProperty(target, "webdriver", {
        configurable: true,
        get: () => false,
      });
      evidence.targets.push(label);
    } catch (error) {
      evidence.errors.push({ label, message: String(error && error.message ? error.message : error) });
    }
  };
  installGetter(Navigator.prototype, "Navigator.prototype");
  installGetter(Object.getPrototypeOf(navigator), "Object.getPrototypeOf(navigator)");
  installGetter(navigator, "navigator");
  evidence.after = {
    webdriver: navigator.webdriver,
    hasChromeObject: Boolean(window.chrome),
    languageCount: Array.isArray(navigator.languages) ? navigator.languages.length : 0,
    pluginCount: navigator.plugins ? navigator.plugins.length : 0,
  };
  window.MAB_WEBDRIVER_EVASION = evidence;
})();
`;

type JoinPageState =
  | "prejoin_lobby"
  | "waiting_room"
  | "hard_blocked"
  | "blank_after_join_click"
  | "admitted"
  | "loading_or_bot_check"
  | "unknown";

function summarizeVisibleText(raw: string, maxLines = 4): string {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(" / ");
}

function classifyJoinPageText(raw: string): JoinPageState {
  const text = raw.trim();
  if (!text) {
    return "blank_after_join_click";
  }
  if (
    /you can't join this video call/i.test(text) ||
    /no one can join a meeting unless invited or admitted by the host/i.test(text) ||
    /returning to home screen/i.test(text) ||
    /无法加入此视频通话/i.test(text) ||
    /无法加入这场视频通话/i.test(text) ||
    /无法加入此通话/i.test(text)
  ) {
    return "hard_blocked";
  }
  if (
    /please wait until a meeting host brings you into the call/i.test(text) ||
    /waiting to be admitted/i.test(text) ||
    /you'll join when someone lets you in/i.test(text) ||
    /still trying to get in/i.test(text) ||
    /正在等待/i.test(text) ||
    /等待主持人/i.test(text)
  ) {
    return "waiting_room";
  }
  if (
    /what's your name\?/i.test(text) ||
    /ask to join/i.test(text) ||
    /join now/i.test(text) ||
    /申请加入/i.test(text)
  ) {
    return "prejoin_lobby";
  }
  if (
    /getting ready/i.test(text) ||
    /confirm you're not a bot/i.test(text) ||
    /you'll be able to join in just a moment/i.test(text)
  ) {
    return "loading_or_bot_check";
  }
  return "unknown";
}

type WebDriverAdmissionResult =
  | { state: "hard_blocked"; message: string }
  | { state: "admitted"; message: string }
  | { state: "timeout"; message: string };

export interface WebDriverAdmittedSession {
  debuggerAddress: string;
  pageURL: string;
  preJoinRuntimeInstall: WebDriverPreJoinRuntimeInstallResult[];
  quit: () => Promise<void>;
}

export interface WebDriverPreJoinRuntimeScript {
  category: string;
  content: string;
}

export interface WebDriverPreJoinRuntimeInstallResult {
  category: string;
  installedOnNewDocument: boolean;
  ready: boolean;
  error?: string;
}

export interface WebDriverJoinLaneOptions {
  meetURL: string;
  botName: string;
  artifactsDir: string;
  launchArgs: string[];
  launchEnv?: NodeJS.ProcessEnv;
  launchArgsMode: string;
  windowSize: string;
  permissionOrigin: string;
  interactionDetails: UIInteractionDetails;
  browserChannel: string;
  preJoinRuntimeScripts?: WebDriverPreJoinRuntimeScript[];
  requirePreJoinRuntimeScripts?: boolean;
  turnOffMicBeforeJoin?: boolean;
  turnOffCameraBeforeJoin?: boolean;
  emitStatus: (status: string, message: string, detail?: Record<string, unknown>) => void;
  isStopped: () => boolean;
}

type ElementTarget = {
  element: WebElement;
  rect: { x: number; y: number; width: number; height: number };
};

export async function runWebDriverJoinLane(
  options: WebDriverJoinLaneOptions,
): Promise<WebDriverAdmittedSession | null> {
  const laneStartedAt = Date.now();
  const emitStage = (status: string, message: string, detail: Record<string, unknown> = {}) => {
    options.emitStatus(status, message, {
      elapsedMs: Date.now() - laneStartedAt,
      ...detail,
    });
  };

  await mkdir(options.artifactsDir, { recursive: true });

  const driver = await buildDriver(options);
  emitStage("webdriver_driver_ready", "ChromeDriver session is ready", {
    browserChannel: options.browserChannel || "chrome",
    browserWindowSize: options.windowSize,
    interactionBackend: options.interactionDetails.backend,
  });
  let releasedToCaller = false;
  let meetPermissionsGranted = false;
  let guestNameInputVisible = false;
  let preJoinRuntimeInstall: WebDriverPreJoinRuntimeInstallResult[] = [];
  let webdriverEvasion: WebDriverEvasionState | null = null;

  try {
    meetPermissionsGranted = await grantMeetPermissions(driver, options.permissionOrigin);
    emitStage(
      meetPermissionsGranted ? "webdriver_permissions_granted" : "webdriver_permissions_failed",
      options.permissionOrigin,
      { permissionOrigin: options.permissionOrigin },
    );
    const webdriverEvasionInstalled = await installWebDriverEvasionScript(driver);
    emitStage(
      webdriverEvasionInstalled
        ? "webdriver_evasion_installed"
        : "webdriver_evasion_install_failed",
      webdriverEvasionInstalled
        ? "WebDriver page-surface evasion script installed"
        : "WebDriver page-surface evasion script failed to install",
    );
    preJoinRuntimeInstall = await installPreJoinRuntimeScripts(driver, options);
    await warmUpMeetBeforeAdmission(driver, options);
    emitStage("prejoin_navigation_start", options.meetURL, {
      host: safeURLHost(options.meetURL),
    });
    await driver.get(options.meetURL);
    emitStage("prejoin_navigation_complete", await driver.getCurrentUrl().catch(() => ""), {
      host: safeURLHost(await driver.getCurrentUrl().catch(() => "")),
    });
    await driver.sleep(3000);
    await pressKey(driver, options, "Escape");
    emitStage("prejoin_escape_pressed", "Escape pressed after Meet navigation");
    preJoinRuntimeInstall = await verifyPreJoinRuntimeScripts(
      driver,
      options,
      preJoinRuntimeInstall,
    );
    webdriverEvasion = await readWebDriverEvasionState(driver);
    emitStage(
      webdriverEvasion.ok ? "webdriver_evasion_ready" : "webdriver_evasion_not_ready",
      webdriverEvasion.ok
        ? "WebDriver page-surface evasion is active"
        : `WebDriver page-surface evasion is incomplete: navigator.webdriver=${String(webdriverEvasion.webdriverValue)}`,
      webdriverEvasion,
    );
    const failedPreJoinRuntime = preJoinRuntimeInstall.filter((entry) => !entry.ready);
    if (failedPreJoinRuntime.length > 0 && options.requirePreJoinRuntimeScripts) {
      const currentURL = await driver.getCurrentUrl();
      const message = `prejoin_runtime_not_ready: ${failedPreJoinRuntime
        .map((entry) => `${entry.category}${entry.error ? `:${entry.error}` : ""}`)
        .join(", ")}`;
      await writeEvidence(options, {
        guestNameInputVisible: false,
        realGoogleMeetUrlOpened: isGoogleMeetURL(currentURL),
        openedURLHost: safeURLHost(currentURL),
        meetPermissionsGranted,
        preJoinRuntimeInstall,
        webdriverEvasion,
      });
      await saveDiagnostic(driver, options.artifactsDir, "prejoin-runtime-not-ready", message);
      options.emitStatus("error", message);
      return null;
    }

    const realGoogleMeetUrlOpened = isGoogleMeetURL(await driver.getCurrentUrl());
    if (!realGoogleMeetUrlOpened) {
      const currentURL = await driver.getCurrentUrl();
      const message = `prejoin_navigation_blocked: expected meet.google.com but opened ${safeURLHost(currentURL) || currentURL}`;
      await writeEvidence(options, {
        guestNameInputVisible: false,
        realGoogleMeetUrlOpened: false,
        openedURLHost: safeURLHost(currentURL),
        meetPermissionsGranted,
        preJoinRuntimeInstall,
        webdriverEvasion,
      });
      await saveDiagnostic(driver, options.artifactsDir, "prejoin-navigation-blocked", message);
      options.emitStatus("prejoin_navigation_blocked", message);
      options.emitStatus("error", message);
      return null;
    }

    const displayName = options.botName || "Bridge Bot";
    const nameDeadline = Date.now() + envNumber("MEET_PREJOIN_NAME_WAIT_MS", 45000);
    let preJoinHardBlockRefreshes = 0;
    for (let attempt = 1; Date.now() < nameDeadline; attempt++) {
      await dismissGotIt(driver, options);
      const filled = await fillGuestName(driver, displayName, options);
      if (filled) {
        guestNameInputVisible = true;
        console.error(
          `[meeting-joiner][webdriver] Filled guest name${attempt > 1 ? ` after retry ${attempt}` : ""}`,
        );
        emitStage("guest_name_filled", displayName, { nameFillAttempt: attempt });
        break;
      }

      const text = await visibleText(driver);
      const state = classifyJoinPageText(text);
      if (state === "hard_blocked") {
        const message =
          summarizeVisibleText(text) || "Google Meet blocked the bot before the pre-join screen";
        if (preJoinHardBlockRefreshes < preJoinHardBlockRefreshLimit(options.launchEnv)) {
          preJoinHardBlockRefreshes += 1;
          const refreshed = await refreshPreJoinHardBlock(driver, options, {
            message,
            refreshCount: preJoinHardBlockRefreshes,
          });
          preJoinRuntimeInstall = await verifyPreJoinRuntimeScripts(
            driver,
            options,
            preJoinRuntimeInstall,
          );
          webdriverEvasion = await readWebDriverEvasionState(driver);
          emitStage(
            webdriverEvasion.ok
              ? "webdriver_evasion_ready_after_refresh"
              : "webdriver_evasion_not_ready_after_refresh",
            webdriverEvasion.ok
              ? "WebDriver page-surface evasion is active after prejoin refresh"
              : `WebDriver page-surface evasion is incomplete after prejoin refresh: navigator.webdriver=${String(webdriverEvasion.webdriverValue)}`,
            webdriverEvasion,
          );
          if (refreshed) {
            continue;
          }
        }
        await writeEvidence(options, {
          guestNameInputVisible: false,
          realGoogleMeetUrlOpened: true,
          openedURLHost: safeURLHost(await driver.getCurrentUrl()),
          meetPermissionsGranted,
          preJoinRuntimeInstall,
          webdriverEvasion,
        });
        await saveDiagnostic(driver, options.artifactsDir, "hard-blocked", message);
        options.emitStatus("hard_blocked", message);
        options.emitStatus("error", `hard_blocked: ${message}`);
        return null;
      }
      if (state === "prejoin_lobby") {
        options.emitStatus(
          "prejoin_lobby",
          summarizeVisibleText(text, 3) || "Meet pre-join lobby is visible",
        );
      }
      await driver.sleep(state === "prejoin_lobby" ? 700 : 1500);
    }

    await writeEvidence(options, {
      guestNameInputVisible,
      realGoogleMeetUrlOpened: true,
      openedURLHost: safeURLHost(await driver.getCurrentUrl()),
      meetPermissionsGranted,
      preJoinRuntimeInstall,
      webdriverEvasion,
    });

    if (!guestNameInputVisible) {
      const text = await visibleText(driver);
      const message = `prejoin_lobby: guest name input is visible but could not be filled; last page text: ${summarizeVisibleText(text)}`;
      await saveDiagnostic(driver, options.artifactsDir, "guest-name-fill-failed", message);
      options.emitStatus("error", message);
      return null;
    }

    await dismissGotIt(driver, options);
    if (
      options.turnOffMicBeforeJoin !== false &&
      (await clickOptional(driver, SELECTORS.micOff, options))
    ) {
      console.error("[meeting-joiner][webdriver] Turned microphone off before join");
      emitStage("prejoin_microphone_toggled_off", "Turned microphone off before join");
    }
    if (
      options.turnOffCameraBeforeJoin !== false &&
      (await clickOptional(driver, SELECTORS.cameraOff, options))
    ) {
      console.error("[meeting-joiner][webdriver] Turned camera off before join");
      emitStage("prejoin_camera_toggled_off", "Turned camera off before join");
    }

    const avatarMediaReadiness = await waitForAvatarMediaReady(driver, options);
    if (avatarMediaReadiness) {
      emitStage(
        avatarMediaReadiness.ready ? "avatar_media_ready" : "avatar_media_wait_timeout",
        avatarMediaReadiness.message,
        avatarMediaReadiness,
      );
    }

    const joinedFromPrejoin = await clickJoinButton(driver, options);
    if (!joinedFromPrejoin) {
      const message = "prejoin_lobby: could not find or activate the Meet join button";
      await saveDiagnostic(
        driver,
        options.artifactsDir,
        "prejoin-lobby-join-button-missing",
        message,
      );
      options.emitStatus("error", message);
      return null;
    }
    console.error("[meeting-joiner][webdriver] Clicked join button");
    emitStage("join_button_clicked", "Meet join button clicked");

    emitStage("admission_wait_start", "Waiting for Meet admission");
    const admission = await waitForWebDriverAdmission(driver, options, 180000);
    if (admission.state === "hard_blocked") {
      await saveDiagnostic(driver, options.artifactsDir, "hard-blocked", admission.message);
      options.emitStatus("hard_blocked", admission.message);
      options.emitStatus("error", `hard_blocked: ${admission.message}`);
      return null;
    }
    if (admission.state === "admitted") {
      options.emitStatus("admitted", admission.message);
      options.emitStatus("in_meeting", "Successfully joined meeting");
      const handoff = await createAdmittedSession(driver, preJoinRuntimeInstall);
      releasedToCaller = true;
      return handoff;
    }

    await saveDiagnostic(driver, options.artifactsDir, "admission-timeout", admission.message);
    options.emitStatus("error", admission.message);
    return null;
  } finally {
    if (!releasedToCaller) {
      await driver.quit().catch(() => {});
    }
  }
}

async function buildDriver(options: WebDriverJoinLaneOptions): Promise<WebDriver> {
  const chromeOptions = new chrome.Options();
  chromeOptions.addArguments(...options.launchArgs);
  if (!options.launchArgs.some((arg) => arg.startsWith("--remote-debugging-port"))) {
    chromeOptions.addArguments("--remote-debugging-port=0");
  }
  chromeOptions.excludeSwitches("enable-automation");
  chromeOptions.setUserPreferences({
    credentials_enable_service: false,
    "profile.password_manager_enabled": false,
  });
  const binary = resolveChromeBinary();
  console.error(`[meeting-joiner][webdriver] Chrome binary: ${binary}`);
  chromeOptions.setChromeBinaryPath(binary);

  const [width, height] = options.windowSize.split(",").map((part) => Number(part));
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(options.launchEnv || {})) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const builder = new Builder().forBrowser("chrome").setChromeOptions(chromeOptions);
    const driver = await builder.build();
    await driver
      .manage()
      .window()
      .setRect({ x: 0, y: 0, width, height })
      .catch(() => {});
    return driver;
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function warmUpMeetBeforeAdmission(
  driver: WebDriver,
  options: WebDriverJoinLaneOptions,
): Promise<void> {
  if (!shouldWarmUpMeetBeforeAdmission(options.launchEnv)) {
    options.emitStatus("prejoin_warmup_skipped", "Meet admission warm-up disabled");
    return;
  }
  const warmupURL =
    envString("MAB_MEET_WEBDRIVER_PREWARM_URL", options.launchEnv) ||
    envString("MEET_WEBDRIVER_PREWARM_URL", options.launchEnv) ||
    "https://meet.google.com/";
  options.emitStatus("prejoin_warmup_start", warmupURL, {
    host: safeURLHost(warmupURL),
  });
  try {
    await driver.get(warmupURL);
    await driver.sleep(envNumber("MAB_MEET_WEBDRIVER_PREWARM_SETTLE_MS", 1200));
    await pressKey(driver, options, "Escape").catch(() => {});
    options.emitStatus("prejoin_warmup_complete", await driver.getCurrentUrl().catch(() => ""), {
      host: safeURLHost(await driver.getCurrentUrl().catch(() => "")),
    });
  } catch (error) {
    options.emitStatus("prejoin_warmup_failed", String(error?.message || error), {
      host: safeURLHost(warmupURL),
    });
  }
}

function shouldWarmUpMeetBeforeAdmission(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw =
    envString("MAB_MEET_WEBDRIVER_PREWARM", env) || envString("MEET_WEBDRIVER_PREWARM", env);
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw);
}

function preJoinHardBlockRefreshLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw =
    envString("MAB_MEET_WEBDRIVER_PREJOIN_REFRESH_ON_HARD_BLOCK", env) ||
    envString("MEET_WEBDRIVER_PREJOIN_REFRESH_ON_HARD_BLOCK", env);
  if (/^(0|false|no|off)$/i.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, 3);
  return 1;
}

async function refreshPreJoinHardBlock(
  driver: WebDriver,
  options: WebDriverJoinLaneOptions,
  detail: { message: string; refreshCount: number },
): Promise<boolean> {
  options.emitStatus("prejoin_hard_block_refresh_start", detail.message, {
    refreshCount: detail.refreshCount,
    refreshURL: options.meetURL,
  });
  try {
    await driver.get(options.meetURL);
    await driver.sleep(envNumber("MAB_MEET_WEBDRIVER_PREJOIN_REFRESH_SETTLE_MS", 2500));
    await pressKey(driver, options, "Escape").catch(() => {});
    options.emitStatus(
      "prejoin_hard_block_refresh_complete",
      await driver.getCurrentUrl().catch(() => ""),
      {
        refreshCount: detail.refreshCount,
        host: safeURLHost(await driver.getCurrentUrl().catch(() => "")),
      },
    );
    return true;
  } catch (error) {
    options.emitStatus("prejoin_hard_block_refresh_failed", String(error?.message || error), {
      refreshCount: detail.refreshCount,
    });
    return false;
  }
}

async function createAdmittedSession(
  driver: WebDriver,
  preJoinRuntimeInstall: WebDriverPreJoinRuntimeInstallResult[],
): Promise<WebDriverAdmittedSession> {
  const debuggerAddress = await getChromeDebuggerAddress(driver);
  const pageURL = await driver.getCurrentUrl().catch(() => "");
  let closed = false;
  return {
    debuggerAddress,
    pageURL,
    preJoinRuntimeInstall,
    quit: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await driver.quit().catch(() => {});
    },
  };
}

async function getChromeDebuggerAddress(driver: WebDriver): Promise<string> {
  const capabilities = await driver.getCapabilities();
  const chromeOptions = capabilities.get("goog:chromeOptions") as
    | { debuggerAddress?: string }
    | undefined;
  const debuggerAddress = chromeOptions?.debuggerAddress || "";
  if (!debuggerAddress) {
    throw new Error(
      "ChromeDriver did not expose goog:chromeOptions.debuggerAddress for Playwright CDP handoff",
    );
  }
  return debuggerAddress;
}

export function resolveChromeBinary(env: NodeJS.ProcessEnv = process.env): string {
  for (const candidate of [
    envString("MAB_CHROMIUM_EXECUTABLE", env),
    envString("MEET_CHROMEDRIVER_CHROME_BINARY", env),
    envString("MEET_SELENIUM_CHROME_BINARY", env),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "google-chrome",
  ]) {
    const executable = normalizeExecutableCandidate(candidate);
    if (!executable) {
      continue;
    }
    if (executable.startsWith("/") && !existsSync(executable)) {
      continue;
    }
    return executable;
  }
  return "google-chrome";
}

function runtimeScriptSourceUrl(script: WebDriverPreJoinRuntimeScript): string {
  const category = String(script.category || "runtime").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `oneesama-prejoin-${category}.js`;
}

async function installWebDriverEvasionScript(driver: WebDriver): Promise<boolean> {
  try {
    await sendCdp(driver, "Page.enable", {}).catch(() => undefined);
    await sendCdp(driver, "Page.addScriptToEvaluateOnNewDocument", {
      source: `${WEBDRIVER_EVASION_SCRIPT}\n//# sourceURL=oneesama-webdriver-evasion.js`,
    });
    return true;
  } catch {
    return false;
  }
}

async function readWebDriverEvasionState(driver: WebDriver): Promise<WebDriverEvasionState> {
  const state = await driver
    .executeScript(
      `
        const evasion = window.MAB_WEBDRIVER_EVASION || {};
        const after = evasion.after || {};
        return {
          markerPresent: Boolean(window.MAB_WEBDRIVER_EVASION),
          webdriverValue: navigator.webdriver,
          targets: Array.isArray(evasion.targets) ? evasion.targets.slice() : [],
          errors: Array.isArray(evasion.errors) ? evasion.errors.slice(-5) : [],
          hasChromeObject: Boolean(after.hasChromeObject || window.chrome),
          languageCount: Number(after.languageCount || (Array.isArray(navigator.languages) ? navigator.languages.length : 0)),
          pluginCount: Number(after.pluginCount || (navigator.plugins ? navigator.plugins.length : 0))
        };
      `,
    )
    .catch(() => null);
  if (!state || typeof state !== "object") {
    return {
      ok: false,
      markerPresent: false,
      webdriverValue: undefined,
      targetCount: 0,
      targets: [],
      errors: [],
      hasChromeObject: false,
      languageCount: 0,
      pluginCount: 0,
    };
  }
  const detail = state as Partial<WebDriverEvasionState>;
  const targets = Array.isArray(detail.targets) ? detail.targets : [];
  const errors = Array.isArray(detail.errors) ? detail.errors : [];
  const webdriverValue = detail.webdriverValue;
  const markerPresent = Boolean(detail.markerPresent);
  return {
    ok: markerPresent && webdriverValue === false,
    markerPresent,
    webdriverValue,
    targetCount: targets.length,
    targets,
    errors,
    hasChromeObject: Boolean(detail.hasChromeObject),
    languageCount: Number(detail.languageCount || 0),
    pluginCount: Number(detail.pluginCount || 0),
  };
}

async function installPreJoinRuntimeScripts(
  driver: WebDriver,
  options: WebDriverJoinLaneOptions,
): Promise<WebDriverPreJoinRuntimeInstallResult[]> {
  const scripts = options.preJoinRuntimeScripts || [];
  if (!scripts.length) return [];

  await sendCdp(driver, "Page.enable", {}).catch(() => undefined);
  const results: WebDriverPreJoinRuntimeInstallResult[] = [];
  for (const script of scripts) {
    try {
      await sendCdp(driver, "Page.addScriptToEvaluateOnNewDocument", {
        source: `${script.content}\n//# sourceURL=${runtimeScriptSourceUrl(script)}`,
      });
      results.push({
        category: script.category,
        installedOnNewDocument: true,
        ready: false,
      });
      options.emitStatus("prejoin_runtime_install", script.category);
    } catch (error: any) {
      results.push({
        category: script.category,
        installedOnNewDocument: false,
        ready: false,
        error: String(error?.message || error),
      });
    }
  }
  return results;
}

async function verifyPreJoinRuntimeScripts(
  driver: WebDriver,
  options: WebDriverJoinLaneOptions,
  installed: WebDriverPreJoinRuntimeInstallResult[],
): Promise<WebDriverPreJoinRuntimeInstallResult[]> {
  if (!installed.length) return installed;

  const scriptsByCategory = new Map(
    (options.preJoinRuntimeScripts || []).map((script) => [script.category, script]),
  );
  const results: WebDriverPreJoinRuntimeInstallResult[] = [];
  for (const entry of installed) {
    const script = scriptsByCategory.get(entry.category);
    let ready = await isPreJoinRuntimeReady(driver, entry.category);
    let error = entry.error;
    if (!ready && script) {
      try {
        const result = (await sendCdp(driver, "Runtime.evaluate", {
          expression: `${script.content}\n//# sourceURL=${runtimeScriptSourceUrl(script)}`,
          awaitPromise: true,
          userGesture: true,
          allowUnsafeEvalBlockedByCSP: true,
        })) as {
          exceptionDetails?: {
            text?: string;
            exception?: { description?: string; value?: unknown };
          };
        };
        const exception =
          result?.exceptionDetails?.exception?.description ||
          result?.exceptionDetails?.exception?.value ||
          result?.exceptionDetails?.text ||
          "";
        if (exception) throw new Error(String(exception));
        ready = await isPreJoinRuntimeReady(driver, entry.category);
      } catch (runtimeError: any) {
        error = String(runtimeError?.message || runtimeError);
      }
    }
    if (!ready && entry.category === "avatar") {
      const bootError = await driver
        .executeScript("return window.MAB_AVATAR_BOOT_ERROR || '';")
        .catch(() => "");
      if (bootError) {
        error = String(bootError);
      }
    }
    results.push({ ...entry, ready, error });
    options.emitStatus(
      ready ? "prejoin_runtime_ready" : "prejoin_runtime_not_ready",
      `${entry.category}${error ? `: ${error}` : ""}`,
    );
  }
  return results;
}

async function isPreJoinRuntimeReady(driver: WebDriver, category: string): Promise<boolean> {
  if (category !== "avatar") return true;
  const deadline = Date.now() + envNumber("MEET_PREJOIN_RUNTIME_WAIT_MS", 10_000);
  while (Date.now() < deadline) {
    const ready = await driver
      .executeScript(
        "return Boolean(window.MAB_AVATAR_READY && window.MAB_AVATAR_START_RENDERER && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);",
      )
      .catch(() => false);
    if (ready) return true;
    await driver.sleep(250);
  }
  return false;
}

type AvatarMediaReadiness = {
  ready: boolean;
  message: string;
  waitElapsedMs: number;
  timeoutMs: number;
  settleMs: number;
  getUserMediaCalls: number;
  audioGetUserMediaCalls: number;
  videoGetUserMediaCalls: number;
  enumerateDevicesCalls: number;
  returnedAudioTrackCount: number;
  returnedVideoTrackCount: number;
  patchedTargets: string[];
  errors: unknown[];
};

type WebDriverEvasionState = {
  ok: boolean;
  markerPresent: boolean;
  webdriverValue: unknown;
  targetCount: number;
  targets: string[];
  errors: unknown[];
  hasChromeObject: boolean;
  languageCount: number;
  pluginCount: number;
};

function hasAvatarPreJoinRuntime(options: WebDriverJoinLaneOptions): boolean {
  return (options.preJoinRuntimeScripts || []).some((script) => script.category === "avatar");
}

async function waitForAvatarMediaReady(
  driver: WebDriver,
  options: WebDriverJoinLaneOptions,
): Promise<AvatarMediaReadiness | null> {
  if (!hasAvatarPreJoinRuntime(options)) {
    return null;
  }
  const timeoutMs = envBoundedNumber("MEET_PREJOIN_AVATAR_MEDIA_READY_WAIT_MS", 5000, 0, 30_000);
  const settleMs = envBoundedNumber("MEET_PREJOIN_AVATAR_MEDIA_READY_SETTLE_MS", 500, 0, 5000);
  const startedAt = Date.now();
  let lastTelemetry = emptyAvatarMediaTelemetry();

  while (Date.now() - startedAt <= timeoutMs) {
    lastTelemetry = await readAvatarMediaTelemetry(driver);
    if (lastTelemetry.videoGetUserMediaCalls > 0 && lastTelemetry.returnedVideoTrackCount > 0) {
      if (settleMs > 0) {
        await driver.sleep(settleMs);
      }
      return {
        ready: true,
        message:
          `avatar video media ready: videoGetUserMedia=${lastTelemetry.videoGetUserMediaCalls}, ` +
          `returnedVideoTracks=${lastTelemetry.returnedVideoTrackCount}, enumerateDevices=${lastTelemetry.enumerateDevicesCalls}`,
        waitElapsedMs: Date.now() - startedAt,
        timeoutMs,
        settleMs,
        ...lastTelemetry,
      };
    }
    if (timeoutMs <= 0) {
      break;
    }
    await driver.sleep(250);
  }

  return {
    ready: false,
    message:
      `avatar video media not observed before join: videoGetUserMedia=${lastTelemetry.videoGetUserMediaCalls}, ` +
      `returnedVideoTracks=${lastTelemetry.returnedVideoTrackCount}, getUserMedia=${lastTelemetry.getUserMediaCalls}, ` +
      `enumerateDevices=${lastTelemetry.enumerateDevicesCalls}`,
    waitElapsedMs: Date.now() - startedAt,
    timeoutMs,
    settleMs,
    ...lastTelemetry,
  };
}

function emptyAvatarMediaTelemetry() {
  return {
    getUserMediaCalls: 0,
    audioGetUserMediaCalls: 0,
    videoGetUserMediaCalls: 0,
    enumerateDevicesCalls: 0,
    returnedAudioTrackCount: 0,
    returnedVideoTrackCount: 0,
    patchedTargets: [] as string[],
    errors: [] as unknown[],
  };
}

async function readAvatarMediaTelemetry(
  driver: WebDriver,
): Promise<ReturnType<typeof emptyAvatarMediaTelemetry>> {
  const telemetry = await driver
    .executeScript(
      `
        const media = window.MAB_AVATAR_MEDIA;
        if (!media) return null;
        return {
          getUserMediaCalls: Number(media.getUserMediaCalls || 0),
          audioGetUserMediaCalls: Number(media.audioGetUserMediaCalls || 0),
          videoGetUserMediaCalls: Number(media.videoGetUserMediaCalls || 0),
          enumerateDevicesCalls: Number(media.enumerateDevicesCalls || 0),
          returnedAudioTrackCount: Number(media.returnedAudioTrackCount || 0),
          returnedVideoTrackCount: Number(media.returnedVideoTrackCount || 0),
          patchedTargets: Array.isArray(media.patchedTargets) ? media.patchedTargets.slice() : [],
          errors: Array.isArray(media.errors) ? media.errors.slice(-3) : []
        };
      `,
    )
    .catch(() => null);
  if (!telemetry || typeof telemetry !== "object") {
    return emptyAvatarMediaTelemetry();
  }
  const detail = telemetry as Partial<ReturnType<typeof emptyAvatarMediaTelemetry>>;
  return {
    getUserMediaCalls: Number(detail.getUserMediaCalls || 0),
    audioGetUserMediaCalls: Number(detail.audioGetUserMediaCalls || 0),
    videoGetUserMediaCalls: Number(detail.videoGetUserMediaCalls || 0),
    enumerateDevicesCalls: Number(detail.enumerateDevicesCalls || 0),
    returnedAudioTrackCount: Number(detail.returnedAudioTrackCount || 0),
    returnedVideoTrackCount: Number(detail.returnedVideoTrackCount || 0),
    patchedTargets: Array.isArray(detail.patchedTargets) ? detail.patchedTargets : [],
    errors: Array.isArray(detail.errors) ? detail.errors : [],
  };
}

function normalizeExecutableCandidate(rawValue: string): string {
  const candidate = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!candidate) {
    return "";
  }
  if (candidate.startsWith("/") && existsSync(candidate)) {
    return candidate;
  }
  return candidate.split(/\s+/)[0] || "";
}

async function grantMeetPermissions(driver: WebDriver, origin: string): Promise<boolean> {
  try {
    const params = {
      origin,
      permissions: ["geolocation", "audioCapture", "displayCapture", "videoCapture"],
    };
    await sendCdp(driver, "Browser.grantPermissions", params);
    console.error(`[meeting-joiner][webdriver] Granted Meet CDP permissions for ${origin}`);
    return true;
  } catch (err: any) {
    console.error(
      `[meeting-joiner][webdriver] Failed to grant Meet CDP permissions: ${err.message}`,
    );
    return false;
  }
}

async function sendCdp(
  driver: WebDriver,
  command: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const chromiumDriver = driver as WebDriver & {
    sendAndGetDevToolsCommand?: (cmd: string, params?: Record<string, unknown>) => Promise<unknown>;
    sendDevToolsCommand?: (cmd: string, params?: Record<string, unknown>) => Promise<void>;
  };
  if (chromiumDriver.sendAndGetDevToolsCommand) {
    return chromiumDriver.sendAndGetDevToolsCommand(command, params);
  }
  if (chromiumDriver.sendDevToolsCommand) {
    await chromiumDriver.sendDevToolsCommand(command, params);
    return undefined;
  }
  throw new Error("WebDriver client does not expose Chrome DevTools commands");
}

async function fillGuestName(
  driver: WebDriver,
  name: string,
  options: WebDriverJoinLaneOptions,
): Promise<boolean> {
  const candidates = [
    By.css('input[aria-label*="Your name" i]'),
    By.css('input[placeholder*="Your name" i]'),
    By.css('input[aria-label*="name" i]'),
    By.css('input[placeholder*="name" i]'),
    By.css('textarea[aria-label*="Your name" i]'),
    By.css('textarea[placeholder*="Your name" i]'),
    By.css('input:not([type="hidden"])'),
    By.css("input[type='text']"),
    By.css("input"),
  ];

  for (const by of candidates) {
    const target = await firstDisplayed(driver, by, 700);
    if (!target) {
      continue;
    }
    await clickElement(driver, target, options);
    await replaceElementText(target.element, name, options);
    await driver.sleep(250);
    const actual = await target.element.getAttribute("value").catch(() => "");
    if ((actual || "").trim() === name) {
      return true;
    }
  }
  return false;
}

async function clickJoinButton(
  driver: WebDriver,
  options: WebDriverJoinLaneOptions,
): Promise<boolean> {
  const candidates = [
    ...SELECTORS.joinButtons.map((selector) => By.css(selector)),
    By.xpath(
      "//button[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'join now')]",
    ),
    By.xpath(
      "//button[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'ask to join')]",
    ),
    By.xpath(
      "//*[@role='button' and contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'join now')]",
    ),
    By.xpath(
      "//*[@role='button' and contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'ask to join')]",
    ),
  ];
  for (const by of candidates) {
    const target = await firstDisplayed(driver, by, 1200, true);
    if (!target) {
      continue;
    }
    await clickElement(driver, target, options);
    await driver.sleep(1000);
    const state = classifyJoinPageText(await visibleText(driver));
    if (state !== "prejoin_lobby") {
      return true;
    }
  }
  return false;
}

async function clickOptional(
  driver: WebDriver,
  selectors: string[],
  options: WebDriverJoinLaneOptions,
): Promise<boolean> {
  for (const selector of selectors) {
    const target = await firstDisplayed(driver, By.css(selector), 500);
    if (!target) {
      continue;
    }
    await clickElement(driver, target, options).catch(() => {});
    await driver.sleep(300);
    return true;
  }
  return false;
}

async function dismissGotIt(
  driver: WebDriver,
  options: WebDriverJoinLaneOptions,
): Promise<boolean> {
  const candidates = [
    By.xpath("//button[normalize-space(.)='Got it']"),
    By.xpath("//*[@role='button' and normalize-space(.)='Got it']"),
  ];
  for (const by of candidates) {
    const target = await firstDisplayed(driver, by, 500);
    if (!target) {
      continue;
    }
    await clickElement(driver, target, options).catch(() => {});
    await driver.sleep(300);
    console.error("[meeting-joiner][webdriver] Dismissed 'Got it' popup");
    return true;
  }
  return false;
}

async function waitForWebDriverAdmission(
  driver: WebDriver,
  options: WebDriverJoinLaneOptions,
  timeoutMs: number,
): Promise<WebDriverAdmissionResult> {
  const deadline = Date.now() + timeoutMs;
  let lastState: JoinPageState = "unknown";
  let lastMessage = "";
  let waitingEmitted = false;

  while (Date.now() < deadline) {
    if (await isInMeeting(driver)) {
      return { state: "admitted", message: "Meet in-call controls are visible" };
    }

    const text = await visibleText(driver);
    const state = classifyJoinPageText(text);
    const message = summarizeVisibleText(text) || state;
    lastState = state;
    lastMessage = message;

    if (state === "hard_blocked") {
      return { state: "hard_blocked", message };
    }
    if (state === "waiting_room" && !waitingEmitted) {
      options.emitStatus("waiting_room", message || "Waiting for host admission");
      waitingEmitted = true;
    }

    await driver.sleep(1000);
  }

  if (lastState === "prejoin_lobby") {
    return {
      state: "timeout",
      message: `prejoin_lobby_timeout: bot remained on the Meet pre-join screen; last page text: ${lastMessage}`,
    };
  }
  return {
    state: "timeout",
    message: `waiting_room_timeout: not admitted by a host; last page text: ${lastMessage}`,
  };
}

async function isInMeeting(driver: WebDriver): Promise<boolean> {
  const selectors = [
    ...SELECTORS.captionToggle,
    ...SELECTORS.leaveButton,
    'button[aria-label*="Leave" i]',
    'button[aria-label*="captions" i]',
  ];
  for (const selector of selectors) {
    const target = await firstDisplayed(driver, By.css(selector), 300);
    if (target) {
      return true;
    }
  }
  return false;
}

async function firstDisplayed(
  driver: WebDriver,
  by: By,
  timeoutMs: number,
  requireEnabled = false,
): Promise<ElementTarget | null> {
  try {
    await driver.wait(until.elementLocated(by), timeoutMs);
    const elements = await driver.findElements(by);
    for (const element of elements.slice(0, 8)) {
      if (!(await element.isDisplayed().catch(() => false))) {
        continue;
      }
      if (requireEnabled && !(await element.isEnabled().catch(() => false))) {
        continue;
      }
      const rect = await elementRect(driver, element);
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      return { element, rect };
    }
  } catch {
    /* not found */
  }
  return null;
}

async function elementRect(driver: WebDriver, element: WebElement): Promise<ElementTarget["rect"]> {
  const rect = await driver.executeScript(
    "const r = arguments[0].getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};",
    element,
  );
  return rect as ElementTarget["rect"];
}

async function clickElement(
  driver: WebDriver,
  target: ElementTarget,
  options: WebDriverJoinLaneOptions,
): Promise<void> {
  await driver
    .executeScript(
      "arguments[0].scrollIntoView({block:'center', inline:'center'});",
      target.element,
    )
    .catch(() => {});
  await driver.sleep(120);
  const rect = await elementRect(driver, target.element);
  const metrics = await windowMetrics(driver);
  if (options.interactionDetails.backend === "cliclick") {
    // macOS event APIs use screen points, while Chrome reports Retina DPR in page metrics.
    metrics.devicePixelRatio = 1;
    activateChromeForMacInput("click");
  }
  const geometry = activeWindowGeometry() || visibleBrowserWindowGeometry();
  const endpoints: Array<{ viewport: Point; screen: Point }> = [];

  for (const viewportPoint of candidateViewportPoints(rect)) {
    if (!(await isElementHitAtViewportPoint(driver, target.element, viewportPoint))) {
      continue;
    }
    endpoints.push({
      viewport: viewportPoint,
      screen: computeScreenPointForViewport(viewportPoint, metrics, geometry),
    });
  }

  if (endpoints.length === 0) {
    throw new Error(`no verified XTEST click target for element rect ${JSON.stringify(rect)}`);
  }

  if (options.interactionDetails.backend === "playwright") {
    await target.element.click();
    console.error("[meeting-joiner][webdriver] WebDriver element click");
    return;
  }

  const plan = moveToAndClick(
    endpoints.map((endpoint) => endpoint.screen),
    options,
  );
  const matched = endpoints.find(
    (endpoint) =>
      Math.hypot(endpoint.screen.x - plan.endpoint.x, endpoint.screen.y - plan.endpoint.y) < 2,
  );
  const viewport = matched?.viewport || endpoints[0].viewport;
  console.error(
    `[meeting-joiner][webdriver] ${options.interactionDetails.backend.toUpperCase()} ${plan.profile} click seed=${plan.seed} hold=${plan.holdMs}ms pre=${plan.preClickDelayMs}ms ` +
      `viewport ${Math.round(viewport.x)},${Math.round(viewport.y)} screen ${Math.round(plan.endpoint.x)},${Math.round(plan.endpoint.y)}`,
  );
}

function candidateViewportPoints(rect: ElementTarget["rect"]): Point[] {
  const insetX = Math.min(Math.max(rect.width * 0.18, 4), Math.max(4, rect.width / 2 - 2));
  const insetY = Math.min(Math.max(rect.height * 0.18, 4), Math.max(4, rect.height / 2 - 2));
  const left = rect.x + insetX;
  const right = rect.x + rect.width - insetX;
  const top = rect.y + insetY;
  const bottom = rect.y + rect.height - insetY;
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  return [
    { x: midX, y: midY },
    { x: left, y: midY },
    { x: right, y: midY },
    { x: midX, y: top },
    { x: midX, y: bottom },
    { x: left, y: top },
    { x: right, y: bottom },
  ];
}

async function isElementHitAtViewportPoint(
  driver: WebDriver,
  element: WebElement,
  point: Point,
): Promise<boolean> {
  return driver
    .executeScript(
      `
			const expected = arguments[0];
			const x = arguments[1];
			const y = arguments[2];
			const hit = document.elementFromPoint(x, y);
			if (!hit) return false;
			if (hit === expected || expected.contains(hit)) return true;
			const interactive = hit.closest("button, [role='button'], input, textarea, [contenteditable='true']");
			return interactive === expected || !!(interactive && expected.contains(interactive));
		`,
      element,
      point.x,
      point.y,
    )
    .catch(() => false) as Promise<boolean>;
}

async function windowMetrics(driver: WebDriver): Promise<PageWindowMetrics> {
  const metrics = await driver.executeScript(`
		return {
			screenX: window.screenX,
			screenY: window.screenY,
			outerWidth: window.outerWidth,
			outerHeight: window.outerHeight,
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			devicePixelRatio: window.devicePixelRatio || 1
		};
	`);
  return metrics as PageWindowMetrics;
}

function activeWindowGeometry(runner: CommandRunner = defaultCommandRunner): ScreenGeometry | null {
  const result = runner("xdotool", ["getactivewindow", "getwindowgeometry", "--shell"]);
  if (result.error || result.status !== 0) {
    return null;
  }
  return parseXdotoolShellGeometry(String(result.stdout || ""));
}

function visibleBrowserWindowGeometry(
  runner: CommandRunner = defaultCommandRunner,
): ScreenGeometry | null {
  for (const className of ["google-chrome", "chrome", "chromium"]) {
    const search = runner("xdotool", ["search", "--onlyvisible", "--class", className]);
    if (search.error || search.status !== 0) {
      continue;
    }
    const windowIDs = String(search.stdout || "")
      .split(/\s+/)
      .filter(Boolean)
      .reverse();
    for (const windowID of windowIDs) {
      const geometry = runner("xdotool", ["getwindowgeometry", "--shell", windowID]);
      if (geometry.error || geometry.status !== 0) {
        continue;
      }
      const parsed = parseXdotoolShellGeometry(String(geometry.stdout || ""));
      if (parsed && parsed.width > 100 && parsed.height > 100) {
        return parsed;
      }
    }
  }
  return null;
}

async function replaceElementText(
  element: WebElement,
  text: string,
  options: WebDriverJoinLaneOptions,
): Promise<void> {
  switch (options.interactionDetails.backend) {
    case "xtest":
      await xtestKey("ctrl+a");
      await xtestPaste(text).catch(async () => {
        await xtestType(text);
      });
      return;
    case "xdotool":
      xdotoolKey("ctrl+a");
      xdotoolType(text);
      return;
    case "cliclick":
      activateChromeForMacInput("paste");
      macPaste(text);
      return;
    case "playwright":
      await element.clear().catch(() => {});
      await element.sendKeys(text);
      return;
  }
}

async function pressKey(
  driver: WebDriver,
  options: WebDriverJoinLaneOptions,
  key: string,
): Promise<void> {
  switch (options.interactionDetails.backend) {
    case "xtest":
      await xtestKey(key);
      return;
    case "xdotool":
      xdotoolKey(key);
      return;
    case "cliclick":
      activateChromeForMacInput(`key:${key}`);
      macKey(key);
      return;
    case "playwright":
      await driver
        .actions()
        .sendKeys(webDriverKey(key))
        .perform()
        .catch(async () => {
          const body = await driver.findElement(By.css("body"));
          await body.sendKeys(webDriverKey(key));
        });
      return;
  }
}

function moveToAndClick(endpoints: Point[], options: WebDriverJoinLaneOptions): HumanizedClickPlan {
  switch (options.interactionDetails.backend) {
    case "xtest":
      return moveToAndClickXTest(endpoints);
    case "xdotool":
      return moveToAndClickXdotool(endpoints);
    case "cliclick":
      return moveToAndClickMac(endpoints);
    case "playwright":
      throw new Error("playwright backend does not use OS-level click plans");
  }
}

function currentXTestMouseLocation(): Point | null {
  const result = defaultCommandRunner(xtestCommand(), ["position"]);
  if (result.error || result.status !== 0) {
    return null;
  }
  const x = String(result.stdout || "").match(/\bX=(-?\d+)\b/);
  const y = String(result.stdout || "").match(/\bY=(-?\d+)\b/);
  if (!x || !y) {
    return null;
  }
  return { x: Number(x[1]), y: Number(y[1]) };
}

function currentXdotoolMouseLocation(): Point | null {
  const result = defaultCommandRunner("xdotool", ["getmouselocation", "--shell"]);
  if (result.error || result.status !== 0) {
    return null;
  }
  const x = String(result.stdout || "").match(/\bX=(-?\d+)\b/);
  const y = String(result.stdout || "").match(/\bY=(-?\d+)\b/);
  if (!x || !y) {
    return null;
  }
  return { x: Number(x[1]), y: Number(y[1]) };
}

function currentMacMouseLocation(): Point | null {
  const result = defaultCommandRunner("cliclick", ["p:."]);
  if (result.error || result.status !== 0) {
    return null;
  }
  const match = String(result.stdout || "")
    .trim()
    .match(/^(-?\d+),(-?\d+)$/);
  if (!match) {
    return null;
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

function moveToAndClickXTest(endpoints: Point[]): HumanizedClickPlan {
  const fallbackEndpoint = endpoints[0] || { x: 0, y: 0 };
  const start = currentXTestMouseLocation() || {
    x: fallbackEndpoint.x - 140,
    y: fallbackEndpoint.y + 80,
  };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const seed = Date.now() + attempt * 7919;
    const plan = generateHumanizedClickPlan(start, endpoints, seed);
    const args = [
      "move-click-rel",
      "--button",
      "1",
      "--pre-click-ms",
      String(plan.preClickDelayMs),
      "--hold-ms",
      String(plan.holdMs),
    ];
    let previousRounded = { x: Math.round(start.x), y: Math.round(start.y) };
    for (let i = 1; i < plan.points.length; i++) {
      const previous = plan.points[i - 1];
      const point = plan.points[i];
      const rounded = { x: Math.round(point.x), y: Math.round(point.y) };
      const dx = rounded.x - previousRounded.x;
      const dy = rounded.y - previousRounded.y;
      const waitMs = Math.max(4, point.t - previous.t);
      if (dx === 0 && dy === 0) {
        continue;
      }
      args.push("--delta", `${dx},${dy},${waitMs}`);
      previousRounded = rounded;
    }
    try {
      ensureCommand(defaultCommandRunner(xtestCommand(), args), xtestCommand(), args);
      const endpoint = currentXTestMouseLocation();
      if (endpoint && Math.hypot(endpoint.x - plan.endpoint.x, endpoint.y - plan.endpoint.y) > 3) {
        throw new Error(
          `XTEST pointer endpoint mismatch: got ${endpoint.x},${endpoint.y}; wanted ${plan.endpoint.x},${plan.endpoint.y}`,
        );
      }
      return plan;
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError || new Error("XTEST click failed");
}

function moveToAndClickXdotool(endpoints: Point[]): HumanizedClickPlan {
  const fallbackEndpoint = endpoints[0] || { x: 0, y: 0 };
  const start = currentXdotoolMouseLocation() || {
    x: fallbackEndpoint.x - 140,
    y: fallbackEndpoint.y + 80,
  };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const seed = Date.now() + attempt * 7919;
    const plan = generateHumanizedClickPlan(start, endpoints, seed);
    const args: string[] = [];
    let previousRounded = { x: Math.round(start.x), y: Math.round(start.y) };
    for (let i = 1; i < plan.points.length; i++) {
      const previous = plan.points[i - 1];
      const point = plan.points[i];
      const rounded = { x: Math.round(point.x), y: Math.round(point.y) };
      if (rounded.x === previousRounded.x && rounded.y === previousRounded.y) {
        continue;
      }
      const waitSeconds = Math.max(0.004, (point.t - previous.t) / 1000);
      args.push("mousemove", String(rounded.x), String(rounded.y), "sleep", waitSeconds.toFixed(3));
      previousRounded = rounded;
    }
    args.push("sleep", (plan.preClickDelayMs / 1000).toFixed(3), "click", "1");
    try {
      ensureCommand(defaultCommandRunner("xdotool", args), "xdotool", args);
      const endpoint = currentXdotoolMouseLocation();
      if (endpoint && Math.hypot(endpoint.x - plan.endpoint.x, endpoint.y - plan.endpoint.y) > 12) {
        throw new Error(
          `xdotool pointer endpoint mismatch: got ${endpoint.x},${endpoint.y}; wanted ${plan.endpoint.x},${plan.endpoint.y}`,
        );
      }
      return plan;
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError || new Error("xdotool click failed");
}

function activateChromeForMacInput(stage: string): void {
  const activateScript = 'tell application "Google Chrome" to activate';
  ensureCommand(defaultCommandRunner("osascript", ["-e", activateScript]), "osascript", [
    "-e",
    activateScript,
  ]);

  const verifyScript =
    'tell application "System Events" to get name of first application process whose frontmost is true';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = defaultCommandRunner("osascript", ["-e", verifyScript]);
    if (result.error || result.status !== 0) {
      console.error(
        `[meeting-joiner][webdriver] macOS foreground guard could not verify frontmost app during ${stage}; continuing after Chrome activate`,
      );
      return;
    }
    const frontmost = String(result.stdout || "").trim();
    if (/chrome/i.test(frontmost)) {
      return;
    }
    if (attempt < 3) {
      defaultCommandRunner("sleep", ["0.15"]);
      ensureCommand(defaultCommandRunner("osascript", ["-e", activateScript]), "osascript", [
        "-e",
        activateScript,
      ]);
    } else {
      throw new Error(
        `macOS foreground guard failed during ${stage}: frontmost app is ${frontmost || "unknown"}`,
      );
    }
  }
}

function moveToAndClickMac(endpoints: Point[]): HumanizedClickPlan {
  const fallbackEndpoint = endpoints[0] || { x: 0, y: 0 };
  const start = currentMacMouseLocation() || {
    x: fallbackEndpoint.x - 140,
    y: fallbackEndpoint.y + 80,
  };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const seed = Date.now() + attempt * 7919;
    const plan = generateHumanizedClickPlan(start, endpoints, seed);
    const args: string[] = [];
    for (let i = 1; i < plan.points.length; i++) {
      const previous = plan.points[i - 1];
      const point = plan.points[i];
      const waitMs = Math.max(4, point.t - previous.t);
      args.push(`m:${Math.round(point.x)},${Math.round(point.y)}`, `w:${waitMs}`);
    }
    args.push(
      `w:${plan.preClickDelayMs}`,
      `c:${Math.round(plan.endpoint.x)},${Math.round(plan.endpoint.y)}`,
    );
    try {
      ensureCommand(defaultCommandRunner("cliclick", args), "cliclick", args);
      const endpoint = currentMacMouseLocation();
      if (endpoint && Math.hypot(endpoint.x - plan.endpoint.x, endpoint.y - plan.endpoint.y) > 12) {
        throw new Error(
          `macOS pointer endpoint mismatch: got ${endpoint.x},${endpoint.y}; wanted ${plan.endpoint.x},${plan.endpoint.y}`,
        );
      }
      return plan;
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError || new Error("macOS click failed");
}

async function xtestKey(key: string): Promise<void> {
  ensureCommand(defaultCommandRunner(xtestCommand(), ["key", key]), xtestCommand(), ["key", key]);
}

async function xtestType(text: string): Promise<void> {
  ensureCommand(
    defaultCommandRunner(xtestCommand(), ["type", "--delay-ms", "35", text]),
    xtestCommand(),
    ["type", "--delay-ms", "35", text],
  );
}

async function xtestPaste(text: string): Promise<void> {
  const copy = spawn("xclip", ["-selection", "clipboard"], {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  copy.stdin.end(text);
  copy.unref();
  await new Promise((resolve) => setTimeout(resolve, 220));
  await xtestKey("ctrl+v");
}

function xdotoolKey(key: string): void {
  ensureCommand(defaultCommandRunner("xdotool", ["key", "--clearmodifiers", key]), "xdotool", [
    "key",
    "--clearmodifiers",
    key,
  ]);
}

function xdotoolType(text: string): void {
  ensureCommand(
    defaultCommandRunner("xdotool", ["type", "--clearmodifiers", "--delay", "35", text]),
    "xdotool",
    ["type", "--clearmodifiers", "--delay", "35", text],
  );
}

function macKey(key: string): void {
  ensureCommand(defaultCommandRunner("cliclick", [`kp:${keyForCliclick(key)}`]), "cliclick", [
    `kp:${keyForCliclick(key)}`,
  ]);
}

function macPaste(text: string): void {
  const previous = spawnSync("pbpaste", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const hadPrevious = !previous.error && previous.status === 0;
  const previousText = hadPrevious ? String(previous.stdout || "") : "";

  ensureCommand(
    spawnSync("pbcopy", {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    }),
    "pbcopy",
    [],
  );

  try {
    ensureCommand(
      defaultCommandRunner("cliclick", ["kd:cmd", "t:a", "ku:cmd", "kd:cmd", "t:v", "ku:cmd"]),
      "cliclick",
      ["kd:cmd", "t:a", "ku:cmd", "kd:cmd", "t:v", "ku:cmd"],
    );
  } finally {
    if (hadPrevious) {
      spawnSync("pbcopy", {
        input: previousText,
        encoding: "utf8",
        stdio: ["pipe", "ignore", "ignore"],
      });
    }
  }
}

function keyForCliclick(key: string): string {
  switch (key.toLowerCase()) {
    case "escape":
    case "esc":
      return "esc";
    case "enter":
    case "return":
      return "return";
    case "tab":
      return "tab";
    case " ":
    case "space":
      return "space";
    default:
      return key.toLowerCase();
  }
}

function webDriverKey(key: string): string {
  switch (key.toLowerCase()) {
    case "escape":
    case "esc":
      return Key.ESCAPE;
    case "enter":
    case "return":
      return Key.ENTER;
    case "tab":
      return Key.TAB;
    default:
      return key;
  }
}

async function visibleText(driver: WebDriver): Promise<string> {
  return driver
    .executeScript("return document.body ? document.body.innerText : '';")
    .catch(() => "") as Promise<string>;
}

async function saveDiagnostic(
  driver: WebDriver,
  artifactsDir: string,
  label: string,
  message: string,
): Promise<void> {
  const safeLabel =
    label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "join-diagnostic";
  const prefix = join(artifactsDir, `join-${safeLabel}`);
  try {
    await mkdir(artifactsDir, { recursive: true });
    const text = await visibleText(driver);
    const state = classifyJoinPageText(text);
    const url = await driver.getCurrentUrl();
    await writeFile(`${prefix}.txt`, `${text || "(empty page text)"}\n`);
    await writeFile(`${prefix}.url.txt`, `${url}\n`);
    await writeFile(
      `${prefix}.json`,
      JSON.stringify(
        { label: safeLabel, state, message, url, captured_at: new Date().toISOString() },
        null,
        2,
      ) + "\n",
    );
    const screenshot = await driver.takeScreenshot().catch(() => "");
    if (screenshot) {
      await writeFile(`${prefix}.png`, Buffer.from(screenshot, "base64"));
    }
    console.error(`[meeting-joiner][webdriver] Saved join diagnostic ${safeLabel}: state=${state}`);
  } catch (err: any) {
    console.error(
      `[meeting-joiner][webdriver] failed to save join diagnostic ${safeLabel}: ${err.message}`,
    );
  }
}

async function writeEvidence(
  options: WebDriverJoinLaneOptions,
  overrides: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(options.artifactsDir, "join-evidence.json"),
    JSON.stringify(
      {
        target: "anonymous_container_admission",
        timestamp: new Date().toISOString(),
        interactionMode: options.interactionDetails.mode,
        interactionBackend: options.interactionDetails.backend,
        interactionLane: options.interactionDetails.lane,
        interactionRequested: options.interactionDetails.requested,
        interactionReason: options.interactionDetails.reason,
        anonymous: true,
        signedIn: false,
        profile: "ephemeral_chromedriver",
        browserChannel: options.browserChannel || "chrome",
        browserControlMode: "webdriver_chromedriver+playwright_cdp",
        webDriverAdmissionOnly: true,
        playwrightPostAdmissionHandoff: true,
        launchArgsMode: options.launchArgsMode || "default",
        browserWindowSize: options.windowSize,
        humanizedMotionMode: envString("MEET_HUMANIZED_MOTION_MODE") || "transformed_settle",
        webDriverNameInputMode: options.interactionDetails.backend,
        webDriverJoinClickMode: options.interactionDetails.backend,
        macInputForegroundGuard: options.interactionDetails.backend === "cliclick",
        joinerChildUser: envString("MEET_JOINER_CHILD_USER") || "",
        ...overrides,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function envString(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return (env[name] || "").trim();
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name] || "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function envBoundedNumber(name: string, fallback: number, min: number, max: number): number {
  const rawValue = String(process.env[name] || "").trim();
  const raw = rawValue ? Number(rawValue) : fallback;
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function safeURLHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function isGoogleMeetURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "meet.google.com";
  } catch {
    return false;
  }
}

function ensureCommand(
  result: { status: number | null; stderr?: string | Buffer; error?: Error },
  command: string,
  args: string[],
): string {
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr || `exit ${result.status}`}`);
  }
  return String((result as { stdout?: string | Buffer }).stdout || "").trim();
}
