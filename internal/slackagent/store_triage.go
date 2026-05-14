package slackagent

import "context"

func (s *slackTriageStore) SaveTriageRun(run SlackTriageContext) error {
	if s == nil {
		return nil
	}
	_, err := s.RecordRun(context.Background(), run)
	return err
}

func (s *slackTriageStore) ListTriageContexts(limit int) ([]SlackTriageContext, error) {
	if s == nil {
		return nil, nil
	}
	return s.ListRuns(context.Background(), limit)
}
