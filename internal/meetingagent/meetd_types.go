package meetingagent

import "time"

type MeetdSlackRef struct {
	ChannelID string `json:"channel_id"`
	ThreadTS  string `json:"thread_ts"`
}

type MeetdMeetingBrief struct {
	MeetingID       string              `json:"meeting_id"`
	EventID         string              `json:"event_id"`
	EventURL        string              `json:"event_url,omitempty"`
	MeetURL         string              `json:"meet_url"`
	Title           string              `json:"title"`
	StartAt         string              `json:"start_at"`
	EndAt           string              `json:"end_at"`
	Attendees       []string            `json:"attendees"`
	SlackRef        *MeetdSlackRef      `json:"slack_ref,omitempty"`
	FocusPoints     []string            `json:"focus_points,omitempty"`
	Captions        []MeetdCaptionInput `json:"captions,omitempty"`
	CaptionSegments []MeetdCaptionInput `json:"caption_segments,omitempty"`
	Segments        []MeetdCaptionInput `json:"segments,omitempty"`
	Status          string              `json:"status,omitempty"`
	Error           string              `json:"error,omitempty"`
	ArtifactsDir    string              `json:"artifacts_dir,omitempty"`
}

type MeetdMeetingRecord struct {
	ID               int64     `json:"id"`
	CalendarEventID  string    `json:"event_id"`
	MeetURL          string    `json:"meet_url"`
	Title            string    `json:"title"`
	StartTime        time.Time `json:"start_time"`
	EndTime          time.Time `json:"end_time"`
	Status           string    `json:"status"`
	Attendees        []string  `json:"attendees,omitempty"`
	SessionID        string    `json:"session_id,omitempty"`
	ErrorMessage     string    `json:"error"`
	ArtifactsDir     string    `json:"artifacts_dir,omitempty"`
	SlackChannelID   string    `json:"slack_channel_id,omitempty"`
	SlackThreadTS    string    `json:"slack_thread_ts,omitempty"`
	WebhookState     string    `json:"webhook_state,omitempty"`
	WebhookError     string    `json:"webhook_error,omitempty"`
	WebhookAttempts  int       `json:"webhook_attempt_count,omitempty"`
	WebhookLastAt    string    `json:"webhook_last_attempt_at,omitempty"`
	WebhookLastEvent string    `json:"webhook_last_event,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type MeetdCaptionInput struct {
	Speaker   string `json:"speaker,omitempty"`
	User      string `json:"user,omitempty"`
	Name      string `json:"name,omitempty"`
	Text      string `json:"text,omitempty"`
	Caption   string `json:"caption,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
	TS        string `json:"ts,omitempty"`
	Source    string `json:"source,omitempty"`
	StreamID  string `json:"stream_id,omitempty"`
	Stream    string `json:"stream,omitempty"`
}

type MeetdCaptionRecord struct {
	ID        int64     `json:"id"`
	MeetingID int64     `json:"meeting_id"`
	Speaker   string    `json:"speaker"`
	Text      string    `json:"text"`
	Timestamp time.Time `json:"timestamp"`
	Source    string    `json:"source"`
	StreamID  string    `json:"stream_id,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type MeetdActionItem struct {
	Description string `json:"description"`
	Owner       string `json:"owner,omitempty"`
	Deadline    string `json:"deadline,omitempty"`
}

type MeetdSummaryData struct {
	Title           string            `json:"title"`
	Attendees       []string          `json:"attendees"`
	DurationMinutes int               `json:"duration_minutes"`
	KeyPoints       []string          `json:"key_points"`
	ActionItems     []MeetdActionItem `json:"action_items"`
	Decisions       []string          `json:"decisions"`
	OpenQuestions   []string          `json:"open_questions"`
	Blockers        []string          `json:"blockers"`
}

type MeetdMeetingArtifacts struct {
	AudioPath      string `json:"audio_path,omitempty"`
	TranscriptPath string `json:"transcript_path,omitempty"`
	CaptionsCount  int    `json:"captions_count"`
}

type MeetdMeetingResult struct {
	MeetingID     string                `json:"meeting_id"`
	Status        string                `json:"status"`
	Summary       *MeetdSummaryData     `json:"summary,omitempty"`
	Artifacts     MeetdMeetingArtifacts `json:"artifacts"`
	Error         string                `json:"error,omitempty"`
	ForceDelivery bool                  `json:"force_delivery,omitempty"`
}

type MeetdMeetingSummaryRecord struct {
	MeetingID int64            `json:"meeting_id"`
	Summary   MeetdSummaryData `json:"summary"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
}

type MeetdWebhookPayload struct {
	Event          string                `json:"event"`
	MeetingID      int64                 `json:"meeting_id"`
	Title          string                `json:"title"`
	SlackRef       *MeetdSlackRef        `json:"slack_ref,omitempty"`
	TimeFrom       string                `json:"time_from,omitempty"`
	TimeTo         string                `json:"time_to,omitempty"`
	Transcript     string                `json:"transcript,omitempty"`
	ChatTranscript string                `json:"chat_transcript,omitempty"`
	Status         string                `json:"status,omitempty"`
	Summary        *MeetdSummaryData     `json:"summary,omitempty"`
	Artifacts      MeetdMeetingArtifacts `json:"artifacts,omitempty"`
	Error          string                `json:"error,omitempty"`
	ForceDelivery  bool                  `json:"force_delivery,omitempty"`
}
