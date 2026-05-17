package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"
)

func (s *slackHeartbeatStore) ReserveThreadRecommendation(ctx context.Context, record SlackThreadRecommendation) (*SlackThreadRecommendation, error) {
	if s == nil || s.recommendations == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record = normalizeThreadRecommendation(record)
	existing, err := s.recommendations.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list thread recommendations: %w", err)
	}
	for _, candidate := range existing {
		if !threadRecommendationSameReservation(candidate, record) || strings.EqualFold(candidate.Status, "closed") || strings.EqualFold(candidate.Status, "done") {
			continue
		}
		record.ID = candidate.ID
		record.CreatedAt = candidate.CreatedAt
		break
	}
	if record.ID == 0 {
		record.ID = newHeartbeatID()
	}
	if err := s.recommendations.Set(ctx, heartbeatKey(record.ID), record); err != nil {
		return nil, fmt.Errorf("record thread recommendation: %w", err)
	}
	return &record, nil
}

func (s *slackHeartbeatStore) ResolveFollowupBySourceRef(ctx context.Context, sourceRef string, status string, resolution string) (int, error) {
	if s == nil || s.followups == nil || strings.TrimSpace(sourceRef) == "" {
		return 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.followups.List(ctx)
	if err != nil {
		return 0, fmt.Errorf("list heartbeat followups: %w", err)
	}
	resolved := 0
	for _, record := range records {
		if record.SourceRef != sourceRef || !strings.EqualFold(record.Status, "open") {
			continue
		}
		record.Status = firstNonEmpty(status, "done")
		record.UpdatedAt = nowRFC3339()
		if strings.TrimSpace(resolution) != "" {
			if record.Metadata == nil {
				record.Metadata = map[string]any{}
			}
			record.Metadata["resolution"] = strings.TrimSpace(resolution)
		}
		if err := s.followups.Set(ctx, heartbeatKey(record.ID), normalizeHeartbeatFollowup(record)); err != nil {
			return resolved, fmt.Errorf("resolve heartbeat followup by source ref: %w", err)
		}
		resolved++
	}
	return resolved, nil
}

func threadRecommendationSameReservation(left SlackThreadRecommendation, right SlackThreadRecommendation) bool {
	return strings.TrimSpace(left.ChannelID) == strings.TrimSpace(right.ChannelID) &&
		strings.TrimSpace(left.ThreadTS) == strings.TrimSpace(right.ThreadTS) &&
		strings.TrimSpace(left.RecommendationType) == strings.TrimSpace(right.RecommendationType)
}

func (s *slackHeartbeatStore) ReserveOutboundAction(ctx context.Context, record SlackOutboundAction) (*SlackOutboundAction, error) {
	if s == nil || s.outbound == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record = normalizeOutboundAction(record)
	existing, err := s.outbound.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list outbound actions: %w", err)
	}
	for _, candidate := range existing {
		if outboundActionSameReservation(candidate, record) && !outboundActionAllowsRetry(candidate.Status) {
			return nil, nil
		}
	}
	if record.ID == 0 {
		record.ID = newHeartbeatID()
	}
	if err := s.outbound.Set(ctx, heartbeatKey(record.ID), record); err != nil {
		return nil, fmt.Errorf("record outbound action: %w", err)
	}
	return &record, nil
}

func (s *slackHeartbeatStore) FailOutboundAction(ctx context.Context, id int64) error {
	if s == nil || s.outbound == nil || id == 0 {
		return nil
	}
	return s.outbound.Delete(ctx, heartbeatKey(id))
}

func (s *slackHeartbeatStore) ConfirmOutboundAction(ctx context.Context, id int64) error {
	if s == nil || s.outbound == nil || id == 0 {
		return nil
	}
	record, ok, err := s.outbound.Get(ctx, heartbeatKey(id))
	if err != nil || !ok {
		return err
	}
	record.Status = "confirmed"
	record.UpdatedAt = nowRFC3339()
	return s.outbound.Set(ctx, heartbeatKey(id), record)
}

func (s *slackHeartbeatStore) CleanupStalePendingActions(ctx context.Context, olderThan time.Duration) (int, error) {
	if s == nil || s.outbound == nil {
		return 0, nil
	}
	records, err := s.outbound.List(ctx)
	if err != nil {
		return 0, fmt.Errorf("list outbound actions: %w", err)
	}
	cutoff := timeNow().UTC().Add(-olderThan)
	cleaned := 0
	for _, record := range records {
		if strings.TrimSpace(record.Status) != "pending" {
			continue
		}
		createdAt, err := time.Parse(time.RFC3339Nano, record.CreatedAt)
		if err != nil || createdAt.Before(cutoff) {
			if err := s.outbound.Delete(ctx, heartbeatKey(record.ID)); err != nil {
				return cleaned, fmt.Errorf("delete stale outbound action: %w", err)
			}
			cleaned++
		}
	}
	return cleaned, nil
}

func outboundActionSameReservation(left SlackOutboundAction, right SlackOutboundAction) bool {
	return strings.TrimSpace(left.ActionType) == strings.TrimSpace(right.ActionType) &&
		strings.TrimSpace(left.Target) == strings.TrimSpace(right.Target) &&
		strings.TrimSpace(left.Reference) == strings.TrimSpace(right.Reference) &&
		strings.TrimSpace(left.SessionID) == strings.TrimSpace(right.SessionID)
}

func outboundActionAllowsRetry(status string) bool {
	switch strings.TrimSpace(status) {
	case "", "failed", "error", "canceled", "cancelled":
		return true
	default:
		return false
	}
}
