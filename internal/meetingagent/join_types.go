package meetingagent

import (
	"github.com/AFK-surf/oneesama/internal/meetrunner"
	"github.com/AFK-surf/oneesama/internal/postmeeting"
)

type JoinGoogleMeetRequest struct {
	SessionID                  string  `json:"session_id,omitempty"`
	MeetingID                  string  `json:"meeting_id,omitempty"`
	MeetingURL                 string  `json:"meeting_url"`
	DisplayName                string  `json:"display_name,omitempty"`
	Title                      string  `json:"title,omitempty"`
	DryRun                     bool    `json:"dry_run"`
	AllowNonGoogleMeet         bool    `json:"allow_non_google_meet,omitempty"`
	CollectFixtureState        bool    `json:"collect_fixture_state,omitempty"`
	CaptureCaptions            bool    `json:"capture_captions,omitempty"`
	CaptionLanguage            string  `json:"caption_language,omitempty"`
	RecordMeeting              bool    `json:"record_meeting,omitempty"`
	ArtifactsDir               string  `json:"artifacts_dir,omitempty"`
	MeetAudioBackend           string  `json:"meet_audio_backend,omitempty"`
	InstallRealtimeBridge      bool    `json:"install_realtime_bridge,omitempty"`
	RealtimeBridgeMode         string  `json:"realtime_bridge_mode,omitempty"`
	AutoConnectRealtime        bool    `json:"auto_connect_realtime,omitempty"`
	SendRealtimeSessionUpdate  bool    `json:"send_realtime_session_update,omitempty"`
	IncludeParticipantAudio    bool    `json:"include_participant_audio,omitempty"`
	ForwardMeetAudioToRealtime bool    `json:"forward_meet_audio_to_realtime,omitempty"`
	RealtimeFallbackToLocalMic bool    `json:"realtime_fallback_to_local_mic,omitempty"`
	InstallLocalDialogBridge   bool    `json:"install_local_dialog_bridge,omitempty"`
	InstallWorkerResultBridge  bool    `json:"install_worker_result_bridge,omitempty"`
	InstallScreenShareBridge   bool    `json:"install_screen_share_bridge,omitempty"`
	AutoStartScreenShare       bool    `json:"auto_start_screen_share,omitempty"`
	WorkerPollURL              string  `json:"worker_poll_url,omitempty"`
	WorkerResultMinCreatedAt   string  `json:"worker_result_min_created_at,omitempty"`
	WorkerDelegateURL          string  `json:"worker_delegate_url,omitempty"`
	WorkerStatusURL            string  `json:"worker_status_url,omitempty"`
	LocalDialogTurnURL         string  `json:"local_dialog_turn_url,omitempty"`
	LocalDialogTTSURL          string  `json:"local_dialog_tts_url,omitempty"`
	LocalDialogTTSMode         string  `json:"local_dialog_tts_mode,omitempty"`
	LocalDialogTTSProvider     string  `json:"local_dialog_tts_provider,omitempty"`
	LocalDialogTTSGain         float64 `json:"local_dialog_tts_gain,omitempty"`
	ScreenShareMode            string  `json:"screen_share_mode,omitempty"`
	ScreenShareTitle           string  `json:"screen_share_title,omitempty"`
	ScreenShareSubtitle        string  `json:"screen_share_subtitle,omitempty"`
	ScreenShareWidth           int     `json:"screen_share_width,omitempty"`
	ScreenShareHeight          int     `json:"screen_share_height,omitempty"`
	ScreenShareFPS             int     `json:"screen_share_fps,omitempty"`
	BrowserExtraArgs           string  `json:"browser_extra_args,omitempty"`
	SlackChannelID             string  `json:"slack_channel_id,omitempty"`
	SlackThreadTS              string  `json:"slack_thread_ts,omitempty"`
}

type JoinGoogleMeetResponse struct {
	OK       bool                    `json:"ok"`
	Accepted bool                    `json:"accepted"`
	Started  bool                    `json:"started"`
	Note     string                  `json:"note,omitempty"`
	Session  SessionRecord           `json:"session"`
	Plan     meetrunner.JoinPlan     `json:"plan"`
	Runner   meetrunner.RunnerStatus `json:"runner"`
}

type JoinStatusResponse struct {
	OK        bool                            `json:"ok"`
	Runner    meetrunner.RunnerStatus         `json:"runner"`
	Active    *SessionRecord                  `json:"active,omitempty"`
	Sessions  SessionSummary                  `json:"sessions"`
	Available bool                            `json:"available"`
	Runtime   *meetrunner.StatusSessionResult `json:"runtime,omitempty"`
}

type StopJoinRequest struct {
	SessionID           string                               `json:"session_id,omitempty"`
	Reason              string                               `json:"reason,omitempty"`
	FixtureCaptions     []postmeeting.TranscriptSegmentInput `json:"fixture_captions,omitempty"`
	FixtureTranscript   string                               `json:"fixture_transcript,omitempty"`
	SyntheticCaptions   []postmeeting.TranscriptSegmentInput `json:"synthetic_captions,omitempty"`
	SyntheticTranscript string                               `json:"synthetic_transcript,omitempty"`
}

type StopJoinResponse struct {
	OK                 bool                           `json:"ok"`
	Stopped            bool                           `json:"stopped"`
	Session            SessionRecord                  `json:"session"`
	Runner             meetrunner.StopSessionResult   `json:"runner"`
	PostMeeting        *postmeeting.PostProcessResult `json:"post_meeting,omitempty"`
	PostMeetingWarning string                         `json:"post_meeting_warning,omitempty"`
}
