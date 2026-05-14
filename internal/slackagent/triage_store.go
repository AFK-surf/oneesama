package slackagent

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

var triageIDSequence int64

const (
	slackTriageRunsCollection     = "slack_triage_runs"
	slackPendingActionsCollection = "slack_pending_actions"
)

type warnLogger interface {
	Warn(msg string, args ...any)
}

type slackTriageStore struct {
	mu      sync.Mutex
	runs    *persistence.TypedCollection[SlackTriageContext]
	actions *persistence.TypedCollection[SlackPendingAction]
}

func newSlackTriageStore(cfg appconfig.PersistenceConfig, logger warnLogger) *slackTriageStore {
	runs, err := persistence.OpenTyped[SlackTriageContext](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackTriageRunsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack triage run store init failed", "error", err)
		return nil
	}
	actions, err := persistence.OpenTyped[SlackPendingAction](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackPendingActionsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack pending action store init failed", "error", err)
		return nil
	}
	return &slackTriageStore{runs: runs, actions: actions}
}

func (s *slackTriageStore) RecordRun(ctx context.Context, run SlackTriageContext) (*SlackTriageContext, error) {
	if s == nil || s.runs == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run = normalizeTriageContext(run)
	if run.ID == 0 {
		run.ID = newTriageID()
	}
	if err := s.runs.Set(ctx, triageKey(run.ID), run); err != nil {
		return nil, fmt.Errorf("record triage run: %w", err)
	}
	return &run, nil
}

func (s *slackTriageStore) UpdateRun(ctx context.Context, run SlackTriageContext) (*SlackTriageContext, error) {
	if s == nil || s.runs == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if run.ID == 0 {
		return s.recordRunLocked(ctx, run)
	}
	previous, ok, err := s.runs.Get(ctx, triageKey(run.ID))
	if err != nil {
		return nil, fmt.Errorf("load triage run %d: %w", run.ID, err)
	}
	if !ok {
		return s.recordRunLocked(ctx, run)
	}
	merged := mergeTriageContext(previous, run)
	if err := s.runs.Set(ctx, triageKey(merged.ID), merged); err != nil {
		return nil, fmt.Errorf("update triage run %d: %w", merged.ID, err)
	}
	return &merged, nil
}

func (s *slackTriageStore) recordRunLocked(ctx context.Context, run SlackTriageContext) (*SlackTriageContext, error) {
	run = normalizeTriageContext(run)
	if run.ID == 0 {
		run.ID = newTriageID()
	}
	if err := s.runs.Set(ctx, triageKey(run.ID), run); err != nil {
		return nil, fmt.Errorf("record triage run: %w", err)
	}
	return &run, nil
}

func (s *slackTriageStore) ListRuns(ctx context.Context, limit int) ([]SlackTriageContext, error) {
	if s == nil || s.runs == nil {
		return nil, nil
	}
	runs, err := s.runs.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list triage runs: %w", err)
	}
	sort.SliceStable(runs, func(i, j int) bool {
		leftTime := parseTriageTimestamp(runs[i].Timestamp)
		rightTime := parseTriageTimestamp(runs[j].Timestamp)
		if !leftTime.IsZero() && !rightTime.IsZero() && !leftTime.Equal(rightTime) {
			return leftTime.After(rightTime)
		}
		if runs[i].Timestamp == runs[j].Timestamp {
			return runs[i].ID > runs[j].ID
		}
		return runs[i].Timestamp > runs[j].Timestamp
	})
	if limit > 0 && len(runs) > limit {
		runs = runs[:limit]
	}
	return runs, nil
}

func (s *slackTriageStore) InsertPendingAction(ctx context.Context, action SlackPendingAction) (*SlackPendingAction, error) {
	if s == nil || s.actions == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := nowRFC3339()
	if action.ID == 0 {
		action.ID = newTriageID()
	}
	if action.Status == "" {
		action.Status = "pending"
	}
	action.CreatedAt = firstNonEmpty(action.CreatedAt, now)
	action.UpdatedAt = now
	if err := s.actions.Set(ctx, triageKey(action.ID), action); err != nil {
		return nil, fmt.Errorf("insert pending action: %w", err)
	}
	return &action, nil
}

