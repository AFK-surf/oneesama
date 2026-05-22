package meetingagent

import "context"

func (s *Service) GoBackground(fn func(context.Context)) {
	if s == nil || fn == nil {
		return
	}
	s.backgroundMu.Lock()
	if s.backgroundStopping {
		s.backgroundMu.Unlock()
		return
	}
	ctx := s.backgroundCtx
	if ctx == nil {
		ctx = context.Background()
	}
	s.backgroundWG.Add(1)
	s.backgroundMu.Unlock()
	go func() {
		defer s.backgroundWG.Done()
		fn(ctx)
	}()
}

func (s *Service) cancelBackground() {
	if s == nil {
		return
	}
	s.backgroundMu.Lock()
	s.backgroundStopping = true
	cancel := s.backgroundCancel
	s.backgroundMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Service) waitBackground(ctx context.Context) error {
	if s == nil {
		return nil
	}
	done := make(chan struct{})
	go func() {
		s.backgroundWG.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
