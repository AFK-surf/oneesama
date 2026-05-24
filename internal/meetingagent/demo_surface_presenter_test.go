package meetingagent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

type fakeDemoSurfaceShareClient struct {
	startCalls   []ScreenShareRequest
	presentCalls []ScreenShareRequest
	appCalls     []AppShareRequest
	stopCalls    []ScreenShareRequest

	startErr   error
	presentErr error
	appErr     error
	stopErr    error

	startResult   meetrunner.ScreenShareResult
	presentResult meetrunner.ScreenShareResult
	appResult     meetrunner.ScreenShareResult
	stopResult    meetrunner.ScreenShareResult
}

func (f *fakeDemoSurfaceShareClient) StartScreenShare(_ context.Context, input ScreenShareRequest) (meetrunner.ScreenShareResult, error) {
	f.startCalls = append(f.startCalls, input)
	if f.startResult != nil {
		return f.startResult, f.startErr
	}
	return meetrunner.ScreenShareResult{"ok": true, "op": "start", "mode": input.Mode, "title": input.Title}, f.startErr
}

func (f *fakeDemoSurfaceShareClient) PresentScreenShare(_ context.Context, input ScreenShareRequest) (meetrunner.ScreenShareResult, error) {
	f.presentCalls = append(f.presentCalls, input)
	if f.presentResult != nil {
		return f.presentResult, f.presentErr
	}
	return meetrunner.ScreenShareResult{"ok": true, "op": "present", "mode": input.Mode, "title": input.Title}, f.presentErr
}

func (f *fakeDemoSurfaceShareClient) PresentAppShare(_ context.Context, input AppShareRequest) (meetrunner.ScreenShareResult, error) {
	f.appCalls = append(f.appCalls, input)
	if f.appResult != nil {
		return f.appResult, f.appErr
	}
	return meetrunner.ScreenShareResult{"ok": true, "op": "app", "mode": input.Mode, "processId": input.ProcessID}, f.appErr
}

func (f *fakeDemoSurfaceShareClient) StopScreenShare(_ context.Context, input ScreenShareRequest) (meetrunner.ScreenShareResult, error) {
	f.stopCalls = append(f.stopCalls, input)
	if f.stopResult != nil {
		return f.stopResult, f.stopErr
	}
	return meetrunner.ScreenShareResult{"ok": true, "op": "stop", "stopped": true}, f.stopErr
}

func TestDemoSurfacePresenterUsesSyntheticShareForWorkspaceProcessByDefault(t *testing.T) {
	share := &fakeDemoSurfaceShareClient{}
	presenter := DemoSurfacePresenter{Share: share}

	result, err := presenter.Present(context.Background(), DemoSurfacePresentRequest{
		MeetingSessionID: "meet_session",
		DemoSession:      DemoWorkspaceSession{ID: "demo_session", ProcessID: 4242},
		Title:            "Dashboard walkthrough",
		Subtitle:         "KWWK demo",
		WaitMs:           250,
	})
	if err != nil {
		t.Fatalf("Present() error = %v", err)
	}

	if result.Status != DemoSurfacePresentationPresenting || result.Source != "screen_share_present" {
		t.Fatalf("result = %#v, want synthetic presenting", result)
	}
	if len(share.startCalls) != 1 || len(share.presentCalls) != 1 || len(share.appCalls) != 0 {
		t.Fatalf("calls start=%d present=%d app=%d, want start+present only", len(share.startCalls), len(share.presentCalls), len(share.appCalls))
	}
	start := share.startCalls[0]
	if start.SessionID != "meet_session" || start.Title != "Dashboard walkthrough" || start.Subtitle != "KWWK demo" || start.Mode != defaultDemoSurfaceStartMode || start.WaitMs != 250 {
		t.Fatalf("start call = %#v", start)
	}
	present := share.presentCalls[0]
	if present.Mode != defaultDemoSurfaceStartMode || present.SessionID != "meet_session" || present.Title != "Dashboard walkthrough" {
		t.Fatalf("present call = %#v", present)
	}
}

func TestDemoSurfacePresenterUsesAppShareForExplicitAppTarget(t *testing.T) {
	share := &fakeDemoSurfaceShareClient{}
	presenter := DemoSurfacePresenter{Share: share}

	result, err := presenter.Present(context.Background(), DemoSurfacePresentRequest{
		MeetingSessionID: "meet_session",
		DemoSession:      DemoWorkspaceSession{ID: "demo_session", ProcessID: 4242},
		Title:            "Dashboard walkthrough",
		Subtitle:         "KWWK demo",
		ProcessID:        4242,
		WaitMs:           250,
	})
	if err != nil {
		t.Fatalf("Present() error = %v", err)
	}

	if result.Status != DemoSurfacePresentationPresenting || result.Source != "screen_share_app" {
		t.Fatalf("result = %#v, want app presenting", result)
	}
	if len(share.startCalls) != 1 || len(share.appCalls) != 1 || len(share.presentCalls) != 0 {
		t.Fatalf("calls start=%d app=%d present=%d, want start+app only", len(share.startCalls), len(share.appCalls), len(share.presentCalls))
	}
	app := share.appCalls[0]
	if app.ProcessID != 4242 || app.Mode != defaultDemoSurfaceAppShareMode || app.SessionID != "meet_session" || app.Title != "Dashboard walkthrough" {
		t.Fatalf("app call = %#v", app)
	}
}

