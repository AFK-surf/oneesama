package meetrunner

import (
	"context"
	"fmt"
	"strings"
)

func (m *Manager) StatusSession(ctx context.Context, input StatusSessionInput) (StatusSessionResult, error) {
	worker, err := m.resolveCallSession(input.SessionID)
	if err != nil {
		return StatusSessionResult{}, err
	}
	var result StatusSessionResult
	if err := worker.CallWithTimeout(ctx, statusSnapshotTimeout, "join.session.status", input, &result); err != nil {
		return StatusSessionResult{}, err
	}
	if strings.TrimSpace(input.SessionID) != "" && result.Session == nil {
		result.Session = &RunnerSession{ID: strings.TrimSpace(input.SessionID)}
	}
	if !result.OK {
		return result, fmt.Errorf("meet-runner status failed")
	}
	return result, nil
}
