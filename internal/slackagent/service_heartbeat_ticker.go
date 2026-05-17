package slackagent

import (
	"context"
	"strings"
	"time"
)

const (
	slackHeartbeatTickerDefaultInitialDelay = 2 * time.Second
	slackHeartbeatTickerDefaultInterval     = 2 * time.Minute
	slackHeartbeatTickerDefaultLimit        = 10
)

var (
	slackHeartbeatTickerInitialDelay = slackHeartbeatTickerDefaultInitialDelay
	slackHeartbeatTickerInterval     = slackHeartbeatTickerDefaultInterval
	slackHeartbeatTickerLimit        = slackHeartbeatTickerDefaultLimit
)

type SlackHeartbeatTickerStatus struct {
	Enabled         bool   `json:"enabled"`
	Running         bool   `json:"running"`
	InitialDelaySec int64  `json:"initial_delay_seconds"`
	IntervalSec     int64  `json:"interval_seconds"`
	Limit           int    `json:"limit"`
	LastTickAt      string `json:"last_tick_at,omitempty"`
	LastPosted      int    `json:"last_posted"`
	LastSkipped     int    `json:"last_skipped"`
	LastError       string `json:"last_error,omitempty"`
	TicksLastWindow int    `json:"ticks_last_window"`
}

func (s *Service) startHeartbeatTicker() {
	if s == nil || s.followups == nil {
		return
	}
	s.heartbeatMu.Lock()
	defer s.heartbeatMu.Unlock()
	if s.heartbeatCancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.heartbeatCancel = cancel
	go s.runHeartbeatTicker(ctx, heartbeatTickerInitialDelay(), heartbeatTickerInterval(), heartbeatTickerLimitValue())
}

func (s *Service) stopHeartbeatTicker() {
	if s == nil {
		return
	}
	s.heartbeatMu.Lock()
	cancel := s.heartbeatCancel
	s.heartbeatCancel = nil
	s.heartbeatMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Service) runHeartbeatTicker(ctx context.Context, initialDelay time.Duration, interval time.Duration, limit int) {
	if initialDelay < 0 {
		initialDelay = 0
	}
	if interval <= 0 {
		interval = slackHeartbeatTickerDefaultInterval
	}
	timer := time.NewTimer(initialDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			response, err := s.runHeartbeatTickerOnce(ctx, limit)
			s.recordHeartbeatTickerTick(timeNow().UTC(), response, err)
			if err != nil {
				s.logger.Warn("slack heartbeat ticker failed", "error", err)
			} else if len(response.Posted) > 0 || len(response.Skipped) > 0 {
				s.logger.Info("slack heartbeat ticker complete", "posted", len(response.Posted), "skipped", len(response.Skipped))
			}
			timer.Reset(interval)
		}
	}
}

func (s *Service) runHeartbeatTickerOnce(ctx context.Context, limit int) (SlackFollowupSurfaceResponse, error) {
	if s == nil || s.followups == nil {
		return SlackFollowupSurfaceResponse{OK: false, Error: "slack_domain_store_disabled"}, nil
	}
	if limit <= 0 {
		limit = slackHeartbeatTickerDefaultLimit
	}
	due, err := s.dueHeartbeatFollowups(ctx, timeNow().UTC(), limit)
	if err != nil {
		return SlackFollowupSurfaceResponse{}, err
	}
	response := SlackFollowupSurfaceResponse{OK: true}
	for _, followup := range due {
		surfaced, err := s.SurfaceSlackFollowups(ctx, SlackFollowupSurfaceRequest{
			FollowupID: followup.ID,
			Limit:      1,
			Surface:    heartbeatSurfaceAuto,
		})
		if err != nil {
			return response, err
		}
		response.Posted = append(response.Posted, surfaced.Posted...)
		response.Skipped = append(response.Skipped, surfaced.Skipped...)
	}
	return response, nil
}

func (s *Service) dueHeartbeatFollowups(ctx context.Context, now time.Time, limit int) ([]SlackHeartbeatFollowup, error) {
	if s == nil || s.followups == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = slackHeartbeatTickerDefaultLimit
	}
	records, err := s.followups.ListFollowups(ctx, "open", limit*4)
	if err != nil {
		return nil, err
	}
	due := make([]SlackHeartbeatFollowup, 0, minInt(limit, len(records)))
	for _, record := range records {
		if !heartbeatFollowupDue(record, now) {
			continue
		}
		due = append(due, record)
		if len(due) >= limit {
			break
		}
	}
	return due, nil
}

func heartbeatFollowupDue(followup SlackHeartbeatFollowup, now time.Time) bool {
	if now.IsZero() {
		now = timeNow().UTC()
	}
	if next := parseHeartbeatTime(followup.NextCheckAt); next != nil {
		return !next.UTC().After(now.UTC())
	}
	if due := parseHeartbeatTime(followup.DueAt); due != nil {
		return !due.UTC().After(now.UTC())
	}
	return true
}

func (s *Service) recordHeartbeatTickerTick(now time.Time, response SlackFollowupSurfaceResponse, err error) {
	if s == nil {
		return
	}
	if now.IsZero() {
		now = timeNow().UTC()
	}
	cutoff := now.Add(-6 * time.Hour)
	errorText := ""
	if err != nil {
		errorText = err.Error()
	} else if strings.TrimSpace(response.Error) != "" {
		errorText = strings.TrimSpace(response.Error)
	}
	s.heartbeatMu.Lock()
	defer s.heartbeatMu.Unlock()
	s.heartbeatLastTickAt = now.UTC()
	s.heartbeatLastPosted = len(response.Posted)
	s.heartbeatLastSkipped = len(response.Skipped)
	s.heartbeatLastError = errorText
	s.heartbeatTicks = append(s.heartbeatTicks, now.UTC())
	kept := s.heartbeatTicks[:0]
	for _, tick := range s.heartbeatTicks {
		if tick.After(cutoff) || tick.Equal(cutoff) {
			kept = append(kept, tick)
		}
	}
	s.heartbeatTicks = kept
}

func (s *Service) heartbeatTickerStatus() SlackHeartbeatTickerStatus {
	status := SlackHeartbeatTickerStatus{
		Enabled:         s != nil && s.followups != nil,
		InitialDelaySec: int64(heartbeatTickerInitialDelay().Seconds()),
		IntervalSec:     int64(heartbeatTickerInterval().Seconds()),
		Limit:           heartbeatTickerLimitValue(),
	}
	if s == nil {
		return status
	}
	s.heartbeatMu.Lock()
	defer s.heartbeatMu.Unlock()
	status.Running = s.heartbeatCancel != nil
	if !s.heartbeatLastTickAt.IsZero() {
		status.LastTickAt = s.heartbeatLastTickAt.UTC().Format(time.RFC3339Nano)
	}
	status.LastPosted = s.heartbeatLastPosted
	status.LastSkipped = s.heartbeatLastSkipped
	status.LastError = s.heartbeatLastError
	status.TicksLastWindow = len(s.heartbeatTicks)
	return status
}

func heartbeatTickerInitialDelay() time.Duration {
	if slackHeartbeatTickerInitialDelay < 0 {
		return 0
	}
	return slackHeartbeatTickerInitialDelay
}

func heartbeatTickerInterval() time.Duration {
	if slackHeartbeatTickerInterval <= 0 {
		return slackHeartbeatTickerDefaultInterval
	}
	return slackHeartbeatTickerInterval
}

func heartbeatTickerLimitValue() int {
	if slackHeartbeatTickerLimit <= 0 {
		return slackHeartbeatTickerDefaultLimit
	}
	return slackHeartbeatTickerLimit
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
