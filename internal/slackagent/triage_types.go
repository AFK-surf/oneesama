package slackagent

type SlackTriageContext struct {
	ID              int64                 `json:"id,omitempty"`
	SessionID       string                `json:"session_id,omitempty"`
	Timestamp       string                `json:"timestamp"`
	Status          string                `json:"status"`
	Channels        []string              `json:"channels"`
	Actions         []SlackTriageAction   `json:"actions"`
	ToolCalls       []SlackTriageToolCall `json:"tool_calls,omitempty"`
	Summary         string                `json:"summary"`
	RawOutput       string                `json:"raw_output,omitempty"`
	Error           string                `json:"error,omitempty"`
	Digest          string                `json:"digest,omitempty"`
	Steps           int                   `json:"steps"`
	DurationSeconds float64               `json:"duration_seconds"`
	Mutations       int                   `json:"mutations"`
	Failures        int                   `json:"failures"`
	TokensUsed      int                   `json:"tokens_used"`
	Metadata        map[string]any        `json:"metadata,omitempty"`
}

type SlackTriageAction struct {
	Tool    string `json:"tool"`
	Channel string `json:"channel"`
	Brief   string `json:"brief"`
}

type SlackTriageToolCall struct {
	Tool    string `json:"tool"`
	Action  string `json:"action,omitempty"`
	Args    string `json:"args,omitempty"`
	Success bool   `json:"success"`
	Brief   string `json:"brief,omitempty"`
	Result  string `json:"result,omitempty"`
}

type SlackTriageThreadContext struct {
	ChannelID    string                `json:"channel_id"`
	ThreadTS     string                `json:"thread_ts"`
	FetchOK      bool                  `json:"fetch_ok"`
	FetchError   string                `json:"fetch_error,omitempty"`
	MessageCount int                   `json:"message_count"`
	Messages     []SlackInboundMessage `json:"messages,omitempty"`
	Transcript   string                `json:"transcript,omitempty"`
}

type SlackTriageDecision struct {
	Summary string                      `json:"summary"`
	Actions []SlackTriageDecisionAction `json:"actions"`
	Raw     map[string]any              `json:"raw,omitempty"`
	ParseOK bool                        `json:"parseOk"`
}

type SlackTriageDecisionAction struct {
	Type                 string  `json:"type"`
	Title                string  `json:"title"`
	Message              string  `json:"message"`
	ChannelID            string  `json:"channelId,omitempty"`
	ThreadTS             string  `json:"threadTs,omitempty"`
	Confidence           float64 `json:"confidence"`
	Reason               string  `json:"reason,omitempty"`
	RequiresConfirmation bool    `json:"requiresConfirmation"`
}

type SlackPendingAction struct {
	ID          int64          `json:"id"`
	ChannelID   string         `json:"channel_id"`
	ThreadTS    string         `json:"thread_ts,omitempty"`
	CardTS      string         `json:"card_ts,omitempty"`
	ActionType  string         `json:"action_type"`
	Params      map[string]any `json:"params,omitempty"`
	Status      string         `json:"status"`
	ConfirmedBy string         `json:"confirmed_by,omitempty"`
	Result      string         `json:"result,omitempty"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
}

type SlackTriageStartResult struct {
	Run          *SlackTriageContext      `json:"run,omitempty"`
	Job          any                      `json:"job,omitempty"`
	Finalization *SlackTriageFinalization `json:"finalization,omitempty"`
}

type SlackTriageFinalization struct {
	Run            *SlackTriageContext        `json:"run,omitempty"`
	Decision       SlackTriageDecision        `json:"decision"`
	PendingActions []SlackTriagePendingResult `json:"pendingActions,omitempty"`
}

type SlackTriagePendingResult struct {
	Action        SlackTriageDecisionAction `json:"action"`
	PendingAction SlackPendingAction        `json:"pendingAction"`
	Post          PostMessageResult         `json:"post,omitempty"`
}

type SlackTriageStatus struct {
	Enabled           bool                      `json:"enabled"`
	PostActions       bool                      `json:"postActions"`
	HeuristicFallback bool                      `json:"heuristicFallback"`
	LastTriageJobID   string                    `json:"lastTriageJobId,omitempty"`
	AuditFreshness    *SlackTriageFreshness     `json:"auditFreshness,omitempty"`
	AuditFixtures     []SlackTriageAuditFixture `json:"auditFixtures,omitempty"`
	Runs              []SlackTriageContext      `json:"runs,omitempty"`
	PendingActions    []SlackPendingAction      `json:"pendingActions,omitempty"`
	ChannelBrains     []SlackChannelBrain       `json:"channelBrains,omitempty"`
}

type SlackTriageFreshness struct {
	GeneratedAt         string `json:"generatedAt"`
	RunCount            int    `json:"runCount"`
	OldestRunAt         string `json:"oldestRunAt,omitempty"`
	NewestRunAt         string `json:"newestRunAt,omitempty"`
	NewestRunAgeSeconds int64  `json:"newestRunAgeSeconds,omitempty"`
	SampleWindowSeconds int64  `json:"sampleWindowSeconds,omitempty"`
}

type SlackTriageAuditFixture struct {
	Name             string `json:"name"`
	Expected         string `json:"expected"`
	Outcome          string `json:"outcome"`
	Pass             bool   `json:"pass"`
	ParseOK          bool   `json:"parseOk"`
	Actions          int    `json:"actions"`
	Mutations        int    `json:"mutations"`
	SuppressedReason string `json:"suppressedReason,omitempty"`
	Summary          string `json:"summary,omitempty"`
}
