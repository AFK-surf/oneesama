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

const slackLearningSignalsCollection = "slack_learning_signals"

const (
	slackLearningSourceApprovalCard             = "approval_card"
	slackLearningSourceAllowCanary              = "visible_reply_allow_list_canary"
	slackLearningSourceIncident                 = "production_incident"
	slackLearningSourceBenchmark                = "benchmark"
	slackLearningSourceReactionBackedConclusion = "reaction_backed_human_conclusion"
)

type SlackLearningSignal struct {
	ID             int64          `json:"id"`
	Source         string         `json:"source"`
	Surface        string         `json:"surface,omitempty"`
	Verdict        string         `json:"verdict"`
	Refs           []string       `json:"refs,omitempty"`
	ReasonCode     string         `json:"reason_code,omitempty"`
	ProposedAction string         `json:"proposed_action,omitempty"`
	Target         string         `json:"target,omitempty"`
	Subject        string         `json:"subject,omitempty"`
	SourceType     string         `json:"source_type,omitempty"`
	Content        string         `json:"content,omitempty"`
	Timestamp      string         `json:"timestamp"`
	Metadata       map[string]any `json:"metadata,omitempty"`
}

type slackLearningSignalStore struct {
	mu      sync.Mutex
	signals *persistence.TypedCollection[SlackLearningSignal]
}

func newSlackLearningSignalStore(cfg appconfig.PersistenceConfig, logger warnLogger) *slackLearningSignalStore {
	collection, err := persistence.OpenTyped[SlackLearningSignal](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackLearningSignalsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack learning signal store init failed", "error", err)
		return nil
	}
	return &slackLearningSignalStore{signals: collection}
}

func (s *slackLearningSignalStore) Insert(ctx context.Context, signal SlackLearningSignal) (*SlackLearningSignal, error) {
	if s == nil || s.signals == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	signal = normalizeSlackLearningSignal(signal)
	if signal.Source == "" {
		return nil, fmt.Errorf("learning signal source is required")
	}
	if signal.Verdict == "" {
		return nil, fmt.Errorf("learning signal verdict is required")
	}
	if signal.ID == 0 {
		signal.ID = newHeartbeatID()
	}
	if err := s.signals.Set(ctx, heartbeatKey(signal.ID), signal); err != nil {
		return nil, fmt.Errorf("record learning signal: %w", err)
	}
	return &signal, nil
}

func (s *slackLearningSignalStore) List(ctx context.Context, limit int, since time.Time) ([]SlackLearningSignal, error) {
	if s == nil || s.signals == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 100
	}
	records, err := s.signals.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list learning signals: %w", err)
	}
	var out []SlackLearningSignal
	for _, signal := range records {
		if !since.IsZero() {
			timestamp := parseTriageTimestamp(signal.Timestamp)
			if timestamp.IsZero() || timestamp.Before(since) {
				continue
			}
		}
		out = append(out, signal)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Timestamp == out[j].Timestamp {
			return out[i].ID > out[j].ID
		}
		return out[i].Timestamp > out[j].Timestamp
	})
	if limit > len(out) {
		limit = len(out)
	}
	return append([]SlackLearningSignal(nil), out[:limit]...), nil
}

func normalizeSlackLearningSignal(signal SlackLearningSignal) SlackLearningSignal {
	signal.Source = strings.TrimSpace(signal.Source)
	signal.Surface = strings.TrimSpace(signal.Surface)
	signal.Verdict = strings.TrimSpace(signal.Verdict)
	signal.ReasonCode = strings.TrimSpace(signal.ReasonCode)
	signal.ProposedAction = strings.TrimSpace(signal.ProposedAction)
	signal.Target = strings.TrimSpace(signal.Target)
	signal.Subject = strings.TrimSpace(signal.Subject)
	signal.SourceType = strings.TrimSpace(signal.SourceType)
	signal.Content = truncateSlackContextText(strings.TrimSpace(signal.Content), 800)
	signal.Timestamp = strings.TrimSpace(signal.Timestamp)
	signal.Refs = compactUniqueStrings(signal.Refs)
	if signal.Timestamp == "" {
		signal.Timestamp = timeNow().UTC().Format(time.RFC3339Nano)
	}
	if signal.SourceType == "" {
		signal.SourceType = signal.Source
	}
	if signal.Subject == "" {
		signal.Subject = "unknown"
	}
	if signal.ProposedAction == "" {
		signal.ProposedAction = "memory_candidate"
	}
	return signal
}

func SlackDreamSignalFromLearningSignal(signal SlackLearningSignal) SlackDreamSignal {
	signal = normalizeSlackLearningSignal(signal)
	return SlackDreamSignal{
		Source:         signal.Source,
		Surface:        signal.Surface,
		Verdict:        signal.Verdict,
		Refs:           signal.Refs,
		ReasonCode:     signal.ReasonCode,
		ProposedAction: signal.ProposedAction,
		Target:         signal.Target,
		Subject:        signal.Subject,
		SourceType:     signal.SourceType,
		Content:        signal.Content,
		Timestamp:      signal.Timestamp,
	}
}

func SlackDreamSignalsFromLearningSignals(signals []SlackLearningSignal) []SlackDreamSignal {
	out := make([]SlackDreamSignal, 0, len(signals))
	for _, signal := range signals {
		out = append(out, SlackDreamSignalFromLearningSignal(signal))
	}
	return out
}
