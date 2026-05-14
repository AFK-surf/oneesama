package slackagent

import (
	"context"
	"fmt"
	"sort"
)

func (s *slackHeartbeatStore) ListRecommendations(ctx context.Context, limit int) ([]SlackThreadRecommendation, error) {
	if s == nil || s.recommendations == nil {
		return nil, nil
	}
	records, err := s.recommendations.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list thread recommendations: %w", err)
	}
	sort.SliceStable(records, func(i, j int) bool { return records[i].CreatedAt > records[j].CreatedAt })
	return limitRecommendations(records, limit), nil
}

func (s *slackHeartbeatStore) ListOutboundActions(ctx context.Context, limit int) ([]SlackOutboundAction, error) {
	if s == nil || s.outbound == nil {
		return nil, nil
	}
	records, err := s.outbound.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list outbound actions: %w", err)
	}
	sort.SliceStable(records, func(i, j int) bool { return records[i].CreatedAt > records[j].CreatedAt })
	return limitOutbound(records, limit), nil
}

func limitFollowups(records []SlackHeartbeatFollowup, limit int) []SlackHeartbeatFollowup {
	if limit <= 0 {
		limit = 20
	}
	if len(records) > limit {
		return records[:limit]
	}
	return records
}

func limitSurfaces(records []SlackHeartbeatSurface, limit int) []SlackHeartbeatSurface {
	if limit <= 0 {
		limit = 20
	}
	if len(records) > limit {
		return records[:limit]
	}
	return records
}

func limitRecommendations(records []SlackThreadRecommendation, limit int) []SlackThreadRecommendation {
	if limit <= 0 {
		limit = 20
	}
	if len(records) > limit {
		return records[:limit]
	}
	return records
}

func limitOutbound(records []SlackOutboundAction, limit int) []SlackOutboundAction {
	if limit <= 0 {
		limit = 20
	}
	if len(records) > limit {
		return records[:limit]
	}
	return records
}
