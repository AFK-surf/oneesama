package meetingagent

type TTSSynthesizeRequest struct {
	Text       string         `json:"text,omitempty"`
	Voice      string         `json:"voice,omitempty"`
	Format     string         `json:"format,omitempty"`
	DurationMs int            `json:"durationMs,omitempty"`
	Frequency  float64        `json:"frequency,omitempty"`
	Gain       *float64       `json:"gain,omitempty"`
	Context    map[string]any `json:"context,omitempty"`
}

type TTSSynthesizeResponse map[string]any

type DialogTurnRequest struct {
	SessionID        string         `json:"sessionId,omitempty"`
	Utterance        string         `json:"utterance,omitempty"`
	Text             string         `json:"text,omitempty"`
	Context          map[string]any `json:"context,omitempty"`
	Mode             string         `json:"mode,omitempty"`
	AllowCodeChanges bool           `json:"allowCodeChanges,omitempty"`
	TimeoutMs        int            `json:"timeoutMs,omitempty"`
}
