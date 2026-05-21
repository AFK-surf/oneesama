package meetingagent

import (
	"context"
	"errors"
)

func (s *Service) StartRealtimeDemoSurface(ctx context.Context, input RealtimeDemoSurfaceStartRequest) (RealtimeDemoBridgeResult, error) {
	if s.demoBridge == nil {
		return RealtimeDemoBridgeResult{OK: false, Status: realtimeDemoBridgeStatusFailed, Error: errRealtimeDemoBridgeUnavailable.Error()}, errRealtimeDemoBridgeUnavailable
	}
	return s.demoBridge.Start(ctx, input)
}

func (s *Service) CancelRealtimeDemoSurface(ctx context.Context, input RealtimeDemoSurfaceCancelRequest) (RealtimeDemoBridgeResult, error) {
	if s.demoBridge == nil {
		return RealtimeDemoBridgeResult{OK: false, Status: realtimeDemoBridgeStatusFailed, Error: errRealtimeDemoBridgeUnavailable.Error()}, errRealtimeDemoBridgeUnavailable
	}
	return s.demoBridge.Cancel(ctx, input)
}

func (s *Service) ControlRealtimeDemoSurface(ctx context.Context, input RealtimeDemoSurfaceControlRequest) (RealtimeDemoBridgeResult, error) {
	if s.demoBridge == nil {
		return RealtimeDemoBridgeResult{OK: false, Status: realtimeDemoBridgeStatusFailed, Error: errRealtimeDemoBridgeUnavailable.Error()}, errRealtimeDemoBridgeUnavailable
	}
	return s.demoBridge.Control(ctx, input)
}

func realtimeDemoBridgeHTTPStatus(err error) int {
	if err == nil {
		return 200
	}
	if errors.Is(err, errRealtimeDemoBridgeUnavailable) ||
		errors.Is(err, errRealtimeDemoBridgeMissingLifecycle) ||
		errors.Is(err, errRealtimeDemoBridgeMissingPresenter) ||
		errors.Is(err, errRealtimeDemoBridgeMissingController) ||
		errors.Is(err, errRealtimeDemoBridgeNoActiveSession) {
		return 503
	}
	if errors.Is(err, errRealtimeDemoBridgeActionBlocked) {
		return 403
	}
	return 500
}
