package meetingagent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

type DemoSurfacePresentationStatus string

const (
	DemoSurfacePresentationPresenting DemoSurfacePresentationStatus = "presenting"
	DemoSurfacePresentationStopped    DemoSurfacePresentationStatus = "stopped"
	DemoSurfacePresentationFailed     DemoSurfacePresentationStatus = "failed"
)

const (
	defaultDemoSurfaceTitle        = "Oneesama demo surface"
	defaultDemoSurfaceSubtitle     = "Bot-owned Computer Use workspace"
	defaultDemoSurfaceStartMode    = "synthetic"
	defaultDemoSurfaceAppShareMode = "native"
)

var (
	errDemoSurfaceMissingShareClient = errors.New("demo_surface_share_client_required")
	errDemoSurfaceMissingSession     = errors.New("demo_surface_session_required")
)

type DemoSurfaceShareClient interface {
	StartScreenShare(context.Context, ScreenShareRequest) (meetrunner.ScreenShareResult, error)
	PresentScreenShare(context.Context, ScreenShareRequest) (meetrunner.ScreenShareResult, error)
	PresentAppShare(context.Context, AppShareRequest) (meetrunner.ScreenShareResult, error)
	StopScreenShare(context.Context, ScreenShareRequest) (meetrunner.ScreenShareResult, error)
}

type DemoSurfacePresenter struct {
	Share DemoSurfaceShareClient
}

type DemoSurfacePresentRequest struct {
	MeetingSessionID string
	DemoSession      DemoWorkspaceSession
	DemoSessionID    string
	Title            string
	Subtitle         string
	Preview          bool
	WaitMs           int
	StartMode        string
	PresentMode      string
	ProcessID        int
	BundleIdentifier string
	ApplicationName  string
	ImageURL         string
	FramePath        string
}

type DemoSurfaceStopRequest struct {
	MeetingSessionID string
	DemoSessionID    string
}

type DemoSurfacePresentation struct {
	MeetingSessionID string
	DemoSessionID    string
	Status           DemoSurfacePresentationStatus
	Source           string
	Started          meetrunner.ScreenShareResult
	Presented        meetrunner.ScreenShareResult
	Stopped          meetrunner.ScreenShareResult
	Reason           string
}

func (p DemoSurfacePresenter) Present(ctx context.Context, req DemoSurfacePresentRequest) (DemoSurfacePresentation, error) {
	if p.Share == nil {
		return DemoSurfacePresentation{Status: DemoSurfacePresentationFailed, Reason: errDemoSurfaceMissingShareClient.Error()}, errDemoSurfaceMissingShareClient
	}
	demoSessionID := firstNonEmpty(req.DemoSessionID, req.DemoSession.ID)
	if strings.TrimSpace(demoSessionID) == "" {
		return DemoSurfacePresentation{Status: DemoSurfacePresentationFailed, Reason: errDemoSurfaceMissingSession.Error()}, errDemoSurfaceMissingSession
	}

	out := DemoSurfacePresentation{
		MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
		DemoSessionID:    strings.TrimSpace(demoSessionID),
		Status:           DemoSurfacePresentationPresenting,
	}
	base := ScreenShareRequest{
		SessionID: out.MeetingSessionID,
		Title:     firstNonEmpty(req.Title, defaultDemoSurfaceTitle),
		Subtitle:  firstNonEmpty(req.Subtitle, defaultDemoSurfaceSubtitle),
		Preview:   req.Preview,
		Mode:      firstNonEmpty(req.StartMode, defaultDemoSurfaceStartMode),
		WaitMs:    req.WaitMs,
		ImageURL:  strings.TrimSpace(req.ImageURL),
		ImagePath: strings.TrimSpace(req.FramePath),
		FramePath: strings.TrimSpace(req.FramePath),
	}
	started, err := p.Share.StartScreenShare(ctx, base)
	out.Started = started
	if err != nil {
		out.Status = DemoSurfacePresentationFailed
		out.Reason = "screen_share_start_failed"
		return out, err
	}
	if screenShareResultFailed(started) {
		out.Status = DemoSurfacePresentationFailed
		out.Reason = "screen_share_start_failed"
		return out, screenShareResultFailureError(out.Reason, started)
	}

	if appRequest, ok := req.appShareRequest(base); ok {
		presented, err := p.Share.PresentAppShare(ctx, appRequest)
		out.Presented = presented
		out.Source = "screen_share_app"
		if err != nil {
			out.Status = DemoSurfacePresentationFailed
			out.Reason = "screen_share_app_failed"
			return out, err
		}
		if screenShareResultFailed(presented) {
			out.Status = DemoSurfacePresentationFailed
			out.Reason = "screen_share_app_failed"
			return out, screenShareResultFailureError(out.Reason, presented)
		}
		return out, nil
	}

	presentRequest := base
	presentRequest.Mode = firstNonEmpty(req.PresentMode, req.StartMode, defaultDemoSurfaceStartMode)
	presented, err := p.Share.PresentScreenShare(ctx, presentRequest)
	out.Presented = presented
	out.Source = "screen_share_present"
	if err != nil {
		out.Status = DemoSurfacePresentationFailed
		out.Reason = "screen_share_present_failed"
		return out, err
	}
	if screenShareResultFailed(presented) {
		out.Status = DemoSurfacePresentationFailed
		out.Reason = "screen_share_present_failed"
		return out, screenShareResultFailureError(out.Reason, presented)
	}
	return out, nil
}

