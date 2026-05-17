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

type SlackTriageAuditReport struct {
	GeneratedAt   string                      `json:"generatedAt"`
	WindowSeconds int64                       `json:"windowSeconds"`
	Cutoff        string                      `json:"cutoff"`
	RunCount      int                         `json:"runCount"`
	Freshness     SlackTriageFreshness        `json:"freshness"`
	Outcome       SlackTriageAuditOutcome     `json:"outcome"`
	InputContext  SlackTriageInputContext     `json:"inputContext"`
	ContextFetch  SlackTriageContextFetch     `json:"contextFetch"`
	SkipReasons   map[string]int              `json:"skipReasons,omitempty"`
	ProcessHealth SlackTriageProcessHealth    `json:"processHealth"`
	Canary        SlackTriageCanarySummary    `json:"canary"`
	LiveProbe     SlackTriageLiveProbeSummary `json:"liveProbe"`
	Flags         []SlackTriageAuditFlag      `json:"flags,omitempty"`
	RecentRuns    []SlackTriageAuditRunBrief  `json:"recentRuns,omitempty"`
}

type SlackTriageAuditOutcome struct {
	OutboundRuns   int `json:"outboundRuns"`
	Mutations      int `json:"mutations"`
	NoActionRuns   int `json:"noActionRuns"`
	FailedRuns     int `json:"failedRuns"`
	ParseFallbacks int `json:"parseFallbacks"`
	MaybeRuns      int `json:"maybeRuns"`
}

type SlackTriageInputContext struct {
	Count       int `json:"count"`
	Min         int `json:"min"`
	Median      int `json:"median"`
	Max         int `json:"max"`
	LowUnder200 int `json:"lowUnder200"`
}

type SlackTriageContextFetch struct {
	ChannelContextFetched int            `json:"channelContextFetched"`
	ThreadContextFetched  int            `json:"threadContextFetched"`
	ExternalLinksFetched  int            `json:"externalLinksFetched"`
	Reasons               map[string]int `json:"reasons,omitempty"`
}

type SlackTriageProcessHealth struct {
	PID                         int     `json:"pid"`
	UptimeSeconds               int64   `json:"uptimeSeconds"`
	CPUPercent                  float64 `json:"cpuPct"`
	ScannerSweepsLastWindow     int     `json:"scannerSweepsLastWindow"`
	ScannerRateLimitsLastWindow int     `json:"scannerRateLimitsLastWindow"`
	HTTP429LastWindow           int     `json:"http429LastWindow"`
	SocketConnected             bool    `json:"socketConnected"`
	SocketReconnectsTotal       int     `json:"socketReconnectsTotal"`
	SocketReconnectsLastWindow  int     `json:"socketReconnectsLastWindow"`
}

type SlackTriageCanarySummary struct {
	Total            int                       `json:"total"`
	Passed           int                       `json:"passed"`
	Controls         []SlackTriageAuditFixture `json:"controls"`
	LivePositiveRuns int                       `json:"livePositiveRuns"`
	NeedsLiveSample  bool                      `json:"needsLiveSample"`
}

type SlackTriageLiveProbeSummary struct {
	Total         int    `json:"total"`
	Passed        int    `json:"passed"`
	LatestRunID   int64  `json:"latestRunId,omitempty"`
	LatestAt      string `json:"latestAt,omitempty"`
	LatestOutcome string `json:"latestOutcome,omitempty"`
	LatestSummary string `json:"latestSummary,omitempty"`
}

type SlackTriageAuditFlag struct {
	Level   string `json:"level"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type SlackTriageAuditRunBrief struct {
	Timestamp             string   `json:"timestamp"`
	Channels              []string `json:"channels,omitempty"`
	InputContextChars     int      `json:"inputContextChars,omitempty"`
	ThreadContextFetched  bool     `json:"threadContextFetched,omitempty"`
	ChannelContextFetched bool     `json:"channelContextFetched,omitempty"`
	ContextFetchReason    string   `json:"contextFetchReason,omitempty"`
	ExternalLinksFetched  int      `json:"externalLinksFetched,omitempty"`
	Mutations             int      `json:"mutations"`
	Actions               int      `json:"actions"`
	SuppressedReason      string   `json:"suppressedReason,omitempty"`
	SkipReasonBucket      string   `json:"skipReasonBucket,omitempty"`
	Summary               string   `json:"summary,omitempty"`
}