func TestDemoSurfacePresenterFallsBackToSyntheticShareWithoutAppTarget(t *testing.T) {
	share := &fakeDemoSurfaceShareClient{}
	presenter := DemoSurfacePresenter{Share: share}

	result, err := presenter.Present(context.Background(), DemoSurfacePresentRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "fixture_frame",
		PresentMode:      "synthetic",
	})
	if err != nil {
		t.Fatalf("Present() error = %v", err)
	}

	if result.Status != DemoSurfacePresentationPresenting || result.Source != "screen_share_present" {
		t.Fatalf("result = %#v, want synthetic presenting", result)
	}
	if len(share.startCalls) != 1 || len(share.presentCalls) != 1 || len(share.appCalls) != 0 {
		t.Fatalf("calls start=%d present=%d app=%d, want start+present only", len(share.startCalls), len(share.presentCalls), len(share.appCalls))
	}
	if share.startCalls[0].Title != defaultDemoSurfaceTitle || share.startCalls[0].Subtitle != defaultDemoSurfaceSubtitle {
		t.Fatalf("start defaults = %#v", share.startCalls[0])
	}
	if share.presentCalls[0].Mode != "synthetic" {
		t.Fatalf("present mode = %q, want synthetic", share.presentCalls[0].Mode)
	}
}

func TestDemoSurfacePresenterStopUsesExistingScreenShareStop(t *testing.T) {
	share := &fakeDemoSurfaceShareClient{}
	presenter := DemoSurfacePresenter{Share: share}

	result, err := presenter.Stop(context.Background(), DemoSurfaceStopRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_session",
	})
	if err != nil {
		t.Fatalf("Stop() error = %v", err)
	}

	if result.Status != DemoSurfacePresentationStopped || result.Source != "screen_share_stop" {
		t.Fatalf("result = %#v, want stopped", result)
	}
	if len(share.stopCalls) != 1 || share.stopCalls[0].SessionID != "meet_session" {
		t.Fatalf("stop calls = %#v", share.stopCalls)
	}
}

func TestDemoSurfacePresenterFailsBeforePresentWhenStartFails(t *testing.T) {
	startErr := errors.New("meet runner offline")
	share := &fakeDemoSurfaceShareClient{startErr: startErr}
	presenter := DemoSurfacePresenter{Share: share}

	result, err := presenter.Present(context.Background(), DemoSurfacePresentRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_session",
	})
	if !errors.Is(err, startErr) {
		t.Fatalf("Present() error = %v, want startErr", err)
	}
	if result.Status != DemoSurfacePresentationFailed || result.Reason != "screen_share_start_failed" {
		t.Fatalf("result = %#v, want start failure", result)
	}
	if len(share.presentCalls) != 0 || len(share.appCalls) != 0 {
		t.Fatalf("present/app called after start failure: present=%d app=%d", len(share.presentCalls), len(share.appCalls))
	}
}

func TestDemoSurfacePresenterFailsBeforePresentWhenStartReturnsNotOK(t *testing.T) {
	share := &fakeDemoSurfaceShareClient{
		startResult: meetrunner.ScreenShareResult{"ok": false, "error": "no_active_join"},
	}
	presenter := DemoSurfacePresenter{Share: share}

	result, err := presenter.Present(context.Background(), DemoSurfacePresentRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_session",
	})
	if err == nil || !strings.Contains(err.Error(), "no_active_join") {
		t.Fatalf("Present() error = %v, want no_active_join", err)
	}
	if result.Status != DemoSurfacePresentationFailed || result.Reason != "screen_share_start_failed" {
		t.Fatalf("result = %#v, want start failure", result)
	}
	if len(share.presentCalls) != 0 || len(share.appCalls) != 0 {
		t.Fatalf("present/app called after not-ok start: present=%d app=%d", len(share.presentCalls), len(share.appCalls))
	}
}

func TestDemoSurfacePresenterFailsWhenStopReturnsNotOK(t *testing.T) {
	share := &fakeDemoSurfaceShareClient{
		stopResult: meetrunner.ScreenShareResult{"ok": false, "error": "no_active_join"},
	}
	presenter := DemoSurfacePresenter{Share: share}

	result, err := presenter.Stop(context.Background(), DemoSurfaceStopRequest{
		MeetingSessionID: "meet_session",
		DemoSessionID:    "demo_session",
	})
	if err == nil || !strings.Contains(err.Error(), "no_active_join") {
		t.Fatalf("Stop() error = %v, want no_active_join", err)
	}
	if result.Status != DemoSurfacePresentationFailed || result.Reason != "screen_share_stop_failed" {
		t.Fatalf("result = %#v, want stop failure", result)
	}
	if len(share.stopCalls) != 1 {
		t.Fatalf("stop calls = %#v", share.stopCalls)
	}
}

func TestDemoSurfacePresenterRejectsMissingDependencies(t *testing.T) {
	presenter := DemoSurfacePresenter{}
	if _, err := presenter.Present(context.Background(), DemoSurfacePresentRequest{DemoSessionID: "demo"}); !errors.Is(err, errDemoSurfaceMissingShareClient) {
		t.Fatalf("Present() error = %v, want missing share client", err)
	}

	presenter = DemoSurfacePresenter{Share: &fakeDemoSurfaceShareClient{}}
	if _, err := presenter.Present(context.Background(), DemoSurfacePresentRequest{}); !errors.Is(err, errDemoSurfaceMissingSession) {
		t.Fatalf("Present() error = %v, want missing demo session", err)
	}
}
