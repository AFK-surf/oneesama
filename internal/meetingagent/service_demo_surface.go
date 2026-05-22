package meetingagent

import "strings"

func (s *Service) DemoSurfaceTrail(sessionID string) (DemoSessionFeedbackPackage, bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || s == nil || s.demoBridge == nil || s.demoBridge.Store == nil {
		return DemoSessionFeedbackPackage{}, false
	}
	snapshot, ok := s.demoBridge.Store.Snapshot(sessionID)
	if !ok {
		return DemoSessionFeedbackPackage{}, false
	}
	entries, _ := s.demoBridge.Store.Entries(sessionID)
	runbook := make([]string, 0, len(entries))
	for _, entry := range entries {
		runbook = append(runbook, FormatRunbookLine(entry))
	}
	return DemoSessionFeedbackPackage{
		Snapshot:     snapshot,
		Entries:      entries,
		RunbookLines: runbook,
		UpdatedAt:    snapshotUpdatedAt(snapshot),
	}, true
}
