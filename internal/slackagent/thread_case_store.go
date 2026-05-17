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

// Slack thread ownership durability. Mirrors Cueboard's `thread_case` table so
// mention queue / scanner suppression / active-thread guard can survive
// restarts. A thread case is keyed by (channel_id, thread_ts) and records the
// owner subsystem plus a lifecycle status (active / closed / expired).

const slackThreadCasesCollection = "slack_thread_cases"

// SlackThreadCaseOwner identifies which subsystem currently owns a thread.
// Values are stable strings persisted to disk so future readers can keep
// matching them without code changes.
type SlackThreadCaseOwner string

const (
	SlackThreadCaseOwnerMention SlackThreadCaseOwner = "mention"
	SlackThreadCaseOwnerScanner SlackThreadCaseOwner = "scanner"
	SlackThreadCaseOwnerTriage  SlackThreadCaseOwner = "triage"
	SlackThreadCaseOwnerMeeting SlackThreadCaseOwner = "meeting"
)

// SlackThreadCaseStatus mirrors Cueboard's "thread_case" status column.
type SlackThreadCaseStatus string

const (
	SlackThreadCaseStatusActive  SlackThreadCaseStatus = "active"
	SlackThreadCaseStatusClosed  SlackThreadCaseStatus = "closed"
	SlackThreadCaseStatusExpired SlackThreadCaseStatus = "expired"
)

// SlackThreadCase is one durable row of thread ownership state. The ID is
// derived from channel_id+thread_ts so writes are idempotent and a restart
// rehydrates the same key. Source records the immediate trigger ("app_mention",
// "scanner_sweep", etc.) for operator visibility.
type SlackThreadCase struct {
	ID        string                `json:"id"`
	ChannelID string                `json:"channel_id"`
	ThreadTS  string                `json:"thread_ts"`
	Owner     SlackThreadCaseOwner  `json:"owner"`
	Status    SlackThreadCaseStatus `json:"status"`
	Source    string                `json:"source,omitempty"`
	CreatedAt string                `json:"created_at"`
	UpdatedAt string                `json:"updated_at"`
	ClosedAt  string                `json:"closed_at,omitempty"`
}

type slackThreadCaseStore struct {
	mu    sync.Mutex
	log   *slog.Logger
	cases *persistence.TypedCollection[SlackThreadCase]
}

func newSlackThreadCaseStore(cfg appconfig.PersistenceConfig, logger *slog.Logger) *slackThreadCaseStore {
	if logger == nil {
		logger = slog.Default()
	}
	cases, err := persistence.OpenTyped[SlackThreadCase](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackThreadCasesCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack thread case store init failed", "error", err)
		return nil
	}
	return &slackThreadCaseStore{log: logger, cases: cases}
}

// UpsertThreadCase claims (or refreshes) a thread case for the given owner.
// Repeating an upsert for the same key with the same owner is a no-op except
// for updated_at. Switching owners (e.g. scanner → mention) overwrites the
// row so the most recent claim wins, matching Cueboard's behavior.
func (s *slackThreadCaseStore) UpsertThreadCase(ctx context.Context, record SlackThreadCase) (*SlackThreadCase, error) {
	if s == nil || s.cases == nil {
		return nil, nil
	}
	channelID := strings.TrimSpace(record.ChannelID)
	threadTS := strings.TrimSpace(record.ThreadTS)
	if channelID == "" || threadTS == "" {
		return nil, nil
	}
	if strings.TrimSpace(string(record.Owner)) == "" {
		return nil, fmt.Errorf("thread case owner is required")
	}
	if strings.TrimSpace(string(record.Status)) == "" {
		record.Status = SlackThreadCaseStatusActive
	}
	id := threadCaseKey(channelID, threadTS)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := nowRFC3339()
	previous, ok, err := s.cases.Get(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("load thread case %s: %w", id, err)
	}
	record.ID = id
	record.ChannelID = channelID
	record.ThreadTS = threadTS
	record.UpdatedAt = now
	if ok {
		if record.CreatedAt == "" {
			record.CreatedAt = previous.CreatedAt
		}
		if record.Status != SlackThreadCaseStatusClosed {
			record.ClosedAt = ""
		}
	} else {
		if record.CreatedAt == "" {
			record.CreatedAt = now
		}
	}
	if err := s.cases.Set(ctx, id, record); err != nil {
		return nil, fmt.Errorf("upsert thread case %s: %w", id, err)
	}
	return &record, nil
}

