package slackagent

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

var heartbeatIDSequence int64

const (
	slackHeartbeatFollowupsCollection    = "slack_heartbeat_followups"
	slackHeartbeatSurfacesCollection     = "slack_heartbeat_surfaces"
	slackThreadRecommendationsCollection = "slack_thread_recommendations"
	slackOutboundActionsCollection       = "slack_outbound_actions"
)

type slackHeartbeatStore struct {
	mu              sync.Mutex
	followups       *persistence.TypedCollection[SlackHeartbeatFollowup]
	surfaces        *persistence.TypedCollection[SlackHeartbeatSurface]
	recommendations *persistence.TypedCollection[SlackThreadRecommendation]
	outbound        *persistence.TypedCollection[SlackOutboundAction]
}

func newSlackHeartbeatStore(cfg appconfig.PersistenceConfig, logger warnLogger) *slackHeartbeatStore {
	store := &slackHeartbeatStore{}
	var err error
	store.followups, err = openHeartbeatCollection[SlackHeartbeatFollowup](cfg, slackHeartbeatFollowupsCollection)
	if err != nil {
		logger.Warn("slack heartbeat followup store init failed", "error", err)
		return nil
	}
	store.surfaces, err = openHeartbeatCollection[SlackHeartbeatSurface](cfg, slackHeartbeatSurfacesCollection)
	if err != nil {
		logger.Warn("slack heartbeat surface store init failed", "error", err)
		return nil
	}
	store.recommendations, _ = openHeartbeatCollection[SlackThreadRecommendation](cfg, slackThreadRecommendationsCollection)
	store.outbound, _ = openHeartbeatCollection[SlackOutboundAction](cfg, slackOutboundActionsCollection)
	return store
}

func openHeartbeatCollection[T any](cfg appconfig.PersistenceConfig, name string) (*persistence.TypedCollection[T], error) {
	return persistence.OpenTyped[T](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: name,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
}

func (s *slackHeartbeatStore) CreateFollowup(ctx context.Context, followup SlackHeartbeatFollowup) (*SlackHeartbeatFollowup, error) {
	if s == nil || s.followups == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	followup = normalizeHeartbeatFollowup(followup)
	if followup.SourceRef != "" {
		existing, err := s.followups.List(ctx)
		if err != nil {
			return nil, fmt.Errorf("list heartbeat followups for source ref: %w", err)
		}
		for _, candidate := range existing {
			if candidate.SourceRef != followup.SourceRef || !strings.EqualFold(candidate.Status, "open") {
				continue
			}
			followup.ID = candidate.ID
			followup.CreatedAt = candidate.CreatedAt
			break
		}
	}
	if followup.ID == 0 {
		followup.ID = newHeartbeatID()
	}
	if err := s.followups.Set(ctx, heartbeatKey(followup.ID), followup); err != nil {
		return nil, fmt.Errorf("record heartbeat followup: %w", err)
	}
	return &followup, nil
}

func (s *slackHeartbeatStore) UpdateFollowup(ctx context.Context, followup SlackHeartbeatFollowup) (*SlackHeartbeatFollowup, error) {
	if s == nil || s.followups == nil || followup.ID == 0 {
		return nil, nil
	}
	followup = normalizeHeartbeatFollowup(followup)
	if err := s.followups.Set(ctx, heartbeatKey(followup.ID), followup); err != nil {
		return nil, fmt.Errorf("update heartbeat followup: %w", err)
	}
	return &followup, nil
}

func (s *slackHeartbeatStore) GetFollowup(ctx context.Context, id int64) (*SlackHeartbeatFollowup, error) {
	if s == nil || s.followups == nil || id == 0 {
		return nil, nil
	}
	record, ok, err := s.followups.Get(ctx, heartbeatKey(id))
	if err != nil || !ok {
		return nil, err
	}
	return &record, nil
}

func (s *slackHeartbeatStore) ResolveFollowup(ctx context.Context, id int64, status string, resolution string) (*SlackHeartbeatFollowup, error) {
	if s == nil || s.followups == nil || id == 0 {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok, err := s.followups.Get(ctx, heartbeatKey(id))
	if err != nil || !ok {
		return nil, err
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
		return nil, fmt.Errorf("resolve heartbeat followup: %w", err)
	}
	updated, _, err := s.followups.Get(ctx, heartbeatKey(record.ID))
	if err != nil {
		return nil, err
	}
	return &updated, nil
}

func (s *slackHeartbeatStore) ListFollowups(ctx context.Context, status string, limit int) ([]SlackHeartbeatFollowup, error) {
	if s == nil || s.followups == nil {
		return nil, nil
	}
	records, err := s.followups.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list heartbeat followups: %w", err)
	}
	filtered := make([]SlackHeartbeatFollowup, 0, len(records))
	for _, record := range records {
		if status == "" || strings.EqualFold(record.Status, status) {
			filtered = append(filtered, record)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		left := firstNonEmpty(filtered[i].NextCheckAt, filtered[i].DueAt, filtered[i].UpdatedAt)
		right := firstNonEmpty(filtered[j].NextCheckAt, filtered[j].DueAt, filtered[j].UpdatedAt)
		if left == right {
			return filtered[i].ID < filtered[j].ID
		}
		return left < right
	})
	return limitFollowups(filtered, limit), nil
}

func (s *slackHeartbeatStore) RecordSurface(ctx context.Context, surface SlackHeartbeatSurface) (*SlackHeartbeatSurface, error) {
	if s == nil || s.surfaces == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	surface = normalizeHeartbeatSurfaceRecord(surface)
	if surface.ID == 0 {
		surface.ID = newHeartbeatID()
	}
	if err := s.surfaces.Set(ctx, heartbeatKey(surface.ID), surface); err != nil {
		return nil, fmt.Errorf("record heartbeat surface: %w", err)
	}
	return &surface, nil
}

func (s *slackHeartbeatStore) ListSurfaces(ctx context.Context, limit int) ([]SlackHeartbeatSurface, error) {
	if s == nil || s.surfaces == nil {
		return nil, nil
	}
	records, err := s.surfaces.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list heartbeat surfaces: %w", err)
	}
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].CreatedAt == records[j].CreatedAt {
			return records[i].ID > records[j].ID
		}
		return records[i].CreatedAt > records[j].CreatedAt
	})
	return limitSurfaces(records, limit), nil
}

func heartbeatKey(id int64) string {
	return fmt.Sprintf("%d", id)
}

func newHeartbeatID() int64 {
	return timeNow().UTC().UnixMilli()*1000 + atomic.AddInt64(&heartbeatIDSequence, 1)%1000
}
