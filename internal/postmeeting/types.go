package postmeeting

import "encoding/json"

type TranscriptSegmentInput struct {
	Speaker   string `json:"speaker,omitempty"`
	User      string `json:"user,omitempty"`
	Name      string `json:"name,omitempty"`
	Text      string `json:"text,omitempty"`
	StartMS   *int64 `json:"start_ms,omitempty"`
	EndMS     *int64 `json:"end_ms,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
	TS        string `json:"ts,omitempty"`
	Source    string `json:"source,omitempty"`
	StreamID  string `json:"streamId,omitempty"`
	Stream    string `json:"stream_id,omitempty"`
}

type TranscriptInput struct {
	Text     string                   `json:"text,omitempty"`
	Segments []TranscriptSegmentInput `json:"segments,omitempty"`
}

type ChatMessageInput struct {
	Direction     string   `json:"direction,omitempty"`
	Type          string   `json:"type,omitempty"`
	Source        string   `json:"source,omitempty"`
	Text          string   `json:"text,omitempty"`
	Message       string   `json:"message,omitempty"`
	Body          string   `json:"body,omitempty"`
	Links         []string `json:"links,omitempty"`
	Timestamp     string   `json:"timestamp,omitempty"`
	TS            string   `json:"ts,omitempty"`
	CreatedAt     string   `json:"created_at,omitempty"`
	SentAt        string   `json:"sent_at,omitempty"`
	MessageID     string   `json:"message_id,omitempty"`
	ID            string   `json:"id,omitempty"`
	EventID       string   `json:"event_id,omitempty"`
	Sender        string   `json:"sender,omitempty"`
	User          string   `json:"user,omitempty"`
	Name          string   `json:"name,omitempty"`
	Author        string   `json:"author,omitempty"`
	DeliveryState string   `json:"delivery_state,omitempty"`
	Status        string   `json:"status,omitempty"`
	Error         string   `json:"error,omitempty"`
}

type Summary struct {
	Title        string   `json:"title,omitempty"`
	MeetURL      string   `json:"meet_url,omitempty"`
	Participants []string `json:"participants,omitempty"`
	Highlights   []string `json:"highlights,omitempty"`
	Decisions    []string `json:"decisions,omitempty"`
	ActionItems  []string `json:"action_items,omitempty"`
	SummaryText  string   `json:"summary_text,omitempty"`
}

type PostProcessInput struct {
	ID                string                   `json:"id,omitempty"`
	ArtifactID        string                   `json:"artifact_id,omitempty"`
	MeetingID         string                   `json:"meeting_id,omitempty"`
	SessionID         string                   `json:"session_id,omitempty"`
	Title             string                   `json:"title,omitempty"`
	MeetURL           string                   `json:"meet_url,omitempty"`
	SummaryText       string                   `json:"summary_text,omitempty"`
	TranscriptText    string                   `json:"transcript_text,omitempty"`
	ASRTranscriptText string                   `json:"asr_transcript_text,omitempty"`
	ASRProvider       string                   `json:"asr_provider,omitempty"`
	Text              string                   `json:"text,omitempty"`
	Transcript        TranscriptInput          `json:"transcript,omitempty"`
	Segments          []TranscriptSegmentInput `json:"segments,omitempty"`
	Captions          []TranscriptSegmentInput `json:"captions,omitempty"`
	ChatMessages      []ChatMessageInput       `json:"chat_messages,omitempty"`
	MeetChatMessages  []ChatMessageInput       `json:"meet_chat_messages,omitempty"`
	Participants      []string                 `json:"participants,omitempty"`
	AudioPath         string                   `json:"audio_path,omitempty"`
	AudioChunks       []string                 `json:"audio_chunks,omitempty"`
	SkipASR           bool                     `json:"skip_asr,omitempty"`
	RootDir           string                   `json:"root_dir,omitempty"`
	Source            string                   `json:"source,omitempty"`
	Summary           *Summary                 `json:"summary,omitempty"`
}

func (i *PostProcessInput) UnmarshalJSON(data []byte) error {
	type postProcessInputAlias PostProcessInput
	var raw struct {
		postProcessInputAlias
		ArtifactID        string                   `json:"artifactId,omitempty"`
		MeetingID         string                   `json:"meetingId,omitempty"`
		SessionID         string                   `json:"sessionId,omitempty"`
		MeetURL           string                   `json:"meetUrl,omitempty"`
		SummaryText       string                   `json:"summaryText,omitempty"`
		TranscriptText    string                   `json:"transcriptText,omitempty"`
		ASRTranscriptText string                   `json:"asrTranscriptText,omitempty"`
		ASRProvider       string                   `json:"asrProvider,omitempty"`
		ChatMessages      []ChatMessageInput       `json:"chatMessages,omitempty"`
		MeetChatMessages  []ChatMessageInput       `json:"meetChatMessages,omitempty"`
		AudioPath         string                   `json:"audioPath,omitempty"`
		AudioChunks       []string                 `json:"audioChunks,omitempty"`
		SkipASR           *bool                    `json:"skipAsr,omitempty"`
		RootDir           string                   `json:"rootDir,omitempty"`
		DynamicSegments   []TranscriptSegmentInput `json:"dynamicSegments,omitempty"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*i = PostProcessInput(raw.postProcessInputAlias)
	i.ArtifactID = firstPostProcessString(i.ArtifactID, raw.ArtifactID)
	i.MeetingID = firstPostProcessString(i.MeetingID, raw.MeetingID)
	i.SessionID = firstPostProcessString(i.SessionID, raw.SessionID)
	i.MeetURL = firstPostProcessString(i.MeetURL, raw.MeetURL)
	i.SummaryText = firstPostProcessString(i.SummaryText, raw.SummaryText)
	i.TranscriptText = firstPostProcessString(i.TranscriptText, raw.TranscriptText)
	i.ASRTranscriptText = firstPostProcessString(i.ASRTranscriptText, raw.ASRTranscriptText)
	i.ASRProvider = firstPostProcessString(i.ASRProvider, raw.ASRProvider)
	i.ChatMessages = firstPostProcessSlice(i.ChatMessages, raw.ChatMessages)
	i.MeetChatMessages = firstPostProcessSlice(i.MeetChatMessages, raw.MeetChatMessages)
	i.AudioPath = firstPostProcessString(i.AudioPath, raw.AudioPath)
	i.AudioChunks = firstPostProcessSlice(i.AudioChunks, raw.AudioChunks)
	if raw.SkipASR != nil {
		i.SkipASR = *raw.SkipASR
	}
	i.RootDir = firstPostProcessString(i.RootDir, raw.RootDir)
	i.Segments = firstPostProcessSlice(i.Segments, raw.DynamicSegments)
	return nil
}

