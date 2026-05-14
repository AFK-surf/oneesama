package slackagent

import "encoding/json"

type SlackSocketOpenResponse struct {
	OK    bool   `json:"ok"`
	URL   string `json:"url,omitempty"`
	Error string `json:"error,omitempty"`
}

type SlackSocketEnvelope struct {
	Type                   string          `json:"type"`
	EnvelopeID             string          `json:"envelope_id,omitempty"`
	AcceptsResponsePayload bool            `json:"accepts_response_payload,omitempty"`
	Payload                json.RawMessage `json:"payload,omitempty"`
	Reason                 string          `json:"reason,omitempty"`
}

type SlackSocketAck struct {
	EnvelopeID string `json:"envelope_id"`
	Payload    any    `json:"payload,omitempty"`
}

type SlackSocketSlashCommand struct {
	Text      string `json:"text,omitempty"`
	TeamID    string `json:"team_id,omitempty"`
	ChannelID string `json:"channel_id,omitempty"`
	ThreadTS  string `json:"thread_ts,omitempty"`
	UserID    string `json:"user_id,omitempty"`
	UserName  string `json:"user_name,omitempty"`
}

type SlackSocketModeStatus struct {
	Configured           bool   `json:"configured"`
	Connected            bool   `json:"connected"`
	Connecting           bool   `json:"connecting"`
	LastConnectedAt      string `json:"last_connected_at,omitempty"`
	LastClosedAt         string `json:"last_closed_at,omitempty"`
	LastEventAt          string `json:"last_event_at,omitempty"`
	LastError            string `json:"last_error,omitempty"`
	Reconnects           int    `json:"reconnects"`
	EventsHandled        int    `json:"events_handled"`
	SlashCommandsHandled int    `json:"slash_commands_handled"`
	InteractionsHandled  int    `json:"interactions_handled"`
	IgnoredEnvelopes     int    `json:"ignored_envelopes"`
}
