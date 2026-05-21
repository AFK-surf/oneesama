package meetingagent

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestRealtimeDemoBridgeStartPublishesObservationContext(t *testing.T) {
	now := time.Date(2026, 5, 21, 14, 20, 0, 0, time.UTC)
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: &fakeDemoWorkspaceProcess{pid: 5151}})
	lifecycle.now = func() time.Time { return now }
	share := &fakeDemoSurfaceShareClient{}
	client := NewFakeDemoKWWKClient()
	client.now = func() time.Time { return now }
	client.QueueResult(DemoKWWKActionResult{
		Summary:    "The demo dashboard is visible and ready.",
		Confidence: 0.95,
		FramePath:  "/tmp/demo/frame-001.png",
	})
	store := NewDemoSessionStore().WithClock(func() time.Time { return now })
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Controller: DemoController{
			Client: client,
			Safety: DemoSafetyPolicy{
				URLAllowlistPatterns: []string{"https://example.test/"},
			},
			Now: func() time.Time { return now },
		},
		Presenter:    DemoSurfacePresenter{Share: share},
		Store:        store,
		Observations: NewDemoObservationBus(),
	}

	result, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_bridge",
		URL:              "https://example.test/dashboard",
		Goal:             "show dashboard",
		Actor:            "Peng",
		Surface:          "meeting",
		ChannelID:        "C123",
		ThreadTS:         "1779339423.969229",
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	if !result.OK || result.Status != realtimeDemoBridgeStatusStarted || result.SessionID != "demo_bridge" {
		t.Fatalf("result = %#v, want started demo_bridge", result)
	}
	if result.Presentation == nil || result.Presentation.Source != "screen_share_app" {
		t.Fatalf("presentation = %#v, want app share", result.Presentation)
	}
	if result.Observation == nil || result.Observation.Summary != "The demo dashboard is visible and ready." {
		t.Fatalf("observation = %#v", result.Observation)
	}
	if result.FeedbackKind != DemoFeedbackOpened || !result.ShouldSpeak || result.FeedbackText != "The demo dashboard is visible and ready." {
		t.Fatalf("feedback = kind=%q speak=%v text=%q", result.FeedbackKind, result.ShouldSpeak, result.FeedbackText)
	}
	if !strings.Contains(result.ObservationContext, "surface_opened: The demo dashboard is visible and ready.") {
		t.Fatalf("observation context = %q", result.ObservationContext)
	}
	if len(client.Requests()) != 1 || client.Requests()[0].Kind != DemoActionOpenURL {
		t.Fatalf("client requests = %#v, want one open_url", client.Requests())
	}
	entries, ok := store.Entries("demo_bridge")
	if !ok || len(entries) != 2 {
		t.Fatalf("audit entries = %#v ok=%v, want trigger+action", entries, ok)
	}
	if entries[1].Result != DemoSessionResultAllowed || entries[1].ArtifactRefs[0] != "/tmp/demo/frame-001.png" {
		t.Fatalf("action audit entry = %#v", entries[1])
	}
}

func TestRealtimeDemoBridgeCancelStopsPresentationAndWorkspace(t *testing.T) {
	now := time.Date(2026, 5, 21, 14, 25, 0, 0, time.UTC)
	process := &fakeDemoWorkspaceProcess{pid: 5152}
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: process})
	lifecycle.now = func() time.Time { return now }
	share := &fakeDemoSurfaceShareClient{}
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Presenter: DemoSurfacePresenter{Share: share},
		Controller: DemoController{
			Client: NewFakeDemoKWWKClient(),
			Safety: DemoSafetyPolicy{
				URLAllowlistPatterns: []string{"https://example.test/"},
			},
			Now: func() time.Time { return now },
		},
		Store:        NewDemoSessionStore().WithClock(func() time.Time { return now }),
		Observations: NewDemoObservationBus(),
	}

	if _, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_cancel",
		URL:              "https://example.test/dashboard",
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	result, err := bridge.Cancel(context.Background(), RealtimeDemoSurfaceCancelRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_cancel",
		Reason:           "user_stop",
	})
	if err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}

	if !result.OK || result.Status != realtimeDemoBridgeStatusStopped || result.SessionID != "demo_cancel" {
		t.Fatalf("cancel result = %#v", result)
	}
	if result.Presentation == nil || result.Presentation.Status != DemoSurfacePresentationStopped {
		t.Fatalf("presentation = %#v, want stopped", result.Presentation)
	}
	if !process.stopped || len(share.stopCalls) != 1 {
		t.Fatalf("process stopped=%v stopCalls=%d", process.stopped, len(share.stopCalls))
	}
	if _, ok := lifecycle.ActiveSession(); ok {
		t.Fatalf("active session still present after cancel")
	}
}

