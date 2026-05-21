package meetingagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

const (
	demoCodexBrowserObservationSource = "codex_browser_use"
	defaultDemoCodexPollInterval      = 250 * time.Millisecond
	defaultDemoCodexTimeout           = 120 * time.Second
	defaultDemoCodexSandbox           = "danger-full-access"
)

var (
	errDemoCodexRunnerRequired = errors.New("demo_codex_runner_required")
	errDemoCodexJobNotFound    = errors.New("demo_codex_job_not_found")
	errDemoCodexJobFailed      = errors.New("demo_codex_job_failed")
)

type DemoCodexBrowserClient struct {
	Runner       agentrunner.Runner
	PollInterval time.Duration
	Timeout      time.Duration
	Sandbox      string
	Now          func() time.Time
}

func NewDemoCodexBrowserClient(runner agentrunner.Runner) *DemoCodexBrowserClient {
	return &DemoCodexBrowserClient{
		Runner:       runner,
		PollInterval: defaultDemoCodexPollInterval,
		Timeout:      defaultDemoCodexTimeout,
	}
}

func (c *DemoCodexBrowserClient) DoDemoAction(ctx context.Context, req DemoKWWKActionRequest) (DemoKWWKActionResult, error) {
	if c == nil || c.Runner == nil {
		return DemoKWWKActionResult{}, errDemoCodexRunnerRequired
	}
	input := agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             buildDemoCodexBrowserTask(req),
		Context:          demoCodexBrowserContext(req),
		Mode:             "analysis",
		AllowCodeChanges: false,
		Sandbox:          firstNonEmpty(c.Sandbox, defaultDemoCodexSandbox),
	}, agentrunner.SessionKindDemoSurface)
	job, err := c.Runner.StartTask(ctx, input)
	if err != nil {
		return DemoKWWKActionResult{}, err
	}
	job, err = c.awaitJob(ctx, job)
	if err != nil {
		return DemoKWWKActionResult{}, err
	}
	result, err := demoKWWKResultFromCodexJob(req, job, c.timestamp())
	if err != nil {
		return DemoKWWKActionResult{}, err
	}
	return result, nil
}

func (c *DemoCodexBrowserClient) awaitJob(ctx context.Context, job agentrunner.Job) (agentrunner.Job, error) {
	if isDemoCodexTerminalStatus(job.Status) {
		return job, demoCodexJobError(job)
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = defaultDemoCodexTimeout
	}
	pollInterval := c.PollInterval
	if pollInterval <= 0 {
		pollInterval = defaultDemoCodexPollInterval
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-waitCtx.Done():
			if errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
				return job, fmt.Errorf("demo_codex_job_timeout: %s", job.ID)
			}
			return job, waitCtx.Err()
		case <-ticker.C:
			updated, found, err := c.Runner.GetJob(waitCtx, job.ID)
			if err != nil {
				return job, err
			}
			if !found {
				return job, fmt.Errorf("%w: %s", errDemoCodexJobNotFound, job.ID)
			}
			job = updated
			if isDemoCodexTerminalStatus(job.Status) {
				return job, demoCodexJobError(job)
			}
		}
	}
}

func isDemoCodexTerminalStatus(status agentrunner.JobStatus) bool {
	switch status {
	case agentrunner.StatusCompleted, agentrunner.StatusFailed, agentrunner.StatusTimeout:
		return true
	default:
		return false
	}
}

func demoCodexJobError(job agentrunner.Job) error {
	switch job.Status {
	case agentrunner.StatusCompleted:
		return nil
	case agentrunner.StatusTimeout:
		if strings.TrimSpace(job.Error) != "" {
			return fmt.Errorf("%w: %s", errDemoCodexJobFailed, strings.TrimSpace(job.Error))
		}
		return fmt.Errorf("%w: timeout", errDemoCodexJobFailed)
	case agentrunner.StatusFailed:
		if strings.TrimSpace(job.Error) != "" {
			return fmt.Errorf("%w: %s", errDemoCodexJobFailed, strings.TrimSpace(job.Error))
		}
		return fmt.Errorf("%w: failed", errDemoCodexJobFailed)
	default:
		return nil
	}
}

func buildDemoCodexBrowserTask(req DemoKWWKActionRequest) string {
	payload, _ := json.MarshalIndent(req, "", "  ")
	return strings.Join([]string{
		"You are the Codex Browser Use adapter for Oneesama's meeting demo surface.",
		"Use the browser-use capability if available. Work only inside the bot-owned demo browser/session described in context. Do not edit repository files.",
		"Do not call meeting, Slack, or messaging tools such as send_meeting_chat, notify_meeting_slack, slack_api, or send_message. Your only output is the JSON object.",
		"Perform the requested demo action and return exactly one JSON object, with no Markdown fences or extra prose.",
		`Required JSON shape: {"summary":"what you observed in one sentence","confidence":0.0,"frame_path":"","kind":"surface_opened"}.`,
		"Use confidence 0.0-1.0. If you cannot verify the requested surface, say that honestly in summary and use low confidence.",
		"Demo action request:\n" + string(payload),
	}, "\n\n")
}

