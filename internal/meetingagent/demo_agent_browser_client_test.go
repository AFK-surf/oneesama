package meetingagent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeDemoAgentBrowserRunner struct {
	calls   [][]string
	outputs map[string]string
	errs    map[string]error
}

func (r *fakeDemoAgentBrowserRunner) RunAgentBrowser(_ context.Context, args ...string) (string, error) {
	copied := append([]string(nil), args...)
	r.calls = append(r.calls, copied)
	key := strings.Join(args, " ")
	if err := r.errs[key]; err != nil {
		return "", err
	}
	return r.outputs[key], nil
}

func TestDemoAgentBrowserClientOpenURLUsesDeterministicCLI(t *testing.T) {
	now := time.Date(2026, 5, 21, 18, 50, 0, 0, time.UTC)
	runner := &fakeDemoAgentBrowserRunner{outputs: map[string]string{
		"--session oneesama-demo-surface-demo_browser open https://example.test/app":                    "✓ Oneesama App",
		"--session oneesama-demo-surface-demo_browser screenshot /tmp/demo-frames/demo_browser-007.png": "✓ screenshot",
		"--session oneesama-demo-surface-demo_browser get title":                                        "Oneesama App",
		"--session oneesama-demo-surface-demo_browser get text body":                                    "Ready score: 0 Start snake",
	}}
	client := &DemoAgentBrowserClient{Runner: runner, Now: func() time.Time { return now }}

	result, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session:  DemoKWWKSessionRef{SessionID: "demo_browser", FramesDir: "/tmp/demo-frames"},
		Kind:     DemoActionOpenURL,
		URL:      "https://example.test/app",
		Sequence: 7,
	})
	if err != nil {
		t.Fatalf("DoDemoAction() error = %v", err)
	}
	if result.Source != demoAgentBrowserObservationSource || result.Kind != demoObservationKindOpened || result.Confidence != 1 {
		t.Fatalf("result = %#v, want confident agent-browser open observation", result)
	}
	if !strings.Contains(result.Summary, "Oneesama App") || !strings.Contains(result.Summary, "Start snake") {
		t.Fatalf("summary = %q, want title and visible body", result.Summary)
	}
	if result.Metadata["adapter"] != string(DemoKWWKAdapterAgentBrowser) || result.Metadata["session"] != "oneesama-demo-surface-demo_browser" {
		t.Fatalf("metadata = %#v, want adapter/session", result.Metadata)
	}
	if result.FramePath != "/tmp/demo-frames/demo_browser-007.png" {
		t.Fatalf("frame path = %q, want deterministic screenshot path", result.FramePath)
	}
	wantFirst := "--session oneesama-demo-surface-demo_browser open https://example.test/app"
	if got := strings.Join(runner.calls[0], " "); got != wantFirst {
		t.Fatalf("first call = %q, want %q", got, wantFirst)
	}
	wantScreenshot := "--session oneesama-demo-surface-demo_browser screenshot /tmp/demo-frames/demo_browser-007.png"
	if got := strings.Join(runner.calls[2], " "); got != wantScreenshot {
		t.Fatalf("screenshot call = %q, want %q", got, wantScreenshot)
	}
}

func TestDemoAgentBrowserClientClickKeepsSessionAndReadsUpdatedState(t *testing.T) {
	runner := &fakeDemoAgentBrowserRunner{outputs: map[string]string{
		"--session oneesama-demo-surface-demo_snake find text Start snake click": "✓ Done",
		"--session oneesama-demo-surface-demo_snake get title":                   "Oneesama Snake POC",
		"--session oneesama-demo-surface-demo_snake get text body":               "Oneesama Snake POC playing score: 1 Start snake",
	}}
	client := &DemoAgentBrowserClient{Runner: runner}

	result, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session:  DemoKWWKSessionRef{SessionID: "demo_snake"},
		Kind:     DemoActionClick,
		Text:     "Start snake",
		Sequence: 2,
	})
	if err != nil {
		t.Fatalf("DoDemoAction() error = %v", err)
	}
	if result.Kind != demoObservationKindStep || !strings.Contains(result.Summary, "score: 1") {
		t.Fatalf("result = %#v, want post-click score observation", result)
	}
	if got := strings.Join(runner.calls[0], " "); got != "--session oneesama-demo-surface-demo_snake find text Start snake click" {
		t.Fatalf("click call = %q, want text-click command", got)
	}
}

func TestDemoAgentBrowserClientDryRunSkipsActiveCommands(t *testing.T) {
	runner := &fakeDemoAgentBrowserRunner{}
	client := &DemoAgentBrowserClient{Runner: runner}

	result, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{SessionID: "demo_dry"},
		Kind:    DemoActionClick,
		Text:    "Start snake",
		DryRun:  true,
	})
	if err != nil {
		t.Fatalf("DoDemoAction() error = %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("calls = %#v, want no active browser command in dry-run", runner.calls)
	}
	if result.Metadata["dry_run"] != "true" || result.Confidence < defaultDemoFeedbackConfidenceFloor {
		t.Fatalf("result = %#v, want dry-run observation", result)
	}
}

func TestDemoAgentBrowserClientPropagatesCommandFailure(t *testing.T) {
	runner := &fakeDemoAgentBrowserRunner{
		errs: map[string]error{
			"--session oneesama-demo-surface-demo_fail open https://example.test/app": errors.New("browser unavailable"),
		},
	}
	client := &DemoAgentBrowserClient{Runner: runner}

	_, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{SessionID: "demo_fail"},
		Kind:    DemoActionOpenURL,
		URL:     "https://example.test/app",
	})
	if err == nil || !strings.Contains(err.Error(), "browser unavailable") {
		t.Fatalf("DoDemoAction() error = %v, want browser failure", err)
	}
}

func TestNormalizeDemoSurfaceAdapterAcceptsAgentBrowserAliases(t *testing.T) {
	for _, raw := range []string{"agent_browser", "agent-browser", "browser", "browser_use", "agentbrowser"} {
		if got := normalizeDemoSurfaceAdapter(raw); got != demoSurfaceAdapterAgentBrowser {
			t.Fatalf("normalizeDemoSurfaceAdapter(%q) = %q, want %q", raw, got, demoSurfaceAdapterAgentBrowser)
		}
	}
}