func TestRealtimeDemoBridgeStartPresentationFailureStopsWorkspace(t *testing.T) {
	now := time.Date(2026, 5, 21, 16, 55, 0, 0, time.UTC)
	process := &fakeDemoWorkspaceProcess{pid: 5154}
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: process})
	lifecycle.now = func() time.Time { return now }
	share := &fakeDemoSurfaceShareClient{
		startResult: map[string]any{"ok": false, "error": "no_active_join"},
	}
	store := NewDemoSessionStore().WithClock(func() time.Time { return now })
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Presenter: DemoSurfacePresenter{Share: share},
		Controller: DemoController{
			Client: NewFakeDemoKWWKClient(),
			Safety: DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://example.test/"}},
			Now:    func() time.Time { return now },
		},
		Store: store,
	}

	result, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_present_fail",
		URL:              "https://example.test/dashboard",
	})
	if err == nil || !strings.Contains(err.Error(), "no_active_join") {
		t.Fatalf("Start() error = %v, want no_active_join", err)
	}
	if result.OK || result.Status != realtimeDemoBridgeStatusFailed || result.Workspace == nil || result.Workspace.Status != DemoWorkspaceStatusStopped {
		t.Fatalf("result = %#v, want failed with stopped workspace", result)
	}
	if !process.stopped {
		t.Fatalf("workspace process was not stopped after presentation failure")
	}
	if _, ok := lifecycle.ActiveSession(); ok {
		t.Fatalf("active session still present after presentation failure")
	}
	entries, ok := store.Entries("demo_present_fail")
	if !ok || len(entries) != 3 || entries[1].Result != DemoSessionResultFailed || entries[2].Result != DemoSessionResultStopped {
		t.Fatalf("audit entries = %#v ok=%v, want trigger + failed action + close", entries, ok)
	}
}

func TestRealtimeDemoBridgeCancelPresentationFailureStillStopsWorkspace(t *testing.T) {
	now := time.Date(2026, 5, 21, 16, 58, 0, 0, time.UTC)
	process := &fakeDemoWorkspaceProcess{pid: 5155}
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: process})
	lifecycle.now = func() time.Time { return now }
	share := &fakeDemoSurfaceShareClient{}
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Presenter: DemoSurfacePresenter{Share: share},
		Controller: DemoController{
			Client: NewFakeDemoKWWKClient(),
			Safety: DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://example.test/"}},
			Now:    func() time.Time { return now },
		},
		Store: NewDemoSessionStore().WithClock(func() time.Time { return now }),
	}

	if _, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_cancel_fail",
		URL:              "https://example.test/dashboard",
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	share.stopResult = map[string]any{"ok": false, "error": "no_active_join"}
	result, err := bridge.Cancel(context.Background(), RealtimeDemoSurfaceCancelRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_cancel_fail",
		Reason:           "user_stop",
	})
	if err == nil || !strings.Contains(err.Error(), "no_active_join") {
		t.Fatalf("Cancel() error = %v, want no_active_join", err)
	}
	if result.OK || result.Status != realtimeDemoBridgeStatusFailed || result.Workspace == nil || result.Workspace.Status != DemoWorkspaceStatusStopped {
		t.Fatalf("cancel result = %#v, want failed but stopped workspace", result)
	}
	if !process.stopped {
		t.Fatalf("workspace process was not stopped after cancel presentation failure")
	}
	if _, ok := lifecycle.ActiveSession(); ok {
		t.Fatalf("active session still present after cancel presentation failure")
	}
}

func TestRealtimeDemoBridgeMissingControllerRecordsFailedObservation(t *testing.T) {
	now := time.Date(2026, 5, 21, 14, 30, 0, 0, time.UTC)
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: &fakeDemoWorkspaceProcess{pid: 5153}})
	lifecycle.now = func() time.Time { return now }
	bridge := &RealtimeDemoBridge{
		Lifecycle:    lifecycle,
		Presenter:    DemoSurfacePresenter{Share: &fakeDemoSurfaceShareClient{}},
		Store:        NewDemoSessionStore().WithClock(func() time.Time { return now }),
		Observations: NewDemoObservationBus(),
	}

	result, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_missing_controller",
		URL:              "https://example.test/dashboard",
	})
	if err != errRealtimeDemoBridgeMissingController {
		t.Fatalf("Start() error = %v, want missing controller", err)
	}
	if result.OK || result.Status != realtimeDemoBridgeStatusFailed {
		t.Fatalf("result = %#v, want failed", result)
	}
	if result.Observation == nil || result.Observation.Kind != demoObservationKindFailed {
		t.Fatalf("observation = %#v, want failed observation", result.Observation)
	}
	if !strings.Contains(result.ObservationContext, "controller_missing") {
		t.Fatalf("observation context = %q, want controller_missing", result.ObservationContext)
	}
}

func TestDemoObservationBusReturnsDefensiveRecentContext(t *testing.T) {
	bus := NewDemoObservationBus()
	bus.Publish(DemoObservation{SessionID: "demo_bus", Sequence: 1, Kind: demoObservationKindOpened, Summary: "opened"})
	bus.Publish(DemoObservation{SessionID: "demo_bus", Sequence: 2, Kind: demoObservationKindScrolled, Summary: "scrolled"})

	recent := bus.Recent("demo_bus", 1)
	if len(recent) != 1 || recent[0].Summary != "scrolled" {
		t.Fatalf("recent = %#v, want latest scrolled", recent)
	}
	recent[0].Summary = "mutated"
	again := bus.Recent("demo_bus", 1)
	if again[0].Summary != "scrolled" {
		t.Fatalf("bus allowed external mutation: %#v", again)
	}
	if context := bus.Context("demo_bus", 2); !strings.Contains(context, "#1 surface_opened: opened") || !strings.Contains(context, "#2 surface_scrolled: scrolled") {
		t.Fatalf("context = %q", context)
	}
}
