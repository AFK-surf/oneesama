package meetingagent

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDemoControllerOpenURLAllowedEmitsOpenedObservation(t *testing.T) {
	now := time.Date(2026, 5, 21, 13, 10, 0, 0, time.UTC)
	client := NewFakeDemoKWWKClient()
	client.now = func() time.Time { return now }
	client.QueueResult(DemoKWWKActionResult{
		Summary:    "The dashboard is open and the red metric is visible.",
		Confidence: 0.91,
		FramePath:  "/tmp/demo/frame-1.jpg",
	})
	controller := DemoController{
		Client: client,
		Safety: DemoSafetyPolicy{
			URLAllowlistPatterns: []string{"https://example.test/"},
		},
		Now: func() time.Time { return now },
	}

	result, err := controller.RunIntent(context.Background(), DemoIntent{
		Session:  DemoKWWKSessionRef{SessionID: "demo_open"},
		Kind:     DemoActionOpenURL,
		URL:      "https://example.test/dashboard",
		Sequence: 3,
	})
	if err != nil {
		t.Fatalf("RunIntent() error = %v", err)
	}

	if result.Verdict.Decision != DemoActionDecisionAllow || result.Verdict.Reason != "url_allowlisted" {
		t.Fatalf("verdict = %#v, want allow/url_allowlisted", result.Verdict)
	}
	if result.Observation.Kind != demoObservationKindOpened {
		t.Fatalf("observation.Kind = %q, want opened", result.Observation.Kind)
	}
	if result.Observation.Summary != "The dashboard is open and the red metric is visible." {
		t.Fatalf("observation.Summary = %q", result.Observation.Summary)
	}
	if result.Observation.Confidence != 0.91 || result.Observation.FramePath != "/tmp/demo/frame-1.jpg" {
		t.Fatalf("observation = %#v, queued KWWK fields not preserved", result.Observation)
	}
	requests := client.Requests()
	if len(requests) != 1 {
		t.Fatalf("client requests = %d, want 1", len(requests))
	}
	if requests[0].Kind != DemoActionOpenURL || requests[0].URL != "https://example.test/dashboard" || requests[0].DryRun {
		t.Fatalf("client request = %#v, want open_url non-dry-run", requests[0])
	}
}

func TestDemoControllerBlockedIntentDoesNotCallClient(t *testing.T) {
	now := time.Date(2026, 5, 21, 13, 11, 0, 0, time.UTC)
	client := NewFakeDemoKWWKClient()
	controller := DemoController{
		Client: client,
		Safety: DemoSafetyPolicy{
			URLAllowlistPatterns: []string{"https://allowed.test/"},
		},
		Now: func() time.Time { return now },
	}

	result, err := controller.RunIntent(context.Background(), DemoIntent{
		Session:  DemoKWWKSessionRef{SessionID: "demo_block"},
		Kind:     DemoActionOpenURL,
		URL:      "https://blocked.test/dashboard",
		Sequence: 8,
	})
	if err != nil {
		t.Fatalf("RunIntent() error = %v", err)
	}

	if result.Verdict.Decision != DemoActionDecisionBlock || result.Verdict.Reason != "url_not_allowlisted" {
		t.Fatalf("verdict = %#v, want block/url_not_allowlisted", result.Verdict)
	}
	if result.Observation.Kind != demoObservationKindBlocked {
		t.Fatalf("observation.Kind = %q, want blocked", result.Observation.Kind)
	}
	if result.Observation.Summary != "demo action blocked: url_not_allowlisted" {
		t.Fatalf("observation.Summary = %q", result.Observation.Summary)
	}
	if !result.Observation.CreatedAt.Equal(now) {
		t.Fatalf("observation.CreatedAt = %s, want %s", result.Observation.CreatedAt, now)
	}
	if len(client.Requests()) != 0 {
		t.Fatalf("client was called for blocked intent: %#v", client.Requests())
	}
}

func TestDemoControllerDryRunScrollPassesDryRunToClient(t *testing.T) {
	client := NewFakeDemoKWWKClient()
	controller := DemoController{
		Client: client,
		Safety: DemoSafetyPolicy{DryRun: true},
	}

	result, err := controller.RunIntent(context.Background(), DemoIntent{
		Session:   DemoKWWKSessionRef{SessionID: "demo_scroll"},
		Kind:      DemoActionScroll,
		Direction: "down",
		Amount:    3,
	})
	if err != nil {
		t.Fatalf("RunIntent() error = %v", err)
	}

	if result.Verdict.Decision != DemoActionDecisionDryRun {
		t.Fatalf("verdict.Decision = %q, want dry_run", result.Verdict.Decision)
	}
	if result.Observation.Kind != demoObservationKindScrolled {
		t.Fatalf("observation.Kind = %q, want scrolled", result.Observation.Kind)
	}
	requests := client.Requests()
	if len(requests) != 1 {
		t.Fatalf("client requests = %d, want 1", len(requests))
	}
	if !requests[0].DryRun || requests[0].Direction != "down" || requests[0].Amount != 3 {
		t.Fatalf("client request = %#v, want dry-run scroll down 3", requests[0])
	}
}

