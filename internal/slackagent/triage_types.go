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
	Emoji                string  `json:"emoji,omitempty"`
	MessageTS            string  `json:"messageTs,omitempty"`
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
	Enabled           bool                       `json:"enabled"`
	PostActions       bool                       `json:"postActions"`
	HeuristicFallback bool                       `json:"heuristicFallback"`
	WorkspacePolicy   SlackWorkspacePolicyStatus `json:"workspacePolicy"`
	LastTriageJobID   string                     `json:"lastTriageJobId,omitempty"`
	AuditFreshness    *SlackTriageFreshness      `json:"auditFreshness,omitempty"`
	AuditFixtures     []SlackTriageAuditFixture  `json:"auditFixtures,omitempty"`
	Runs              []SlackTriageContext       `json:"runs,omitempty"`
	PendingActions    []SlackPendingAction       `json:"pendingActions,omitempty"`
	ChannelBrains     []SlackChannelBrain        `json:"channelBrains,omitempty"`
}

type SlackWorkspacePolicyStatus struct {
	Configured  bool   `json:"configured"`
	Source      string `json:"source"`
	Version     string `json:"version,omitempty"`
	Hash        string `json:"hash,omitempty"`
	LengthChars int    `json:"lengthChars,omitempty"`
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
	Name             string   `json:"name"`
	Category         string   `json:"category,omitempty"`
	Expected         string   `json:"expected"`
	Outcome          string   `json:"outcome"`
	Pass             bool     `json:"pass"`
	ParseOK          bool     `json:"parseOk"`
	Actions          int      `json:"actions"`
	Mutations        int      `json:"mutations"`
	SuppressedReason string   `json:"suppressedReason,omitempty"`
	Summary          string   `json:"summary,omitempty"`
	Evidence         []string `json:"evidence,omitempty"`
}

type SlackTriageAuditReport struct {
	GeneratedAt       string                             `json:"generatedAt"`
	WindowSeconds     int64                              `json:"windowSeconds"`
	Cutoff            string                             `json:"cutoff"`
	RunCount          int                                `json:"runCount"`
	Freshness         SlackTriageFreshness               `json:"freshness"`
	Outcome           SlackTriageAuditOutcome            `json:"outcome"`
	RealOutcome       SlackTriageAuditOutcome            `json:"realOutcome"`
	ProbeOutcome      SlackTriageAuditOutcome            `json:"probeOutcome"`
	InputContext      SlackTriageInputContext            `json:"inputContext"`
	ContextBudget     SlackTriageContextBudget           `json:"contextBudget"`
	Harness           SlackTriageHarnessDrift            `json:"harness"`
	ContextFetch      SlackTriageContextFetch            `json:"contextFetch"`
	SkipReasons       map[string]int                     `json:"skipReasons,omitempty"`
	ProcessHealth     SlackTriageProcessHealth           `json:"processHealth"`
	PersonaRuntime    SlackTriagePersonaRuntime          `json:"personaRuntime"`
	PersonaQuality    SlackTriagePersonaQuality          `json:"personaQuality"`
	Canary            SlackTriageCanarySummary           `json:"canary"`
	LiveProbe         SlackTriageLiveProbeSummary        `json:"liveProbe"`
	FailureSamples    []SlackTriageFailureSample         `json:"failureSamples,omitempty"`
	Flags             []SlackTriageAuditFlag             `json:"flags,omitempty"`
	RecentRuns        []SlackTriageAuditRunBrief         `json:"recentRuns,omitempty"`
	QualityThresholds SlackTriageQualityBucketThresholds `json:"qualityThresholds"`
	ReviewBuckets     SlackTriageReviewBuckets           `json:"reviewBuckets"`
	InfoBuckets       SlackTriageInfoBuckets             `json:"infoBuckets"`
}

type SlackTriageAuditOutcome struct {
	OutboundRuns           int `json:"outboundRuns"`
	Mutations              int `json:"mutations"`
	NoActionRuns           int `json:"noActionRuns"`
	FailedRuns             int `json:"failedRuns"`
	RetryScheduledFailures int `json:"retryScheduledFailures,omitempty"`
	ParseFallbacks         int `json:"parseFallbacks"`
	MaybeRuns              int `json:"maybeRuns"`
}

