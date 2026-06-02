import { join as pathJoin } from "node:path";
import { listShareableApplications } from "./meeting-recorder.ts";
import {
  captureMacOSWindowFrame,
  listMacOSWindowCaptureTargets,
  matchesMacOSWindowCaptureTarget,
  readImageDimensions,
  startMacOSWindowCaptureStream,
} from "./macos-window-capture.ts";
import {
  DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
  DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT,
  DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH,
  buildVideoStageHtml,
  installPageDiagnostics,
  normalizeScreenShareImageUrl,
  positiveInteger,
  safeFilePart,
  saveDiagnostics,
  startLocalMultipartFrameServer,
  syntheticShareDimensionsFromSource,
  takeScreenshot,
  withTimeout,
  type AppShareInput,
  type LocalMultipartFrameServer,
  type ScreenShareBridgeInput,
  type VideoStageInput,
} from "./google-meet-joiner-base.ts";
import {
  clickFirstVisible,
  clickMeetShareScreenControl,
  collectButtonInventory,
  ensureScreenShareController,
  getMeetPresentationState,
  readScreenShareControllerState,
  waitForScreenShareImageSource,
} from "./google-meet-joiner-ui.ts";
import { evaluateMeetPageState } from "./google-meet-joiner-runtime-state.ts";
type Page = import("playwright").Page;
type MeetPageState = any;
type ScreenShareControllerState = any;

