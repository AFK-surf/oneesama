package persona

import (
	"context"
	"time"
)

const (
	ProviderLegacy = "legacy"
	ProviderFake   = "fake"
	ProviderHTTP   = "http"
	ProviderPi     = "pi"
	// ProviderOneesamaPi is the dedicated Oneesama foreground cognition runtime.
	// ProviderPi remains the generic sidecar/http compatibility provider.
	ProviderOneesamaPi = "oneesama-pi"

	ModeShadow = "shadow"
	ModeLive   = "live"

	DecisionStaySilent     = "stay_silent"
	DecisionReply          = "reply"
	DecisionReact          = "react"
	DecisionDelegateWorker = "delegate_worker"
	DecisionMemoryWrite    = "memory_write"
)

// Runtime is the narrow boundary between Go orchestration and the foreground
// Pi-style persona. Slack/Meet services should depend on this contract, not on
// whether the implementation is a JS sidecar, a Go fake, or a future Go port.
type Runtime interface {
	Decide(ctx context.Context, req Request) (Response, error)
	Status(ctx context.Context) Status
}

type Request struct {
	ID             string                   `json:"id"`
	Mode           string                   `json:"mode,omitempty"`
	Event          Event                    `json:"event"`
	Actor          Actor                    `json:"actor,omitempty"`
	Anchor         Anchor                   `json:"anchor,omitempty"`
	Context        []ContextItem            `json:"context,omitempty"`
	DynamicContext []DynamicContextEnvelope `json:"dynamic_context,omitempty"`
	Evidence       EvidenceBundle           `json:"evidence,omitempty"`
	Memory         MemoryContext            `json:"memory,omitempty"`
	Safety         SafetyConstraints        `json:"safety,omitempty"`
	Metadata       map[string]any           `json:"metadata,omitempty"`
}