func firstPostProcessString(value string, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func firstPostProcessSlice[T any](value []T, fallback []T) []T {
	if len(value) != 0 {
		return value
	}
	return fallback
}

type NormalizedSegment struct {
	Speaker   string `json:"speaker"`
	Text      string `json:"text"`
	StartMS   *int64 `json:"start_ms,omitempty"`
	EndMS     *int64 `json:"end_ms,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
	Source    string `json:"source,omitempty"`
	StreamID  string `json:"stream_id,omitempty"`
}

type NormalizedChatMessage struct {
	Direction string   `json:"direction"`
	Sender    string   `json:"sender"`
	Text      string   `json:"text"`
	Timestamp string   `json:"timestamp,omitempty"`
	MessageID string   `json:"message_id,omitempty"`
	Links     []string `json:"links,omitempty"`
	Source    string   `json:"source,omitempty"`
	Error     string   `json:"error,omitempty"`
}

type TranscriptArtifact struct {
	Schema       string              `json:"schema"`
	ID           string              `json:"id"`
	Provider     string              `json:"provider"`
	OK           bool                `json:"ok"`
	Text         string              `json:"text"`
	Segments     []NormalizedSegment `json:"segments"`
	SegmentCount int                 `json:"segment_count"`
	CreatedAt    string              `json:"created_at"`
}

type ChatArtifact struct {
	Schema       string                  `json:"schema"`
	ID           string                  `json:"id"`
	MeetingID    string                  `json:"meeting_id,omitempty"`
	SessionID    string                  `json:"session_id,omitempty"`
	MeetURL      string                  `json:"meet_url,omitempty"`
	MessageCount int                     `json:"message_count"`
	LinkCount    int                     `json:"link_count"`
	Links        []string                `json:"links,omitempty"`
	Messages     []NormalizedChatMessage `json:"messages"`
	CreatedAt    string                  `json:"created_at"`
}

type ArtifactFiles struct {
	Transcript     string   `json:"transcript"`
	TranscriptText string   `json:"transcript_text,omitempty"`
	Summary        string   `json:"summary"`
	Manifest       string   `json:"manifest"`
	Chat           string   `json:"chat"`
	Audio          string   `json:"audio,omitempty"`
	AudioChunks    []string `json:"audio_chunks,omitempty"`
}

type ArtifactManifest struct {
	Schema     string        `json:"schema"`
	ID         string        `json:"id"`
	Title      string        `json:"title"`
	MeetingID  string        `json:"meeting_id,omitempty"`
	SessionID  string        `json:"session_id,omitempty"`
	MeetURL    string        `json:"meet_url,omitempty"`
	Dir        string        `json:"dir"`
	CreatedAt  string        `json:"created_at"`
	UpdatedAt  string        `json:"updated_at"`
	Files      ArtifactFiles `json:"files"`
	Transcript struct {
		Provider     string `json:"provider"`
		SegmentCount int    `json:"segment_count"`
		TextLength   int    `json:"text_length"`
	} `json:"transcript"`
	Chat struct {
		MessageCount int    `json:"message_count"`
		LinkCount    int    `json:"link_count"`
		LatestAt     string `json:"latest_at,omitempty"`
	} `json:"chat"`
	Summary struct {
		Highlights  []string `json:"highlights,omitempty"`
		Decisions   []string `json:"decisions,omitempty"`
		ActionItems []string `json:"action_items,omitempty"`
	} `json:"summary"`
	Warnings []PostProcessWarning `json:"warnings,omitempty"`
	Source   string               `json:"source,omitempty"`
}

type PostProcessWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
}

type PostProcessResult struct {
	OK         bool                 `json:"ok"`
	Artifact   ArtifactManifest     `json:"artifact"`
	Transcript TranscriptArtifact   `json:"transcript"`
	Summary    Summary              `json:"summary"`
	Chat       ChatArtifact         `json:"chat"`
	Warnings   []PostProcessWarning `json:"warnings,omitempty"`
}

type DigestWebhookRequest struct {
	URL          string         `json:"url,omitempty"`
	Secret       string         `json:"secret,omitempty"`
	Payload      map[string]any `json:"payload,omitempty"`
	MaxAttempts  int            `json:"max_attempts,omitempty"`
	RetryDelayMS int            `json:"retry_delay_ms,omitempty"`
}

type DigestWebhookAttempt struct {
	Attempt int    `json:"attempt"`
	OK      bool   `json:"ok"`
	Status  int    `json:"status"`
	Body    string `json:"body,omitempty"`
	Error   string `json:"error,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

type DigestWebhookResult struct {
	OK           bool                   `json:"ok"`
	Attempts     int                    `json:"attempts"`
	Status       int                    `json:"status"`
	Error        string                 `json:"error,omitempty"`
	Signature    string                 `json:"signature,omitempty"`
	PayloadBytes int                    `json:"payload_bytes"`
	History      []DigestWebhookAttempt `json:"history,omitempty"`
}
