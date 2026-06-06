import { mkdir, readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { getRuntimeConfig } from "../env.ts";
import { buildAvatarRuntimeInitScripts } from "../avatar-runtime/runtime-init-builder.ts";
import { validateGoogleMeetRuntimeSessionConfig } from "../avatar-runtime/google-meet-surface.ts";
import type { RuntimeInitScript } from "../avatar-runtime/contracts.ts";
import { enableMeetCaptions, installMeetCaptionCapture } from "./caption-capture.ts";
import { buildGoogleMeetChromiumArgs } from "./google-meet-launch-args.ts";
import { ensureMeetCameraOff } from "./meet-camera-controls.ts";
import { waitForMeetAdmission } from "./meet-admission.ts";
import { installMeetLocalPlaybackMute } from "./meet-local-playback-mute.ts";
import * as audio from "./meeting-audio-inputs.ts";
import { dismissMeetPrompts, installMeetPromptAutoDismisser } from "./meet-prompts.ts";
import {
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  defaultRealtimeToolSchemas,
  type RealtimeCurrentUser,
} from "../realtime/realtime-contract.ts";
import { normalizeRealtimeRuntimePlacement } from "../realtime/realtime-browser-init-builder.ts";
import {
  DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
  DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT,
  DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH,
  assertMeetUrl,
  createDiagnostics,
  gotoMeetWithRetry,
  installPageDiagnostics,
  loadPlaywright,
  normalizeMeetProfileMode,
  nowIso,
  saveDiagnostics,
  shouldMuteMeetLocalPlayback,
  shouldRetryMeetNavigationAfterProductRedirect,
  takeScreenshot,
  type Diagnostics,
  type GoogleMeetJoinInput,
  type GoogleMeetJoinerOptions,
  type LocalMultipartFrameServer,
  type LocalStaticAssetServer,
  type MeetChatInput,
} from "./google-meet-joiner-base.ts";
import { createActiveBrowserRecord } from "./google-meet-joiner-browser-record.ts";
import {
  getRealtimeControlPageForActive,
  injectWorkerResultIntoActive,
  readMeetChatFromActive,
  requestRealtimeTextTurnFromActive,
  sendMeetChatFromActive,
  sendRealtimeEventToActive,
} from "./google-meet-joiner-realtime-control.ts";
import {
  assertRealtimeRuntimePlacementForMeetJoin,
  collectRealtimeSidecarPageStatus,
  defaultRealtimeBridgeModeForRuntime,
  mergeMeetSurfaceAudioOutputState,
} from "./google-meet-joiner-realtime-status.ts";
import { startRealtimeSidecarPage } from "./google-meet-joiner-realtime-sidecar.ts";
import { clickFirstVisible, collectButtonInventory } from "./google-meet-joiner-ui.ts";
import {
  buildMeetingAwarenessState,
  clickMeetJoinButton,
  compactCaptionState,
  compactJoinStatusActive,
  compactRuntimeState,
  evaluateAvatarAudio,
  evaluateAvatarReady,
  evaluateFixtureState,
  evaluateLocalDialogState,
  evaluateMeetPageState,
  evaluateRealtimeBridgeState,
  evaluateScreenShareState,
  evaluateWorkerResultBridgeState,
  fillGuestName,
  logMeetingAwarenessDebug,
  meetingAwarenessSignature,
  openMeetPeoplePanelForAwareness,
  publishMeetingAwarenessToPage,
  startAvatarRenderer,
} from "./google-meet-joiner-runtime-state.ts";
import { createGoogleMeetShareActions } from "./google-meet-joiner-share-actions.ts";
import {
  runWebDriverJoinLane,
  type WebDriverAdmittedSession,
} from "./google-meet-webdriver-lane.ts";
import { resolveMeetUIInteractionDetails } from "./google-meet-humanized-input.ts";

export {
  buildMeetingAwarenessState,
  meetingAwarenessContextText,
} from "./google-meet-joiner-runtime-state.ts";

function videoMimeType(relativePath: string): string {
  const normalized = String(relativePath || "").toLowerCase();
  if (normalized.endsWith(".webm")) return "video/webm";
  if (normalized.endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

function normalizeMeetBrowserControlMode(value: string): "playwright" | "webdriver_chromedriver" {
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

function defaultMeetBrowserControlMode(input: {
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

function defaultMeetUIInteractionMode(input: {
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

function normalizeJoinRetryPolicy(value: unknown): "" | "none" {
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

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, envInt(name, fallback)));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function meetOrigin(meetUrl: string): string {
  try {
    const url = new URL(meetUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "https://meet.google.com";
  }
}

function isGoogleMeetUrl(meetUrl: string): boolean {
  try {
    return new URL(meetUrl).hostname === "meet.google.com";
  } catch {
    return false;
  }
}

function shouldUseChromeFakeMediaDevice(input: {
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

async function installRuntimeInitScriptForPage(
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

async function settleAfterMeetProductRedirectRecovery(
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

async function waitForMeetInteractiveSurface(
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

async function buildMeetAvatarConfig({
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

export function defaultGoogleMeetRealtimeTools() {
  return defaultRealtimeToolSchemas;
}

export function createGoogleMeetJoiner(options: GoogleMeetJoinerOptions = {}) {
  const config = getRuntimeConfig();
  let active = null;
  let activeMacWindowCapture: null | {
    timer: NodeJS.Timeout | null;
    stopped: boolean;
    window: unknown;
    stream?: { stop: () => void; processId?: number };
    mjpeg?: LocalMultipartFrameServer;
    stop: (reason?: string) => void;
  } = null;
  const activeBrowserPath = pathJoin(config.dataDir, "active-meet-browser.json");
  const activeBrowserRecord = createActiveBrowserRecord(activeBrowserPath);

  function buildConfiguredRealtimeCurrentUser(): RealtimeCurrentUser {
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

  async function stop(reason = "manual_stop") {
    if (!active) return { ok: true, stopped: false, reason };
    const previous = active;
    active = null;
    stopActiveMacWindowCapture(reason);
    previous.avatarAssetServer?.stop();
    previous.realtimeSidecarServer?.stop();
    previous.diagnostics?.record("stop", { reason });
    try {
      const browserStop = previous.page?.isClosed?.()
        ? { ok: true, skipped: true, reason: "page_already_closed" }
        : await previous.page
            ?.evaluate(async (stopReason) => {
              const client = window.MAB_REALTIME_CLIENT;
              if (typeof client?.stopMeetAudioCapture !== "function") {
                return { ok: true, skipped: true, reason: "realtime_audio_capture_missing" };
              }
              return await client.stopMeetAudioCapture(stopReason);
            }, reason)
            .catch((error) => ({ ok: false, error: String(error?.message || error) }));
      previous.diagnostics?.record("realtime_audio_capture_browser_stop", { browserStop });
    } catch (error) {
      previous.diagnostics?.record("realtime_audio_capture_stop_error", {
        error: String(error?.message || error),
      });
    }
    await audio.stopRealtimeRecappiAudioInput(previous);
    try {
      await previous.recorder?.stop();
    } catch (error) {
      previous.diagnostics?.record("recorder_stop_error", {
        error: String(error?.message || error),
      });
    }
    try {
      const finalized = previous.realtimeAudioCapture
        ? await previous.realtimeAudioCapture.finalize()
        : null;
      previous.diagnostics?.record("realtime_audio_capture_finalize", { finalized });
    } catch (error) {
      previous.diagnostics?.record("realtime_audio_capture_finalize_error", {
        error: String(error?.message || error),
      });
    }
    try {
      await previous.captionCapture?.flush();
    } catch (error) {
      previous.diagnostics?.record("caption_flush_error", {
        error: String(error?.message || error),
      });
    }
    try {
      if (previous.persistentBrowserContext) {
        await previous.context?.close();
      } else {
        await previous.browser?.close();
      }
    } catch (error) {
      previous.diagnostics?.record("stop_close_error", { error: String(error?.message || error) });
      // Browser may already be gone.
    }
    try {
      await previous.webDriverSession?.quit?.();
    } catch (error) {
      previous.diagnostics?.record("webdriver_quit_error", {
        error: String(error?.message || error),
      });
    }
    await activeBrowserRecord.clear();
    if (previous.diagnostics) await saveDiagnostics(previous.diagnostics).catch(() => {});
    return {
      ok: true,
      stopped: true,
      sessionId: previous.sessionId,
      reason,
      diagnosticsPath: previous.diagnostics?.jsonPath || "",
    };
  }

  function getRealtimeControlPage() {
    return getRealtimeControlPageForActive(active);
  }

  async function join(input: GoogleMeetJoinInput) {
    const meetUrl = input.meetUrl || "";
    const allowNonGoogleMeet = Boolean(input.allowNonGoogleMeet || options.allowNonGoogleMeet);
    assertMeetUrl(meetUrl, { allowNonGoogleMeet });
    const sessionId = input.sessionId || `manual_${Date.now()}`;
    const botName = input.botName || config.botName;
    const dryRun = Boolean(input.dryRun);
    const installAvatar = input.installAvatar !== false;
    const installRealtimeBridge = input.installRealtimeBridge !== false;
    const installLocalDialogBridge = Boolean(input.installLocalDialogBridge);
    const installWorkerResultBridge = input.installWorkerResultBridge !== false;
    const installScreenShareBridge = Boolean(input.installScreenShareBridge);
    const realtimeRuntimePlacement = normalizeRealtimeRuntimePlacement(
      input.realtimeRuntimePlacement || config.openaiRealtimeRuntimePlacement,
    );
    assertRealtimeRuntimePlacementForMeetJoin({
      installRealtimeBridge,
      realtimeRuntimePlacement,
      meetUrl,
    });
    const realtimeSdkOwner = realtimeRuntimePlacement === "sidecar" ? "sidecar" : "meet-page";
    const autoStartScreenShare = Boolean(input.autoStartScreenShare);
    const workerPollUrl = input.workerPollUrl || `${config.meetingAgentUrl}/worker/poll-realtime`;
    const recordMeeting = Boolean(input.recordMeeting ?? config.recordMeeting);
    const captureCaptions = Boolean(input.captureCaptions ?? config.captureCaptions);
    const captionLanguage = input.captionLanguage || config.captionLanguage || "";
    const artifactsDir = input.artifactsDir || pathJoin(config.meetingArtifactsDir, sessionId);
    const realtimeWantsMeetAudio =
      installRealtimeBridge &&
      input.forwardMeetAudioToRealtime !== false &&
      Boolean(input.includeParticipantAudio);
    const realtimeRequiresRecappi =
      realtimeWantsMeetAudio && audio.isGoogleMeetUrlForRealtimeAudio(meetUrl);
    const {
      recorder,
      realtimeAudioCapture,
      realtimeRecappiAudioInput: initialRecappiAudioInput,
    } = audio.createMeetingAudioInputs({
      input,
      config,
      sessionId,
      artifactsDir,
      meetUrl,
      installRealtimeBridge,
      recordMeeting,
    });
    let realtimeRecappiAudioInput = initialRecappiAudioInput;
    const browserUserDataDirInput = input.browserUserDataDir || config.browserUserDataDir || "";
    const meetProfileMode = normalizeMeetProfileMode(
      input.meetProfileMode || config.meetProfileMode,
      Boolean(browserUserDataDirInput),
    );
    if (meetProfileMode === "persistent" && !browserUserDataDirInput) {
      throw new Error(
        "MAB_BROWSER_USER_DATA_DIR is required when MAB_MEET_PROFILE_MODE=persistent",
      );
    }
    const browserUserDataDir = meetProfileMode === "persistent" ? browserUserDataDirInput : "";
    const chromiumExecutablePath =
      options.chromiumExecutablePath || config.chromiumExecutablePath || "";
    const browserChannel =
      input.browserChannel || options.browserChannel || config.browserChannel || "";
    const meetJoinLane = String(input.meetJoinLane || "").trim();
    const meetUIInteractionMode = String(
      input.meetUIInteractionMode ||
        defaultMeetUIInteractionMode({
          meetUrl,
          browserUserDataDir,
          meetProfileMode,
          installRealtimeBridge,
          autoConnectRealtime: Boolean(input.autoConnectRealtime),
          installLocalDialogBridge,
          installWorkerResultBridge,
          installScreenShareBridge,
        }) ||
        "",
    ).trim();
    const meetUIInteractionEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(meetUIInteractionMode ? { MAB_MEET_UI_INTERACTION_MODE: meetUIInteractionMode } : {}),
      ...(meetJoinLane ? { MAB_MEET_JOIN_LANE: meetJoinLane } : {}),
    };
    const meetBrowserControlMode = normalizeMeetBrowserControlMode(
      String(
        input.meetBrowserControlMode ||
          process.env.MAB_MEET_BROWSER_CONTROL_MODE ||
          process.env.MEET_BROWSER_CONTROL_MODE ||
          defaultMeetBrowserControlMode({
            meetUrl,
            browserUserDataDir,
            meetProfileMode,
            installRealtimeBridge,
            autoConnectRealtime: Boolean(input.autoConnectRealtime),
            installLocalDialogBridge,
            installWorkerResultBridge,
            installScreenShareBridge,
          }) ||
          "",
      ),
    );
    const retryPolicy = normalizeJoinRetryPolicy(
      input.retryPolicy ||
        process.env.MAB_MEET_JOIN_RETRY_POLICY ||
        process.env.ONEESAMA_MEET_JOIN_RETRY_POLICY ||
        "",
    );
    const navigationMaxAttempts = retryPolicy === "none" ? 1 : 2;
    const realtimeAgentRuntime = input.realtimeAgentRuntime || config.openaiRealtimeAgentRuntime;
    const realtimeBridgeMode =
      input.realtimeBridgeMode || defaultRealtimeBridgeModeForRuntime(realtimeAgentRuntime);
    const runtimeSessionValidation = validateGoogleMeetRuntimeSessionConfig({
      sessionId,
      botName,
      realtimeBridgeMode,
      installAvatar,
      installRealtimeBridge,
      installLocalDialogBridge,
      installScreenShareBridge,
      installWorkerResultBridge,
    });
    if (runtimeSessionValidation.failure) throw new Error(runtimeSessionValidation.failure.error);
    const runtimeSessionConfig = runtimeSessionValidation.config!;

    const replacementStop = await stop("replace_existing_bot");
    const recordedBrowserStop = replacementStop.stopped
      ? { ok: true, stopped: false, reason: "active_stop_closed_browser", source: "record_skipped" }
      : await activeBrowserRecord.stop("replace_existing_bot");

    const plan = {
      provider: "google-meet",
      sessionId,
      meetUrl,
      botName,
      headless: config.browserHeadless,
      installAvatar,
      installRealtimeBridge,
      installLocalDialogBridge,
      installWorkerResultBridge,
      installScreenShareBridge,
      autoStartScreenShare,
      workerPollUrl,
      recordMeeting,
      captureCaptions,
      captionLanguage,
      artifactsDir,
      meetAudioBackend: recorder.backend,
      allowNonGoogleMeet,
      screenshotDir: config.screenshotDir,
      meetProfileMode,
      browserUserDataDir,
      realtimeRuntimePlacement,
      realtimeSdkOwner,
      replacementStop,
      recordedBrowserStop,
      browserChannel,
      chromiumExecutablePathConfigured: Boolean(chromiumExecutablePath),
      browserChannelIgnoredByExecutablePath: Boolean(browserChannel && chromiumExecutablePath),
      meetUIInteractionMode,
      meetJoinLane,
      meetBrowserControlMode,
      retryPolicy,
      runtimeSessionValidation: runtimeSessionValidation.summary,
      steps: [
        "open Google Meet URL",
        "fill guest name when prompted",
        "click Join / Ask to join",
        "wait for admission and meeting readiness",
        "install avatar and Realtime runtime bridges",
      ],
    };

    if (dryRun) return { ok: true, dryRun: true, plan };

    await mkdir(config.screenshotDir, { recursive: true });
    const diagnostics = createDiagnostics(sessionId, config.screenshotDir);
    diagnostics.record("join_start", {
      meetUrl,
      botName,
      installAvatar,
      allowNonGoogleMeet,
      meetProfileMode,
      realtimeRuntimePlacement,
      realtimeSdkOwner,
      meetUIInteractionMode,
      meetJoinLane,
      meetBrowserControlMode,
      retryPolicy,
    });
    const avatarConfig = await buildMeetAvatarConfig({
      input,
      config,
      botName,
      installAvatar,
      diagnostics,
    });
    const playwright = await loadPlaywright(
      options.playwrightModulePath || config.playwrightModulePath,
    );
    const recorderLaunchEnv = recordMeeting ? await recorder.prepareLaunchEnv() : undefined;
    const browserLaunchOptions = {
      ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
      ...(!chromiumExecutablePath && browserChannel ? { channel: browserChannel } : {}),
      headless: config.browserHeadless,
      env: recorderLaunchEnv,
      args: buildGoogleMeetChromiumArgs({
        avatarUseSwiftShader: config.avatarUseSwiftShader,
        browserExtraArgs: input.browserExtraArgs,
        chromiumExtraArgs: config.chromiumExtraArgs,
        useFakeMediaDevice: shouldUseChromeFakeMediaDevice({
          installAvatar,
          browserExtraArgs: input.browserExtraArgs,
          chromiumExtraArgs: config.chromiumExtraArgs,
        }),
      }),
    };
    const contextOptions = {
      permissions: ["microphone", "camera"],
      viewport: {
        width: Number(input.browserViewportWidth || config.browserViewportWidth || 1440),
        height: Number(input.browserViewportHeight || config.browserViewportHeight || 900),
      },
    };
    let browser;
    let context;
    let webDriverSession: WebDriverAdmittedSession | null = null;
    let webDriverPreJoined = false;
    let webDriverAdmission = null;
    const useWebDriverAdmission =
      !browserUserDataDir &&
      meetBrowserControlMode === "webdriver_chromedriver" &&
      isGoogleMeetUrl(meetUrl);
    if (browserUserDataDir) {
      await mkdir(browserUserDataDir, { recursive: true });
      diagnostics.record("browser_launch", {
        persistentUserDataDir: browserUserDataDir,
        admissionLane: "persistent_profile",
        executablePath: browserLaunchOptions.executablePath || "",
        channel: browserLaunchOptions.channel || "",
        configuredChannel: browserChannel,
        channelIgnoredByExecutablePath: Boolean(browserChannel && chromiumExecutablePath),
        headless: browserLaunchOptions.headless,
        args: browserLaunchOptions.args,
      });
      context = await playwright.chromium.launchPersistentContext(browserUserDataDir, {
        ...browserLaunchOptions,
        ...contextOptions,
      });
      browser = typeof context.browser === "function" ? context.browser() : null;
    } else if (useWebDriverAdmission) {
      diagnostics.record("browser_launch", {
        persistentUserDataDir: "",
        admissionLane: "webdriver_chromedriver",
        executablePath: browserLaunchOptions.executablePath || "",
        channel: browserLaunchOptions.channel || "",
        configuredChannel: browserChannel,
        channelIgnoredByExecutablePath: Boolean(browserChannel && chromiumExecutablePath),
        headless: false,
        args: browserLaunchOptions.args,
      });
      const interactionDetails = resolveMeetUIInteractionDetails(meetUIInteractionEnv);
      const hardBlockRetryDelayMs = boundedEnvInt(
        "MAB_MEET_WEBDRIVER_HARD_BLOCK_RETRY_DELAY_MS",
        2500,
        0,
        15_000,
      );
      const maxWebDriverJoinAttempts =
        retryPolicy === "none"
          ? 1
          : 1 + boundedEnvInt("MAB_MEET_WEBDRIVER_HARD_BLOCK_RETRIES", 2, 0, 3);
      let webDriverFailure: { status: string; message: string } | null = null;
      for (let attempt = 1; attempt <= maxWebDriverJoinAttempts; attempt++) {
        webDriverFailure = null;
        diagnostics.record("webdriver_join_attempt", {
          attempt,
          maxAttempts: maxWebDriverJoinAttempts,
          reason: attempt === 1 ? "initial" : "hard_block_retry",
          retryPolicy,
        });
        try {
          webDriverSession = await runWebDriverJoinLane({
            meetURL: meetUrl,
            botName,
            artifactsDir,
            launchArgs: browserLaunchOptions.args,
            launchEnv: {
              ...(browserLaunchOptions.env || process.env),
              ...(chromiumExecutablePath
                ? { MAB_CHROMIUM_EXECUTABLE: chromiumExecutablePath }
                : {}),
            },
            launchArgsMode: "oneesama_default",
            windowSize: `${contextOptions.viewport.width},${contextOptions.viewport.height}`,
            permissionOrigin: meetOrigin(meetUrl),
            interactionDetails,
            browserChannel: browserChannel || "chrome",
            preJoinRuntimeScripts: installAvatar
              ? buildAvatarRuntimeInitScripts({
                  sessionId,
                  botName,
                  surfaceKind: runtimeSessionConfig.surfaceKind,
                  conversationTransport: runtimeSessionConfig.conversationTransport,
                  installAvatar: true,
                  installRealtimeBridge: false,
                  installLocalDialogBridge: false,
                  installScreenShareBridge: false,
                  installWorkerResultBridge: false,
                  avatar: avatarConfig,
                }).map((script) => ({ category: script.category, content: script.content }))
              : [],
            requirePreJoinRuntimeScripts: installAvatar,
            turnOffMicBeforeJoin: !installAvatar,
            turnOffCameraBeforeJoin: !installAvatar,
            emitStatus: (webdriverStatus, message, detail = {}) => {
              diagnostics.record("webdriver_join_status", {
                status: webdriverStatus,
                message,
                attempt,
                maxAttempts: maxWebDriverJoinAttempts,
                ...detail,
              });
              if (
                webdriverStatus === "hard_blocked" ||
                webdriverStatus === "prejoin_navigation_blocked"
              ) {
                webDriverFailure = { status: webdriverStatus, message };
                return;
              }
              if (webdriverStatus === "error" && webDriverFailure?.status !== "hard_blocked") {
                webDriverFailure = { status: webdriverStatus, message };
              }
            },
            isStopped: () => false,
          });
        } catch (error) {
          const message = String(error?.message || error);
          diagnostics.record("webdriver_join_error", {
            error: message,
            attempt,
            maxAttempts: maxWebDriverJoinAttempts,
          });
          await saveDiagnostics(diagnostics);
          return {
            ok: false,
            error: "webdriver_join_error",
            sessionId,
            screenshotDir: config.screenshotDir,
            diagnosticsPath: diagnostics.jsonPath,
            webDriver: { status: "error", message },
          };
        }
        if (webDriverSession) break;
        if (webDriverFailure?.status === "hard_blocked" && attempt < maxWebDriverJoinAttempts) {
          diagnostics.record("webdriver_hard_block_retry", {
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts: maxWebDriverJoinAttempts,
            delayMs: hardBlockRetryDelayMs,
            message: webDriverFailure.message,
          });
          await saveDiagnostics(diagnostics);
          await delay(hardBlockRetryDelayMs);
          continue;
        }
        break;
      }
      if (!webDriverSession) {
        const meetPage = null;
        const failure = webDriverFailure || {
          status: "error",
          message: "webdriver_admission_failed",
        };
        diagnostics.record("webdriver_join_failed", failure);
        await saveDiagnostics(diagnostics);
        return {
          ok: false,
          error: failure.status === "hard_blocked" ? "cannot_join_meeting" : failure.status,
          sessionId,
          screenshotDir: config.screenshotDir,
          diagnosticsPath: diagnostics.jsonPath,
          meetPage,
          webDriver: failure,
        };
      }
      diagnostics.record("webdriver_admitted", {
        debuggerAddress: webDriverSession.debuggerAddress,
        pageURL: webDriverSession.pageURL,
      });
      try {
        browser = await playwright.chromium.connectOverCDP(
          `http://${webDriverSession.debuggerAddress}`,
        );
        context = browser.contexts()[0] || (await browser.newContext(contextOptions));
      } catch (error) {
        await webDriverSession.quit().catch(() => {});
        diagnostics.record("webdriver_cdp_handoff_error", {
          error: String(error?.message || error),
        });
        await saveDiagnostics(diagnostics);
        throw error;
      }
      webDriverPreJoined = true;
      webDriverAdmission = {
        state: "admitted",
        signal: "webdriver_chromedriver",
        interaction: interactionDetails,
      };
    } else {
      diagnostics.record("browser_launch", {
        persistentUserDataDir: "",
        admissionLane: "playwright",
        executablePath: browserLaunchOptions.executablePath || "",
        channel: browserLaunchOptions.channel || "",
        configuredChannel: browserChannel,
        channelIgnoredByExecutablePath: Boolean(browserChannel && chromiumExecutablePath),
        headless: browserLaunchOptions.headless,
        args: browserLaunchOptions.args,
      });
      browser = await playwright.chromium.launch(browserLaunchOptions);
      context = await browser.newContext(contextOptions);
    }
    const realtimeAudioCaptureExpose = realtimeAudioCapture
      ? await realtimeAudioCapture.exposeTo(context)
      : null;
    if (realtimeAudioCaptureExpose) {
      diagnostics.record("realtime_audio_capture_expose", realtimeAudioCaptureExpose);
    }
    if (realtimeRequiresRecappi && !realtimeRecappiAudioInput) {
      diagnostics.record("recappi_realtime_audio_required_missing", {
        meetUrl,
        recorderBackend: recorder.backend,
        realtimeWantsMeetAudio,
      });
      await saveDiagnostics(diagnostics);
      await context.close().catch(() => {});
      if (browser && typeof browser.close === "function") await browser.close().catch(() => {});
      await activeBrowserRecord.clear();
      return {
        ok: false,
        error: "recappi_realtime_audio_required",
        sessionId,
        diagnosticsPath: diagnostics.jsonPath,
      };
    }
    active = {
      sessionId,
      browser,
      context,
      persistentBrowserContext: Boolean(browserUserDataDir),
      browserUserDataDir,
      meetProfileMode,
      startedAt: nowIso(),
      meetUrl,
      realtimeRuntimePlacement,
      realtimeSdkOwner,
      diagnostics,
      artifactsDir,
      realtimeSidecarPage: null,
      realtimeSidecarServer: null,
      recorder: recordMeeting ? recorder : null,
      realtimeAudioCapture,
      realtimeRecappiAudioInput,
      webDriverSession,
      avatarAssetServer: null as LocalStaticAssetServer | null,
      captionCapture: null,
    };
    const browserRecord = await activeBrowserRecord.remember(browser, sessionId, meetUrl);
    // tsx/esbuild can serialize page.evaluate callbacks through __name; expose a no-op
    // helper so browser-side diagnostics keep working when smokes run TypeScript directly.
    await context.addInitScript({
      content: `
        (() => {
          if (typeof globalThis.__name !== "function") {
            Object.defineProperty(globalThis, "__name", {
              value: (fn) => fn,
              configurable: true,
            });
          }
        })();
      `,
    });
    const realtimeCurrentUser = buildConfiguredRealtimeCurrentUser();
    const realtimeTools = input.realtimeTools || defaultGoogleMeetRealtimeTools();
    let realtimeInstructions = "",
      realtimeSession = null;
    if (installRealtimeBridge) {
      realtimeInstructions =
        input.realtimeInstructions ||
        buildRealtimeInstructions({
          botName,
          personalityContext: config.realtimePersonalityContext,
          currentUser: realtimeCurrentUser,
        });
      realtimeSession =
        input.realtimeSession ||
        buildRealtimeSessionConfig(
          {
            botName,
            currentUser: realtimeCurrentUser,
            instructions: realtimeInstructions,
            tools: realtimeTools,
          },
          config,
        );
    }
    const recappiRealtimeProbe = await audio.probeRealtimeRecappiAudioInput({
      realtimeRecappiAudioInput,
      context,
      diagnostics,
    });
    if (realtimeRecappiAudioInput && recappiRealtimeProbe?.source !== "recappi_process_audio") {
      diagnostics.record("recappi_realtime_audio_disabled", {
        reason: recappiRealtimeProbe?.error || "recappi_process_audio_unavailable",
        probe: recappiRealtimeProbe,
        fallback: "none",
      });
      await saveDiagnostics(diagnostics);
      await stop("recappi_realtime_audio_unavailable").catch(() => {});
      return {
        ok: false,
        error: "recappi_realtime_audio_unavailable",
        sessionId,
        diagnosticsPath: diagnostics.jsonPath,
        recappiRealtimeProbe,
      };
    }
    const realtimeMeetAudioInputSource = realtimeRecappiAudioInput
      ? "recappi_process_audio"
      : realtimeRequiresRecappi
        ? "none"
        : "webrtc";
    const allowHostMeetAudioPcmInput =
      realtimeRuntimePlacement === "sidecar" &&
      realtimeWantsMeetAudio &&
      !audio.isGoogleMeetUrlForRealtimeAudio(meetUrl);
    const realtimeBridgeConfig = {
      mode: realtimeBridgeMode,
      agentRuntime: realtimeAgentRuntime,
      realtimeRuntimePlacement,
      sessionId,
      botName,
      toolCallbackToken: input.realtimeToolCallbackToken || config.internalAuthKey || "",
      autoRespondToWorkerResults: input.autoRespondToWorkerResults !== false,
      autoRespondToAvatarToolCalls: input.autoRespondToAvatarToolCalls !== false,
      instructions: realtimeInstructions,
      tools: realtimeTools,
      session: realtimeSession,
      currentUser: realtimeCurrentUser,
      sendSessionUpdateOnConnect: input.sendRealtimeSessionUpdate !== false,
      includeParticipantAudio: Boolean(input.includeParticipantAudio),
      forwardMeetAudioToRealtime: input.forwardMeetAudioToRealtime !== false,
      meetAudioInputSource: realtimeMeetAudioInputSource,
      allowHostMeetAudioPcmInput,
      allowParticipantAudioStreamEvents: allowNonGoogleMeet,
      meetAudioInputGain: input.meetAudioInputGain,
      captureMeetAudioForTranscript: Boolean(realtimeAudioCapture),
      workerDelegateUrl: input.workerDelegateUrl || `${config.meetingAgentUrl}/worker/delegate`,
      workerStatusUrl: input.workerStatusUrl || `${config.meetingAgentUrl}/worker/status`,
      autoConnect: Boolean(input.autoConnectRealtime),
      tokenUrl: input.realtimeTokenUrl || `${config.meetingAgentUrl}/realtime/client-secret`,
      openaiRealtimeBaseUrl: config.openaiBaseUrl,
      sdpUrl: input.realtimeSdpUrl || config.openaiRealtimeSdpUrl,
      directTextTurnToolRouting: input.directTextTurnToolRouting !== false,
      dryRunLocalTools: Boolean(input.dryRunLocalTools),
    };
    const workerResultConfig = {
      workerPollUrl,
      workerMarkRealtimeDeliveredUrl: `${config.meetingAgentUrl}/worker/mark-realtime-delivered`,
      enabled: Boolean(workerPollUrl),
      minCreatedAt: input.workerResultMinCreatedAt || new Date().toISOString(),
      sessionId,
      toolCallbackToken: realtimeBridgeConfig.toolCallbackToken,
    };
    const runtimeInitScripts = buildAvatarRuntimeInitScripts({
      sessionId,
      botName,
      surfaceKind: runtimeSessionConfig.surfaceKind,
      conversationTransport: runtimeSessionConfig.conversationTransport,
      installAvatar,
      installRealtimeBridge,
      installLocalDialogBridge,
      installScreenShareBridge,
      installWorkerResultBridge:
        installWorkerResultBridge && realtimeRuntimePlacement !== "sidecar",
      avatar: avatarConfig,
      realtime: {
        ...realtimeBridgeConfig,
        realtimeRuntimePlacement,
        realtimePageRole: "meet-surface",
      },
      localDialog: {
        enabled: true,
        botName,
        sessionId,
        turnUrl: input.localDialogTurnUrl || `${config.meetingAgentUrl}/dialog/turn`,
        ttsMode: input.localDialogTtsMode || "tone",
        ttsUrl: input.localDialogTtsUrl || `${config.meetingAgentUrl}/tts/synthesize`,
        sttProvider: input.localDialogSttProvider || config.sttProvider,
        ttsProvider: input.localDialogTtsProvider || config.ttsProvider,
        ttsGain: Number(input.localDialogTtsGain ?? 0.025),
      },
      screenShare: {
        enabled: true,
        autoStart: autoStartScreenShare,
        mode: input.screenShareMode || "synthetic",
        title: input.screenShareTitle || "Meeting Avatar Bot",
        subtitle: input.screenShareSubtitle || "Agent screen share",
        width: input.screenShareWidth || DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH,
        height: input.screenShareHeight || DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT,
        fps: input.screenShareFps || DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
      },
      workerResult: {
        ...workerResultConfig,
      },
    });
    diagnostics.record("runtime_session_validation", runtimeSessionValidation.summary);
    diagnostics.record("runtime_init_scripts", {
      categories: runtimeInitScripts.map((script) => script.category),
      events: runtimeInitScripts.map((script) => script.event),
    });
    if (installRealtimeBridge && realtimeRuntimePlacement === "sidecar") {
      const realtimeSidecar = await startRealtimeSidecarPage({
        context,
        diagnostics,
        getMeetPage: () => active?.page || null,
        realtimeBridgeConfig,
        sessionId,
        workerResultConfig: installWorkerResultBridge ? workerResultConfig : null,
      });
      active = {
        ...active,
        realtimeSidecarPage: realtimeSidecar.page,
        realtimeSidecarServer: realtimeSidecar.server,
      };
    }
    const existingPages = typeof context.pages === "function" ? context.pages() : [];
    const page = webDriverPreJoined
      ? existingPages.find((candidate) => /meet\.google\.com/i.test(candidate.url())) ||
        existingPages[0] ||
        (await context.newPage())
      : await context.newPage();
    installPageDiagnostics(page, diagnostics);
    for (const script of runtimeInitScripts) {
      await installRuntimeInitScriptForPage(page, script, { diagnostics, webDriverPreJoined });
    }
    active = {
      ...active,
      context,
      page,
    };
    let clicked = "";
    let admission = null;
    if (webDriverPreJoined) {
      diagnostics.record("goto_skipped", {
        reason: "webdriver_chromedriver_prejoined",
        url: page.url(),
      });
      await installMeetPromptAutoDismisser(page, diagnostics);
      await installMeetLocalPlaybackMute(page, diagnostics, shouldMuteMeetLocalPlayback(input));
      await waitForMeetInteractiveSurface(page, diagnostics, "after-webdriver-join", 3000);
      await takeScreenshot(page, diagnostics, "02-after-webdriver-join");
      await collectButtonInventory(page, diagnostics, "after-webdriver-join");
      clicked = "webdriver_chromedriver";
      admission = webDriverAdmission;
    } else {
      diagnostics.record("goto_start", { meetUrl });
      await saveDiagnostics(diagnostics);
      const gotoResponse = await gotoMeetWithRetry(page, meetUrl, diagnostics, {
        maxAttempts: navigationMaxAttempts,
      });
      diagnostics.record("goto_complete", {
        url: page.url(),
        status: gotoResponse?.status?.() || 0,
      });
      await saveDiagnostics(diagnostics);
      await installMeetPromptAutoDismisser(page, diagnostics);
      await installMeetLocalPlaybackMute(page, diagnostics, shouldMuteMeetLocalPlayback(input));
      await waitForMeetInteractiveSurface(page, diagnostics, "after-nav");
      await takeScreenshot(page, diagnostics, "01-after-nav");
      await collectButtonInventory(page, diagnostics, "after-nav");

      await dismissMeetPrompts(page, diagnostics);
      await settleAfterMeetProductRedirectRecovery(page, meetUrl, diagnostics, "01b", retryPolicy);

      let guestNameResult = await fillGuestName(
        page,
        botName,
        diagnostics,
        35_000,
        meetUIInteractionEnv,
      );
      if (
        !guestNameResult.ok &&
        guestNameResult.reason === "meet_product_redirect" &&
        (await settleAfterMeetProductRedirectRecovery(
          page,
          meetUrl,
          diagnostics,
          "01c-guest-name",
          retryPolicy,
        ))
      ) {
        guestNameResult = await fillGuestName(
          page,
          botName,
          diagnostics,
          35_000,
          meetUIInteractionEnv,
        );
      }
      if (
        !guestNameResult.ok &&
        ["cannot_join_meeting", "google_sign_in_required", "meet_anti_bot_prejoin"].includes(
          guestNameResult.reason,
        )
      ) {
        const meetPage = await evaluateMeetPageState(page);
        diagnostics.record("join_failed_terminal_state", { guestNameResult, meetPage });
        await saveDiagnostics(diagnostics);
        return {
          ok: false,
          error: guestNameResult.reason,
          sessionId,
          screenshotDir: config.screenshotDir,
          diagnosticsPath: diagnostics.jsonPath,
          meetPage,
          guestName: guestNameResult,
        };
      }

      await collectButtonInventory(page, diagnostics, "pre-join-click");
      if (
        await settleAfterMeetProductRedirectRecovery(
          page,
          meetUrl,
          diagnostics,
          "01d-pre-click",
          retryPolicy,
        )
      ) {
        guestNameResult = await fillGuestName(
          page,
          botName,
          diagnostics,
          35_000,
          meetUIInteractionEnv,
        );
        diagnostics.record("guest_name_refilled_after_product_redirect", { guestNameResult });
        if (
          !guestNameResult.ok &&
          ["cannot_join_meeting", "google_sign_in_required", "meet_anti_bot_prejoin"].includes(
            guestNameResult.reason,
          )
        ) {
          const meetPage = await evaluateMeetPageState(page);
          diagnostics.record("join_failed_terminal_state_after_product_redirect", {
            guestNameResult,
            meetPage,
          });
          await saveDiagnostics(diagnostics);
          return {
            ok: false,
            error: guestNameResult.reason,
            sessionId,
            screenshotDir: config.screenshotDir,
            diagnosticsPath: diagnostics.jsonPath,
            meetPage,
            guestName: guestNameResult,
          };
        }
        await collectButtonInventory(page, diagnostics, "pre-join-click-after-product-redirect");
      }
      const preJoinSettleInteraction = resolveMeetUIInteractionDetails(meetUIInteractionEnv);
      const useHumanizedMeetUI = preJoinSettleInteraction.mode === "humanized";
      const preJoinSettleMs = useHumanizedMeetUI
        ? boundedEnvInt("MAB_MEET_HUMANIZED_PREJOIN_SETTLE_MS", 500, 0, 12_000)
        : 0;
      if (preJoinSettleMs > 0) {
        diagnostics.record("humanized_prejoin_settle", {
          ms: preJoinSettleMs,
          interaction: preJoinSettleInteraction,
        });
        await page.waitForTimeout(preJoinSettleMs);
      }
      if (!installAvatar) await ensureMeetCameraOff(page, diagnostics, "pre_join");

      clicked = await clickMeetJoinButton(page, diagnostics, 45_000, meetUIInteractionEnv);
      if (clicked === "terminal:cannot_join_meeting") {
        const meetPage = await evaluateMeetPageState(page);
        diagnostics.record("join_failed_terminal_state_after_click", {
          reason: "cannot_join_meeting",
          meetPage,
        });
        await saveDiagnostics(diagnostics);
        await stop("cannot_join_meeting").catch(() => {});
        return {
          ok: false,
          error: "cannot_join_meeting",
          sessionId,
          screenshotDir: config.screenshotDir,
          diagnosticsPath: diagnostics.jsonPath,
          meetPage,
        };
      }
      if (!clicked && !useHumanizedMeetUI) {
        clicked = await clickFirstVisible(
          page,
          [
            'button:has-text("Ask to join")',
            'button:has-text("Join now")',
            'button:has-text("加入")',
            'button:has-text("申请加入")',
            'button:has-text("立即加入")',
            'button:has-text("Join")',
            '[aria-label*="Ask to join" i]',
            '[aria-label*="Join now" i]',
            '[aria-label*="加入" i]',
            "button[jsname]",
          ],
          2500,
          diagnostics,
        );
      }
      if (!clicked && !useHumanizedMeetUI) {
        const enterFallback = await page.keyboard
          .press("Enter")
          .then(() => true)
          .catch(() => false);
        diagnostics.record("join_enter_fallback", { ok: enterFallback });
        if (enterFallback) {
          await page.waitForTimeout(1500);
          const pageState = await evaluateMeetPageState(page);
          if (pageState?.waitingForAdmit || (pageState?.inMeeting && !pageState?.preJoin)) {
            clicked = "keyboard:enter";
          }
        }
      }
      if (!clicked) {
        const meetPage = await evaluateMeetPageState(page);
        if (meetPage?.cannotJoin === true) {
          diagnostics.record("join_failed_terminal_state_no_button", {
            reason: "cannot_join_meeting",
            meetPage,
          });
          await saveDiagnostics(diagnostics);
          await stop("cannot_join_meeting").catch(() => {});
          return {
            ok: false,
            error: "cannot_join_meeting",
            sessionId,
            screenshotDir: config.screenshotDir,
            diagnosticsPath: diagnostics.jsonPath,
            meetPage,
          };
        }
        diagnostics.record("join_failed_no_button", { meetPage });
        await saveDiagnostics(diagnostics);
        await stop("join_button_not_found").catch(() => {});
        return {
          ok: false,
          error: "join_button_not_found",
          sessionId,
          screenshotDir: config.screenshotDir,
          diagnosticsPath: diagnostics.jsonPath,
          meetPage,
        };
      }

      await waitForMeetInteractiveSurface(page, diagnostics, "after-join-click", 3000);
      await takeScreenshot(page, diagnostics, "02-after-join-click");
      await collectButtonInventory(page, diagnostics, "after-join-click");
      if (clicked) {
        const joinedFixture = allowNonGoogleMeet ? await evaluateFixtureState(page) : null;
        if (joinedFixture?.joined === true) {
          admission = { state: "admitted", signal: "fixture_joined", fixtureState: joinedFixture };
          diagnostics.record("admission_state", admission);
        } else {
          admission = await waitForMeetAdmission(page, {
            diagnostics,
            dismissMeetPrompts,
            evaluateMeetPageState,
            timeoutMs: 120_000,
          });
        }
        if (admission.state === "denied") {
          await saveDiagnostics(diagnostics);
          return {
            ok: false,
            error: "admission_denied",
            sessionId,
            screenshotDir: config.screenshotDir,
            diagnosticsPath: diagnostics.jsonPath,
            admission,
          };
        }
        if (admission.state === "sign_in_required") {
          await saveDiagnostics(diagnostics);
          return {
            ok: false,
            error: "google_sign_in_required",
            sessionId,
            screenshotDir: config.screenshotDir,
            diagnosticsPath: diagnostics.jsonPath,
            admission,
          };
        }
      }
    }
    if (!installAvatar) await ensureMeetCameraOff(page, diagnostics, "post_admission");
    const avatarRendererStart =
      installAvatar && clicked
        ? await startAvatarRenderer(page, diagnostics)
        : { ok: false, skipped: true, reason: "avatar_not_installed_or_not_joined" };
    let captionCapture = null;
    let captionEnable = null;
    if (captureCaptions && clicked) {
      captionCapture = await installMeetCaptionCapture(page, { artifactsDir, diagnostics });
      captionEnable = await enableMeetCaptions(page, { captionLanguage, diagnostics });
      await page.waitForTimeout(1200);
      const captionStatus = await captionCapture.status();
      diagnostics.record("caption_capture_ready", {
        captionEnable,
        captions: compactCaptionState(captionStatus),
      });
    } else if (captureCaptions) {
      diagnostics.record("caption_capture_skipped", { reason: "join_not_confirmed" });
    }
    await audio.startRealtimeRecappiAudioInput({
      realtimeRecappiAudioInput,
      context,
      page: getRealtimeControlPage(),
      diagnostics,
    });
    if (recordMeeting) {
      const recorderStart = await recorder.start({ context, artifactsDir });
      diagnostics.record("recorder_start", recorderStart);
    }
    if (input.localDialogAcceptanceUtterance) {
      const localDialogDispatch = await page
        .evaluate(
          async ({ text, sessionId: localSessionId }) => {
            if (!window.MAB_LOCAL_DIALOG_CONTROLLER?.sendUtterance) {
              return { ok: false, error: "local_dialog_controller_missing" };
            }
            return await window.MAB_LOCAL_DIALOG_CONTROLLER.sendUtterance({
              source: "joiner-acceptance",
              text,
              sessionId: localSessionId,
              context: { acceptance: "joiner-local-dialog" },
            });
          },
          { text: input.localDialogAcceptanceUtterance, sessionId },
        )
        .catch((error) => ({
          ok: false,
          error: String(error?.message || error),
        }));
      diagnostics.record("local_dialog_acceptance_dispatched", localDialogDispatch);
    }
    let screenShareStart = null;
    if (installScreenShareBridge && autoStartScreenShare) {
      screenShareStart = await page
        .evaluate(
          async ({ title, subtitle }) => {
            if (!window.MAB_SCREEN_SHARE_CONTROLLER?.start) {
              return { ok: false, error: "screen_share_controller_missing" };
            }
            return await window.MAB_SCREEN_SHARE_CONTROLLER.start({ title, subtitle });
          },
          {
            title: input.screenShareTitle || "Meeting Avatar Bot",
            subtitle: input.screenShareSubtitle || "Agent screen share",
          },
        )
        .catch((error) => ({
          ok: false,
          error: String(error?.message || error),
        }));
      diagnostics.record("screen_share_auto_start", screenShareStart);
    }
    const avatarReady = await evaluateAvatarReady(page);
    const avatarAudio = await evaluateAvatarAudio(page);
    const fixtureState = input.collectFixtureState ? await evaluateFixtureState(page) : null;
    const localDialog = await evaluateLocalDialogState(page);
    const screenShare = await evaluateScreenShareState(page);
    let meetPage = await evaluateMeetPageState(page);
    if (meetPage.inMeeting) {
      await openMeetPeoplePanelForAwareness(page, diagnostics);
      meetPage = await evaluateMeetPageState(page);
    }
    const captions = captionCapture ? await captionCapture.status() : null;
    const meetingAwareness = buildMeetingAwarenessState({
      meetPage,
      captions,
      currentUser: realtimeCurrentUser,
    });
    diagnostics.record("join_complete", {
      clickedJoinSelector: clicked,
      admission,
      meetPage,
      meetingAwareness,
      avatarReady,
      avatarAudio,
      fixtureState,
      localDialog,
      screenShare,
      screenShareStart,
      avatarRendererStart,
      captions: compactCaptionState(captions),
    });
    await saveDiagnostics(diagnostics);
    active = {
      ...active,
      context,
      page,
      captionCapture,
      captionEnable,
      clickedJoinSelector: clicked,
      admission,
      avatarReady,
      avatarAudio,
      fixtureState,
      localDialog,
      screenShare,
      meetPage,
      captions,
      meetingAwareness,
      peoplePanelAwarenessAttempted: Boolean(meetPage.inMeeting),
    };
    active.lastMeetingAwarenessSignature = "";
    const realtimeControlPage = getRealtimeControlPage();
    active.meetingAwarenessPush = await publishMeetingAwarenessToPage(
      realtimeControlPage,
      meetingAwareness,
    );
    active.meetingAwarenessSurfaceStore = await publishMeetingAwarenessToPage(
      page,
      meetingAwareness,
      false,
    );
    logMeetingAwarenessDebug("join_complete", meetingAwareness, active.meetingAwarenessPush);
    if (active.meetingAwarenessPush?.pushed) {
      active.lastMeetingAwarenessSignature = meetingAwarenessSignature(meetingAwareness);
      diagnostics.record("meeting_awareness_push", active.meetingAwarenessPush);
      await saveDiagnostics(diagnostics).catch(() => {});
    }

    return {
      ok: true,
      dryRun: false,
      sessionId,
      replacementStop,
      recordedBrowserStop,
      browserRecord,
      clickedJoinSelector: clicked,
      admission,
      screenshotDir: config.screenshotDir,
      diagnosticsPath: diagnostics.jsonPath,
      artifactsDir,
      realtimeRuntimePlacement,
      realtimeSdkOwner,
      recorder: recordMeeting ? recorder.status() : null,
      realtimeAudioCapture: realtimeAudioCapture?.status() || null,
      realtimeRecappiAudioInput: realtimeRecappiAudioInput?.status() || null,
      captions: compactCaptionState(captions),
      screenshots: diagnostics.screenshots,
      buttonInventories: diagnostics.buttonInventories,
      avatarReady,
      avatarAudio,
      fixtureState,
      localDialog,
      screenShare,
      meetPage,
      meetingAwareness,
      meetingAwarenessPush: active.meetingAwarenessPush,
      screenShareStart,
    };
  }

  async function refreshActiveRuntimeState() {
    if (!active?.page) return;
    const realtimeControlPage = getRealtimeControlPage();
    let [
      avatarReady,
      avatarAudio,
      fixtureState,
      realtimeBridge,
      meetSurfaceRealtimeBridge,
      workerResultBridge,
      localDialog,
      screenShare,
      captions,
      meetPage,
    ] = await Promise.all([
      evaluateAvatarReady(active.page),
      evaluateAvatarAudio(active.page),
      evaluateFixtureState(active.page),
      evaluateRealtimeBridgeState(realtimeControlPage),
      realtimeControlPage === active.page
        ? Promise.resolve(null)
        : evaluateRealtimeBridgeState(active.page),
      evaluateWorkerResultBridgeState(realtimeControlPage),
      evaluateLocalDialogState(active.page),
      evaluateScreenShareState(active.page),
      active.captionCapture?.status() || Promise.resolve(null),
      evaluateMeetPageState(active.page),
    ]);
    realtimeBridge = mergeMeetSurfaceAudioOutputState(
      realtimeBridge,
      meetSurfaceRealtimeBridge || realtimeBridge,
    );
    if (meetPage.inMeeting && !active.peoplePanelAwarenessAttempted) {
      active.peoplePanelAwarenessAttempted = true;
      await openMeetPeoplePanelForAwareness(active.page, active.diagnostics);
      meetPage = await evaluateMeetPageState(active.page);
    }
    const realtimeCurrentUser = buildConfiguredRealtimeCurrentUser();
    const meetingAwareness = buildMeetingAwarenessState({
      meetPage,
      captions,
      currentUser: realtimeCurrentUser,
    });
    active.avatarReady = avatarReady;
    active.avatarAudio = avatarAudio;
    active.fixtureState = fixtureState;
    active.realtimeBridge = realtimeBridge;
    active.workerResultBridge = workerResultBridge;
    active.localDialog = localDialog;
    active.screenShare = screenShare;
    active.captions = captions;
    active.meetPage = meetPage;
    active.meetingAwareness = meetingAwareness;
    const nextAwarenessSignature = meetingAwarenessSignature(meetingAwareness);
    if (nextAwarenessSignature && nextAwarenessSignature !== active.lastMeetingAwarenessSignature) {
      active.meetingAwarenessPush = await publishMeetingAwarenessToPage(
        realtimeControlPage,
        meetingAwareness,
      );
      active.meetingAwarenessSurfaceStore = await publishMeetingAwarenessToPage(
        active.page,
        meetingAwareness,
        false,
      );
      if (active.meetingAwarenessPush?.pushed) {
        active.lastMeetingAwarenessSignature = nextAwarenessSignature;
      }
    } else {
      await publishMeetingAwarenessToPage(realtimeControlPage, meetingAwareness, false).catch(
        () => {},
      );
      await publishMeetingAwarenessToPage(active.page, meetingAwareness, false).catch(() => {});
    }
    logMeetingAwarenessDebug(
      "runtime_state_refresh",
      meetingAwareness,
      active.meetingAwarenessPush,
    );
    if (active.diagnostics) {
      active.diagnostics.record("runtime_state_refresh", {
        meetPage,
        meetingAwareness,
        meetingAwarenessPush: active.meetingAwarenessPush || null,
        ...compactRuntimeState({
          avatarReady,
          avatarAudio,
          realtimeBridge,
          workerResultBridge,
          localDialog,
          screenShare,
          captions,
        }),
      });
      await saveDiagnostics(active.diagnostics).catch(() => {});
      await active.captionCapture?.flush().catch(() => {});
    }
  }

  async function injectWorkerResult(job) {
    return injectWorkerResultIntoActive(active, job, refreshActiveRuntimeState);
  }

  async function sendRealtimeEvent(event) {
    return sendRealtimeEventToActive(active, event, refreshActiveRuntimeState);
  }

  async function requestRealtimeTextTurn({ text, instructions }) {
    return requestRealtimeTextTurnFromActive(
      active,
      { text, instructions },
      refreshActiveRuntimeState,
    );
  }

  async function sendMeetChat(input: MeetChatInput = {}) {
    return sendMeetChatFromActive(active, input, refreshActiveRuntimeState);
  }

  async function readMeetChat(input: MeetChatInput = {}) {
    return readMeetChatFromActive(active, input, refreshActiveRuntimeState);
  }

  const captureRef = {
    get current() {
      return activeMacWindowCapture;
    },
    set current(value) {
      activeMacWindowCapture = value;
    },
  };
  const {
    listShareableApps,
    presentAppShare,
    startScreenShare,
    presentScreenShare,
    openVideoStage,
    presentVideoStage,
    stopScreenShare,
    stopActiveMacWindowCapture,
  } = createGoogleMeetShareActions({
    config,
    options,
    captureRef,
    getActive: () => active,
    refreshActiveRuntimeState,
  });

  async function status() {
    await refreshActiveRuntimeState();
    const realtimeSidecarStatus = active ? await collectRealtimeSidecarPageStatus(active) : null;
    return {
      ok: true,
      active: compactJoinStatusActive(active, realtimeSidecarStatus),
    };
  }

  return {
    join,
    stop,
    status,
    injectWorkerResult,
    sendRealtimeEvent,
    requestRealtimeTextTurn,
    sendMeetChat,
    readMeetChat,
    listShareableApps,
    presentAppShare,
    startScreenShare,
    presentScreenShare,
    openVideoStage,
    presentVideoStage,
    stopScreenShare,
  };
}