func (p DemoSurfacePresenter) Update(ctx context.Context, req DemoSurfacePresentRequest) (DemoSurfacePresentation, error) {
	if p.Share == nil {
		return DemoSurfacePresentation{Status: DemoSurfacePresentationFailed, Reason: errDemoSurfaceMissingShareClient.Error()}, errDemoSurfaceMissingShareClient
	}
	demoSessionID := firstNonEmpty(req.DemoSessionID, req.DemoSession.ID)
	if strings.TrimSpace(demoSessionID) == "" {
		return DemoSurfacePresentation{Status: DemoSurfacePresentationFailed, Reason: errDemoSurfaceMissingSession.Error()}, errDemoSurfaceMissingSession
	}
	out := DemoSurfacePresentation{
		MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
		DemoSessionID:    strings.TrimSpace(demoSessionID),
		Status:           DemoSurfacePresentationPresenting,
		Source:           "screen_share_update",
	}
	updated, err := p.Share.StartScreenShare(ctx, ScreenShareRequest{
		SessionID: out.MeetingSessionID,
		Title:     strings.TrimSpace(req.Title),
		Subtitle:  strings.TrimSpace(req.Subtitle),
		Mode:      firstNonEmpty(req.StartMode, defaultDemoSurfaceStartMode),
		WaitMs:    req.WaitMs,
		ImageURL:  strings.TrimSpace(req.ImageURL),
		ImagePath: strings.TrimSpace(req.FramePath),
		FramePath: strings.TrimSpace(req.FramePath),
	})
	out.Presented = updated
	if err != nil {
		out.Status = DemoSurfacePresentationFailed
		out.Reason = "screen_share_update_failed"
		return out, err
	}
	if screenShareResultFailed(updated) {
		out.Status = DemoSurfacePresentationFailed
		out.Reason = "screen_share_update_failed"
		return out, screenShareResultFailureError(out.Reason, updated)
	}
	return out, nil
}

func (p DemoSurfacePresenter) Stop(ctx context.Context, req DemoSurfaceStopRequest) (DemoSurfacePresentation, error) {
	if p.Share == nil {
		return DemoSurfacePresentation{Status: DemoSurfacePresentationFailed, Reason: errDemoSurfaceMissingShareClient.Error()}, errDemoSurfaceMissingShareClient
	}
	stopped, err := p.Share.StopScreenShare(ctx, ScreenShareRequest{SessionID: strings.TrimSpace(req.MeetingSessionID)})
	out := DemoSurfacePresentation{
		MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
		DemoSessionID:    strings.TrimSpace(req.DemoSessionID),
		Stopped:          stopped,
	}
	if err != nil {
		out.Status = DemoSurfacePresentationFailed
		out.Reason = "screen_share_stop_failed"
		return out, err
	}
	if screenShareResultFailed(stopped) {
		out.Status = DemoSurfacePresentationFailed
		out.Reason = "screen_share_stop_failed"
		return out, screenShareResultFailureError(out.Reason, stopped)
	}
	out.Status = DemoSurfacePresentationStopped
	out.Source = "screen_share_stop"
	return out, nil
}

func screenShareResultFailed(result meetrunner.ScreenShareResult) bool {
	if len(result) == 0 {
		return false
	}
	ok, exists := result["ok"].(bool)
	return exists && !ok
}

func screenShareResultFailureError(reason string, result meetrunner.ScreenShareResult) error {
	detail := strings.TrimSpace(stringFromAny(result["error"]))
	if detail == "" {
		detail = strings.TrimSpace(stringFromAny(result["reason"]))
	}
	if detail == "" {
		detail = "screen_share_result_not_ok"
	}
	return fmt.Errorf("%s: %s", reason, detail)
}

func (req DemoSurfacePresentRequest) appShareRequest(base ScreenShareRequest) (AppShareRequest, bool) {
	processID := req.ProcessID
	bundleID := strings.TrimSpace(req.BundleIdentifier)
	appName := strings.TrimSpace(req.ApplicationName)
	if processID == 0 && bundleID == "" && appName == "" {
		return AppShareRequest{}, false
	}
	return AppShareRequest{
		ScreenShareRequest: ScreenShareRequest{
			SessionID: base.SessionID,
			Title:     base.Title,
			Subtitle:  base.Subtitle,
			Preview:   base.Preview,
			Mode:      firstNonEmpty(req.PresentMode, defaultDemoSurfaceAppShareMode),
			WaitMs:    base.WaitMs,
		},
		ProcessID:        processID,
		BundleIdentifier: bundleID,
		ApplicationName:  appName,
	}, true
}
