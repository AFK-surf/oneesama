import { readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import type { RuntimeInitScript } from "../avatar-runtime/contracts.ts";
import type { getRuntimeConfig } from "../env.ts";
import {
  defaultRealtimeToolSchemas,
  type RealtimeCurrentUser,
} from "../realtime/realtime-contract.ts";
import {
  gotoMeetWithRetry,
  saveDiagnostics,
  shouldRetryMeetNavigationAfterProductRedirect,
  takeScreenshot,
  type Diagnostics,
  type GoogleMeetJoinInput,
} from "./google-meet-joiner-base.ts";
import { collectButtonInventory } from "./google-meet-joiner-ui.ts";
import { dismissMeetPrompts, installMeetPromptAutoDismisser } from "./meet-prompts.ts";

function videoMimeType(relativePath: string): string {
  const normalized = String(relativePath || "").toLowerCase();
  if (normalized.endsWith(".webm")) return "video/webm";
  if (normalized.endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

export function normalizeMeetBrowserControlMode(
  value: string,
): "playwright" | "webdriver_chromedriver" {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "playwright") return "playwright";
  if (
    normalized === "webdriver" ||
    normalized === "webdriver_chromedriver" ||
    normalized === "selenium" ||
    normalized === "selenium_chromedriver" ||
    normalized === "chromedriver"
  ) {
    return "webdriver_chromedriver";
  }
  throw new Error(`Unsupported MAB_MEET_BROWSER_CONTROL_MODE=${value}`);
}

export function defaultMeetBrowserControlMode(input: {
  meetUrl: string;
  browserUserDataDir: string;
  meetProfileMode: string;
  installRealtimeBridge: boolean;
  autoConnectRealtime: boolean;
  installLocalDialogBridge: boolean;
  installWorkerResultBridge: boolean;
  installScreenShareBridge: boolean;
}): "" | "playwright" {
  if (!isGoogleMeetUrl(input.meetUrl)) return "";
  if (input.browserUserDataDir) return "";
  if (input.meetProfileMode.toLowerCase() === "persistent") return "";
  if (
    input.installRealtimeBridge ||
    input.autoConnectRealtime ||
    input.installLocalDialogBridge ||
    input.installWorkerResultBridge ||
    input.installScreenShareBridge
  ) {
    return "playwright";
  }
  return "";
}

export function defaultMeetUIInteractionMode(input: {
  meetUrl: string;
  browserUserDataDir: string;
  meetProfileMode: string;
  installRealtimeBridge: boolean;
  autoConnectRealtime: boolean;
  installLocalDialogBridge: boolean;
  installWorkerResultBridge: boolean;
  installScreenShareBridge: boolean;
}): "" | "humanized" {
  if (!isGoogleMeetUrl(input.meetUrl)) return "";
  if (input.browserUserDataDir) return "";
  if (input.meetProfileMode.toLowerCase() === "persistent") return "";
  if (
    input.installRealtimeBridge ||
    input.autoConnectRealtime ||
    input.installLocalDialogBridge ||
    input.installWorkerResultBridge ||
    input.installScreenShareBridge
  ) {
    return "humanized";
  }
  return "";
}

export function normalizeJoinRetryPolicy(value: unknown): "" | "none" {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!normalized || normalized === "default" || normalized === "auto") return "";
  if (normalized === "none" || normalized === "no-retry" || normalized === "no-retries") {
    return "none";
  }
  throw new Error(`Unsupported retry_policy=${String(value)}`);
}

function envInt(name: string, fallback: number): number {
  const value = String(process.env[name] || "").trim();
  if (!value) return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) ? Math.trunc(raw) : fallback;
}

