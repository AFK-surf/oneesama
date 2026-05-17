package slackagent

import "context"

func (s *Service) Start() error {
	s.startSlackHistoryScanner()
	s.startHeartbeatTicker()

	if s == nil || s.appToken == "" {
		return nil
	}

	s.socketModeMu.Lock()
	defer s.socketModeMu.Unlock()
	if s.socketMode != nil {
		return s.socketMode.Start()
	}

	s.socketMode = NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   s.logger,
		Service:  s,
		AppToken: s.appToken,
	})
	return s.socketMode.Start()
}

func (s *Service) Shutdown(ctx context.Context) error {
	if s == nil {
		return nil
	}
	s.stopSlackHistoryScanner()
	s.stopHeartbeatTicker()
	s.socketModeMu.Lock()
	runner := s.socketMode
	s.socketModeMu.Unlock()
	if runner == nil {
		return nil
	}
	return runner.Shutdown(ctx)
}

func (s *Service) socketModeStatus() SlackSocketModeStatus {
	if s == nil {
		return SlackSocketModeStatus{}
	}
	s.socketModeMu.Lock()
	runner := s.socketMode
	appTokenConfigured := s.appToken != ""
	s.socketModeMu.Unlock()
	if runner == nil {
		return SlackSocketModeStatus{Configured: appTokenConfigured}
	}
	status := runner.Snapshot()
	status.Configured = appTokenConfigured
	return status
}
