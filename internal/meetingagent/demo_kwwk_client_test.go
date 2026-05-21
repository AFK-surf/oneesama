package meetingagent

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestDefaultDemoKWWKAdapterDecisionPrefersAgentBrowser(t *testing.T) {
	decision := DefaultDemoKWWKAdapterDecision()

	if decision.Preferred != DemoKWWKAdapterAgentBrowser {
		t.Fatalf("Preferred = %q, want agent_browser", decision.Preferred)
	}
	if !reflect.DeepEqual(decision.Deferred, []DemoKWWKAdapterKind{DemoKWWKAdapterCodex, DemoKWWKAdapterStdioJSONRPC, DemoKWWKAdapterLibrary}) {
		t.Fatalf("Deferred = %#v, want codex/stdio/library deferred", decision.Deferred)
	}
	if len(decision.Rationale) < 3 {
		t.Fatalf("Rationale = %#v, want agent-browser/fake/deferred-adapter rationale", decision.Rationale)
	}
}

func TestDemoKWWKSessionFromWorkspaceCarriesLifecycleDirs(t *testing.T) {
	session := DemoWorkspaceSession{
		ID:           "demo_123",
		RuntimeDir:   "/tmp/demo_123",
		ProfileDir:   "/tmp/demo_123/profile",
		FramesDir:    "/tmp/demo_123/frames",
		DownloadsDir: "/tmp/demo_123/downloads",
	}

	ref := DemoKWWKSessionFromWorkspace(session)

	if ref.SessionID != session.ID ||
		ref.RuntimeDir != session.RuntimeDir ||
		ref.ProfileDir != session.ProfileDir ||
		ref.FramesDir != session.FramesDir ||
		ref.DownloadsDir != session.DownloadsDir {
		t.Fatalf("DemoKWWKSessionFromWorkspace() = %#v, want %#v dirs", ref, session)
	}
}

func TestFakeDemoKWWKClientRecordsCallsAndReturnsQueuedResults(t *testing.T) {
	now := time.Date(2026, 5, 21, 12, 45, 0, 0, time.UTC)
	client := NewFakeDemoKWWKClient()
	client.now = func() time.Time { return now }
	client.QueueResult(DemoKWWKActionResult{
		Kind:      "screenshot_observation",
		Summary:   "dashboard is red",
		FramePath: "/tmp/frame.jpg",
	})
	req := DemoKWWKActionRequest{
		Session:  DemoKWWKSessionRef{SessionID: "demo_alpha"},
		Kind:     DemoActionCapture,
		Sequence: 7,
	}

	result, err := client.DoDemoAction(context.Background(), req)
	if err != nil {
		t.Fatalf("DoDemoAction() error = %v", err)
	}

	if result.SessionID != "demo_alpha" {
		t.Fatalf("result.SessionID = %q, want demo_alpha", result.SessionID)
	}
	if result.Sequence != 7 {
		t.Fatalf("result.Sequence = %d, want 7", result.Sequence)
	}
	if result.Source != demoKWWKObservationSource {
		t.Fatalf("result.Source = %q, want %q", result.Source, demoKWWKObservationSource)
	}
	if result.Action != DemoActionCapture {
		t.Fatalf("result.Action = %q, want capture", result.Action)
	}
	if result.Summary != "dashboard is red" || result.FramePath != "/tmp/frame.jpg" {
		t.Fatalf("result = %#v, queued fields not preserved", result)
	}
	if !result.CreatedAt.Equal(now) {
		t.Fatalf("result.CreatedAt = %s, want %s", result.CreatedAt, now)
	}
	requests := client.Requests()
	if !reflect.DeepEqual(requests, []DemoKWWKActionRequest{req}) {
		t.Fatalf("Requests() = %#v, want %#v", requests, []DemoKWWKActionRequest{req})
	}
}

func TestFakeDemoKWWKClientDefaultsObservationFields(t *testing.T) {
	now := time.Date(2026, 5, 21, 12, 50, 0, 0, time.UTC)
	client := NewFakeDemoKWWKClient()
	client.now = func() time.Time { return now }

	first, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{SessionID: "demo_beta"},
		Kind:    DemoActionOpenURL,
		URL:     "https://example.test",
	})
	if err != nil {
		t.Fatalf("DoDemoAction(first) error = %v", err)
	}
	second, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{SessionID: "demo_beta"},
		Kind:    DemoActionScroll,
	})
	if err != nil {
		t.Fatalf("DoDemoAction(second) error = %v", err)
	}

	if first.Sequence != 1 || second.Sequence != 2 {
		t.Fatalf("sequences = %d/%d, want 1/2", first.Sequence, second.Sequence)
	}
	if first.Kind != "fake_open_url" || second.Kind != "fake_scroll" {
		t.Fatalf("kinds = %q/%q, want fake action kinds", first.Kind, second.Kind)
	}
	if first.Confidence != 1 || second.Confidence != 1 {
		t.Fatalf("confidence = %f/%f, want 1", first.Confidence, second.Confidence)
	}
	if !first.CreatedAt.Equal(now) || !second.CreatedAt.Equal(now) {
		t.Fatalf("created timestamps = %s/%s, want %s", first.CreatedAt, second.CreatedAt, now)
	}
}

func TestFakeDemoKWWKClientStrictModeRequiresQueuedResult(t *testing.T) {
	client := NewFakeDemoKWWKClient()
	client.SetStrict(true)

	_, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{SessionID: "demo_strict"},
		Kind:    DemoActionCapture,
	})
	if !errors.Is(err, errDemoKWWKNoQueuedResult) {
		t.Fatalf("DoDemoAction() error = %v, want errDemoKWWKNoQueuedResult", err)
	}
}

func TestFakeDemoKWWKClientHonorsContextCancellation(t *testing.T) {
	client := NewFakeDemoKWWKClient()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := client.DoDemoAction(ctx, DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{SessionID: "demo_cancelled"},
		Kind:    DemoActionCapture,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("DoDemoAction() error = %v, want context.Canceled", err)
	}
	if len(client.Requests()) != 0 {
		t.Fatalf("Requests() = %#v, want none after context cancellation", client.Requests())
	}
}

func TestFakeDemoKWWKClientReturnsInjectedError(t *testing.T) {
	client := NewFakeDemoKWWKClient()
	wantErr := errors.New("adapter failed")
	client.SetError(wantErr)

	_, err := client.DoDemoAction(context.Background(), DemoKWWKActionRequest{
		Session: DemoKWWKSessionRef{SessionID: "demo_error"},
		Kind:    DemoActionCapture,
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("DoDemoAction() error = %v, want injected err", err)
	}
	if len(client.Requests()) != 1 {
		t.Fatalf("Requests() = %d, want 1 recorded request", len(client.Requests()))
	}
}
