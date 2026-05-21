package meetingagent

import (
	"context"
	"errors"
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

func TestRealtimeDemoBridgeControlUpdatesActiveSharedSurface(t *testing.T) {
	now := time.Date(2026, 5, 21, 18, 55, 0, 0, time.UTC)
	process := &fakeDemoWorkspaceProcess{pid: 5158}
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: process})
	lifecycle.now = func() time.Time { return now }
	share := &fakeDemoSurfaceShareClient{}
	client := NewFakeDemoKWWKClient()
	client.QueueResult(DemoKWWKActionResult{
		Summary:    "Oneesama Snake POC is visible with score: 0.",
		Confidence: 0.92,
	})
	client.QueueResult(DemoKWWKActionResult{
		Summary:    "The same shared demo browser now shows score: 1.",
		Confidence: 0.97,
	})
	store := NewDemoSessionStore().WithClock(func() time.Time { return now })
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Presenter: DemoSurfacePresenter{Share: share},
		Controller: DemoController{
			Client: client,
			Safety: DemoSafetyPolicy{
				URLAllowlistPatterns: []string{"https://example.test/"},
				AllowActiveControl:   true,
			},
			Now: func() time.Time { return now },
		},
		Store:        store,
		Observations: NewDemoObservationBus(),
	}

	start, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_change_surface",
		URL:              "https://example.test/snake",
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if start.Presentation == nil || start.Presentation.Source != "screen_share_app" {
		t.Fatalf("presentation = %#v, want shared app/window", start.Presentation)
	}
	control, err := bridge.Control(context.Background(), RealtimeDemoSurfaceControlRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_change_surface",
		Action:           DemoActionClick,
		Text:             "Start snake",
	})
	if err != nil {
		t.Fatalf("Control() error = %v", err)
	}
	if !control.OK || control.Status != realtimeDemoBridgeStatusUpdated || control.Observation == nil {
		t.Fatalf("control = %#v, want updated observation", control)
	}
	if control.Observation.Kind != demoObservationKindStep || !strings.Contains(control.Observation.Summary, "score: 1") {
		t.Fatalf("control observation = %#v, want post-click shared content", control.Observation)
	}
	if len(share.startCalls) != 1 || len(share.appCalls) != 1 || len(share.presentCalls) != 0 {
		t.Fatalf("share calls start=%d app=%d present=%d, want one initial shared window reused for control", len(share.startCalls), len(share.appCalls), len(share.presentCalls))
	}
	requests := client.Requests()
	if len(requests) != 2 || requests[0].Kind != DemoActionOpenURL || requests[1].Kind != DemoActionClick || requests[1].Text != "Start snake" {
		t.Fatalf("client requests = %#v, want open then click", requests)
	}
	if !strings.Contains(control.ObservationContext, "score: 0") || !strings.Contains(control.ObservationContext, "score: 1") {
		t.Fatalf("observation context = %q, want before and after content", control.ObservationContext)
	}
	entries, ok := store.Entries("demo_change_surface")
	if !ok || len(entries) != 3 || entries[2].ActionClass != DemoActionClick || entries[2].Result != DemoSessionResultAllowed {
		t.Fatalf("audit entries = %#v ok=%v, want trigger + open + click", entries, ok)
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
	process := &fakeDemoWorkspaceProcess{pid: 5153}
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: process})
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
	if result.Workspace == nil || result.Workspace.Status != DemoWorkspaceStatusStopped || !process.stopped {
		t.Fatalf("workspace = %#v stopped=%v, want stopped after failed observation", result.Workspace, process.stopped)
	}
	if _, ok := lifecycle.ActiveSession(); ok {
		t.Fatalf("active session still present after missing controller")
	}
	if !strings.Contains(result.ObservationContext, "controller_missing") {
		t.Fatalf("observation context = %q, want controller_missing", result.ObservationContext)
	}
}

