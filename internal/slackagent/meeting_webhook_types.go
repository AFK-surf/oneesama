package slackagent

type MeetingWebhookPayload struct {
	Event             string                  `json:"event"`
	MeetingID         any                     `json:"meeting_id"`
	MeetingIDAlt      any                     `json:"meetingId,omitempty"`
	ID                any                     `json:"id,omitempty"`
	Title             string                  `json:"title"`
	Status            string                  `json:"status,omitempty"`
	Error             string                  `json:"error,omitempty"`
	Message           string                  `json:"message,omitempty"`
	Summary           *MeetingSummaryData     `json:"summary,omitempty"`
	Result            *MeetingWebhookResult   `json:"result,omitempty"`
	Artifacts         MeetingWebhookArtifacts `json:"artifacts,omitempty"`
	Transcript        string                  `json:"transcript,omitempty"`
	ChatTranscript    string                  `json:"chat_transcript,omitempty"`
	ChatTranscriptAlt string                  `json:"chatTranscript,omitempty"`
	TimeFrom          string                  `json:"time_from,omitempty"`
	TimeFromAlt       string                  `json:"timeFrom,omitempty"`
	TimeTo            string                  `json:"time_to,omitempty"`
	TimeToAlt         string                  `json:"timeTo,omitempty"`
	SlackRef          *MeetingWebhookSlackRef `json:"slack_ref,omitempty"`
	SlackRefAlt       *MeetingWebhookSlackRef `json:"slackRef,omitempty"`
	Slack             *MeetingWebhookSlackRef `json:"slack,omitempty"`
	ChannelID         string                  `json:"channel_id,omitempty"`
	ChannelIDAlt      string                  `json:"channelId,omitempty"`
	Channel           string                  `json:"channel,omitempty"`
	ThreadTS          string                  `json:"thread_ts,omitempty"`
	ThreadTSAlt       string                  `json:"threadTs,omitempty"`
	TS                string                  `json:"ts,omitempty"`
	ForceDelivery     bool                    `json:"force_delivery,omitempty"`
}

type MeetingWebhookResult struct {
	Summary *MeetingSummaryData `json:"summary,omitempty"`
}

type MeetingWebhookSlackRef struct {
	ChannelID    string `json:"channel_id,omitempty"`
	ChannelIDAlt string `json:"channelId,omitempty"`
	Channel      string `json:"channel,omitempty"`
	ThreadTS     string `json:"thread_ts,omitempty"`
	ThreadTSAlt  string `json:"threadTs,omitempty"`
	TS           string `json:"ts,omitempty"`
}

type MeetingSummaryData struct {
	Title              string              `json:"title,omitempty"`
	Attendees          []string            `json:"attendees,omitempty"`
	DurationMinutes    int                 `json:"duration_minutes,omitempty"`
	DurationMinutesAlt int                 `json:"durationMinutes,omitempty"`
	KeyPoints          []string            `json:"key_points,omitempty"`
	KeyPointsAlt       []string            `json:"keyPoints,omitempty"`
	Highlights         []string            `json:"highlights,omitempty"`
	ActionItems        []MeetingActionItem `json:"action_items,omitempty"`
	ActionItemsAlt     []MeetingActionItem `json:"actionItems,omitempty"`
	Decisions          []string            `json:"decisions,omitempty"`
	OpenQuestions      []string            `json:"open_questions,omitempty"`
	OpenQuestionsAlt   []string            `json:"openQuestions,omitempty"`
	Blockers           []string            `json:"blockers,omitempty"`
}

type MeetingActionItem struct {
	Description string `json:"description,omitempty"`
	Text        string `json:"text,omitempty"`
	Title       string `json:"title,omitempty"`
	Owner       string `json:"owner,omitempty"`
	Deadline    string `json:"deadline,omitempty"`
	Due         string `json:"due,omitempty"`
}

type MeetingWebhookArtifacts struct {
	TranscriptPath    string `json:"transcript_path,omitempty"`
	TranscriptPathAlt string `json:"transcriptPath,omitempty"`
	Transcript        string `json:"transcript,omitempty"`
	AudioPath         string `json:"audio_path,omitempty"`
	AudioPathAlt      string `json:"audioPath,omitempty"`
	Audio             string `json:"audio,omitempty"`
}

type NormalizedMeetingWebhookPayload struct {
	Event          string
	MeetingID      int64
	Title          string
	Status         string
	Error          string
	Summary        *MeetingSummaryData
	Artifacts      MeetingWebhookArtifacts
	Transcript     string
	ChatTranscript string
	TimeFrom       string
	TimeTo         string
	SlackRef       MeetingSlackRef
	ForceDelivery  bool
}

type MeetingSlackRef struct {
	ChannelID string `json:"channelId"`
	ThreadTS  string `json:"threadTs"`
	Source    string `json:"source,omitempty"`
}

type MeetingWebhookResponse struct {
	OK              bool                         `json:"ok"`
	Accepted        bool                         `json:"accepted,omitempty"`
	Skipped         bool                         `json:"skipped,omitempty"`
	Duplicate       bool                         `json:"duplicate,omitempty"`
	Event           string                       `json:"event,omitempty"`
	MeetingID       int64                        `json:"meeting_id,omitempty"`
	Status          string                       `json:"status,omitempty"`
	Reason          string                       `json:"reason,omitempty"`
	Error           string                       `json:"error,omitempty"`
	Detail          string                       `json:"detail,omitempty"`
	SlackRef        MeetingSlackRef              `json:"slack_ref,omitempty"`
	Post            *PostMessageResult           `json:"post,omitempty"`
	Published       *PublishedCanvasManifest     `json:"published,omitempty"`
	AssistantStatus *AssistantAPIResult          `json:"assistant_status,omitempty"`
	Delivery        *MeetingResultDeliveryRecord `json:"delivery,omitempty"`
	MeetingThread   *MeetingThreadRecord         `json:"meeting_thread,omitempty"`
	Copilot         *meetingCopilotRunResult     `json:"copilot,omitempty"`
}
