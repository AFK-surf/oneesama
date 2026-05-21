package meetingagent

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

const (
	realtimeDemoBridgeStatusStarted = "started"
	realtimeDemoBridgeStatusStopped = "stopped"
	realtimeDemoBridgeStatusFailed  = "failed"
)

var (
	errRealtimeDemoBridgeUnavailable       = errors.New("realtime_demo_bridge_unavailable")
	errRealtimeDemoBridgeMissingLifecycle  = errors.New("realtime_demo_bridge_lifecycle_required")
	errRealtimeDemoBridgeMissingPresenter  = errors.New("realtime_demo_bridge_presenter_required")
	errRealtimeDemoBridgeMissingController = errors.New("realtime_demo_bridge_controller_required")
	errRealtimeDemoBridgeActionBlocked     = errors.New("realtime_demo_bridge_action_blocked")
)

type DemoWorkspaceLifecycleClient interface {
	Start(context.Context, DemoWorkspaceStartRequest) (DemoWorkspaceSession, error)
	Stop(context.Context, string) (DemoWorkspaceSession, error)
	ActiveSession() (DemoWorkspaceSession, bool)
}

type DemoIntentRunner interface {
	RunIntent(context.Context, DemoIntent) (DemoControllerResult, error)
}

type DemoSurfacePresentationClient interface {
	Present(context.Context, DemoSurfacePresentRequest) (DemoSurfacePresentation, error)
	Stop(context.Context, DemoSurfaceStopRequest) (DemoSurfacePresentation, error)
}

type RealtimeDemoBridge struct {
	Lifecycle    DemoWorkspaceLifecycleClient
	Controller   DemoIntentRunner
	Presenter    DemoSurfacePresentationClient
	Store        *DemoSessionStore
	Observations *DemoObservationBus
	Renderer     DemoFeedbackRenderer
	RunAsync     bool
	Now          func() time.Time

	mu      sync.Mutex
	cancels map[string]*DemoCancelToken
}

type RealtimeDemoSurfaceStartRequest struct {
	MeetingSessionID string `json:"session_id,omitempty"`
	DemoSessionID    string `json:"demo_session_id,omitempty"`
	URL              string `json:"url,omitempty"`
	Goal             string `json:"goal,omitempty"`
	Instruction      string `json:"instruction,omitempty"`
	Title            string `json:"title,omitempty"`
	Subtitle         string `json:"subtitle,omitempty"`
	Actor            string `json:"actor,omitempty"`
	Surface          string `json:"surface,omitempty"`
	ChannelID        string `json:"channel_id,omitempty"`
	ThreadTS         string `json:"thread_ts,omitempty"`
}

type RealtimeDemoSurfaceCancelRequest struct {
	MeetingSessionID string `json:"session_id,omitempty"`
	DemoSessionID    string `json:"demo_session_id,omitempty"`
	Reason           string `json:"reason,omitempty"`
}

type RealtimeDemoBridgeResult struct {
	OK                 bool                     `json:"ok"`
	Status             string                   `json:"status"`
	SessionID          string                   `json:"session_id,omitempty"`
	MeetingSessionID   string                   `json:"meeting_session_id,omitempty"`
	Async              bool                     `json:"async,omitempty"`
	Presentation       *DemoSurfacePresentation `json:"presentation,omitempty"`
	Workspace          *DemoWorkspaceSession    `json:"workspace,omitempty"`
	Observation        *DemoObservation         `json:"observation,omitempty"`
	FeedbackKind       DemoFeedbackKind         `json:"feedback_kind,omitempty"`
	FeedbackText       string                   `json:"feedback_text,omitempty"`
	ShouldSpeak        bool                     `json:"should_speak,omitempty"`
	ObservationContext string                   `json:"observation_context,omitempty"`
	Error              string                   `json:"error,omitempty"`
	Audit              []DemoSessionAuditEntry  `json:"audit,omitempty"`
}