export function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, envInt(name, fallback)));
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function meetOrigin(meetUrl: string): string {
  try {
    const url = new URL(meetUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "https://meet.google.com";
  }
}

export function isGoogleMeetUrl(meetUrl: string): boolean {
  try {
    return new URL(meetUrl).hostname === "meet.google.com";
  } catch {
    return false;
  }
}

export function shouldUseChromeFakeMediaDevice(input: {
  installAvatar: boolean;
  browserExtraArgs?: unknown;
  chromiumExtraArgs?: unknown;
}): boolean {
  if (input.installAvatar) return false;
  const callerArgs = `${String(input.browserExtraArgs || "")} ${String(input.chromiumExtraArgs || "")}`;
  if (/\b--use-fake-device-for-media-stream\b/.test(callerArgs)) return true;
  if (/\b--use-file-for-fake-audio-capture(?:=|\b)/.test(callerArgs)) return true;
  return true;
}

interface GoogleMeetJoinPlanInput {
  sessionId: string;
  meetUrl: string;
  botName: string;
  headless: boolean;
  installAvatar: boolean;
  installRealtimeBridge: boolean;
  installLocalDialogBridge: boolean;
  installWorkerResultBridge: boolean;
  installScreenShareBridge: boolean;
  autoStartScreenShare: boolean;
  workerPollUrl: string;
  recordMeeting: boolean;
  captureCaptions: boolean;
  captionLanguage: string;
  artifactsDir: string;
  meetAudioBackend: string;
  allowNonGoogleMeet: boolean;
  screenshotDir: string;
  meetProfileMode: string;
  browserUserDataDir: string;
  realtimeRuntimePlacement: string;
  realtimeSdkOwner: string;
  replacementStop: unknown;
  recordedBrowserStop: unknown;
  browserChannel: string;
  chromiumExecutablePathConfigured: boolean;
  browserChannelIgnoredByExecutablePath: boolean;
  meetUIInteractionMode: string;
  meetJoinLane: string;
  meetBrowserControlMode: string;
  retryPolicy: string;
  runtimeSessionValidationSummary: unknown;
}

export function buildGoogleMeetJoinPlan(input: GoogleMeetJoinPlanInput) {
  return {
    provider: "google-meet",
    sessionId: input.sessionId,
    meetUrl: input.meetUrl,
    botName: input.botName,
    headless: input.headless,
    installAvatar: input.installAvatar,
    installRealtimeBridge: input.installRealtimeBridge,
    installLocalDialogBridge: input.installLocalDialogBridge,
    installWorkerResultBridge: input.installWorkerResultBridge,
    installScreenShareBridge: input.installScreenShareBridge,
    autoStartScreenShare: input.autoStartScreenShare,
    workerPollUrl: input.workerPollUrl,
    recordMeeting: input.recordMeeting,
    captureCaptions: input.captureCaptions,
    captionLanguage: input.captionLanguage,
    artifactsDir: input.artifactsDir,
    meetAudioBackend: input.meetAudioBackend,
    allowNonGoogleMeet: input.allowNonGoogleMeet,
    screenshotDir: input.screenshotDir,
    meetProfileMode: input.meetProfileMode,
    browserUserDataDir: input.browserUserDataDir,
    realtimeRuntimePlacement: input.realtimeRuntimePlacement,
    realtimeSdkOwner: input.realtimeSdkOwner,
    replacementStop: input.replacementStop,
    recordedBrowserStop: input.recordedBrowserStop,
    browserChannel: input.browserChannel,
    chromiumExecutablePathConfigured: input.chromiumExecutablePathConfigured,
    browserChannelIgnoredByExecutablePath: input.browserChannelIgnoredByExecutablePath,
    meetUIInteractionMode: input.meetUIInteractionMode,
    meetJoinLane: input.meetJoinLane,
    meetBrowserControlMode: input.meetBrowserControlMode,
    retryPolicy: input.retryPolicy,
    runtimeSessionValidation: input.runtimeSessionValidationSummary,
    steps: [
      "open Google Meet URL",
      "fill guest name when prompted",
      "click Join / Ask to join",
      "wait for admission and meeting readiness",
      "install avatar and Realtime runtime bridges",
    ],
  };
}

export function buildConfiguredRealtimeCurrentUser(
  config: ReturnType<typeof getRuntimeConfig>,
): RealtimeCurrentUser {
  return {
    name: config.currentUserName,
    englishName: config.currentUserEnglishName,
    email: config.currentUserEmail,
    linear: config.currentUserLinear,
    github: config.currentUserGithub,
    role: config.currentUserRole,
    aliases: config.currentUserAliases,
  };
}

export function defaultGoogleMeetRealtimeTools() {
  return defaultRealtimeToolSchemas;
}

function runtimeScriptSourceUrl(script: RuntimeInitScript): string {
  const category = String(script.category || "runtime").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const event = String(script.event?.event || "install").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `oneesama-${category}-${event}.js`;
}

function cdpRuntimeEvaluateError(result: unknown): string {
  const details = (result as { exceptionDetails?: unknown })?.exceptionDetails as
    | {
        text?: string;
        exception?: { description?: string; value?: unknown };
      }
    | undefined;
  if (!details) return "";
  return String(
    details.exception?.description ||
      details.exception?.value ||
      details.text ||
      "Runtime.evaluate exception",
  );
}

export async function installRuntimeInitScriptForPage(
  page: import("playwright").Page,
  script: RuntimeInitScript,
  {
    diagnostics,
    webDriverPreJoined,
  }: {
    diagnostics: Diagnostics;
    webDriverPreJoined: boolean;
  },
): Promise<void> {
  await page.addInitScript({ content: script.content });
  if (!webDriverPreJoined) return;

  const sourceUrl = runtimeScriptSourceUrl(script);
  const expression = `${script.content}\n//# sourceURL=${sourceUrl}`;
  const category = script.category;
  const event = script.event?.event || "";

  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        userGesture: true,
        allowUnsafeEvalBlockedByCSP: true,
      });
      const exception = cdpRuntimeEvaluateError(result);
      if (exception) throw new Error(exception);
      diagnostics.record("runtime_script_late_install", {
        category,
        event,
        method: "cdp_runtime_evaluate",
      });
      return;
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch (error) {
    const evaluateError = String(error?.message || error);
    await page
      .addScriptTag({ content: script.content })
      .then(() => {
        diagnostics.record("runtime_script_late_install", {
          category,
          event,
          method: "script_tag_fallback",
          evaluateError,
        });
        return null;
      })
      .catch((scriptTagError) => {
        diagnostics.record("runtime_script_late_install_error", {
          category,
          event,
          method: "cdp_runtime_evaluate_then_script_tag",
          evaluateError,
          error: String(scriptTagError?.message || scriptTagError),
        });
      });
  }
}

