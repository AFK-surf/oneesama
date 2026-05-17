package slackagent

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// Slack workspace state durability: channels + channel membership.
// Mirrors Cueboard's `channel` and `channel_membership` tables so scanner
// restart can rebuild a workspace-aware view of where the bot lives without
// re-walking conversations.list+members on every cold boot.

const (
	slackChannelsCollection          = "slack_channels"
	slackChannelMembershipCollection = "slack_channel_membership"
)

// SlackChannelRecord is the durable shape of one Slack channel the bot has
// observed. Field names are stable JSON and used by parity/status endpoints.
type SlackChannelRecord struct {
	ID         string `json:"id"`
	Name       string `json:"name,omitempty"`
	IsPrivate  bool   `json:"is_private,omitempty"`
	IsArchived bool   `json:"is_archived,omitempty"`
	IsMember   bool   `json:"is_member"`
	UpdatedAt  string `json:"updated_at"`
}

// SlackChannelMembershipRecord captures the bot-observed roster for a channel.
// We keep MemberIDs sorted + deduped so SyncChannelMembers is idempotent.
type SlackChannelMembershipRecord struct {
	ChannelID string   `json:"channel_id"`
	MemberIDs []string `json:"member_ids"`
	UpdatedAt string   `json:"updated_at"`
}

type slackWorkspaceStore struct {
	mu          sync.Mutex
	logger      *slog.Logger
	channels    *persistence.TypedCollection[SlackChannelRecord]
	memberships *persistence.TypedCollection[SlackChannelMembershipRecord]
}

func newSlackWorkspaceStore(cfg appconfig.PersistenceConfig, logger *slog.Logger) *slackWorkspaceStore {
	if logger == nil {
		logger = slog.Default()
	}
	channels, err := persistence.OpenTyped[SlackChannelRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackChannelsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack channel store init failed", "error", err)
		return nil
	}
	memberships, err := persistence.OpenTyped[SlackChannelMembershipRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackChannelMembershipCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack channel membership store init failed", "error", err)
		_ = channels.Close()
		return nil
	}
	return &slackWorkspaceStore{logger: logger, channels: channels, memberships: memberships}
}

// UpsertChannel persists the latest known state for a single Slack channel.
// An empty ID is a no-op so callers can pass scanner records through without
// guarding every site.
func (s *slackWorkspaceStore) UpsertChannel(ctx context.Context, record SlackChannelRecord) (*SlackChannelRecord, error) {
	if s == nil || s.channels == nil {
		return nil, nil
	}
	record.ID = strings.TrimSpace(record.ID)
	if record.ID == "" {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record.UpdatedAt = nowRFC3339()
	if err := s.channels.Set(ctx, record.ID, record); err != nil {
		return nil, fmt.Errorf("upsert slack channel %s: %w", record.ID, err)
	}
	return &record, nil
}

// SyncChannelMembers replaces the persisted roster for a channel with the
// supplied IDs (sorted + deduped). Passing an empty channel ID is a no-op.
func (s *slackWorkspaceStore) SyncChannelMembers(ctx context.Context, channelID string, memberIDs []string) (*SlackChannelMembershipRecord, error) {
	if s == nil || s.memberships == nil {
		return nil, nil
	}
	channelID = strings.TrimSpace(channelID)
	if channelID == "" {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	normalized := normalizeMemberIDs(memberIDs)
	record := SlackChannelMembershipRecord{
		ChannelID: channelID,
		MemberIDs: normalized,
		UpdatedAt: nowRFC3339(),
	}
	if err := s.memberships.Set(ctx, channelID, record); err != nil {
		return nil, fmt.Errorf("sync slack channel members %s: %w", channelID, err)
	}
	return &record, nil
}

// ListChannels returns the durable channel inventory in deterministic order
// (sorted by ID) so callers and tests can compare results across snapshots.
func (s *slackWorkspaceStore) ListChannels(ctx context.Context) ([]SlackChannelRecord, error) {
	if s == nil || s.channels == nil {
		return nil, nil
	}
	records, err := s.channels.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list slack channels: %w", err)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].ID < records[j].ID })
	return records, nil
}

// ListChannelIDs returns just the IDs in sorted order — handy for status logs
// and parity checks against Cueboard's `ListChannelIDs`.
func (s *slackWorkspaceStore) ListChannelIDs(ctx context.Context) ([]string, error) {
	records, err := s.ListChannels(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(records))
	for _, record := range records {
		ids = append(ids, record.ID)
	}
	return ids, nil
}

// ListChannelMemberIDs returns the persisted membership for one channel. An
// unknown channel resolves to an empty slice with ok=false so callers can
// distinguish "no roster known" from "roster known to be empty".
func (s *slackWorkspaceStore) ListChannelMemberIDs(ctx context.Context, channelID string) ([]string, bool, error) {
	if s == nil || s.memberships == nil {
		return nil, false, nil
	}
	channelID = strings.TrimSpace(channelID)
	if channelID == "" {
		return nil, false, nil
	}
	record, ok, err := s.memberships.Get(ctx, channelID)
	if err != nil {
		return nil, false, fmt.Errorf("load slack channel members %s: %w", channelID, err)
	}
	if !ok {
		return nil, false, nil
	}
	members := append([]string(nil), record.MemberIDs...)
	return members, true, nil
}

// Stats returns durable counts for status/audit endpoints, matching the
// Cueboard "0 channels, 0 memberships, 0 cases" log line shape so operators
// can confirm the workspace state actually persists across restarts.
type SlackWorkspaceStateStats struct {
	Channels    int `json:"channels"`
	Memberships int `json:"memberships"`
}

func (s *slackWorkspaceStore) Stats(ctx context.Context) SlackWorkspaceStateStats {
	if s == nil {
		return SlackWorkspaceStateStats{}
	}
	stats := SlackWorkspaceStateStats{}
	if s.channels != nil {
		if records, err := s.channels.List(ctx); err == nil {
			stats.Channels = len(records)
		} else if s.logger != nil {
			s.logger.Warn("slack workspace channel stats failed", "error", err)
		}
	}
	if s.memberships != nil {
		if records, err := s.memberships.List(ctx); err == nil {
			stats.Memberships = len(records)
		} else if s.logger != nil {
			s.logger.Warn("slack workspace membership stats failed", "error", err)
		}
	}
	return stats
}

// Close releases the underlying typed collections. Currently used by tests so
// temporary on-disk stores can be torn down between cases.
func (s *slackWorkspaceStore) Close() error {
	if s == nil {
		return nil
	}
	var firstErr error
	if s.channels != nil {
		if err := s.channels.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if s.memberships != nil {
		if err := s.memberships.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// Note: nowRFC3339 is shared with other Slack stores (see canvas_helpers.go).

func normalizeMemberIDs(ids []string) []string {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
