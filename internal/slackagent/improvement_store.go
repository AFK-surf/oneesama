package slackagent

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const slackImprovementSignalsCollection = "slack_improvement_signals"

const (
	improvementSignalTypeComplaint  = "complaint"
	improvementSignalTypeProposal   = "proposal"
	improvementSignalTypePreference = "preference"
	improvementSignalTypeSuccess    = "success"
	improvementSignalTypeConfirm    = "confirm"
	improvementSignalTypeDismiss    = "dismiss"
)

const (
	improvementSignalSeverityLow      = "low"
	improvementSignalSeverityMedium   = "medium"
	improvementSignalSeverityHigh     = "high"
	improvementSignalSeverityCritical = "critical"
)

const (
	improvementSignalStatusOpen     = "open"
	improvementSignalStatusAbsorbed = "absorbed"
	improvementSignalStatusResolved = "resolved"
)

type slackImprovementStore struct {
	mu      sync.Mutex
	signals *persistence.TypedCollection[SlackImprovementSignal]
}

func newSlackImprovementStore(cfg appconfig.PersistenceConfig, logger warnLogger) *slackImprovementStore {
	collection, err := persistence.OpenTyped[SlackImprovementSignal](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackImprovementSignalsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack improvement store init failed", "error", err)
		return nil
	}
	return &slackImprovementStore{signals: collection}
}

func (s *slackImprovementStore) InsertSignal(ctx context.Context, signal SlackImprovementSignal) (*SlackImprovementSignal, error) {
	if s == nil || s.signals == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	signal = normalizeImprovementSignal(signal)
	if signal.Topic == "" {
		return nil, fmt.Errorf("improvement signal topic is required")
	}
	if signal.Summary == "" {
		return nil, fmt.Errorf("improvement signal summary is required")
	}
	existing, err := s.signals.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list improvement signals for dedupe: %w", err)
	}
	for _, candidate := range existing {
		if sameImprovementSignal(candidate, signal) {
			return &candidate, nil
		}
	}
	if signal.ID == 0 {
		signal.ID = newHeartbeatID()
	}
	if err := s.signals.Set(ctx, heartbeatKey(signal.ID), signal); err != nil {
		return nil, fmt.Errorf("record improvement signal: %w", err)
	}
	return &signal, nil
}

func (s *slackImprovementStore) ListSignals(ctx context.Context, limit int, statuses []string, since time.Time) ([]SlackImprovementSignal, error) {
	if s == nil || s.signals == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 50
	}
	records, err := s.signals.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list improvement signals: %w", err)
	}
	filtered := filterImprovementSignals(records, statuses, since, "")
	sortImprovementSignals(filtered)
	if limit > len(filtered) {
		limit = len(filtered)
	}
	return append([]SlackImprovementSignal(nil), filtered[:limit]...), nil
}

func (s *slackImprovementStore) ListSignalsForCluster(ctx context.Context, clusterKey string, statuses []string, since time.Time, limit int) ([]SlackImprovementSignal, error) {
	if strings.TrimSpace(clusterKey) == "" {
		return nil, nil
	}
	if s == nil || s.signals == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 50
	}
	records, err := s.signals.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list improvement signals for cluster: %w", err)
	}
	filtered := filterImprovementSignals(records, statuses, since, strings.TrimSpace(clusterKey))
	sortImprovementSignals(filtered)
	if limit > len(filtered) {
		limit = len(filtered)
	}
	return append([]SlackImprovementSignal(nil), filtered[:limit]...), nil
}

func (s *slackImprovementStore) UpdateSignalStatus(ctx context.Context, ids []int64, status string) error {
	if s == nil || s.signals == nil || len(ids) == 0 {
		return nil
	}
	status = normalizeImprovementSignalStatus(status)
	idSet := map[int64]struct{}{}
	for _, id := range ids {
		if id != 0 {
			idSet[id] = struct{}{}
		}
	}
	if len(idSet) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.signals.List(ctx)
	if err != nil {
		return fmt.Errorf("list improvement signals for status update: %w", err)
	}
	for _, record := range records {
		if _, ok := idSet[record.ID]; !ok {
			continue
		}
		record.Status = status
		record.UpdatedAt = nowRFC3339()
		if err := s.signals.Set(ctx, heartbeatKey(record.ID), record); err != nil {
			return fmt.Errorf("update improvement signal: %w", err)
		}
	}
	return nil
}