type SlackTriageInputContext struct {
	Count       int `json:"count"`
	Min         int `json:"min"`
	Median      int `json:"median"`
	Max         int `json:"max"`
	LowUnder200 int `json:"lowUnder200"`
}

type SlackTriageContextBudget struct {
	Count                   int `json:"count"`
	MaxTotalChars           int `json:"maxTotalChars"`
	MedianTotalChars        int `json:"medianTotalChars"`
	MaxTotalTokens          int `json:"maxTotalTokens"`
	MaxStableTokens         int `json:"maxStableTokens"`
	MaxDynamicTokens        int `json:"maxDynamicTokens"`
	MaxWorkerResultTokens   int `json:"maxWorkerResultTokens"`
	MaxMemoryEvidenceTokens int `json:"maxMemoryEvidenceTokens"`
}

// SlackTriageHarnessDrift is the operator-facing rollup of Harness-level
// cache-locality and evidence-boundary signals. It intentionally aggregates
// already-audited fields instead of introducing new triage decisions.
type SlackTriageHarnessDrift struct {
	PIStablePromptHash           string `json:"piStablePromptHash,omitempty"`
	DynamicContextIssueCount     int    `json:"dynamicContextIssueCount"`
	DelegateNoVisibleActionCount int    `json:"delegateNoVisibleActionCount"`
	HandledByOtherNoActionCount  int    `json:"handledByOtherNoActionCount"`
	RunsWithContextBudget        int    `json:"runsWithContextBudget"`
	MaxContextBudgetTokens       int    `json:"maxContextBudgetTokens"`
	MaxStablePromptTokens        int    `json:"maxStablePromptTokens"`
	MaxDynamicContextTokens      int    `json:"maxDynamicContextTokens"`
	MaxWorkerResultTokens        int    `json:"maxWorkerResultTokens"`
	MaxMemoryEvidenceTokens      int    `json:"maxMemoryEvidenceTokens"`
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
	SocketLastConnectedAt       string  `json:"socketLastConnectedAt,omitempty"`
	SocketLastClosedAt          string  `json:"socketLastClosedAt,omitempty"`
	SocketLastEventAt           string  `json:"socketLastEventAt,omitempty"`
	CodexRequiredEnvKey         string  `json:"codexRequiredEnvKey,omitempty"`
	CodexRequiredEnvPresent     bool    `json:"codexRequiredEnvPresent,omitempty"`
}

type SlackTriagePersonaRuntime struct {
	Configured        bool           `json:"configured"`
	ForegroundEnabled bool           `json:"foregroundEnabled"`
	Provider          string         `json:"provider,omitempty"`
	Mode              string         `json:"mode,omitempty"`
	Ready             bool           `json:"ready"`
	Healthy           bool           `json:"healthy"`
	ShadowOnly        bool           `json:"shadowOnly"`
	Version           string         `json:"version,omitempty"`
	BaseURL           string         `json:"baseUrl,omitempty"`
	LastRequestAt     string         `json:"lastRequestAt,omitempty"`
	LastLatencyMS     int64          `json:"lastLatencyMs,omitempty"`
	LastError         string         `json:"lastError,omitempty"`
	StateSummary      map[string]any `json:"stateSummary,omitempty"`
	Error             string         `json:"error,omitempty"`
}

