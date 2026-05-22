package meetingagent

import (
	"context"
	"fmt"
	"strings"
)

const joinStartupRecoverySource = "startup_recovery"

// RecoverUnavailableJoinSessions reconciles persisted join sessions after a
// service restart. The meet-runner session registry is process-local, so any
// started non-terminal join session cannot be resumed after the service comes
// back; route it through the same artifact recovery path used by monitor-time
// runner failures.
func (s *Service) RecoverUnavailableJoinSessions(ctx context.Context) (int, error) {
	sessions, err := s.ListSessions(ctx)
	if err != nil {
		return 0, err
	}

	finalized := 0
	for _, session := range sessions {
		if !joinSessionNeedsStartupRecovery(session) {
			continue
		}
		metadata := cloneMap(session.Metadata)
		if len(metadata) == 0 {
			metadata = map[string]any{}
		}
		metadata["stale_recovery_source"] = joinStartupRecoverySource
		session.Metadata = metadata

		cause := fmt.Errorf("meet-runner session %s not found during startup recovery", session.ID)
		if updated := s.finalizeStaleJoin(ctx, session, cause); updated != nil {
			finalized++
		}
	}
	return finalized, nil
}

func joinSessionNeedsStartupRecovery(session SessionRecord) bool {
	if strings.TrimSpace(session.ID) == "" || isTerminalSessionStatus(session.Status) {
		return false
	}
	return joinSessionWasStarted(session)
}

func joinSessionWasStarted(session SessionRecord) bool {
	if strings.TrimSpace(session.StartedAt) != "" {
		return true
	}
	return boolField(session.Metadata, "started")
}
