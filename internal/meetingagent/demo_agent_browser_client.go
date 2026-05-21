package meetingagent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	demoAgentBrowserObservationSource = "agent_browser"
	defaultDemoAgentBrowserBin        = "agent-browser"
	defaultDemoAgentBrowserTimeout    = 25 * time.Second
	defaultDemoAgentBrowserTextLimit  = 220
	defaultDemoAgentBrowserSession    = "oneesama-demo-surface"
)

var (
	errDemoAgentBrowserMissingURL    = errors.New("demo_agent_browser_url_required")
	errDemoAgentBrowserMissingTarget = errors.New("demo_agent_browser_target_required")
)

type demoAgentBrowserRunner interface {
	RunAgentBrowser(context.Context, ...string) (string, error)
}

type DemoAgentBrowserClient struct {
	Bin     string
	Runner  demoAgentBrowserRunner
	Timeout time.Duration
	Now     func() time.Time
}

func NewDemoAgentBrowserClient() *DemoAgentBrowserClient {
	return &DemoAgentBrowserClient{}
}

func (c *DemoAgentBrowserClient) DoDemoAction(ctx context.Context, req DemoKWWKActionRequest) (DemoKWWKActionResult, error) {
	runner := c.runner()
	session := demoAgentBrowserSessionName(req.Session.SessionID)
	base := []string{"--session", session}
	now := c.timestamp()

	switch req.Kind {
	case DemoActionOpenURL:
		rawURL := strings.TrimSpace(req.URL)
		if rawURL == "" {
			return DemoKWWKActionResult{}, errDemoAgentBrowserMissingURL
		}
		if _, err := runner.RunAgentBrowser(ctx, append(base, "open", rawURL)...); err != nil {
			return DemoKWWKActionResult{}, err
		}
		_, _ = runner.RunAgentBrowser(ctx, append(base, "wait", "--load", "networkidle")...)
		return c.pageObservation(ctx, runner, req, "surface_opened", now)
	case DemoActionCapture:
		framePath := demoAgentBrowserFramePath(req)
		if framePath != "" {
			if err := os.MkdirAll(filepath.Dir(framePath), 0o755); err != nil {
				return DemoKWWKActionResult{}, err
			}
			if _, err := runner.RunAgentBrowser(ctx, append(base, "screenshot", framePath)...); err != nil {
				return DemoKWWKActionResult{}, err
			}
		}
		result, err := c.pageObservation(ctx, runner, req, "screenshot_observation", now)
		if err != nil {
			return DemoKWWKActionResult{}, err
		}
		result.FramePath = framePath
		return result, nil
	case DemoActionScroll:
		if req.DryRun {
			return c.dryRunObservation(req, "surface_scrolled", "dry-run scroll skipped"), nil
		}
		direction := firstNonEmpty(strings.TrimSpace(req.Direction), "down")
		amount := req.Amount
		if amount <= 0 {
			amount = 500
		}
		if _, err := runner.RunAgentBrowser(ctx, append(base, "scroll", direction, fmt.Sprintf("%d", amount))...); err != nil {
			return DemoKWWKActionResult{}, err
		}
		return c.pageObservation(ctx, runner, req, "surface_scrolled", now)
	case DemoActionHighlight:
		target := strings.TrimSpace(req.Text)
		if target == "" {
			return DemoKWWKActionResult{}, errDemoAgentBrowserMissingTarget
		}
		if req.DryRun {
			return c.dryRunObservation(req, "step_observation", "dry-run highlight skipped for "+target), nil
		}
		if _, err := runner.RunAgentBrowser(ctx, append(base, "highlight", target)...); err != nil {
			return DemoKWWKActionResult{}, err
		}
		return c.pageObservation(ctx, runner, req, "step_observation", now)
	case DemoActionClick:
		target := strings.TrimSpace(req.Text)
		if target == "" {
			return DemoKWWKActionResult{}, errDemoAgentBrowserMissingTarget
		}
		if req.DryRun {
			return c.dryRunObservation(req, "step_observation", "dry-run click skipped for "+target), nil
		}
		if err := c.clickTarget(ctx, runner, base, target); err != nil {
			return DemoKWWKActionResult{}, err
		}
		return c.pageObservation(ctx, runner, req, "step_observation", now)
	case DemoActionType:
		text := strings.TrimSpace(req.Text)
		if text == "" {
			return DemoKWWKActionResult{}, errDemoAgentBrowserMissingTarget
		}
		if req.DryRun {
			return c.dryRunObservation(req, "step_observation", "dry-run type skipped"), nil
		}
		if _, err := runner.RunAgentBrowser(ctx, append(base, "keyboard", "type", text)...); err != nil {
			return DemoKWWKActionResult{}, err
		}
		return c.pageObservation(ctx, runner, req, "step_observation", now)
	default:
		return DemoKWWKActionResult{}, fmt.Errorf("unsupported demo agent-browser action %q", req.Kind)
	}
}

func (c *DemoAgentBrowserClient) runner() demoAgentBrowserRunner {
	if c != nil && c.Runner != nil {
		return c.Runner
	}
	bin := defaultDemoAgentBrowserBin
	timeout := defaultDemoAgentBrowserTimeout
	if c != nil {
		if strings.TrimSpace(c.Bin) != "" {
			bin = strings.TrimSpace(c.Bin)
		}
		if c.Timeout > 0 {
			timeout = c.Timeout
		}
	}
	return demoAgentBrowserCommandRunner{bin: bin, timeout: timeout}
}