type SlackTriagePersonaQuality struct {
	ForegroundRuns            int    `json:"foregroundRuns"`
	ForegroundQueuedRuns      int    `json:"foregroundQueuedRuns"`
	ForegroundStaleQueuedRuns int    `json:"foregroundStaleQueuedRuns,omitempty"`
	Successes                 int    `json:"successes"`
	Replies                   int    `json:"replies"`
	Failures                  int    `json:"failures"`
	RetryScheduledFailures    int    `json:"retryScheduledFailures,omitempty"`
	AuthFailures              int    `json:"authFailures,omitempty"`
	ShadowOnlyResponses       int    `json:"shadowOnlyResponses"`
	WorkerRequests            int    `json:"workerRequests"`
	MemoryWriteIntents        int    `json:"memoryWriteIntents"`
	OldestQueuedRunID         int64  `json:"oldestQueuedRunId,omitempty"`
	OldestQueuedAt            string `json:"oldestQueuedAt,omitempty"`
	OldestQueuedAgeSeconds    int64  `json:"oldestQueuedAgeSeconds,omitempty"`
	LatestRunID               int64  `json:"latestRunId,omitempty"`
	LatestAt                  string `json:"latestAt,omitempty"`
	LatestDecision            string `json:"latestDecision,omitempty"`
	LatestError               string `json:"latestError,omitempty"`
	LatestLatencyMS           int64  `json:"latestLatencyMs,omitempty"`
	LatestAuthFailureRunID    int64  `json:"latestAuthFailureRunId,omitempty"`
	LatestAuthFailureAt       string `json:"latestAuthFailureAt,omitempty"`
	LatestAuthFailureError    string `json:"latestAuthFailureError,omitempty"`
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

type SlackTriageFailureSample struct {
	Timestamp string   `json:"timestamp,omitempty"`
	Channels  []string `json:"channels,omitempty"`
	Probe     bool     `json:"probe,omitempty"`
	Status    string   `json:"status,omitempty"`
	Summary   string   `json:"summary,omitempty"`
	Error     string   `json:"error,omitempty"`
}

// SlackTriageIntentActionMismatchSample surfaces runs whose summary text
// contains an action-intent marker (delegate / reply / react / 应该 / 委托
// ...) even though actions=0 and mutations=0. The triple
// (summary, actionsCount, personaDecision) lets the operator distinguish
// "model said it would but didn't" from "model is narrating history".
// Driver review request 2026-05-21 (#285 follow-up).
type SlackTriageIntentActionMismatchSample struct {
	Timestamp       string   `json:"timestamp,omitempty"`
	RunID           int64    `json:"runId,omitempty"`
	Channels        []string `json:"channels,omitempty"`
	Summary         string   `json:"summary,omitempty"`
	ActionsCount    int      `json:"actionsCount"`
	PersonaDecision string   `json:"personaDecision,omitempty"`
	MarkerMatched   string   `json:"markerMatched,omitempty"`
}

// SlackTriageDelegateNoVisibleActionSample surfaces no-action runs whose
// `persona_foreground.decision` is `delegate_worker` and that carry a
// non-empty `worker_requests` list. These are NOT narrative mismatches
// (the persona made a real delegation call) — they are visibility gaps:
// the audit layer cannot confirm the downstream worker started, was
// blocked by policy, is still queued, or silently dropped. The operator
// triple is (worker_requests, job_id, delivery_status).
// Task #285 follow-up (driver 2h sweep 2026-05-21 15:00 review proposal).
type SlackTriageDelegateNoVisibleActionSample struct {
	Timestamp      string   `json:"timestamp,omitempty"`
	RunID          int64    `json:"runId,omitempty"`
	Channels       []string `json:"channels,omitempty"`
	Summary        string   `json:"summary,omitempty"`
	ActionsCount   int      `json:"actionsCount"`
	WorkerRequests []string `json:"workerRequests,omitempty"`
	JobID          string   `json:"jobId,omitempty"`
	DeliveryStatus string   `json:"deliveryStatus,omitempty"`
}

// SlackTriageDynamicContextIssueSample surfaces Pi foreground runs whose
// dynamic_context audit snapshot is missing, incomplete, or stale relative to
// the run timestamp. This bucket is gated by
// metadata.persona_dynamic_context_expected so legacy pre-envelope runs do not
// create review noise. Task #324.
type SlackTriageDynamicContextIssueSample struct {
	Timestamp       string   `json:"timestamp,omitempty"`
	RunID           int64    `json:"runId,omitempty"`
	Channels        []string `json:"channels,omitempty"`
	Summary         string   `json:"summary,omitempty"`
	MissingKinds    []string `json:"missingKinds,omitempty"`
	IncompleteKinds []string `json:"incompleteKinds,omitempty"`
	StaleKinds      []string `json:"staleKinds,omitempty"`
	Details         []string `json:"details,omitempty"`
}

// SlackTriageReviewBuckets aggregates per-bucket counts + capped sample
// lists for the triage audit review surface. Buckets count all matching runs
// in the window; samples are limited and ordered newest-first.
//
// Bucket precedence (most-specific first): a no-action run that matches
// DelegateNoVisibleAction is NOT also counted in IntentActionMismatch,
// because the failure mode + the evidence the operator needs are
// different. See `buildSlackTriageReviewBuckets` for the dispatch order.
type SlackTriageReviewBuckets struct {
	DynamicContextIssueCount       int                                        `json:"dynamicContextIssueCount"`
	DynamicContextIssueSamples     []SlackTriageDynamicContextIssueSample     `json:"dynamicContextIssueSamples,omitempty"`
	DelegateNoVisibleActionCount   int                                        `json:"delegateNoVisibleActionCount"`
	DelegateNoVisibleActionSamples []SlackTriageDelegateNoVisibleActionSample `json:"delegateNoVisibleActionSamples,omitempty"`
	IntentActionMismatchCount      int                                        `json:"intentActionMismatchCount"`
	IntentActionMismatchSamples    []SlackTriageIntentActionMismatchSample    `json:"intentActionMismatchSamples,omitempty"`
}

// SlackTriageHandledByOtherSample records a no-action run whose summary
// describes another agent / teammate already handling the thread. These runs
// land in the info tier (not review) so operators stop having to triage
// through correct dispose runs. Task #285 follow-up #3.
type SlackTriageHandledByOtherSample struct {
	Timestamp     string   `json:"timestamp,omitempty"`
	RunID         int64    `json:"runId,omitempty"`
	Channels      []string `json:"channels,omitempty"`
	Summary       string   `json:"summary,omitempty"`
	MarkerMatched string   `json:"markerMatched,omitempty"`
}

// SlackTriageDirectedToActiveAgentSample records a no-action run where the
// latest user message explicitly mentions an agent / handler and the fetched
// thread context shows that mentioned actor has already been active in the
// same thread. This is stronger structural evidence than summary text
// markers, so it lands in a separate info bucket.
type SlackTriageDirectedToActiveAgentSample struct {
	Timestamp       string   `json:"timestamp,omitempty"`
	RunID           int64    `json:"runId,omitempty"`
	Channels        []string `json:"channels,omitempty"`
	Summary         string   `json:"summary,omitempty"`
	MentionedUserID string   `json:"mentionedUserId,omitempty"`
	ActiveMessages  int      `json:"activeMessages,omitempty"`
	Evidence        string   `json:"evidence,omitempty"`
}

// SlackTriageInfoBuckets aggregates "info tier" (record-keeping only, NOT
// operator-attention-needed) bucket counts + samples. Operators should be
// able to glance at info bucket counts to confirm "system is correctly
// staying silent because work was done elsewhere", without these counts
// landing in review queues. Task #285 follow-up #3.
type SlackTriageInfoBuckets struct {
	DirectedToActiveAgentNoActionCount   int                                      `json:"directedToActiveAgentNoActionCount"`
	DirectedToActiveAgentNoActionSamples []SlackTriageDirectedToActiveAgentSample `json:"directedToActiveAgentNoActionSamples,omitempty"`
	HandledByOtherNoActionCount          int                                      `json:"handledByOtherNoActionCount"`
	HandledByOtherNoActionSamples        []SlackTriageHandledByOtherSample        `json:"handledByOtherNoActionSamples,omitempty"`
}

type SlackTriageAuditRunBrief struct {
	Timestamp             string   `json:"timestamp"`
	Channels              []string `json:"channels,omitempty"`
	InputContextChars     int      `json:"inputContextChars,omitempty"`
	ContextBudgetTokens   int      `json:"contextBudgetTokens,omitempty"`
	DynamicContextTokens  int      `json:"dynamicContextTokens,omitempty"`
	WorkerResultTokens    int      `json:"workerResultTokens,omitempty"`
	MemoryEvidenceTokens  int      `json:"memoryEvidenceTokens,omitempty"`
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
