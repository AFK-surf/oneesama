package meetingagent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const demoKWWKObservationSource = "kwwk_demo_surface"

var errDemoKWWKNoQueuedResult = errors.New("demo_kwwk_no_queued_result")

type DemoKWWKAdapterKind string

const (
	DemoKWWKAdapterFake         DemoKWWKAdapterKind = "fake"
	DemoKWWKAdapterCodex        DemoKWWKAdapterKind = "codex"
	DemoKWWKAdapterStdioJSONRPC DemoKWWKAdapterKind = "stdio_json_rpc"
	DemoKWWKAdapterLibrary      DemoKWWKAdapterKind = "library"
)

type DemoKWWKAdapterDecision struct {
	Preferred DemoKWWKAdapterKind   `json:"preferred"`
	Deferred  []DemoKWWKAdapterKind `json:"deferred,omitempty"`
	Rationale []string              `json:"rationale,omitempty"`
}

func DefaultDemoKWWKAdapterDecision() DemoKWWKAdapterDecision {
	return DemoKWWKAdapterDecision{
		Preferred: DemoKWWKAdapterCodex,
		Deferred:  []DemoKWWKAdapterKind{DemoKWWKAdapterStdioJSONRPC, DemoKWWKAdapterLibrary},
		Rationale: []string{
			"codex_browser_use_reuses_existing_worker_runtime_without_reimplementing_desktop_minion_kwwk",
			"host_run_poc_needs_a_process_boundary_around_browser_control_permissions",
			"fake_adapter_unblocks_controller_tests_without_meet_or_realtime",
			"stdio_or_library_kwwk_binding_can_replace_codex_without_changing_demo_controller",
		},
	}
}

type DemoKWWKSessionRef struct {
	SessionID    string `json:"session_id"`
	RuntimeDir   string `json:"runtime_dir,omitempty"`
	ProfileDir   string `json:"profile_dir,omitempty"`
	FramesDir    string `json:"frames_dir,omitempty"`
	DownloadsDir string `json:"downloads_dir,omitempty"`
}

func DemoKWWKSessionFromWorkspace(session DemoWorkspaceSession) DemoKWWKSessionRef {
	return DemoKWWKSessionRef{
		SessionID:    session.ID,
		RuntimeDir:   session.RuntimeDir,
		ProfileDir:   session.ProfileDir,
		FramesDir:    session.FramesDir,
		DownloadsDir: session.DownloadsDir,
	}
}

type DemoKWWKRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

type DemoKWWKActionRequest struct {
	Session     DemoKWWKSessionRef `json:"session"`
	Kind        DemoActionKind     `json:"kind"`
	URL         string             `json:"url,omitempty"`
	Instruction string             `json:"instruction,omitempty"`
	Direction   string             `json:"direction,omitempty"`
	Amount      int                `json:"amount,omitempty"`
	Rect        DemoKWWKRect       `json:"rect,omitempty"`
	Text        string             `json:"text,omitempty"`
	DryRun      bool               `json:"dry_run,omitempty"`
	Sequence    int                `json:"sequence,omitempty"`
}

type DemoKWWKActionResult struct {
	SessionID  string            `json:"session_id"`
	Sequence   int               `json:"sequence"`
	Source     string            `json:"source"`
	Action     DemoActionKind    `json:"action"`
	Kind       string            `json:"kind"`
	Summary    string            `json:"summary,omitempty"`
	Confidence float64           `json:"confidence,omitempty"`
	FramePath  string            `json:"frame_path,omitempty"`
	Metadata   map[string]string `json:"metadata,omitempty"`
	CreatedAt  time.Time         `json:"created_at"`
}

type DemoKWWKClient interface {
	DoDemoAction(ctx context.Context, req DemoKWWKActionRequest) (DemoKWWKActionResult, error)
}

type FakeDemoKWWKClient struct {
	mu        sync.Mutex
	now       func() time.Time
	results   []DemoKWWKActionResult
	err       error
	strict    bool
	requests  []DemoKWWKActionRequest
	sequences map[string]int
}

func NewFakeDemoKWWKClient() *FakeDemoKWWKClient {
	return &FakeDemoKWWKClient{
		now:       time.Now,
		sequences: map[string]int{},
	}
}

func (f *FakeDemoKWWKClient) QueueResult(result DemoKWWKActionResult) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results = append(f.results, result)
}

func (f *FakeDemoKWWKClient) SetError(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func (f *FakeDemoKWWKClient) SetStrict(strict bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.strict = strict
}

func (f *FakeDemoKWWKClient) Requests() []DemoKWWKActionRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]DemoKWWKActionRequest(nil), f.requests...)
}

func (f *FakeDemoKWWKClient) DoDemoAction(ctx context.Context, req DemoKWWKActionRequest) (DemoKWWKActionResult, error) {
	if err := ctx.Err(); err != nil {
		return DemoKWWKActionResult{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()

	f.requests = append(f.requests, req)
	if f.err != nil {
		return DemoKWWKActionResult{}, f.err
	}
	if len(f.results) > 0 {
		result := f.results[0]
		f.results = f.results[1:]
		return normalizeDemoKWWKResult(req, result, f.timestamp()), nil
	}
	if f.strict {
		return DemoKWWKActionResult{}, errDemoKWWKNoQueuedResult
	}
	return f.defaultResult(req), nil
}

func (f *FakeDemoKWWKClient) defaultResult(req DemoKWWKActionRequest) DemoKWWKActionResult {
	sessionID := strings.TrimSpace(req.Session.SessionID)
	if sessionID == "" {
		sessionID = "demo_unknown"
	}
	sequence := req.Sequence
	if sequence <= 0 {
		f.sequences[sessionID]++
		sequence = f.sequences[sessionID]
	}
	action := req.Kind
	summaryAction := strings.TrimSpace(string(action))
	if summaryAction == "" {
		summaryAction = "unknown"
	}
	return DemoKWWKActionResult{
		SessionID:  sessionID,
		Sequence:   sequence,
		Source:     demoKWWKObservationSource,
		Action:     action,
		Kind:       "fake_" + summaryAction,
		Summary:    fmt.Sprintf("fake kwwk %s observation", summaryAction),
		Confidence: 1,
		CreatedAt:  f.timestamp(),
	}
}

func (f *FakeDemoKWWKClient) timestamp() time.Time {
	if f.now == nil {
		return time.Now()
	}
	return f.now()
}

func normalizeDemoKWWKResult(req DemoKWWKActionRequest, result DemoKWWKActionResult, now time.Time) DemoKWWKActionResult {
	if strings.TrimSpace(result.SessionID) == "" {
		result.SessionID = strings.TrimSpace(req.Session.SessionID)
	}
	if result.Sequence <= 0 {
		result.Sequence = req.Sequence
	}
	if strings.TrimSpace(result.Source) == "" {
		result.Source = demoKWWKObservationSource
	}
	if result.Action == "" {
		result.Action = req.Kind
	}
	if strings.TrimSpace(result.Kind) == "" {
		result.Kind = "kwwk_action_result"
	}
	if result.CreatedAt.IsZero() {
		result.CreatedAt = now
	}
	return result
}