// GetThreadCase looks up a thread case by (channel, thread). Missing rows
// return (nil, false, nil) so callers can distinguish "no case" from "error".
func (s *slackThreadCaseStore) GetThreadCase(ctx context.Context, channelID, threadTS string) (*SlackThreadCase, bool, error) {
	if s == nil || s.cases == nil {
		return nil, false, nil
	}
	channelID = strings.TrimSpace(channelID)
	threadTS = strings.TrimSpace(threadTS)
	if channelID == "" || threadTS == "" {
		return nil, false, nil
	}
	record, ok, err := s.cases.Get(ctx, threadCaseKey(channelID, threadTS))
	if err != nil {
		return nil, false, fmt.Errorf("load thread case %s/%s: %w", channelID, threadTS, err)
	}
	if !ok {
		return nil, false, nil
	}
	return &record, true, nil
}

// IsActive reports whether the given thread currently has an active claim.
// Used by scanner suppression and the active-thread guard so duplicate replies
// can be avoided.
func (s *slackThreadCaseStore) IsActive(ctx context.Context, channelID, threadTS string) bool {
	record, ok, err := s.GetThreadCase(ctx, channelID, threadTS)
	if err != nil {
		if s != nil && s.log != nil {
			s.log.Warn("slack thread case lookup failed", "channel", channelID, "thread", threadTS, "error", err)
		}
		return false
	}
	if !ok || record == nil {
		return false
	}
	return record.Status == SlackThreadCaseStatusActive
}

// MarkClosed transitions a thread case to status=closed with a closed_at
// timestamp. If no row exists yet, MarkClosed creates a closed row so the
// historical "this thread was handled" signal still survives restart.
func (s *slackThreadCaseStore) MarkClosed(ctx context.Context, channelID, threadTS string, owner SlackThreadCaseOwner, source string) (*SlackThreadCase, error) {
	if s == nil || s.cases == nil {
		return nil, nil
	}
	channelID = strings.TrimSpace(channelID)
	threadTS = strings.TrimSpace(threadTS)
	if channelID == "" || threadTS == "" {
		return nil, nil
	}
	id := threadCaseKey(channelID, threadTS)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := nowRFC3339()
	previous, ok, err := s.cases.Get(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("load thread case %s: %w", id, err)
	}
	record := SlackThreadCase{
		ID:        id,
		ChannelID: channelID,
		ThreadTS:  threadTS,
		Owner:     owner,
		Status:    SlackThreadCaseStatusClosed,
		Source:    source,
		UpdatedAt: now,
		ClosedAt:  now,
		CreatedAt: now,
	}
	if ok {
		record.CreatedAt = previous.CreatedAt
		if owner == "" {
			record.Owner = previous.Owner
		}
		if source == "" {
			record.Source = previous.Source
		}
	}
	if err := s.cases.Set(ctx, id, record); err != nil {
		return nil, fmt.Errorf("close thread case %s: %w", id, err)
	}
	return &record, nil
}

// ListByChannel returns all known thread cases for a channel, sorted by
// updated_at descending (newest first) so operator views can show recent
// activity without extra sorting.
func (s *slackThreadCaseStore) ListByChannel(ctx context.Context, channelID string) ([]SlackThreadCase, error) {
	if s == nil || s.cases == nil {
		return nil, nil
	}
	channelID = strings.TrimSpace(channelID)
	all, err := s.cases.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list thread cases: %w", err)
	}
	out := make([]SlackThreadCase, 0, len(all))
	for _, record := range all {
		if channelID != "" && record.ChannelID != channelID {
			continue
		}
		out = append(out, record)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out, nil
}

// Stats returns the durable thread-case counts split by status. Used by the
// status endpoint so operators can see how many active claims survive a
// restart.
type SlackThreadCaseStats struct {
	Total   int `json:"total"`
	Active  int `json:"active"`
	Closed  int `json:"closed"`
	Expired int `json:"expired"`
}

func (s *slackThreadCaseStore) Stats(ctx context.Context) SlackThreadCaseStats {
	if s == nil || s.cases == nil {
		return SlackThreadCaseStats{}
	}
	records, err := s.cases.List(ctx)
	if err != nil {
		if s.log != nil {
			s.log.Warn("slack thread case stats failed", "error", err)
		}
		return SlackThreadCaseStats{}
	}
	stats := SlackThreadCaseStats{Total: len(records)}
	for _, record := range records {
		switch record.Status {
		case SlackThreadCaseStatusActive:
			stats.Active++
		case SlackThreadCaseStatusClosed:
			stats.Closed++
		case SlackThreadCaseStatusExpired:
			stats.Expired++
		}
	}
	return stats
}

// Close releases the underlying typed collection. Used by tests to tear down
// temporary stores between cases.
func (s *slackThreadCaseStore) Close() error {
	if s == nil || s.cases == nil {
		return nil
	}
	return s.cases.Close()
}

func threadCaseKey(channelID, threadTS string) string {
	return strings.TrimSpace(channelID) + ":" + strings.TrimSpace(threadTS)
}
