import { mkdir, readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { getRuntimeConfig } from "../env.ts";
import { buildAvatarRuntimeInitScripts } from "../avatar-runtime/runtime-init-builder.ts";
import { validateGoogleMeetRuntimeSessionConfig } from "../avatar-runtime/google-meet-surface.ts";
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
  mergeMeetSurfaceAudioOutputState,
} from "./google-meet-joiner-realtime-status.ts";
import { startRealtimeSidecarPage } from "./google-meet-joiner-realtime-sidecar.ts";
import { clickFirstVisible, collectButtonInventory } from "./google-meet-joiner-ui.ts";
import {
  buildMeetingAwarenessState,
  clickMeetJoinButton,
  compactCaptionState,
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
    });
    const playwright = await loadPlaywright(
      options.playwrightModulePath || config.playwrightModulePath,
    );
    const recorderLaunchEnv = recordMeeting ? await recorder.prepareLaunchEnv() : undefined;
    const browserLaunchOptions = {
      executablePath: options.chromiumExecutablePath || config.chromiumExecutablePath || undefined,
      headless: config.browserHeadless,
      env: recorderLaunchEnv,
      args: buildGoogleMeetChromiumArgs({
        avatarUseSwiftShader: config.avatarUseSwiftShader,
        browserExtraArgs: input.browserExtraArgs,
        chromiumExtraArgs: config.chromiumExtraArgs,
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
    if (browserUserDataDir) {
      await mkdir(browserUserDataDir, { recursive: true });
      diagnostics.record("browser_launch", {
        persistentUserDataDir: browserUserDataDir,
        executablePath: browserLaunchOptions.executablePath || "",
        headless: browserLaunchOptions.headless,
        args: browserLaunchOptions.args,
      });
      context = await playwright.chromium.launchPersistentContext(browserUserDataDir, {
        ...browserLaunchOptions,
        ...contextOptions,
      });
      browser = typeof context.browser === "function" ? context.browser() : null;
    } else {
      diagnostics.record("browser_launch", {
        persistentUserDataDir: "",
        executablePath: browserLaunchOptions.executablePath || "",
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
    const requestedAvatarRenderer = input.avatarRenderer || config.avatarRenderer;
    const avatarRendererIsVideo = String(requestedAvatarRenderer || "").toLowerCase() === "video";
    const avatarConfig = {
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
    const page = await context.newPage();
    installPageDiagnostics(page, diagnostics);
    for (const script of runtimeInitScripts) {
      await page.addInitScript({ content: script.content });
    }
    active = {
      ...active,
      context,
      page,
    };
    diagnostics.record("goto_start", { meetUrl });
    await saveDiagnostics(diagnostics);
    const gotoResponse = await gotoMeetWithRetry(page, meetUrl, diagnostics);
    diagnostics.record("goto_complete", { url: page.url(), status: gotoResponse?.status?.() || 0 });
    await saveDiagnostics(diagnostics);
    await installMeetPromptAutoDismisser(page, diagnostics);
    await installMeetLocalPlaybackMute(page, diagnostics, shouldMuteMeetLocalPlayback(input));
    await page.waitForTimeout(2500);
    await takeScreenshot(page, diagnostics, "01-after-nav");
    await collectButtonInventory(page, diagnostics, "after-nav");

    await dismissMeetPrompts(page, diagnostics);

    const guestNameResult = await fillGuestName(page, botName, diagnostics);
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
    if (!installAvatar) await ensureMeetCameraOff(page, diagnostics, "pre_join");

    let clicked = await clickMeetJoinButton(page, diagnostics, 45_000);
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
        if (pageState?.waitingForAdmit || pageState?.inMeeting) clicked = "keyboard:enter";
      }
    }
    if (!clicked) {
      const meetPage = await evaluateMeetPageState(page);
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

    await page.waitForTimeout(2500);
    await takeScreenshot(page, diagnostics, "02-after-join-click");
    await collectButtonInventory(page, diagnostics, "after-join-click");
    let admission = null;
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
      active: active
        ? {
            sessionId: active.sessionId,
            meetUrl: active.meetUrl,
            startedAt: active.startedAt,
            meetProfileMode: active.meetProfileMode || "",
            browserUserDataDir: active.browserUserDataDir || "",
            realtimeRuntimePlacement: active.realtimeRuntimePlacement || "sidecar",
            realtimeSdkOwner: active.realtimeSdkOwner || "sidecar",
            realtimeSidecar: active.realtimeSidecarPage ? realtimeSidecarStatus : null,
            clickedJoinSelector: active.clickedJoinSelector || "",
            diagnosticsPath: active.diagnostics?.jsonPath || "",
            artifactsDir: active.artifactsDir || "",
            screenshots: active.diagnostics?.screenshots || [],
            avatarReady: active.avatarReady || null,
            avatarAudio: active.avatarAudio || null,
            recorder: active.recorder?.status() || null,
            realtimeAudioCapture: active.realtimeAudioCapture?.status() || null,
            realtimeRecappiAudioInput: active.realtimeRecappiAudioInput?.status() || null,
            captions: compactCaptionState(active.captions) || null,
            fixtureState: active.fixtureState || null,
            realtimeBridge: active.realtimeBridge || null,
            workerResultBridge: active.workerResultBridge || null,
            localDialog: active.localDialog || null,
            screenShare: active.screenShare || null,
            meetPage: active.meetPage || null,
            meetingAwareness: active.meetingAwareness || null,
            meetingAwarenessPush: active.meetingAwarenessPush || null,
          }
        : null,
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
