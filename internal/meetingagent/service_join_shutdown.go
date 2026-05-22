package meetingagent

import "context"

const joinShutdownStopReason = "service_shutdown"

func (s *Service) stopActiveJoinSessionsForShutdown(ctx context.Context) int {
	sessions, err := s.ListSessions(ctx)
	if err != nil {
		s.logger.Warn("list join sessions before shutdown failed", "error", err)
		return 0
	}

	stopped := 0
	for _, session := range sessions {
		if !joinSessionNeedsShutdownStop(session) {
			continue
		}
		select {
		case <-ctx.Done():
			s.logger.Warn("stop active join sessions before shutdown cancelled", "error", ctx.Err())
			return stopped
		default:
		}
		if _, err := s.StopJoin(ctx, StopJoinRequest{
			SessionID: session.ID,
			Reason:    joinShutdownStopReason,
		}); err != nil {
			s.logger.Warn("stop active join session before shutdown failed", "session_id", session.ID, "error", err)
			continue
		}
		stopped++
	}
	return stopped
}

func joinSessionNeedsShutdownStop(session SessionRecord) bool {
	return joinSessionNeedsStartupRecovery(session)
}