async function recoverMeetProductRedirect(
  page: import("playwright").Page,
  meetUrl: string,
  diagnostics: Diagnostics,
  retryPolicy: "" | "none" = "",
): Promise<boolean> {
  const currentUrl = page.url();
  if (!shouldRetryMeetNavigationAfterProductRedirect(meetUrl, currentUrl)) return false;
  if (retryPolicy === "none") {
    diagnostics.record("meet_product_redirect_recovery_skipped", {
      requestedUrl: meetUrl,
      currentUrl,
      retryPolicy,
    });
    await saveDiagnostics(diagnostics);
    return false;
  }
  diagnostics.record("meet_product_redirect_recovery_start", { requestedUrl: meetUrl, currentUrl });
  await dismissMeetPrompts(page, diagnostics);
  await page.waitForTimeout(500);
  const response = await gotoMeetWithRetry(page, meetUrl, diagnostics);
  diagnostics.record("meet_product_redirect_recovery_complete", {
    requestedUrl: meetUrl,
    currentUrl: page.url(),
    status: response?.status?.() || 0,
  });
  await saveDiagnostics(diagnostics);
  return true;
}

export async function settleAfterMeetProductRedirectRecovery(
  page: import("playwright").Page,
  meetUrl: string,
  diagnostics: Diagnostics,
  label: string,
  retryPolicy: "" | "none" = "",
): Promise<boolean> {
  if (!(await recoverMeetProductRedirect(page, meetUrl, diagnostics, retryPolicy))) return false;
  await installMeetPromptAutoDismisser(page, diagnostics);
  await waitForMeetInteractiveSurface(page, diagnostics, `${label}-after-product-redirect-retry`);
  await takeScreenshot(page, diagnostics, `${label}-after-product-redirect-retry`);
  await collectButtonInventory(page, diagnostics, `${label}-after-product-redirect-retry`);
  await dismissMeetPrompts(page, diagnostics);
  return true;
}