func TestRealtimeDemoBridgeStartAdapterFailureStopsWorkspace(t *testing.T) {
	now := time.Date(2026, 5, 21, 17, 20, 0, 0, time.UTC)
	process := &fakeDemoWorkspaceProcess{pid: 5156}
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: process})
	lifecycle.now = func() time.Time { return now }
	client := NewFakeDemoKWWKClient()
	client.SetError(context.DeadlineExceeded)
	share := &fakeDemoSurfaceShareClient{}
	store := NewDemoSessionStore().WithClock(func() time.Time { return now })
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Presenter: DemoSurfacePresenter{Share: share},
		Controller: DemoController{
			Client: client,
			Safety: DemoSafetyPolicy{
				URLAllowlistPatterns: []string{"https://example.test/"},
			},
			Now: func() time.Time { return now },
		},
		Store:        store,
		Observations: NewDemoObservationBus(),
	}

	result, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_adapter_fail",
		URL:              "https://example.test/dashboard",
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Start() error = %v, want deadline exceeded", err)
	}
	if result.OK || result.Status != realtimeDemoBridgeStatusFailed || result.Workspace == nil || result.Workspace.Status != DemoWorkspaceStatusStopped {
		t.Fatalf("result = %#v, want failed with stopped workspace", result)
	}
	if !process.stopped || len(share.stopCalls) != 1 {
		t.Fatalf("process stopped=%v stopCalls=%d, want cleanup after adapter failure", process.stopped, len(share.stopCalls))
	}
	if _, ok := lifecycle.ActiveSession(); ok {
		t.Fatalf("active session still present after adapter failure")
	}
	entries, ok := store.Entries("demo_adapter_fail")
	if !ok || len(entries) != 3 || entries[1].Result != DemoSessionResultFailed || entries[2].Result != DemoSessionResultStopped {
		t.Fatalf("audit entries = %#v ok=%v, want trigger + failed action + close", entries, ok)
	}
}

func TestRealtimeDemoBridgeStartBlockedActionStopsWorkspace(t *testing.T) {
	now := time.Date(2026, 5, 21, 17, 25, 0, 0, time.UTC)
	process := &fakeDemoWorkspaceProcess{pid: 5157}
	lifecycle := NewDemoWorkspaceLifecycle(t.TempDir(), &fakeDemoWorkspaceLauncher{process: process})
	lifecycle.now = func() time.Time { return now }
	client := NewFakeDemoKWWKClient()
	share := &fakeDemoSurfaceShareClient{}
	store := NewDemoSessionStore().WithClock(func() time.Time { return now })
	bridge := &RealtimeDemoBridge{
		Lifecycle: lifecycle,
		Presenter: DemoSurfacePresenter{Share: share},
		Controller: DemoController{
			Client: client,
			Safety: DemoSafetyPolicy{
				URLAllowlistPatterns: []string{"https://allowed.test/"},
			},
			Now: func() time.Time { return now },
		},
		Store:        store,
		Observations: NewDemoObservationBus(),
	}

	result, err := bridge.Start(context.Background(), RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_blocked_url",
		URL:              "https://not-allowed.test/dashboard",
	})
	if !errors.Is(err, errRealtimeDemoBridgeActionBlocked) {
		t.Fatalf("Start() error = %v, want action blocked", err)
	}
	if result.OK || result.Status != realtimeDemoBridgeStatusFailed || result.Workspace == nil || result.Workspace.Status != DemoWorkspaceStatusStopped {
		t.Fatalf("result = %#v, want failed with stopped workspace", result)
	}
	if len(client.Requests()) != 0 {
		t.Fatalf("client requests = %#v, want blocked before adapter", client.Requests())
	}
	if !process.stopped || len(share.stopCalls) != 1 {
		t.Fatalf("process stopped=%v stopCalls=%d, want cleanup after blocked action", process.stopped, len(share.stopCalls))
	}
	entries, ok := store.Entries("demo_blocked_url")
	if !ok || len(entries) != 3 || entries[1].Result != DemoSessionResultBlocked || entries[2].Result != DemoSessionResultStopped {
		t.Fatalf("audit entries = %#v ok=%v, want trigger + blocked action + close", entries, ok)
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
