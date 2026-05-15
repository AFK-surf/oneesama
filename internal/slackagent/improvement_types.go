package slackagent

type SlackImprovementTopicCount struct {
	Topic string `json:"topic"`
	Count int    `json:"count"`
}

type SlackImprovementSignal struct {
	ID              int64          `json:"id"`
	Topic           string         `json:"topic"`
	SignalType      string         `json:"signal_type"`
	Summary         string         `json:"summary"`
	DesiredBehavior string         `json:"desired_behavior"`
	Severity        string         `json:"severity"`
	Confidence      float64        `json:"confidence"`
	ChannelID       string         `json:"channel_id"`
	ThreadTS        string         `json:"thread_ts"`
	MsgTS           string         `json:"msg_ts"`
	SessionID       string         `json:"session_id"`
	ClusterKey      string         `json:"cluster_key"`
	Status          string         `json:"status"`
	Metadata        map[string]any `json:"metadata,omitempty"`
	CreatedAt       string         `json:"created_at"`
	UpdatedAt       string         `json:"updated_at"`
}
