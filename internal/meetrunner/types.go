package meetrunner

import "context"

type Runner interface {
	Ping(ctx context.Context) (RunnerStatus, error)
	PrepareGoogleMeet(ctx context.Context, input PrepareGoogleMeetInput) (PrepareGoogleMeetResult, error)
	StatusSession(ctx context.Context, input StatusSessionInput) (StatusSessionResult, error)
	StopSession(ctx context.Context, input StopSessionInput) (StopSessionResult, error)
	InjectWorkerResult(ctx context.Context, input WorkerResultInput) (WorkerResultDelivery, error)
	StartScreenShare(ctx context.Context, input ScreenShareInput) (ScreenShareResult, error)
	PresentScreenShare(ctx context.Context, input ScreenShareInput) (ScreenShareResult, error)
	PresentVideoStage(ctx context.Context, input VideoStageInput) (ScreenShareResult, error)
	StopScreenShare(ctx context.Context, input ScreenShareInput) (ScreenShareResult, error)
}

type RunnerStatus struct {
	OK           bool     `json:"ok"`
	Name         string   `json:"name"`
	Entry        string   `json:"entry,omitempty"`
	BridgeMode   string   `json:"bridge_mode,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
}

type PrepareGoogleMeetInput struct {
	SessionID                  string `json:"session_id,omitempty"`
	MeetingURL                 string `json:"meeting_url"`
	DisplayName                string `json:"display_name,omitempty"`
	Title                      string `json:"title,omitempty"`
	DryRun                     bool   `json:"dry_run"`
	AllowNonGoogleMeet         bool   `json:"allow_non_google_meet,omitempty"`
	CollectFixtureState        bool   `json:"collect_fixture_state,omitempty"`
	CaptureCaptions            bool   `json:"capture_captions,omitempty"`
	CaptionLanguage            string `json:"caption_language,omitempty"`
	RecordMeeting              bool   `json:"record_meeting,omitempty"`
	ArtifactsDir               string `json:"artifacts_dir,omitempty"`
	MeetAudioBackend           string `json:"meet_audio_backend,omitempty"`
	InstallAvatar              bool   `json:"install_avatar,omitempty"`
	DisableLive2D              bool   `json:"disable_live2d,omitempty"`
	InstallRealtimeBridge      bool   `json:"install_realtime_bridge,omitempty"`
	RealtimeBridgeMode         string `json:"realtime_bridge_mode,omitempty"`
	AutoConnectRealtime        bool   `json:"auto_connect_realtime,omitempty"`
	SendRealtimeSessionUpdate  bool   `json:"send_realtime_session_update,omitempty"`
	IncludeParticipantAudio    bool   `json:"include_participant_audio,omitempty"`
	ForwardMeetAudioToRealtime bool   `json:"forward_meet_audio_to_realtime,omitempty"`
	RealtimeFallbackToLocalMic bool   `json:"realtime_fallback_to_local_mic,omitempty"`
	InstallLocalDialogBridge   bool   `json:"install_local_dialog_bridge,omitempty"`
	InstallWorkerResultBridge  bool   `json:"install_worker_result_bridge,omitempty"`
	InstallScreenShareBridge   bool   `json:"install_screen_share_bridge,omitempty"`
	AutoStartScreenShare       bool   `json:"auto_start_screen_share,omitempty"`
	WorkerPollURL              string `json:"worker_poll_url,omitempty"`
	WorkerResultMinCreatedAt   string `json:"worker_result_min_created_at,omitempty"`
	WorkerDelegateURL          string `json:"worker_delegate_url,omitempty"`
	WorkerStatusURL            string `json:"worker_status_url,omitempty"`
	LocalDialogTurnURL         string `json:"local_dialog_turn_url,omitempty"`
	LocalDialogTTSURL          string `json:"local_dialog_tts_url,omitempty"`
	LocalDialogTTSMode         string `json:"local_dialog_tts_mode,omitempty"`
	LocalDialogTTSProvider     string `json:"local_dialog_tts_provider,omitempty"`
	LocalDialogTTSGain         string `json:"local_dialog_tts_gain,omitempty"`
	ScreenShareMode            string `json:"screen_share_mode,omitempty"`
	ScreenShareTitle           string `json:"screen_share_title,omitempty"`
	ScreenShareSubtitle        string `json:"screen_share_subtitle,omitempty"`
	ScreenShareWidth           int    `json:"screen_share_width,omitempty"`
	ScreenShareHeight          int    `json:"screen_share_height,omitempty"`
	ScreenShareFPS             int    `json:"screen_share_fps,omitempty"`
	BrowserExtraArgs           string `json:"browser_extra_args,omitempty"`
}

type RunnerSession struct {
	ID         string `json:"id"`
	MeetingURL string `json:"meeting_url,omitempty"`
	Status     string `json:"status,omitempty"`
	Title      string `json:"title,omitempty"`
	UpdatedAt  string `json:"updated_at,omitempty"`
}

type JoinPlan struct {
	Entry                      string `json:"entry"`
	Mode                       string `json:"mode"`
	DryRun                     bool   `json:"dry_run"`
	DisplayName                string `json:"display_name,omitempty"`
	AllowNonGoogleMeet         bool   `json:"allow_non_google_meet,omitempty"`
	CollectFixtureState        bool   `json:"collect_fixture_state,omitempty"`
	CaptureCaptions            bool   `json:"capture_captions,omitempty"`
	CaptionLanguage            string `json:"caption_language,omitempty"`
	RecordMeeting              bool   `json:"record_meeting,omitempty"`
	ArtifactsDir               string `json:"artifacts_dir,omitempty"`
	MeetAudioBackend           string `json:"meet_audio_backend,omitempty"`
	InstallAvatar              bool   `json:"install_avatar,omitempty"`
	DisableLive2D              bool   `json:"disable_live2d,omitempty"`
	InstallRealtimeBridge      bool   `json:"install_realtime_bridge,omitempty"`
	RealtimeBridgeMode         string `json:"realtime_bridge_mode,omitempty"`
	AutoConnectRealtime        bool   `json:"auto_connect_realtime,omitempty"`
	SendRealtimeSessionUpdate  bool   `json:"send_realtime_session_update,omitempty"`
	IncludeParticipantAudio    bool   `json:"include_participant_audio,omitempty"`
	ForwardMeetAudioToRealtime bool   `json:"forward_meet_audio_to_realtime,omitempty"`
	RealtimeFallbackToLocalMic bool   `json:"realtime_fallback_to_local_mic,omitempty"`
	InstallLocalDialogBridge   bool   `json:"install_local_dialog_bridge,omitempty"`
	InstallWorkerResultBridge  bool   `json:"install_worker_result_bridge,omitempty"`
	InstallScreenShareBridge   bool   `json:"install_screen_share_bridge,omitempty"`
	AutoStartScreenShare       bool   `json:"auto_start_screen_share,omitempty"`
}

type PrepareGoogleMeetResult struct {
	OK         bool          `json:"ok"`
	Accepted   bool          `json:"accepted"`
	Started    bool          `json:"started"`
	BridgeMode string        `json:"bridge_mode,omitempty"`
	Note       string        `json:"note,omitempty"`
	Session    RunnerSession `json:"session"`
	Plan       JoinPlan      `json:"plan"`
}

type StopSessionInput struct {
	SessionID string `json:"session_id"`
	Reason    string `json:"reason,omitempty"`
}

type StatusSessionInput struct {
	SessionID string `json:"session_id,omitempty"`
}

type StatusSessionResult struct {
	OK      bool           `json:"ok"`
	Active  any            `json:"active,omitempty"`
	Session *RunnerSession `json:"session,omitempty"`
}

type StopSessionResult struct {
	OK        bool          `json:"ok"`
	Session   RunnerSession `json:"session"`
	StoppedAt string        `json:"stopped_at,omitempty"`
	Reason    string        `json:"reason,omitempty"`
	Runtime   any           `json:"runtime,omitempty"`
}

type WorkerResultInput struct {
	SessionID string `json:"session_id,omitempty"`
	Job       any    `json:"job"`
}

type WorkerResultDelivery struct {
	OK                 bool   `json:"ok"`
	Channel            string `json:"channel,omitempty"`
	Delivery           any    `json:"delivery,omitempty"`
	RealtimeBridge     any    `json:"realtimeBridge,omitempty"`
	WorkerResultBridge any    `json:"workerResultBridge,omitempty"`
	Error              string `json:"error,omitempty"`
}

type ScreenShareInput struct {
	SessionID string `json:"session_id,omitempty"`
	Title     string `json:"title,omitempty"`
	Subtitle  string `json:"subtitle,omitempty"`
	Preview   bool   `json:"preview,omitempty"`
	Mode      string `json:"mode,omitempty"`
	WaitMs    int    `json:"waitMs,omitempty"`
}

type VideoStageInput struct {
	ScreenShareInput
	VideoURL   string `json:"videoUrl,omitempty"`
	URL        string `json:"url,omitempty"`
	Path       string `json:"path,omitempty"`
	StageTitle string `json:"stageTitle,omitempty"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	Muted      bool   `json:"muted,omitempty"`
}

type ScreenShareResult map[string]any