export async function waitForMeetInteractiveSurface(
  page: import("playwright").Page,
  diagnostics: Diagnostics,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  if (typeof page.waitForFunction !== "function") return;
  const observed = await page
    .waitForFunction(
      () => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const visibleButton = (pattern: RegExp) =>
          Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]")).some(
            (node) => {
              const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              if (
                rect.width <= 0 ||
                rect.height <= 0 ||
                style.visibility === "hidden" ||
                style.display === "none"
              ) {
                return false;
              }
              const buttonLabel =
                `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
                  .replace(/\s+/g, " ")
                  .trim();
              return pattern.test(buttonLabel);
            },
          );
        const hasGuestNameInput = Array.from(
          document.querySelectorAll<HTMLElement>(
            [
              'input[aria-label*="name" i]',
              'input[placeholder*="name" i]',
              'input[type="text"]',
              "textarea",
              '[contenteditable="true"]',
            ].join(","),
          ),
        ).some((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        });
        if (hasGuestNameInput) return { kind: "guest_name_input" };
        if (visibleButton(/\b(ask to join|join now)\b|申请加入|立即加入/i)) {
          return { kind: "join_button" };
        }
        if (visibleButton(/captions?|字幕/i)) return { kind: "captions" };
        if (visibleButton(/leave (?:call|meeting)|离开通话/i)) return { kind: "leave_control" };
        if (
          /asking to join|you'?ll join|waiting for.*(?:admit|host)|正在请求加入|等待.*(?:主持人|允许)/i.test(
            text,
          )
        ) {
          return { kind: "waiting_for_admit" };
        }
        if (
          /You can't join this video call|No one can join a meeting unless invited or admitted by the host|Returning to home screen/i.test(
            text,
          )
        ) {
          return { kind: "cannot_join_meeting" };
        }
        if (
          /accounts\.google\.com/i.test(location.href) ||
          /Forgot email|Use your Google Account/i.test(text)
        ) {
          return { kind: "sign_in_required" };
        }
        return false;
      },
      undefined,
      { polling: 100, timeout: Math.max(1, timeoutMs) },
    )
    .then(async (handle) => ({ ok: true, ...(await handle.jsonValue()) }))
    .catch((error) => ({
      ok: false,
      error: String(error?.message || error).slice(0, 180),
    }));
  diagnostics.record("meet_interactive_surface_wait", { label, observed });
}

interface MeetAvatarConfigInput {
  input: GoogleMeetJoinInput;
  config: ReturnType<typeof getRuntimeConfig>;
  botName: string;
  installAvatar: boolean;
  diagnostics: Diagnostics;
}

export async function buildMeetAvatarConfig({
  input,
  config,
  botName,
  installAvatar,
  diagnostics,
}: MeetAvatarConfigInput): Promise<Record<string, unknown>> {
  const requestedAvatarRenderer = input.avatarRenderer || config.avatarRenderer;
  const avatarRendererIsVideo = String(requestedAvatarRenderer || "").toLowerCase() === "video";
  const avatarConfig: Record<string, unknown> = {
    modelUrl: input.avatarModelUrl || config.avatarModelUrl,
    modelFallbackUrls: config.avatarModelFallbackUrls,
    avatarRenderer: requestedAvatarRenderer,
    vrmModelUrl: input.avatarVRMModelUrl || config.avatarVRMModelUrl,
    vrmModelFallbackUrls: config.avatarVRMModelFallbackUrls,
    live2dDepsDir: input.avatarDepsDir || config.avatarDepsDir,
    layout: input.avatarLayout || config.avatarLayout,
    botName,
    disableLive2D: Boolean(input.disableLive2D),
    deferRendererUntilExplicitStart:
      input.deferAvatarRendererUntilJoined !== false && installAvatar,
    canvasWidth: Number(input.avatarCanvasWidth || config.avatarCanvasWidth || 1280),
    canvasHeight: Number(input.avatarCanvasHeight || config.avatarCanvasHeight || 720),
    captureFps: Number(input.avatarCaptureFps || config.avatarCaptureFps || 12),
  };
  if (avatarRendererIsVideo && installAvatar) {
    const videoUsesAlpha =
      /\.webm$/iu.test(String(config.avatarVideoIdlePath || "")) &&
      /\.webm$/iu.test(String(config.avatarVideoSpeakingPath || ""));
    const loadInlineVideoSource = async (relativePath: string) => {
      const assetPath = pathJoin(config.avatarAssetRoot, relativePath);
      const data = await readFile(assetPath);
      return {
        inlineBase64: data.toString("base64"),
        mimeType: videoMimeType(relativePath),
      };
    };
    const idleInlineSource = await loadInlineVideoSource(config.avatarVideoIdlePath);
    const speakingInlineSource = await loadInlineVideoSource(config.avatarVideoSpeakingPath);
    Object.assign(avatarConfig, {
      background: "#0b1018",
      videoObjectFit: "cover",
      videoMuted: true,
      videoCrossfadeMs: 0,
      videoSpeakingDebounceMs: 220,
      videoChromaKey: {
        enabled: !videoUsesAlpha,
        keyColor: "#00ff00",
        similarity: 0.22,
        smoothness: 0.06,
        minGreen: 45,
        minDominance: 18,
        spill: 0.82,
        spillSoftness: 10,
        matteErodePx: 0,
        matteFeatherPx: 0,
        maxProcessingWidth: 640,
        maxProcessingHeight: 360,
      },
      videoSources: [
        {
          id: "idle",
          label: "Idle loop",
          state: "idle",
          ...idleInlineSource,
          objectFit: "cover",
          background: "#0b1018",
          default: true,
        },
        {
          id: "speaking",
          label: "Speaking loop",
          state: "speaking",
          ...speakingInlineSource,
          objectFit: "cover",
          background: "#0b1018",
        },
      ],
    });
    diagnostics.record("avatar_video_assets", {
      root: config.avatarAssetRoot,
      delivery: "inline_blob",
      idlePath: config.avatarVideoIdlePath,
      speakingPath: config.avatarVideoSpeakingPath,
      alpha: videoUsesAlpha,
    });
  }
  return avatarConfig;
}
