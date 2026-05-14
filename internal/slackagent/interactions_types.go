package slackagent

type SlackInteractionPayload struct {
	Actions     []SlackInteractionAction `json:"actions,omitempty"`
	Team        *SlackInteractionTeam    `json:"team,omitempty"`
	TeamID      string                   `json:"team_id,omitempty"`
	Channel     *SlackInteractionChannel `json:"channel,omitempty"`
	ChannelID   string                   `json:"channel_id,omitempty"`
	User        *SlackInteractionUser    `json:"user,omitempty"`
	UserID      string                   `json:"user_id,omitempty"`
	State       *SlackInteractionState   `json:"state,omitempty"`
	ResponseURL string                   `json:"response_url,omitempty"`
	TriggerID   string                   `json:"trigger_id,omitempty"`
	Message     *SlackInteractionMessage `json:"message,omitempty"`
}

type SlackInteractionAction struct {
	BlockID        string                         `json:"block_id,omitempty"`
	ActionID       string                         `json:"action_id,omitempty"`
	Value          string                         `json:"value,omitempty"`
	SelectedOption *SlackInteractionSelectedValue `json:"selected_option,omitempty"`
	SelectedUser   string                         `json:"selected_user,omitempty"`
}

type SlackInteractionSelectedValue struct {
	Value string `json:"value,omitempty"`
}

type SlackInteractionState struct {
	Values map[string]map[string]SlackInteractionAction `json:"values,omitempty"`
}

type SlackInteractionTeam struct {
	ID     string `json:"id,omitempty"`
	Domain string `json:"domain,omitempty"`
}

type SlackInteractionChannel struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

type SlackInteractionUser struct {
	ID       string `json:"id,omitempty"`
	Username string `json:"username,omitempty"`
	Name     string `json:"name,omitempty"`
}

type SlackInteractionMessage struct {
	ThreadTS string `json:"thread_ts,omitempty"`
	TS       string `json:"ts,omitempty"`
}

type SlackPendingActionInteraction struct {
	ID             int64  `json:"id"`
	Status         string `json:"status"`
	UserID         string `json:"user_id,omitempty"`
	ActionID       string `json:"action_id,omitempty"`
	AssigneeUserID string `json:"assignee_user_id,omitempty"`
	SnoozeMinutes  int    `json:"snooze_minutes,omitempty"`
	ChannelID      string `json:"channel_id,omitempty"`
	ThreadTS       string `json:"thread_ts,omitempty"`
}