func TestDemoControllerCancelShortCircuitsBeforeClient(t *testing.T) {
	token := NewDemoCancelToken()
	token.Cancel("user asked stop")
	client := NewFakeDemoKWWKClient()
	controller := DemoController{
		Client: client,
		Safety: DemoSafetyPolicy{ApprovedSessionURLs: []string{"https://example.test/dashboard"}},
	}

	result, err := controller.RunIntent(context.Background(), DemoIntent{
		Session: DemoKWWKSessionRef{SessionID: "demo_cancel"},
		Kind:    DemoActionOpenURL,
		URL:     "https://example.test/dashboard",
		Cancel:  token,
	})
	if err != nil {
		t.Fatalf("RunIntent() error = %v", err)
	}

	if result.Verdict.Decision != DemoActionDecisionBlock || result.Verdict.Reason != "demo_cancelled" {
		t.Fatalf("verdict = %#v, want block/demo_cancelled", result.Verdict)
	}
	if result.Observation.Kind != demoObservationKindBlocked {
		t.Fatalf("observation.Kind = %q, want blocked", result.Observation.Kind)
	}
	if len(client.Requests()) != 0 {
		t.Fatalf("client was called after cancellation: %#v", client.Requests())
	}
}

func TestDemoControllerClientErrorEmitsFailedObservation(t *testing.T) {
	now := time.Date(2026, 5, 21, 13, 12, 0, 0, time.UTC)
	client := NewFakeDemoKWWKClient()
	client.SetError(errors.New("adapter offline"))
	controller := DemoController{
		Client: client,
		Safety: DemoSafetyPolicy{ApprovedSessionURLs: []string{"https://example.test/dashboard"}},
		Now:    func() time.Time { return now },
	}

	result, err := controller.RunIntent(context.Background(), DemoIntent{
		Session:  DemoKWWKSessionRef{SessionID: "demo_fail"},
		Kind:     DemoActionOpenURL,
		URL:      "https://example.test/dashboard",
		Sequence: 4,
	})
	if err == nil || err.Error() != "adapter offline" {
		t.Fatalf("RunIntent() error = %v, want adapter offline", err)
	}
	if result.Observation.Kind != demoObservationKindFailed {
		t.Fatalf("observation.Kind = %q, want failed", result.Observation.Kind)
	}
	if result.Observation.Summary != "demo action failed: adapter_failed" {
		t.Fatalf("observation.Summary = %q", result.Observation.Summary)
	}
	if !result.Observation.CreatedAt.Equal(now) {
		t.Fatalf("observation.CreatedAt = %s, want %s", result.Observation.CreatedAt, now)
	}
}

func TestDemoControllerMissingClientFailsAfterPolicyAllow(t *testing.T) {
	controller := DemoController{
		Safety: DemoSafetyPolicy{ApprovedSessionURLs: []string{"https://example.test/dashboard"}},
	}

	result, err := controller.RunIntent(context.Background(), DemoIntent{
		Session: DemoKWWKSessionRef{SessionID: "demo_missing_client"},
		Kind:    DemoActionOpenURL,
		URL:     "https://example.test/dashboard",
	})
	if !errors.Is(err, errDemoControllerMissingClient) {
		t.Fatalf("RunIntent() error = %v, want errDemoControllerMissingClient", err)
	}
	if result.Observation.Kind != demoObservationKindFailed {
		t.Fatalf("observation.Kind = %q, want failed", result.Observation.Kind)
	}
	if result.Observation.Summary != "demo action failed: adapter_missing" {
		t.Fatalf("observation.Summary = %q", result.Observation.Summary)
	}
}

func TestDemoObservationKindForAction(t *testing.T) {
	tests := []struct {
		action DemoActionKind
		want   string
	}{
		{action: DemoActionOpenURL, want: demoObservationKindOpened},
		{action: DemoActionCapture, want: demoObservationKindScreenshot},
		{action: DemoActionScroll, want: demoObservationKindScrolled},
		{action: DemoActionHighlight, want: demoObservationKindStep},
		{action: DemoActionClick, want: demoObservationKindStep},
		{action: DemoActionType, want: demoObservationKindStep},
	}
	for _, tt := range tests {
		t.Run(string(tt.action), func(t *testing.T) {
			if got := demoObservationKindForAction(tt.action); got != tt.want {
				t.Fatalf("demoObservationKindForAction(%q) = %q, want %q", tt.action, got, tt.want)
			}
		})
	}
}
