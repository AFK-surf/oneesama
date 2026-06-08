import type { RealtimeCurrentUser } from "../realtime/realtime-contract.ts";
import { enableMeetCaptions, installMeetCaptionCapture } from "./caption-capture.ts";
import {
  saveDiagnostics,
  type Diagnostics,
  type GoogleMeetJoinInput,
} from "./google-meet-joiner-base.ts";
import { mergeMeetSurfaceAudioOutputState } from "./google-meet-joiner-realtime-status.ts";
import {
  buildMeetingAwarenessState,
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
  logMeetingAwarenessDebug,
  meetingAwarenessSignature,
  openMeetPeoplePanelForAwareness,
  publishMeetingAwarenessToPage,
  startAvatarRenderer,
} from "./google-meet-joiner-runtime-state.ts";
import { ensureMeetCameraOff } from "./meet-camera-controls.ts";
import * as audio from "./meeting-audio-inputs.ts";

interface CompleteGoogleMeetJoinRuntimeInput {
  active: any;
  context: any;
  page: import("playwright").Page;
  input: GoogleMeetJoinInput;
  installAvatar: boolean;
  clicked: string;
  admission: any;
  captureCaptions: boolean;
  artifactsDir: string;
  diagnostics: Diagnostics;
  captionLanguage: string;
  realtimeRecappiAudioInput: any;
  recordMeeting: boolean;
  recorder: any;
  installScreenShareBridge: boolean;
  autoStartScreenShare: boolean;
  sessionId: string;
  realtimeCurrentUser: RealtimeCurrentUser;
  getRealtimeControlPage: () => import("playwright").Page;
}

export async function completeGoogleMeetJoinRuntime({
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
}: CompleteGoogleMeetJoinRuntimeInput) {
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
  const nextActive = {
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
  nextActive.lastMeetingAwarenessSignature = "";
  const realtimeControlPage = getRealtimeControlPage();
  nextActive.meetingAwarenessPush = await publishMeetingAwarenessToPage(
    realtimeControlPage,
    meetingAwareness,
  );
  nextActive.meetingAwarenessSurfaceStore = await publishMeetingAwarenessToPage(
    page,
    meetingAwareness,
    false,
  );
  logMeetingAwarenessDebug("join_complete", meetingAwareness, nextActive.meetingAwarenessPush);
  if (nextActive.meetingAwarenessPush?.pushed) {
    nextActive.lastMeetingAwarenessSignature = meetingAwarenessSignature(meetingAwareness);
    diagnostics.record("meeting_awareness_push", nextActive.meetingAwarenessPush);
    await saveDiagnostics(diagnostics).catch(() => {});
  }
  return {
    active: nextActive,
    avatarReady,
    avatarAudio,
    fixtureState,
    localDialog,
    screenShare,
    meetPage,
    captions,
    compactCaptions: compactCaptionState(captions),
    meetingAwareness,
    screenShareStart,
  };
}

interface RefreshGoogleMeetJoinerRuntimeStateInput {
  active: any;
  realtimeControlPage: import("playwright").Page;
  realtimeCurrentUser: RealtimeCurrentUser;
}

export async function refreshGoogleMeetJoinerRuntimeState({
  active,
  realtimeControlPage,
  realtimeCurrentUser,
}: RefreshGoogleMeetJoinerRuntimeStateInput): Promise<void> {
  if (!active?.page) return;
  const [
    avatarReady,
    avatarAudio,
    fixtureState,
    initialRealtimeBridge,
    meetSurfaceRealtimeBridge,
    workerResultBridge,
    localDialog,
    screenShare,
    captions,
    initialMeetPage,
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
  const realtimeBridge = mergeMeetSurfaceAudioOutputState(
    initialRealtimeBridge,
    meetSurfaceRealtimeBridge || initialRealtimeBridge,
  );
  let meetPage = initialMeetPage;
  if (meetPage.inMeeting && !active.peoplePanelAwarenessAttempted) {
    active.peoplePanelAwarenessAttempted = true;
    await openMeetPeoplePanelForAwareness(active.page, active.diagnostics);
    meetPage = await evaluateMeetPageState(active.page);
  }
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
  logMeetingAwarenessDebug("runtime_state_refresh", meetingAwareness, active.meetingAwarenessPush);
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
