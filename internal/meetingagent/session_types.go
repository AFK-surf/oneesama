package meetingagent

type SessionRecord struct {
	ID               string         `json:"id"`
	MeetingID        string         `json:"meeting_id,omitempty"`
	MeetingURL       string         `json:"meeting_url,omitempty"`
	Status           string         `json:"status"`
	Title            string         `json:"title,omitempty"`
	ParticipantCount int            `json:"participant_count,omitempty"`
	StartedAt        string         `json:"started_at,omitempty"`
	EndedAt          string         `json:"ended_at,omitempty"`
	CreatedAt        string         `json:"created_at"`
	UpdatedAt        string         `json:"updated_at"`
	Metadata         map[string]any `json:"metadata,omitempty"`
}

type SessionUpsertInput struct {
	ID               string         `json:"id,omitempty"`
	MeetingID        string         `json:"meeting_id,omitempty"`
	MeetingURL       string         `json:"meeting_url,omitempty"`
	Status           string         `json:"status,omitempty"`
	Title            string         `json:"title,omitempty"`
	ParticipantCount int            `json:"participant_count,omitempty"`
	StartedAt        string         `json:"started_at,omitempty"`
	EndedAt          string         `json:"ended_at,omitempty"`
	Metadata         map[string]any `json:"metadata,omitempty"`
}

type SessionSummary struct {
	Total    int            `json:"total"`
	ByStatus map[string]int `json:"by_status,omitempty"`
}