func (b *RealtimeDemoBridge) Start(ctx context.Context, req RealtimeDemoSurfaceStartRequest) (RealtimeDemoBridgeResult, error) {
	if b == nil {
		return RealtimeDemoBridgeResult{OK: false, Status: realtimeDemoBridgeStatusFailed, Error: errRealtimeDemoBridgeUnavailable.Error()}, errRealtimeDemoBridgeUnavailable
	}
	if b.Lifecycle == nil {
		return RealtimeDemoBridgeResult{OK: false, Status: realtimeDemoBridgeStatusFailed, Error: errRealtimeDemoBridgeMissingLifecycle.Error()}, errRealtimeDemoBridgeMissingLifecycle
	}
	if b.Presenter == nil {
		return RealtimeDemoBridgeResult{OK: false, Status: realtimeDemoBridgeStatusFailed, Error: errRealtimeDemoBridgeMissingPresenter.Error()}, errRealtimeDemoBridgeMissingPresenter
	}

	workspace, err := b.Lifecycle.Start(ctx, DemoWorkspaceStartRequest{
		SessionID: strings.TrimSpace(req.DemoSessionID),
		URL:       strings.TrimSpace(req.URL),
		Now:       b.timestamp(),
	})
	if err != nil {
		return RealtimeDemoBridgeResult{OK: false, Status: realtimeDemoBridgeStatusFailed, Error: err.Error()}, err
	}

	if b.Store != nil {
		_, _ = b.Store.RecordTrigger(DemoSessionTriggerRequest{
			SessionID: workspace.ID,
			Actor:     strings.TrimSpace(req.Actor),
			ThreadKey: DemoSessionThreadKey{
				Surface:   strings.TrimSpace(req.Surface),
				ChannelID: strings.TrimSpace(req.ChannelID),
				ThreadTS:  strings.TrimSpace(req.ThreadTS),
			},
			URL: workspace.URL,
		})
	}

	presentation, err := b.Presenter.Present(ctx, DemoSurfacePresentRequest{
		MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
		DemoSession:      workspace,
		Title:            strings.TrimSpace(req.Title),
		Subtitle:         strings.TrimSpace(req.Subtitle),
	})
	if err != nil {
		b.recordAction(workspace.ID, DemoActionOpenURL, workspace.URL, DemoSessionResultFailed, presentation.Reason, nil)
		stoppedWorkspace := workspace
		if stopped, stopErr := b.Lifecycle.Stop(ctx, workspace.ID); stopErr == nil {
			stoppedWorkspace = stopped
			b.recordClose(stopped.ID, firstNonEmpty(presentation.Reason, "presentation_failed"))
		}
		return RealtimeDemoBridgeResult{
			OK:               false,
			Status:           realtimeDemoBridgeStatusFailed,
			SessionID:        workspace.ID,
			MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
			Workspace:        &stoppedWorkspace,
			Presentation:     &presentation,
			Error:            err.Error(),
		}, err
	}

	token := NewDemoCancelToken()
	b.setCancel(workspace.ID, token)
	run := func(runCtx context.Context) (DemoObservation, DemoFeedback, error) {
		return b.runObservation(runCtx, workspace, req, token)
	}

	result := RealtimeDemoBridgeResult{
		OK:               true,
		Status:           realtimeDemoBridgeStatusStarted,
		SessionID:        workspace.ID,
		MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
		Async:            b.RunAsync,
		Workspace:        &workspace,
		Presentation:     &presentation,
	}
	if b.RunAsync {
		go func() {
			if _, _, err := run(context.Background()); err != nil {
				b.cleanupFailedStartedDemo(context.Background(), workspace, req, err.Error())
			}
		}()
		return result, nil
	}

	obs, feedback, err := run(ctx)
	result.Observation = &obs
	result.FeedbackKind = feedback.Kind
	result.FeedbackText = feedback.Spoken
	result.ShouldSpeak = feedback.ShouldSpeak
	result.ObservationContext = b.observationContext(workspace.ID)
	if err != nil {
		stoppedWorkspace := b.cleanupFailedStartedDemo(ctx, workspace, req, err.Error())
		result.OK = false
		result.Status = realtimeDemoBridgeStatusFailed
		result.Error = err.Error()
		result.Workspace = &stoppedWorkspace
		return result, err
	}
	return result, nil
}