func demoCodexBrowserContext(req DemoKWWKActionRequest) map[string]any {
	return map[string]any{
		"source":          "meeting-demo-surface",
		"adapter":         string(DemoKWWKAdapterCodex),
		"session_id":      strings.TrimSpace(req.Session.SessionID),
		"runtime_dir":     strings.TrimSpace(req.Session.RuntimeDir),
		"profile_dir":     strings.TrimSpace(req.Session.ProfileDir),
		"frames_dir":      strings.TrimSpace(req.Session.FramesDir),
		"downloads_dir":   strings.TrimSpace(req.Session.DownloadsDir),
		"action_kind":     string(req.Kind),
		"url":             strings.TrimSpace(req.URL),
		"instruction":     strings.TrimSpace(req.Instruction),
		"dry_run":         req.DryRun,
		"browser_profile": "bot_owned_demo_surface",
		"output_contract": map[string]any{
			"format": "json_object_only",
			"fields": []string{"summary", "confidence", "frame_path", "kind"},
		},
	}
}

type demoCodexObservationPayload struct {
	Summary    string            `json:"summary"`
	Confidence float64           `json:"confidence"`
	FramePath  string            `json:"frame_path"`
	Kind       string            `json:"kind"`
	Metadata   map[string]string `json:"metadata"`
}

func demoKWWKResultFromCodexJob(req DemoKWWKActionRequest, job agentrunner.Job, now time.Time) (DemoKWWKActionResult, error) {
	summary := strings.TrimSpace(job.Result)
	payload, ok := parseDemoCodexObservation(summary)
	if ok {
		summary = strings.TrimSpace(payload.Summary)
	} else if summary != "" {
		summary = "I could not verify the demo surface yet."
	}
	if summary == "" {
		summary = "I could not verify the demo surface yet."
	}
	confidence := 0.6
	if ok {
		confidence = payload.Confidence
	} else if !ok {
		confidence = 0.2
	}
	if confidence > 1 {
		confidence = 1
	}
	if confidence < 0 {
		confidence = 0
	}
	metadata := map[string]string{
		"adapter":    string(DemoKWWKAdapterCodex),
		"job_id":     strings.TrimSpace(job.ID),
		"provider":   strings.TrimSpace(job.Provider),
		"job_status": string(job.Status),
	}
	if ok {
		for key, value := range payload.Metadata {
			key = strings.TrimSpace(key)
			value = strings.TrimSpace(value)
			if key != "" && value != "" && !demoCodexReservedMetadataKey(key) {
				metadata[key] = value
			}
		}
	}
	return normalizeDemoKWWKResult(req, DemoKWWKActionResult{
		SessionID:  strings.TrimSpace(req.Session.SessionID),
		Sequence:   req.Sequence,
		Source:     demoCodexBrowserObservationSource,
		Action:     req.Kind,
		Kind:       firstNonEmpty(payload.Kind, "codex_browser_observation"),
		Summary:    summary,
		Confidence: confidence,
		FramePath:  strings.TrimSpace(payload.FramePath),
		Metadata:   metadata,
		CreatedAt:  now,
	}, now), nil
}

func demoCodexReservedMetadataKey(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "adapter", "job_id", "provider", "job_status":
		return true
	default:
		return false
	}
}

func parseDemoCodexObservation(raw string) (demoCodexObservationPayload, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return demoCodexObservationPayload{}, false
	}
	for _, candidate := range demoCodexJSONCandidates(trimmed) {
		var payload demoCodexObservationPayload
		if err := json.Unmarshal([]byte(candidate), &payload); err == nil {
			return payload, true
		}
	}
	return demoCodexObservationPayload{}, false
}

func demoCodexJSONCandidates(raw string) []string {
	candidates := []string{raw}
	if strings.HasPrefix(raw, "```") {
		lines := strings.Split(raw, "\n")
		if len(lines) >= 3 {
			body := strings.Join(lines[1:len(lines)-1], "\n")
			candidates = append(candidates, strings.TrimSpace(body))
		}
	}
	start := strings.Index(raw, "{")
	end := strings.LastIndex(raw, "}")
	if start >= 0 && end > start {
		candidates = append(candidates, raw[start:end+1])
	}
	return candidates
}

func (c *DemoCodexBrowserClient) timestamp() time.Time {
	if c != nil && c.Now != nil {
		return c.Now()
	}
	return time.Now()
}