func (s *slackTriageStore) SetPendingActionCardTS(ctx context.Context, id int64, cardTS string) error {
	if s == nil || s.actions == nil || id == 0 || strings.TrimSpace(cardTS) == "" {
		return nil
	}
	action, ok, err := s.actions.Get(ctx, triageKey(id))
	if err != nil || !ok {
		return err
	}
	action.CardTS = strings.TrimSpace(cardTS)
	action.UpdatedAt = nowRFC3339()
	return s.actions.Set(ctx, triageKey(id), action)
}

func (s *slackTriageStore) UpdatePendingAction(ctx context.Context, id int64, apply func(*SlackPendingAction)) (*SlackPendingAction, error) {
	if s == nil || s.actions == nil || id == 0 {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	action, ok, err := s.actions.Get(ctx, triageKey(id))
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	apply(&action)
	action.UpdatedAt = nowRFC3339()
	if err := s.actions.Set(ctx, triageKey(id), action); err != nil {
		return nil, err
	}
	return &action, nil
}

func (s *slackTriageStore) ListPendingActions(ctx context.Context, limit int) ([]SlackPendingAction, error) {
	if s == nil || s.actions == nil {
		return nil, nil
	}
	actions, err := s.actions.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list pending actions: %w", err)
	}
	sort.SliceStable(actions, func(i, j int) bool {
		if actions[i].CreatedAt == actions[j].CreatedAt {
			return actions[i].ID > actions[j].ID
		}
		return actions[i].CreatedAt > actions[j].CreatedAt
	})
	if limit > 0 && len(actions) > limit {
		actions = actions[:limit]
	}
	return actions, nil
}

func normalizeTriageContext(run SlackTriageContext) SlackTriageContext {
	run.Timestamp = firstNonEmpty(run.Timestamp, nowRFC3339())
	run.Status = firstNonEmpty(run.Status, "failed")
	run.Summary = strings.TrimSpace(run.Summary)
	run.RawOutput = truncateSlackContextText(strings.TrimSpace(run.RawOutput), 8000)
	run.Error = truncateSlackContextText(strings.TrimSpace(run.Error), 300)
	run.Digest = truncateSlackContextText(strings.TrimSpace(run.Digest), 2000)
	return run
}

func mergeTriageContext(previous SlackTriageContext, patch SlackTriageContext) SlackTriageContext {
	merged := previous
	merged.Status = firstNonEmpty(patch.Status, previous.Status)
	merged.Summary = firstNonEmpty(patch.Summary, previous.Summary)
	merged.RawOutput = firstNonEmpty(patch.RawOutput, previous.RawOutput)
	merged.Error = firstNonEmpty(patch.Error, previous.Error)
	merged.Digest = firstNonEmpty(patch.Digest, previous.Digest)
	merged.Actions = patch.Actions
	merged.ToolCalls = patch.ToolCalls
	if len(patch.Channels) > 0 {
		merged.Channels = patch.Channels
	}
	merged.Steps = maxInt(patch.Steps, previous.Steps)
	merged.DurationSeconds = maxFloat64(patch.DurationSeconds, previous.DurationSeconds)
	merged.Mutations = maxInt(patch.Mutations, previous.Mutations)
	merged.Failures = maxInt(patch.Failures, previous.Failures)
	merged.TokensUsed = maxInt(patch.TokensUsed, previous.TokensUsed)
	merged.Metadata = patch.Metadata
	return normalizeTriageContext(merged)
}

func triageKey(id int64) string {
	return fmt.Sprintf("%d", id)
}

func newTriageID() int64 {
	return time.Now().UTC().UnixMilli()*1000 + atomic.AddInt64(&triageIDSequence, 1)%1000
}

func parseTriageTimestamp(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func maxFloat64(a float64, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