func (b *RealtimeDemoBridge) Cancel(ctx context.Context, req RealtimeDemoSurfaceCancelRequest) (RealtimeDemoBridgeResult, error) {
	if b == nil {
		return RealtimeDemoBridgeResult{OK: false, Status: realtimeDemoBridgeStatusFailed, Error: errRealtimeDemoBridgeUnavailable.Error()}, errRealtimeDemoBridgeUnavailable
	}
	if b.Lifecycle == nil {
		return RealtimeDemoBridgeResult{OK: false, Status: realtimeDemoBridgeStatusFailed, Error: errRealtimeDemoBridgeMissingLifecycle.Error()}, errRealtimeDemoBridgeMissingLifecycle
	}
	sessionID := strings.TrimSpace(req.DemoSessionID)
	if sessionID == "" {
		if active, ok := b.Lifecycle.ActiveSession(); ok {
			sessionID = active.ID
		}
	}
	if token := b.popCancel(sessionID); token != nil {
		token.Cancel(firstNonEmpty(strings.TrimSpace(req.Reason), "cancel_requested"))
	}

	var presentation *DemoSurfacePresentation
	var presentationErr error
	if b.Presenter != nil {
		stopped, err := b.Presenter.Stop(ctx, DemoSurfaceStopRequest{
			MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
			DemoSessionID:    sessionID,
		})
		presentation = &stopped
		if err != nil {
			b.recordAction(sessionID, DemoActionCapture, "", DemoSessionResultFailed, stopped.Reason, nil)
			presentationErr = err
		}
	}
	workspace, err := b.Lifecycle.Stop(ctx, sessionID)
	if err != nil {
		return RealtimeDemoBridgeResult{OK: false, Status: realtimeDemoBridgeStatusFailed, SessionID: sessionID, Presentation: presentation, Error: err.Error()}, err
	}
	b.recordClose(workspace.ID, firstNonEmpty(strings.TrimSpace(req.Reason), "cancel_requested"))
	if presentationErr != nil {
		return RealtimeDemoBridgeResult{
			OK:               false,
			Status:           realtimeDemoBridgeStatusFailed,
			SessionID:        workspace.ID,
			MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
			Workspace:        &workspace,
			Presentation:     presentation,
			Audit:            b.entries(workspace.ID),
			Error:            presentationErr.Error(),
		}, presentationErr
	}
	return RealtimeDemoBridgeResult{
		OK:               true,
		Status:           realtimeDemoBridgeStatusStopped,
		SessionID:        workspace.ID,
		MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
		Workspace:        &workspace,
		Presentation:     presentation,
		Audit:            b.entries(workspace.ID),
	}, nil
}

func (b *RealtimeDemoBridge) runObservation(ctx context.Context, workspace DemoWorkspaceSession, req RealtimeDemoSurfaceStartRequest, token *DemoCancelToken) (DemoObservation, DemoFeedback, error) {
	if b.Controller == nil {
		obs := DemoObservation{
			SessionID:  workspace.ID,
			Sequence:   1,
			Source:     demoKWWKObservationSource,
			Kind:       demoObservationKindFailed,
			Summary:    "demo action failed: controller_missing",
			Confidence: 1,
			CreatedAt:  b.timestamp(),
		}
		b.publishObservation(obs)
		feedback := b.renderer().Render(obs)
		b.recordAction(workspace.ID, DemoActionOpenURL, workspace.URL, DemoSessionResultFailed, errRealtimeDemoBridgeMissingController.Error(), []string{obs.FramePath})
		return obs, feedback, errRealtimeDemoBridgeMissingController
	}

	kind := DemoActionOpenURL
	if strings.TrimSpace(workspace.URL) == "" {
		kind = DemoActionCapture
	}
	controllerResult, err := b.Controller.RunIntent(ctx, DemoIntent{
		Session:     DemoKWWKSessionFromWorkspace(workspace),
		Kind:        kind,
		URL:         workspace.URL,
		Instruction: firstNonEmpty(strings.TrimSpace(req.Instruction), strings.TrimSpace(req.Goal)),
		Sequence:    1,
		Cancel:      token,
	})
	obs := controllerResult.Observation
	if strings.TrimSpace(obs.SessionID) == "" {
		obs.SessionID = workspace.ID
	}
	if obs.CreatedAt.IsZero() {
		obs.CreatedAt = b.timestamp()
	}
	b.publishObservation(obs)
	feedback := b.renderer().Render(obs)
	result := demoSessionResultFromController(controllerResult, err)
	reason := firstNonEmpty(controllerResult.Verdict.Reason, feedback.AuditDetail)
	if err != nil {
		reason = firstNonEmpty(reason, err.Error())
	}
	b.recordAction(workspace.ID, kind, workspace.URL, result, reason, []string{obs.FramePath})
	if controllerResult.Verdict.Decision == DemoActionDecisionBlock {
		return obs, feedback, errRealtimeDemoBridgeActionBlocked
	}
	return obs, feedback, err
}

