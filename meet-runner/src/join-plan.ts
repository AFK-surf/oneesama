import type { PrepareJoinParams } from "./types.ts";

export type BrowserIslandOptions = {
  allowNonGoogleMeet: boolean;
  collectFixtureState: boolean;
  captureCaptions: boolean;
  captionLanguage: string;
  recordMeeting: boolean;
  artifactsDir: string;
  meetAudioBackend: string;
  installRealtimeBridge: boolean;
  installLocalDialogBridge: boolean;
  installWorkerResultBridge: boolean;
  installScreenShareBridge: boolean;
  autoStartScreenShare: boolean;
};

export function normalizeBrowserIslandOptions(params: PrepareJoinParams): BrowserIslandOptions {
  return {
    allowNonGoogleMeet: Boolean(params.allow_non_google_meet),
    collectFixtureState: Boolean(params.collect_fixture_state),
    captureCaptions: Boolean(params.capture_captions),
    captionLanguage: typeof params.caption_language === "string" ? params.caption_language.trim() : "",
    recordMeeting: Boolean(params.record_meeting),
    artifactsDir: typeof params.artifacts_dir === "string" ? params.artifacts_dir.trim() : "",
    meetAudioBackend: typeof params.meet_audio_backend === "string" ? params.meet_audio_backend.trim() : "",
    installRealtimeBridge: Boolean(params.install_realtime_bridge),
    installLocalDialogBridge: Boolean(params.install_local_dialog_bridge),
    installWorkerResultBridge: Boolean(params.install_worker_result_bridge),
    installScreenShareBridge: Boolean(params.install_screen_share_bridge),
    autoStartScreenShare: Boolean(params.auto_start_screen_share),
  };
}

export function buildPlan(params: PrepareJoinParams, meetingUrl: string) {
  const options = normalizeBrowserIslandOptions(params);
  return {
    entry: "google-meet-joiner.ts",
    mode: "playwright-ts",
    dry_run: Boolean(params.dry_run),
    display_name: typeof params.display_name === "string" ? params.display_name.trim() : "",
    allow_non_google_meet: options.allowNonGoogleMeet,
    collect_fixture_state: options.collectFixtureState,
    capture_captions: options.captureCaptions,
    caption_language: options.captionLanguage,
    record_meeting: options.recordMeeting,
    artifacts_dir: options.artifactsDir,
    meet_audio_backend: options.meetAudioBackend,
    install_realtime_bridge: options.installRealtimeBridge,
    install_local_dialog_bridge: options.installLocalDialogBridge,
    install_worker_result_bridge: options.installWorkerResultBridge,
    install_screen_share_bridge: options.installScreenShareBridge,
    auto_start_screen_share: options.autoStartScreenShare,
    meet_url: meetingUrl,
  };
}
