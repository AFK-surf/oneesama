package slackagent

type SlackChannelBrain struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	ChannelID      string `json:"channel_id"`
	Summary        string `json:"summary"`
	SummaryVersion int    `json:"summary_version"`
	LastSessionID  string `json:"last_session_id,omitempty"`
	LastThreadTS   string `json:"last_thread_ts,omitempty"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
}

type SlackThreadLedgerRecord struct {
	ID                     string `json:"id"`
	WorkspaceID            string `json:"workspace_id"`
	ChannelID              string `json:"channel_id"`
	ThreadTS               string `json:"thread_ts"`
	AssistantSessionID     string `json:"assistant_session_id,omitempty"`
	Status                 string `json:"status"`
	OwnerUserID            string `json:"owner_user_id,omitempty"`
	LastUserID             string `json:"last_user_id,omitempty"`
	LastUserMessageAt      string `json:"last_user_message_at,omitempty"`
	LastAssistantMessageAt string `json:"last_assistant_message_at,omitempty"`
	LastActionType         string `json:"last_action_type,omitempty"`
	LastActionStatus       string `json:"last_action_status,omitempty"`
	Summary                string `json:"summary,omitempty"`
	CreatedAt              string `json:"created_at"`
	UpdatedAt              string `json:"updated_at"`
}
