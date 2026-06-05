import { mkdir } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { getRuntimeConfig } from "../env.ts";
import { buildAvatarRuntimeInitScripts } from "../avatar-runtime/runtime-init-builder.ts";
import { validateGoogleMeetRuntimeSessionConfig } from "../avatar-runtime/google-meet-surface.ts";
import { buildGoogleMeetChromiumArgs } from "./google-meet-launch-args.ts";
import { ensureMeetCameraOff } from "./meet-camera-controls.ts";
import { waitForMeetAdmission } from "./meet-admission.ts";
import { installMeetLocalPlaybackMute } from "./meet-local-playback-mute.ts";
import * as audio from "./meeting-audio-inputs.ts";
import { dismissMeetPrompts, installMeetPromptAutoDismisser } from "./meet-prompts.ts";
import {
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
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
  takeScreenshot,
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
} from "./google-meet-joiner-realtime-status.ts";
import { startRealtimeSidecarPage } from "./google-meet-joiner-realtime-sidecar.ts";
import { clickFirstVisible, collectButtonInventory } from "./google-meet-joiner-ui.ts";
import {
  clickMeetJoinButton,
  compactJoinStatusActive,
  evaluateFixtureState,
  evaluateMeetPageState,
  fillGuestName,
} from "./google-meet-joiner-runtime-state.ts";
import { createGoogleMeetShareActions } from "./google-meet-joiner-share-actions.ts";
import {
  runWebDriverJoinLane,
  type WebDriverAdmittedSession,
} from "./google-meet-webdriver-lane.ts";
import { resolveMeetUIInteractionDetails } from "./google-meet-humanized-input.ts";
import {
  boundedEnvInt,
  buildConfiguredRealtimeCurrentUser,
  buildGoogleMeetJoinPlan,
  buildMeetAvatarConfig,
  defaultMeetBrowserControlMode,
  defaultGoogleMeetRealtimeTools,
  defaultMeetUIInteractionMode,
  delay,
  installRuntimeInitScriptForPage,
  isGoogleMeetUrl,
  meetOrigin,
  normalizeJoinRetryPolicy,
  normalizeMeetBrowserControlMode,
  settleAfterMeetProductRedirectRecovery,
  shouldUseChromeFakeMediaDevice,
  waitForMeetInteractiveSurface,
} from "./google-meet-joiner-helpers.ts";
import {
  completeGoogleMeetJoinRuntime,
  refreshGoogleMeetJoinerRuntimeState,
} from "./google-meet-joiner-runtime-sync.ts";

export {
  buildMeetingAwarenessState,
  meetingAwarenessContextText,
} from "./google-meet-joiner-runtime-state.ts";
export { defaultGoogleMeetRealtimeTools } from "./google-meet-joiner-helpers.ts";

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
    const realtimeRecappiAudioInput = initialRecappiAudioInput;
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

    const plan = buildGoogleMeetJoinPlan({
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
      runtimeSessionValidationSummary: runtimeSessionValidation.summary,
    });

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
              if (["hard_blocked", "prejoin_navigation_blocked"].includes(webdriverStatus)) {
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
    const realtimeCurrentUser = buildConfiguredRealtimeCurrentUser(config);
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
      const preJoinSettleMs =
        preJoinSettleInteraction.mode === "humanized"
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
      if (!clicked)
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
      if (!clicked) {
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
    const completion = await completeGoogleMeetJoinRuntime({
      active,
      context,
      page,
      input,
      installAvatar,
      clicked,
      admission,
      captureCaptions,
      artifactsDir,
      diagnostics,
      captionLanguage,
      realtimeRecappiAudioInput,
      recordMeeting,
      recorder,
      installScreenShareBridge,
      autoStartScreenShare,
      sessionId,
      realtimeCurrentUser,
      getRealtimeControlPage,
    });
    active = completion.active;

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
      captions: completion.compactCaptions,
      screenshots: diagnostics.screenshots,
      buttonInventories: diagnostics.buttonInventories,
      avatarReady: completion.avatarReady,
      avatarAudio: completion.avatarAudio,
      fixtureState: completion.fixtureState,
      localDialog: completion.localDialog,
      screenShare: completion.screenShare,
      meetPage: completion.meetPage,
      meetingAwareness: completion.meetingAwareness,
      meetingAwarenessPush: active.meetingAwarenessPush,
      screenShareStart: completion.screenShareStart,
    };
  }

  async function refreshActiveRuntimeState() {
    await refreshGoogleMeetJoinerRuntimeState({
      active,
      realtimeControlPage: getRealtimeControlPage(),
      realtimeCurrentUser: buildConfiguredRealtimeCurrentUser(config),
    });
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
