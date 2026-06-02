package meetingagent

type RealtimeTextTurnRequest struct {
	SessionID    string `json:"session_id,omitempty"`
	Text         string `json:"text,omitempty"`
	Instructions string `json:"instructions,omitempty"`
}

type RealtimeEventRequest struct {
	SessionID string         `json:"session_id,omitempty"`
	Event     map[string]any `json:"event,omitempty"`
}