type Event struct {
	Kind      string `json:"kind"`
	Text      string `json:"text,omitempty"`
	Language  string `json:"language,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
}

type Actor struct {
	ID          string   `json:"id,omitempty"`
	Name        string   `json:"name,omitempty"`
	DisplayName string   `json:"display_name,omitempty"`
	Aliases     []string `json:"aliases,omitempty"`
}

type Anchor struct {
	Surface   string `json:"surface,omitempty"`
	ChannelID string `json:"channel_id,omitempty"`
	ThreadTS  string `json:"thread_ts,omitempty"`
	MessageTS string `json:"message_ts,omitempty"`
	MeetingID string `json:"meeting_id,omitempty"`
	URL       string `json:"url,omitempty"`
}

type ContextItem struct {
	Kind      string `json:"kind"`
	Text      string `json:"text"`
	SourceRef string `json:"source_ref,omitempty"`
}

const (
	DynamicContextCachePolicyNotStablePrefix = "dynamic_not_stable_prefix"
)

type DynamicContextEnvelope struct {
	Kind        string         `json:"kind"`
	Source      string         `json:"source,omitempty"`
	Version     string         `json:"version,omitempty"`
	Freshness   string         `json:"freshness,omitempty"`
	Confidence  float64        `json:"confidence,omitempty"`
	Content     string         `json:"content,omitempty"`
	CachePolicy string         `json:"cache_policy,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

type EvidenceBundle struct {
	Summary   string     `json:"summary,omitempty"`
	Citations []Citation `json:"citations,omitempty"`
}

type MemoryContext struct {
	Summary string         `json:"summary,omitempty"`
	Items   []MemoryRecord `json:"items,omitempty"`
}

type MemoryRecord struct {
	Kind      string  `json:"kind,omitempty"`
	Text      string  `json:"text,omitempty"`
	SourceRef string  `json:"source_ref,omitempty"`
	Score     float64 `json:"score,omitempty"`
}

type SafetyConstraints struct {
	AllowVisibleReply  bool     `json:"allow_visible_reply"`
	AllowSpeech        bool     `json:"allow_speech"`
	AllowWorkerRequest bool     `json:"allow_worker_request"`
	AllowReactions     bool     `json:"allow_reactions,omitempty"`
	MaxVisibleChars    int      `json:"max_visible_chars,omitempty"`
	AllowedWorkers     []string `json:"allowed_workers,omitempty"`
}

type Response struct {
	Runtime         string           `json:"runtime,omitempty"`
	Decision        string           `json:"decision"`
	VisibleText     string           `json:"visible_text,omitempty"`
	SpeechIntent    string           `json:"speech_intent,omitempty"`
	Reactions       []ReactionIntent `json:"reactions,omitempty"`
	WorkerRequests  []WorkerRequest  `json:"worker_requests,omitempty"`
	MemoryWrites    []MemoryWrite    `json:"memory_writes,omitempty"`
	Confidence      float64          `json:"confidence,omitempty"`
	Citations       []Citation       `json:"citations,omitempty"`
	EvidenceAnchors []EvidenceAnchor `json:"evidence_anchors,omitempty"`
	Reason          string           `json:"reason,omitempty"`
	ShadowOnly      bool             `json:"shadow_only,omitempty"`
	Metadata        map[string]any   `json:"metadata,omitempty"`
}

type ReactionIntent struct {
	Emoji      string  `json:"emoji"`
	ChannelID  string  `json:"channel_id,omitempty"`
	MessageTS  string  `json:"message_ts,omitempty"`
	Reason     string  `json:"reason,omitempty"`
	Confidence float64 `json:"confidence,omitempty"`
}

type WorkerRequest struct {
	ID      string         `json:"id,omitempty"`
	Kind    string         `json:"kind"`
	Prompt  string         `json:"prompt"`
	Context map[string]any `json:"context,omitempty"`
	Handoff *WorkerHandoff `json:"handoff,omitempty"`
}

type WorkerHandoff struct {
	SourceAgent    string             `json:"source_agent,omitempty"`
	TargetAgent    string             `json:"target_agent,omitempty"`
	Reason         string             `json:"reason,omitempty"`
	UserRequest    string             `json:"user_request,omitempty"`
	Task           string             `json:"task,omitempty"`
	ContextSummary string             `json:"context_summary,omitempty"`
	ExpectedOutput string             `json:"expected_output,omitempty"`
	Boundaries     []string           `json:"boundaries,omitempty"`
	SourceRefs     []HandoffSourceRef `json:"source_refs,omitempty"`
}

type HandoffSourceRef struct {
	Kind      string `json:"kind,omitempty"`
	SourceRef string `json:"source_ref,omitempty"`
	Summary   string `json:"summary,omitempty"`
}

type MemoryWrite struct {
	Kind      string         `json:"kind"`
	Text      string         `json:"text"`
	SourceRef string         `json:"source_ref,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

type Citation struct {
	Kind      string `json:"kind,omitempty"`
	Source    string `json:"source,omitempty"`
	SourceRef string `json:"source_ref,omitempty"`
	LineStart int    `json:"line_start,omitempty"`
	LineEnd   int    `json:"line_end,omitempty"`
	Snippet   string `json:"snippet,omitempty"`
}

type EvidenceAnchor struct {
	Kind      string `json:"kind,omitempty"`
	SourceRef string `json:"source_ref,omitempty"`
	Quote     string `json:"quote,omitempty"`
	Freshness string `json:"freshness,omitempty"`
}

type Status struct {
	Provider      string         `json:"provider"`
	Mode          string         `json:"mode"`
	Healthy       bool           `json:"healthy"`
	Ready         bool           `json:"ready"`
	ShadowOnly    bool           `json:"shadow_only"`
	Version       string         `json:"version,omitempty"`
	LastRequestAt string         `json:"last_request_at,omitempty"`
	LastLatencyMS int64          `json:"last_latency_ms,omitempty"`
	LastError     string         `json:"last_error,omitempty"`
	StateSummary  map[string]any `json:"state_summary,omitempty"`
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}