export function createGoogleMeetShareActions(ctx: any) {
  const { config, captureRef, refreshActiveRuntimeState } = ctx;

  async function listShareableApps() {
    const errors: string[] = [];
    let recappiApplications: any[] = [];
    try {
      const applications = await listShareableApplications();
      recappiApplications = applications.map((app) =>
        Object.assign({}, app, { source: app.source || "recappi_shareable_content" }),
      );
    } catch (error) {
      const message = String(error?.message || error);
      errors.push(`recappi_shareable_content: ${message}`);
      ctx.getActive()?.diagnostics?.record("shareable_apps_list_error", { error: message });
    }
    let macOSApplications: any[] = [];
    try {
      const macOS = await listMacOSWindowCaptureTargets({
        keepProcessIds: [captureRef.current?.stream?.processId],
      });
      macOSApplications = macOS.applications || [];
    } catch (error) {
      const message = String(error?.message || error);
      errors.push(`macos_screencapturekit: ${message}`);
      ctx.getActive()?.diagnostics?.record("macos_window_capture_list_error", { error: message });
    }
    const seen = new Set<string>();
    const applications = [...macOSApplications, ...recappiApplications].filter((app) => {
      const key = [
        app.source || "",
        app.windowId || app.windowID || "",
        app.processId || app.pid || "",
        app.bundleIdentifier || "",
        app.applicationName || app.name || app.title || "",
      ].join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    ctx.getActive()?.diagnostics?.record("shareable_apps_listed", {
      count: applications.length,
      source: macOSApplications.length ? "macos_screencapturekit" : "recappi_shareable_content",
      errors,
    });
    await saveDiagnostics(ctx.getActive()?.diagnostics).catch(() => {});
    if (!applications.length && errors.length) {
      await saveDiagnostics(ctx.getActive()?.diagnostics).catch(() => {});
      return {
        ok: false,
        error: "shareable_apps_unavailable",
        detail: errors.join("; "),
        source: "macos_screencapturekit",
      };
    }
    return {
      ok: true,
      source: macOSApplications.length ? "macos_screencapturekit" : "recappi_shareable_content",
      count: applications.length,
      applications,
      errors,
    };
  }

  function stopActiveMacWindowCapture(reason = "replace_window_capture") {
    if (!captureRef.current) return { ok: true, stopped: false, reason };
    captureRef.current.stop(reason);
    const window = captureRef.current.window;
    captureRef.current = null;
    ctx.getActive()?.diagnostics?.record("macos_window_capture_stop", { reason, window });
    return { ok: true, stopped: true, reason, window };
  }

  function macWindowFramePath(app: any, frame: number) {
    const captureDir = pathJoin(
      ctx.getActive()?.artifactsDir || config.dataDir,
      "screen-share-capture",
    );
    const appPart = safeFilePart(app.applicationName || app.name || app.title || "app");
    const windowPart = safeFilePart(app.windowId || app.windowID || app.processId || "window");
    return pathJoin(captureDir, `${appPart}-${windowPart}-${String(frame).padStart(4, "0")}.png`);
  }

  function macWindowLatestFramePath(app: any) {
    const captureDir = pathJoin(
      ctx.getActive()?.artifactsDir || config.dataDir,
      "screen-share-capture",
    );
    const appPart = safeFilePart(app.applicationName || app.name || app.title || "app");
    const windowPart = safeFilePart(app.windowId || app.windowID || app.processId || "window");
    return pathJoin(captureDir, `${appPart}-${windowPart}-latest.jpg`);
  }

  async function captureMacWindowToSynthetic(app: any, input: AppShareInput, frame: number) {
    const windowId = Number(app.windowId || app.windowID || 0) || 0;
    if (!windowId) throw new Error("macos_window_id_required");
    const framePath = macWindowFramePath(app, frame);
    const capture = await captureMacOSWindowFrame({
      windowId,
      outputPath: framePath,
      timeoutMs: 2500,
    });
    const dimensions = syntheticShareDimensionsFromSource(input, {
      width: capture.width,
      height: capture.height,
      frame: app.frame,
    });
    const update = await startScreenShare({
      ...input,
      title: input.title || `Share ${app.applicationName || app.name || "application"}`,
      subtitle:
        input.subtitle ||
        `${app.title || app.applicationName || "Mac window"} via synthetic capture`,
      imagePath: capture.output || framePath,
      framePath: capture.output || framePath,
      width: dimensions.width,
      height: dimensions.height,
      preview: input.preview,
    });
    return { capture, update, framePath, dimensions };
  }

  function startMacWindowOneShotCaptureLoop(
    app: any,
    input: AppShareInput,
    firstFrame: number,
    fallbackReason = "",
  ) {
    const fps = Math.max(
      1,
      Math.min(
        30,
        positiveInteger(input.fps ?? input.screenShareFps) || DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
      ),
    );
    const intervalMs = Math.max(16, Math.round(1000 / fps));
    let frame = firstFrame;
    let busy = false;
    const tick = async () => {
      if (busy || !captureRef.current || captureRef.current.stopped) return;
      busy = true;
      frame += 1;
      try {
        const result = await captureMacWindowToSynthetic(app, input, frame);
        ctx.getActive()?.diagnostics?.record("macos_window_capture_frame", {
          frame,
          window: app,
          output: result.capture.output,
          sourceWidth: result.capture.width || null,
          sourceHeight: result.capture.height || null,
          width: result.dimensions.width,
          height: result.dimensions.height,
          updateOk: result.update?.ok,
        });
      } catch (error) {
        ctx.getActive()?.diagnostics?.record("macos_window_capture_frame_error", {
          frame,
          window: app,
          error: String(error?.message || error),
        });
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, intervalMs);
    captureRef.current = {
      timer,
      stopped: false,
      window: app,
      stop: () => {
        if (timer) clearInterval(timer);
        if (captureRef.current) captureRef.current.stopped = true;
      },
    };
    ctx.getActive()?.diagnostics?.record("macos_window_capture_loop_started", {
      window: app,
      intervalMs,
      fps,
      width: input.width || null,
      height: input.height || null,
      fallbackReason,
    });
    return {
      ok: true,
      source: "macos_screencapturekit",
      backend: "screencapturekit_oneshot",
      intervalMs,
      fps,
      fallbackReason,
      window: app,
    };
  }

  async function startMacWindowCaptureLoop(app: any, input: AppShareInput, firstFrame: number) {
    stopActiveMacWindowCapture("replace_window_capture");
    const fps = Math.max(
      1,
      Math.min(
        30,
        positiveInteger(input.fps ?? input.screenShareFps) || DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
      ),
    );
    const intervalMs = Math.max(16, Math.round(1000 / fps));
    const windowId = Number(app.windowId || app.windowID || 0) || 0;
    const outputPath = macWindowLatestFramePath(app);
    let stream: Awaited<ReturnType<typeof startMacOSWindowCaptureStream>>;
    try {
      stream = await startMacOSWindowCaptureStream({
        windowId,
        outputPath,
        fps,
        timeoutMs: 3000,
      });
    } catch (error) {
      const fallbackReason = String(error?.message || error);
      ctx.getActive()?.diagnostics?.record("macos_window_capture_stream_fallback", {
        window: app,
        error: fallbackReason,
      });
      return startMacWindowOneShotCaptureLoop(app, input, firstFrame, fallbackReason);
    }

    let mjpeg: LocalMultipartFrameServer;
    try {
      mjpeg = await startLocalMultipartFrameServer({ framePath: outputPath, fps });
    } catch (error) {
      stream.stop();
      const fallbackReason = String(error?.message || error);
      ctx.getActive()?.diagnostics?.record("macos_window_capture_mjpeg_fallback", {
        window: app,
        output: outputPath,
        error: fallbackReason,
      });
      return startMacWindowOneShotCaptureLoop(app, input, firstFrame, fallbackReason);
    }
    const dimensions = syntheticShareDimensionsFromSource(input, {
      ...readImageDimensions(outputPath),
      width: stream.width,
      height: stream.height,
      frame: app.frame,
    });
    const update = await startScreenShare({
      ...input,
      title: input.title || `Share ${app.applicationName || app.name || "application"}`,
      subtitle:
        input.subtitle ||
        `${app.title || app.applicationName || "Mac window"} via synthetic capture`,
      imageUrl: mjpeg.url,
      width: dimensions.width,
      height: dimensions.height,
      preview: input.preview,
    });
    if (!update?.ok) {
      mjpeg.stop();
      stream.stop();
      return startMacWindowOneShotCaptureLoop(
        app,
        input,
        firstFrame,
        String(update?.error || "mjpeg_screen_share_start_failed"),
      );
    }
    captureRef.current = {
      timer: null,
      stopped: false,
      window: app,
      stream,
      mjpeg,
      stop: () => {
        mjpeg.stop();
        stream.stop();
        if (captureRef.current) captureRef.current.stopped = true;
      },
    };
    ctx.getActive()?.diagnostics?.record("macos_window_capture_loop_started", {
      backend: "screencapturekit_stream_multipart",
      window: app,
      intervalMs,
      fps,
      frameTransport: "local_multipart",
      frameContentType: "image/jpeg",
      frameUrl: mjpeg.url,
      processId: stream.processId || null,
      output: outputPath,
      sourceWidth: stream.width || null,
      sourceHeight: stream.height || null,
      width: dimensions.width,
      height: dimensions.height,
      updateOk: update.ok,
    });
    return {
      ok: true,
      source: "macos_screencapturekit",
      backend: "screencapturekit_stream_multipart",
      intervalMs,
      fps,
      output: outputPath,
      frameUrl: mjpeg.url,
      processId: stream.processId || null,
      update,
      window: app,
    };
  }

  function matchesShareableApp(app, input: AppShareInput) {
    const hasStableTarget =
      Number(input.windowId || input.windowID || 0) ||
      Number(input.processId || input.pid || 0) ||
      String(input.bundleIdentifier || input.bundleId || "").trim();
    if (hasStableTarget) return matchesMacOSWindowCaptureTarget(app, input);
    if (matchesMacOSWindowCaptureTarget(app, input)) return true;
    const windowTitle = String(input.windowTitle || "")
      .trim()
      .toLowerCase();
    if (
      windowTitle &&
      String(app.title || app.name || "")
        .trim()
        .toLowerCase()
        .includes(windowTitle)
    )
      return true;
    const processId = Number(input.processId || input.pid || 0) || 0;
    const bundle = String(input.bundleIdentifier || input.bundleId || "")
      .trim()
      .toLowerCase();
    const name = String(input.applicationName || input.appName || input.name || "")
      .trim()
      .toLowerCase();
    if (processId && Number(app.processId || 0) === processId) return true;
    if (
      bundle &&
      String(app.bundleIdentifier || "")
        .trim()
        .toLowerCase() === bundle
    )
      return true;
    if (!name) return false;
    return [app.applicationName, app.name, app.title]
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .some((candidate) => candidate === name || candidate.includes(name));
  }

  function activeMeetPage(): { ok: true; page: Page } | { ok: false; error: string } {
    if (!ctx.getActive()?.page) return { ok: false, error: "no_active_join" };
    if (ctx.getActive().page.isClosed()) return { ok: false, error: "meet_page_closed" };
    return { ok: true, page: ctx.getActive().page };
  }

  function meetPageUnavailable(meetPage?: MeetPageState | null) {
    if (!meetPage || meetPage.ok !== false) return false;
    return /target page, context or browser has been closed|target page has been closed|context has been closed|browser has been closed/i.test(
      String(meetPage.error || ""),
    );
  }

  function screenSharePostcheck() {
    if (meetPageUnavailable(ctx.getActive()?.meetPage)) {
      return { ok: false, error: "meet_page_closed", meetPage: ctx.getActive()?.meetPage || null };
    }
    if (!ctx.getActive()?.screenShare?.active) {
      return {
        ok: false,
        error: "screen_share_not_active_after_present",
        meetPage: ctx.getActive()?.meetPage || null,
        screenShare: ctx.getActive()?.screenShare || null,
      };
    }
    return {
      ok: true,
      meetPage: ctx.getActive()?.meetPage || null,
      screenShare: ctx.getActive()?.screenShare || null,
    };
  }

  async function presentAppShare(input: AppShareInput = {}) {
    const ready = activeMeetPage();
    if ("error" in ready) return { ok: false, error: ready.error };
    await refreshActiveRuntimeState();
    if (meetPageUnavailable(ctx.getActive()?.meetPage)) {
      return { ok: false, error: "meet_page_closed", meetPage: ctx.getActive()?.meetPage || null };
    }
    const beforePresentation = await getMeetPresentationState(ready.page);
    const replaceExistingShare = Boolean(
      ctx.getActive()?.screenShare?.active || beforePresentation.presenting,
    );
    const listed = await listShareableApps();
    if (!listed.ok) return listed;
    const applications = Array.isArray(listed.applications) ? listed.applications : [];
    const app = applications.find((candidate) => matchesShareableApp(candidate, input));
    if (!app) {
      return {
        ok: false,
        error: "shareable_app_not_found",
        source: listed.source,
        count: applications.length,
        candidates: applications.slice(0, 20),
      };
    }
    const previousCaptureStop = stopActiveMacWindowCapture("replace_window_capture");
    const title = input.title || `Share ${app.applicationName || app.name || "application"}`;
    const baseInput: AppShareInput = {
      ...input,
      title,
      subtitle:
        input.subtitle ||
        `${app.title || app.applicationName || "Mac window"} via synthetic capture`,
    };
    const firstFrame = await captureMacWindowToSynthetic(app, baseInput, 1);
    const shareInput: AppShareInput = {
      ...baseInput,
      width: firstFrame.dimensions.width,
      height: firstFrame.dimensions.height,
    };
    await refreshActiveRuntimeState();
    if (meetPageUnavailable(ctx.getActive()?.meetPage)) {
      return { ok: false, error: "meet_page_closed", meetPage: ctx.getActive()?.meetPage || null };
    }
    const present = replaceExistingShare
      ? {
          ok: true,
          replaced: true,
          reason: "synthetic_share_replaced_active",
          screenShare: ctx.getActive().screenShare,
        }
      : await presentScreenShare({
          ...shareInput,
          mode: "synthetic",
          title,
          imagePath: firstFrame.capture.output,
          waitMs: input.waitMs || 2500,
          fps: shareInput.fps || shareInput.screenShareFps || DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
        });
    const loop = await startMacWindowCaptureLoop(app, shareInput, 1);
    await refreshActiveRuntimeState();
    const postcheck = screenSharePostcheck();
    const result = {
      ok: Boolean(present.ok && postcheck.ok),
      app,
      present,
      postcheck,
      beforePresentation,
      capture: {
        mode: "macos_window_to_synthetic",
        source: "macos_screencapturekit",
        backend: firstFrame.capture.captureBackend || "screencapturekit",
        appPixelsAutomaticallySelected: true,
        windowId: app.windowId || app.windowID || 0,
        firstFrame: firstFrame.capture.output,
        sourceWidth: firstFrame.capture.width || null,
        sourceHeight: firstFrame.capture.height || null,
        width: firstFrame.dimensions.width,
        height: firstFrame.dimensions.height,
        previousCaptureStop,
        loop,
      },
      note: "app_share_started_via_synthetic_capture; Meet native picker was not used.",
    };
    ctx.getActive().diagnostics?.record("shareable_app_present_requested", {
      app,
      mode: "macos_window_to_synthetic",
      ok: result.ok,
      present,
      postcheck,
      capture: result.capture,
    });
    await saveDiagnostics(ctx.getActive().diagnostics).catch(() => {});
    return result;
  }

  async function startScreenShare(input: ScreenShareBridgeInput = {}) {
    const ready = activeMeetPage();
    if ("error" in ready) {
      return {
        ok: false,
        error: ready.error,
        screenShare: ctx.getActive()?.screenShare || null,
        fixtureState: ctx.getActive()?.fixtureState || null,
      };
    }
    const bridgeInput: ScreenShareBridgeInput = {
      ...input,
      mode: "synthetic",
      screenShareMode: "synthetic",
    };
    const imageUrl = await normalizeScreenShareImageUrl(
      bridgeInput.imageUrl || bridgeInput.imagePath || bridgeInput.framePath || "",
    );
    const controller = await ensureScreenShareController(ready.page, bridgeInput);
    if (!controller.ok) {
      const result = {
        ok: false,
        error: "screen_share_controller_install_failed",
        controller,
      };
      ctx.getActive().diagnostics?.record("screen_share_start_requested", result);
      await refreshActiveRuntimeState();
      return {
        ...result,
        screenShare: ctx.getActive().screenShare || null,
        fixtureState: ctx.getActive().fixtureState || null,
      };
    }
    const result: any = await ready.page
      .evaluate(
        async (payload) => {
          if (!window.MAB_SCREEN_SHARE_CONTROLLER?.start) {
            return { ok: false, error: "screen_share_controller_missing" };
          }
          return await window.MAB_SCREEN_SHARE_CONTROLLER.start(payload);
        },
        {
          title: bridgeInput.title || "Meeting Avatar Bot",
          subtitle: bridgeInput.subtitle || "Agent screen share",
          videoUrl: bridgeInput.videoUrl || bridgeInput.url || bridgeInput.path || "",
          imageUrl,
          width:
            positiveInteger(bridgeInput.width ?? bridgeInput.screenShareWidth) ||
            DEFAULT_SYNTHETIC_SCREEN_SHARE_WIDTH,
          height:
            positiveInteger(bridgeInput.height ?? bridgeInput.screenShareHeight) ||
            DEFAULT_SYNTHETIC_SCREEN_SHARE_HEIGHT,
          fps:
            positiveInteger(bridgeInput.fps ?? bridgeInput.screenShareFps) ||
            DEFAULT_SYNTHETIC_SCREEN_SHARE_FPS,
          preview: Boolean(bridgeInput.preview),
        },
      )
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    const imageSourcePostcheck: {
      ok: boolean;
      error?: string;
      state?: ScreenShareControllerState | null;
    } = imageUrl ? await waitForScreenShareImageSource(ready.page) : { ok: true };
    if (imageUrl && !imageSourcePostcheck.ok) {
      result.ok = false;
      result.error = imageSourcePostcheck.error || "screen_share_image_source_not_attached";
    }
    ctx.getActive().diagnostics?.record("screen_share_start_requested", {
      ...result,
      controllerInstalled: controller.installed,
      controllerState: controller.state || null,
      imageSourcePostcheck,
    });
    await refreshActiveRuntimeState();
    if (meetPageUnavailable(ctx.getActive()?.meetPage)) {
      return {
        ...result,
        ok: false,
        error: "meet_page_closed",
        meetPage: ctx.getActive()?.meetPage || null,
        screenShare: ctx.getActive().screenShare || null,
        fixtureState: ctx.getActive().fixtureState || null,
      };
    }
    return {
      ...result,
      screenShare: ctx.getActive().screenShare || null,
      fixtureState: ctx.getActive().fixtureState || null,
    };
  }

  async function presentScreenShare(input: ScreenShareBridgeInput = {}) {
    const ready = activeMeetPage();
    if ("error" in ready) return { ok: false, error: ready.error };
    const bridgeInput: ScreenShareBridgeInput = {
      ...input,
      mode: "synthetic",
      screenShareMode: "synthetic",
    };
    const meetPage = await evaluateMeetPageState(ready.page);
    if (meetPageUnavailable(meetPage)) {
      return { ok: false, error: "meet_page_closed", mode: "synthetic", meetPage };
    }
    const beforePresentation = await getMeetPresentationState(ready.page);
    const beforeButtons = await collectButtonInventory(
      ready.page,
      ctx.getActive().diagnostics,
      "before-synthetic-present",
    );
    ctx.getActive().diagnostics?.record("screen_share_present_start", {
      inputMode: "synthetic",
      requestedMode: input.mode || input.screenShareMode || "",
      waitMs: bridgeInput.waitMs || 0,
      meetPage,
      beforePresentation,
      beforeButtons: beforeButtons.slice(0, 30),
    });
    await saveDiagnostics(ctx.getActive().diagnostics).catch(() => {});
    if (!meetPage.inMeeting) {
      ctx.getActive().diagnostics?.record("screen_share_present_blocked", {
        reason: meetPage.signIn ? "google_sign_in_required" : "not_in_meeting",
        meetPage,
        beforePresentation,
      });
      await saveDiagnostics(ctx.getActive().diagnostics).catch(() => {});
      return {
        ok: false,
        error: meetPage.signIn ? "google_sign_in_required" : "not_in_meeting",
        mode: "synthetic",
        meetPage,
        presentation: beforePresentation,
        buttons: beforeButtons.slice(0, 30),
      };
    }
    const controllerBefore = await readScreenShareControllerState(ready.page);
    const start = await startScreenShare(bridgeInput);
    const clickedSelector = await clickMeetShareScreenControl(
      ready.page,
      ctx.getActive().diagnostics,
      {
        allowCoordinateFallback: Boolean(bridgeInput.allowCoordinateFallback),
      },
    );
    if (!clickedSelector) {
      const afterMissPresentation = await getMeetPresentationState(ready.page);
      ctx.getActive().diagnostics?.record("screen_share_present_blocked", {
        reason: "share_screen_button_not_found",
        start,
        afterMissPresentation,
      });
      await saveDiagnostics(ctx.getActive().diagnostics).catch(() => {});
      return {
        ok: false,
        error: "share_screen_button_not_found",
        mode: "synthetic",
        start,
        presentation: afterMissPresentation,
        screenShare: ctx.getActive().screenShare || null,
        fixtureState: ctx.getActive().fixtureState || null,
      };
    }
    const afterClickPresentation = await getMeetPresentationState(ready.page);
    ctx.getActive().diagnostics?.record("screen_share_present_clicked", {
      nativeMode: false,
      controllerBefore,
      clickedSelector,
      start,
      afterClickPresentation,
    });
    await saveDiagnostics(ctx.getActive().diagnostics).catch(() => {});
    await clickFirstVisible(
      ready.page,
      [
        "text=/Your entire screen/i",
        "text=/Entire screen/i",
        "text=/A window/i",
        "text=/A tab/i",
        'button:has-text("Share")',
      ],
      700,
      ctx.getActive().diagnostics,
    );
    await ready.page.waitForTimeout(Number(bridgeInput.waitMs || 3000));
    let screenshot = "";
    try {
      screenshot = await takeScreenshot(
        ready.page,
        ctx.getActive().diagnostics,
        "screen-share-present-click",
      );
    } catch (error) {
      ctx.getActive().diagnostics?.record("screen_share_present_screenshot_error", {
        error: String(error?.message || error),
      });
    }
    const buttons = await collectButtonInventory(
      ready.page,
      ctx.getActive().diagnostics,
      "after-screen-share-present-click",
    );
    await refreshActiveRuntimeState();
    const postcheck = screenSharePostcheck();
    ctx.getActive().diagnostics?.record("screen_share_present_requested", {
      start,
      clickedSelector,
      screenshot,
      postcheck,
    });
    await saveDiagnostics(ctx.getActive().diagnostics).catch(() => {});
    return {
      ok: Boolean(start.ok && clickedSelector && postcheck.ok),
      error: postcheck.ok ? undefined : postcheck.error,
      start,
      clickedSelector,
      screenshot,
      postcheck,
      visibleButtonLabels: buttons
        .filter((button) => button.visible)
        .map((button) => button.aria || button.text || "")
        .filter(Boolean),
      screenShare: ctx.getActive().screenShare || null,
      fixtureState: ctx.getActive().fixtureState || null,
    };
  }

  async function openVideoStage(input: VideoStageInput = {}) {
    if (!ctx.getActive()?.context) return { ok: false, error: "no_active_join" };
    if (ctx.getActive().stagePage && !ctx.getActive().stagePage.isClosed()) {
      await ctx
        .getActive()
        .stagePage.close()
        .catch(() => {});
    }
    const stagePage = await ctx.getActive().context.newPage();
    ctx.getActive().stagePage = stagePage;
    installPageDiagnostics(stagePage, ctx.getActive().diagnostics);
    const html = buildVideoStageHtml(input);
    await stagePage.setContent(html, { waitUntil: "domcontentloaded" });
    await stagePage
      .setViewportSize({
        width: Number(input.width || 1280),
        height: Number(input.height || 720),
      })
      .catch(() => {});
    await stagePage.waitForTimeout(500);
    const stage = await withTimeout(
      stagePage.evaluate(() => window.MAB_VIDEO_STAGE || null),
      2500,
      null,
    ).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    ctx.getActive().diagnostics?.record("video_stage_opened", {
      title: input.stageTitle || input.title || "Meeting Avatar Bot",
      videoUrl: input.videoUrl || input.url || input.path || "",
      stage,
    });
    await saveDiagnostics(ctx.getActive().diagnostics).catch(() => {});
    return {
      ok: true,
      title: await stagePage.title().catch(() => ""),
      url: stagePage.url(),
      stage,
    };
  }

  async function presentVideoStage(input: ScreenShareBridgeInput = {}) {
    const ready = activeMeetPage();
    if ("error" in ready) return { ok: false, error: ready.error };
    const stage = await openVideoStage({
      ...input,
      stageTitle: input.stageTitle || "Meeting Avatar Bot",
    });
    if (!stage.ok) return stage;
    const presentationMode = "synthetic";
    const syntheticController = await ensureScreenShareController(ready.page, {
      ...input,
      mode: "synthetic",
      title: input.title || "Onee Sama video stage",
      subtitle: input.subtitle || "Shared by Onee Sama",
      fps: input.fps || 30,
    });
    await ready.page.bringToFront().catch(() => {});
    const present = await presentScreenShare({
      ...input,
      mode: presentationMode,
      waitMs: input.waitMs || 2500,
    });
    return {
      ok: Boolean(stage.ok && present.ok),
      stage,
      syntheticController,
      present,
      note: "video_stage_tab_opened; synthetic Meet screen-share stream was requested",
    };
  }

  async function stopScreenShare() {
    const ready = activeMeetPage();
    if ("error" in ready) {
      return {
        ok: false,
        error: ready.error,
        screenShare: ctx.getActive()?.screenShare || null,
        fixtureState: ctx.getActive()?.fixtureState || null,
      };
    }
    const captureStop = stopActiveMacWindowCapture("screen_share_stop");
    const result = await ready.page
      .evaluate(async () => {
        if (!window.MAB_SCREEN_SHARE_CONTROLLER?.stop) {
          return { ok: false, error: "screen_share_controller_missing" };
        }
        return await window.MAB_SCREEN_SHARE_CONTROLLER.stop();
      })
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    ctx.getActive().diagnostics?.record("screen_share_stop_requested", { ...result, captureStop });
    await refreshActiveRuntimeState();
    return {
      ...result,
      screenShare: ctx.getActive().screenShare || null,
      fixtureState: ctx.getActive().fixtureState || null,
    };
  }

  return {
    listShareableApps,
    presentAppShare,
    startScreenShare,
    presentScreenShare,
    openVideoStage,
    presentVideoStage,
    stopScreenShare,
    stopActiveMacWindowCapture,
  };
}