func (s *slackImprovementStore) CountOpen(ctx context.Context) (int, error) {
	if s == nil || s.signals == nil {
		return 0, nil
	}
	records, err := s.signals.List(ctx)
	if err != nil {
		return 0, fmt.Errorf("count improvement signals: %w", err)
	}
	count := 0
	for _, record := range records {
		if strings.EqualFold(record.Status, improvementSignalStatusOpen) {
			count++
		}
	}
	return count, nil
}

func normalizeImprovementSignal(signal SlackImprovementSignal) SlackImprovementSignal {
	now := nowRFC3339()
	signal.Topic = strings.TrimSpace(signal.Topic)
	signal.SignalType = normalizeImprovementSignalType(signal.SignalType)
	signal.Summary = strings.TrimSpace(signal.Summary)
	signal.DesiredBehavior = strings.TrimSpace(signal.DesiredBehavior)
	signal.Severity = normalizeImprovementSignalSeverity(signal.Severity)
	signal.ChannelID = strings.TrimSpace(signal.ChannelID)
	signal.ThreadTS = strings.TrimSpace(signal.ThreadTS)
	signal.MsgTS = strings.TrimSpace(signal.MsgTS)
	signal.SessionID = strings.TrimSpace(signal.SessionID)
	signal.ClusterKey = strings.TrimSpace(signal.ClusterKey)
	if signal.ClusterKey == "" {
		signal.ClusterKey = signal.Topic
	}
	signal.Status = normalizeImprovementSignalStatus(signal.Status)
	if signal.Summary == "" {
		signal.Summary = signal.DesiredBehavior
	}
	if signal.Confidence < 0 {
		signal.Confidence = 0
	}
	if signal.Confidence > 1 {
		signal.Confidence = 1
	}
	if signal.CreatedAt == "" {
		signal.CreatedAt = now
	}
	signal.UpdatedAt = now
	if signal.Metadata == nil {
		signal.Metadata = map[string]any{}
	}
	return signal
}

func normalizeImprovementSignalType(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case improvementSignalTypeProposal,
		improvementSignalTypePreference,
		improvementSignalTypeSuccess,
		improvementSignalTypeConfirm,
		improvementSignalTypeDismiss:
		return strings.TrimSpace(strings.ToLower(value))
	default:
		return improvementSignalTypeComplaint
	}
}

func normalizeImprovementSignalSeverity(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case improvementSignalSeverityLow,
		improvementSignalSeverityHigh,
		improvementSignalSeverityCritical:
		return strings.TrimSpace(strings.ToLower(value))
	default:
		return improvementSignalSeverityMedium
	}
}

func normalizeImprovementSignalStatus(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case improvementSignalStatusAbsorbed, improvementSignalStatusResolved:
		return strings.TrimSpace(strings.ToLower(value))
	default:
		return improvementSignalStatusOpen
	}
}

func sameImprovementSignal(a, b SlackImprovementSignal) bool {
	return a.Topic == b.Topic &&
		a.ChannelID == b.ChannelID &&
		a.ThreadTS == b.ThreadTS &&
		firstNonEmpty(a.MsgTS, a.SessionID, a.Summary) == firstNonEmpty(b.MsgTS, b.SessionID, b.Summary)
}

func filterImprovementSignals(records []SlackImprovementSignal, statuses []string, since time.Time, clusterKey string) []SlackImprovementSignal {
	statusSet := map[string]struct{}{}
	for _, status := range statuses {
		statusSet[normalizeImprovementSignalStatus(status)] = struct{}{}
	}
	filtered := make([]SlackImprovementSignal, 0, len(records))
	for _, record := range records {
		record = normalizeImprovementSignal(record)
		if clusterKey != "" && record.ClusterKey != clusterKey {
			continue
		}
		if len(statusSet) > 0 {
			if _, ok := statusSet[record.Status]; !ok {
				continue
			}
		}
		if !since.IsZero() {
			created, err := time.Parse(time.RFC3339Nano, record.CreatedAt)
			if err == nil && created.Before(since) {
				continue
			}
		}
		filtered = append(filtered, record)
	}
	return filtered
}

func sortImprovementSignals(records []SlackImprovementSignal) {
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].CreatedAt == records[j].CreatedAt {
			return records[i].ID > records[j].ID
		}
		return records[i].CreatedAt > records[j].CreatedAt
	})
}