func (c *DemoAgentBrowserClient) pageObservation(ctx context.Context, runner demoAgentBrowserRunner, req DemoKWWKActionRequest, kind string, now time.Time) (DemoKWWKActionResult, error) {
	session := demoAgentBrowserSessionName(req.Session.SessionID)
	base := []string{"--session", session}
	title, _ := runner.RunAgentBrowser(ctx, append(base, "get", "title")...)
	body, _ := runner.RunAgentBrowser(ctx, append(base, "get", "text", "body")...)
	summary := demoAgentBrowserSummary(req, title, body)
	confidence := 1.0
	if strings.TrimSpace(title) == "" && strings.TrimSpace(body) == "" {
		confidence = 0.2
		summary = "Agent browser action ran, but no visible page text could be verified yet."
	}
	return normalizeDemoKWWKResult(req, DemoKWWKActionResult{
		Source:     demoAgentBrowserObservationSource,
		Kind:       kind,
		Summary:    summary,
		Confidence: confidence,
		Metadata: map[string]string{
			"adapter": string(DemoKWWKAdapterAgentBrowser),
			"session": session,
		},
		CreatedAt: now,
	}, now), nil
}

func (c *DemoAgentBrowserClient) dryRunObservation(req DemoKWWKActionRequest, kind string, summary string) DemoKWWKActionResult {
	now := c.timestamp()
	return normalizeDemoKWWKResult(req, DemoKWWKActionResult{
		Source:     demoAgentBrowserObservationSource,
		Kind:       kind,
		Summary:    summary,
		Confidence: 0.8,
		Metadata: map[string]string{
			"adapter": string(DemoKWWKAdapterAgentBrowser),
			"dry_run": "true",
		},
		CreatedAt: now,
	}, now)
}

func (c *DemoAgentBrowserClient) clickTarget(ctx context.Context, runner demoAgentBrowserRunner, base []string, target string) error {
	if strings.HasPrefix(target, "@") {
		_, err := runner.RunAgentBrowser(ctx, append(base, "click", target)...)
		return err
	}
	_, err := runner.RunAgentBrowser(ctx, append(base, "find", "text", target, "click")...)
	return err
}

func (c *DemoAgentBrowserClient) timestamp() time.Time {
	if c == nil || c.Now == nil {
		return time.Now()
	}
	return c.Now()
}

type demoAgentBrowserCommandRunner struct {
	bin     string
	timeout time.Duration
}

func (r demoAgentBrowserCommandRunner) RunAgentBrowser(ctx context.Context, args ...string) (string, error) {
	timeout := r.timeout
	if timeout <= 0 {
		timeout = defaultDemoAgentBrowserTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, r.bin, args...)
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = strings.TrimSpace(stdout.String())
		}
		if message == "" {
			message = err.Error()
		}
		return strings.TrimSpace(stdout.String()), fmt.Errorf("agent-browser %s: %w: %s", strings.Join(args, " "), err, message)
	}
	return strings.TrimSpace(stdout.String()), nil
}

func demoAgentBrowserSessionName(sessionID string) string {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return defaultDemoAgentBrowserSession
	}
	sessionID = strings.NewReplacer(":", "-", "/", "-", " ", "-").Replace(sessionID)
	return defaultDemoAgentBrowserSession + "-" + sessionID
}

func demoAgentBrowserFramePath(req DemoKWWKActionRequest) string {
	framesDir := strings.TrimSpace(req.Session.FramesDir)
	if framesDir == "" {
		return ""
	}
	name := strings.TrimSpace(req.Session.SessionID)
	if name == "" {
		name = "demo"
	}
	sequence := req.Sequence
	if sequence <= 0 {
		sequence = 1
	}
	return filepath.Join(framesDir, fmt.Sprintf("%s-%03d.png", safeDemoAgentBrowserFilePart(name), sequence))
}

func safeDemoAgentBrowserFilePart(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "demo"
	}
	var b strings.Builder
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "demo"
	}
	return out
}

func demoAgentBrowserSummary(req DemoKWWKActionRequest, title string, body string) string {
	title = compactDemoAgentBrowserText(title, 80)
	body = compactDemoAgentBrowserText(body, defaultDemoAgentBrowserTextLimit)
	switch {
	case title != "" && body != "":
		return fmt.Sprintf("Agent browser observed %s; title: %s; visible text: %s", firstNonEmpty(req.URL, string(req.Kind)), title, body)
	case title != "":
		return fmt.Sprintf("Agent browser observed %s; title: %s", firstNonEmpty(req.URL, string(req.Kind)), title)
	case body != "":
		return fmt.Sprintf("Agent browser observed %s; visible text: %s", firstNonEmpty(req.URL, string(req.Kind)), body)
	default:
		return ""
	}
}

func compactDemoAgentBrowserText(raw string, max int) string {
	trimmed := strings.Join(strings.Fields(strings.TrimSpace(raw)), " ")
	if max <= 0 || len([]rune(trimmed)) <= max {
		return trimmed
	}
	runes := []rune(trimmed)
	return strings.TrimRight(string(runes[:max]), " ") + "…"
}