func (b *RealtimeDemoBridge) cleanupFailedStartedDemo(ctx context.Context, workspace DemoWorkspaceSession, req RealtimeDemoSurfaceStartRequest, reason string) DemoWorkspaceSession {
	b.popCancel(workspace.ID)
	if b.Presenter != nil {
		_, _ = b.Presenter.Stop(ctx, DemoSurfaceStopRequest{
			MeetingSessionID: strings.TrimSpace(req.MeetingSessionID),
			DemoSessionID:    workspace.ID,
		})
	}
	stoppedWorkspace := workspace
	if b.Lifecycle != nil {
		if stopped, stopErr := b.Lifecycle.Stop(ctx, workspace.ID); stopErr == nil {
			stoppedWorkspace = stopped
		}
	}
	b.recordClose(workspace.ID, firstNonEmpty(strings.TrimSpace(reason), "demo_start_failed"))
	return stoppedWorkspace
}

func demoSessionResultFromController(result DemoControllerResult, err error) DemoSessionResult {
	if err != nil {
		return DemoSessionResultFailed
	}
	switch result.Verdict.Decision {
	case DemoActionDecisionBlock:
		return DemoSessionResultBlocked
	case DemoActionDecisionDryRun:
		return DemoSessionResultDryRun
	default:
		return DemoSessionResultAllowed
	}
}

func (b *RealtimeDemoBridge) publishObservation(obs DemoObservation) {
	b.observationBus().Publish(obs)
}

func (b *RealtimeDemoBridge) observationContext(sessionID string) string {
	return b.observationBus().Context(sessionID, defaultDemoObservationContextLimit)
}

func (b *RealtimeDemoBridge) observationBus() *DemoObservationBus {
	if b.Observations != nil {
		return b.Observations
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.Observations == nil {
		b.Observations = NewDemoObservationBus()
	}
	return b.Observations
}

func (b *RealtimeDemoBridge) renderer() DemoFeedbackRenderer {
	return b.Renderer
}

func (b *RealtimeDemoBridge) recordAction(sessionID string, action DemoActionKind, url string, result DemoSessionResult, reason string, artifactRefs []string) {
	if b.Store == nil || strings.TrimSpace(sessionID) == "" {
		return
	}
	cleanRefs := make([]string, 0, len(artifactRefs))
	for _, ref := range artifactRefs {
		if strings.TrimSpace(ref) != "" {
			cleanRefs = append(cleanRefs, strings.TrimSpace(ref))
		}
	}
	_, _ = b.Store.RecordAction(DemoSessionActionRequest{
		SessionID:    sessionID,
		ActionClass:  action,
		URL:          url,
		Result:       result,
		ReasonCode:   firstNonEmpty(strings.TrimSpace(reason), "demo_action_recorded"),
		ArtifactRefs: cleanRefs,
	})
}

func (b *RealtimeDemoBridge) recordClose(sessionID string, reason string) {
	if b.Store == nil || strings.TrimSpace(sessionID) == "" {
		return
	}
	_, _ = b.Store.RecordClose(sessionID, DemoSessionResultStopped, firstNonEmpty(strings.TrimSpace(reason), "demo_session_closed"))
}

func (b *RealtimeDemoBridge) entries(sessionID string) []DemoSessionAuditEntry {
	if b.Store == nil || strings.TrimSpace(sessionID) == "" {
		return nil
	}
	entries, _ := b.Store.Entries(sessionID)
	return entries
}

func (b *RealtimeDemoBridge) timestamp() time.Time {
	if b != nil && b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

func (b *RealtimeDemoBridge) setCancel(sessionID string, token *DemoCancelToken) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || token == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancels == nil {
		b.cancels = map[string]*DemoCancelToken{}
	}
	b.cancels[sessionID] = token
}

func (b *RealtimeDemoBridge) popCancel(sessionID string) *DemoCancelToken {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	token := b.cancels[sessionID]
	delete(b.cancels, sessionID)
	return token
}
