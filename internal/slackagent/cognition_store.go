package slackagent

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const (
	slackChannelBrainCollection = "slack_channel_brain"
	slackThreadLedgerCollection = "slack_thread_ledger"
)

var slackUserMentionSummaryPattern = regexp.MustCompile(`<@[A-Z0-9][A-Z0-9._-]*>`)

type slackCognitionStore struct {
	brains  *persistence.TypedCollection[SlackChannelBrain]
	ledgers *persistence.TypedCollection[SlackThreadLedgerRecord]
}

func newSlackCognitionStore(cfg appconfig.PersistenceConfig, logger warnLogger) *slackCognitionStore {
	brains, err := persistence.OpenTyped[SlackChannelBrain](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackChannelBrainCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack channel brain store init failed", "error", err)
		return nil
	}
	ledgers, err := persistence.OpenTyped[SlackThreadLedgerRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackThreadLedgerCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack thread ledger store init failed", "error", err)
		return nil
	}
	return &slackCognitionStore{brains: brains, ledgers: ledgers}
}

func (s *slackCognitionStore) RecordInbound(ctx context.Context, workspaceID string, message SlackInboundMessage) error {
	if s == nil || s.ledgers == nil {
		return nil
	}
	message = normalizeSlackInboundMessage(message)
	threadTS := firstNonEmpty(message.ThreadTS, message.TS, "channel-root")
	if workspaceID == "" || message.ChannelID == "" || threadTS == "" || message.UserID == "" {
		return nil
	}
	id := threadLedgerID(workspaceID, message.ChannelID, threadTS)
	previous, ok, err := s.ledgers.Get(ctx, id)
	if err != nil {
		return fmt.Errorf("load thread ledger: %w", err)
	}
	now := nowRFC3339()
	record := previous
	if !ok {
		record = SlackThreadLedgerRecord{
			ID:          id,
			WorkspaceID: workspaceID,
			ChannelID:   message.ChannelID,
			ThreadTS:    threadTS,
			Status:      "active",
			OwnerUserID: message.UserID,
			CreatedAt:   now,
		}
	}
	if record.OwnerUserID == "" {
		record.OwnerUserID = message.UserID
	}
	record.LastUserID = message.UserID
	record.LastUserMessageAt = firstNonEmpty(message.TS, now)
	record.UpdatedAt = now
	if err := s.ledgers.Set(ctx, id, record); err != nil {
		return fmt.Errorf("record thread inbound: %w", err)
	}
	return s.RebuildChannelBrainSummary(ctx, workspaceID, message.ChannelID, 6)
}

func (s *slackCognitionStore) RecordOutbound(ctx context.Context, workspaceID string, channelID string, threadTS string, summary string) error {
	if s == nil || s.ledgers == nil || workspaceID == "" || channelID == "" || threadTS == "" {
		return nil
	}
	id := threadLedgerID(workspaceID, channelID, threadTS)
	previous, ok, err := s.ledgers.Get(ctx, id)
	if err != nil {
		return fmt.Errorf("load thread ledger: %w", err)
	}
	now := nowRFC3339()
	record := previous
	if !ok {
		record = SlackThreadLedgerRecord{ID: id, WorkspaceID: workspaceID, ChannelID: channelID, ThreadTS: threadTS, Status: "active", CreatedAt: now}
	}
	record.LastAssistantMessageAt = now
	if strings.TrimSpace(summary) != "" {
		record.Summary = sanitizeThreadLedgerSummary(summary)
	}
	record.UpdatedAt = now
	if err := s.ledgers.Set(ctx, id, record); err != nil {
		return fmt.Errorf("record thread outbound: %w", err)
	}
	return s.RebuildChannelBrainSummary(ctx, workspaceID, channelID, 6)
}

func (s *slackCognitionStore) RecordTriageSummary(ctx context.Context, workspaceID string, channelID string, threadTS string, sessionID string, summary string, outcome string) error {
	if s == nil || s.ledgers == nil || workspaceID == "" || channelID == "" || threadTS == "" {
		return nil
	}
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return nil
	}
	id := threadLedgerID(workspaceID, channelID, threadTS)
	previous, ok, err := s.ledgers.Get(ctx, id)
	if err != nil {
		return fmt.Errorf("load thread ledger: %w", err)
	}
	now := nowRFC3339()
	record := previous
	if !ok {
		record = SlackThreadLedgerRecord{ID: id, WorkspaceID: workspaceID, ChannelID: channelID, ThreadTS: threadTS, Status: "active", CreatedAt: now}
	}
	record.AssistantSessionID = firstNonEmpty(sessionID, record.AssistantSessionID)
	if record.Status == "" {
		record.Status = "active"
	}
	if !strings.EqualFold(record.Status, "awaiting_confirmation") && !strings.EqualFold(record.LastActionStatus, "pending") {
		record.LastActionType = "triage"
		record.LastActionStatus = firstNonEmpty(strings.TrimSpace(outcome), "observed")
	}
	record.Summary = sanitizeThreadLedgerSummary(summary)
	record.UpdatedAt = now
	if err := s.ledgers.Set(ctx, id, record); err != nil {
		return fmt.Errorf("record thread triage summary: %w", err)
	}
	return s.RebuildChannelBrainSummary(ctx, workspaceID, channelID, 6)
}

func (s *slackCognitionStore) RecordAction(ctx context.Context, workspaceID string, channelID string, threadTS string, actionType string, actionStatus string) error {
	if s == nil || s.ledgers == nil || workspaceID == "" || channelID == "" || threadTS == "" || actionType == "" || actionStatus == "" {
		return nil
	}
	id := threadLedgerID(workspaceID, channelID, threadTS)
	previous, ok, err := s.ledgers.Get(ctx, id)
	if err != nil {
		return fmt.Errorf("load thread ledger: %w", err)
	}
	now := nowRFC3339()
	record := previous
	if !ok {
		record = SlackThreadLedgerRecord{ID: id, WorkspaceID: workspaceID, ChannelID: channelID, ThreadTS: threadTS, CreatedAt: now}
	}
	if actionStatus == "pending" {
		record.Status = "awaiting_confirmation"
	} else {
		record.Status = "active"
	}
	record.LastActionType = actionType
	record.LastActionStatus = actionStatus
	record.UpdatedAt = now
	if err := s.ledgers.Set(ctx, id, record); err != nil {
		return fmt.Errorf("record thread action: %w", err)
	}
	return s.RebuildChannelBrainSummary(ctx, workspaceID, channelID, 6)
}

func (s *slackCognitionStore) UpsertChannelBrainSummary(ctx context.Context, workspaceID string, channelID string, summary string) (*SlackChannelBrain, error) {
	if s == nil || s.brains == nil || workspaceID == "" || channelID == "" {
		return nil, nil
	}
	summary = strings.TrimSpace(summary)
	summary = sanitizeChannelBrainSummary(summary)
	id := channelBrainID(workspaceID, channelID)
	previous, ok, err := s.brains.Get(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("load channel brain: %w", err)
	}
	if !ok && summary == "" {
		return nil, nil
	}
	now := nowRFC3339()
	record := previous
	if !ok {
		record = SlackChannelBrain{ID: id, WorkspaceID: workspaceID, ChannelID: channelID, CreatedAt: now}
	}
	if ok && record.Summary == summary {
		return &record, nil
	}
	record.Summary = summary
	record.SummaryVersion++
	record.UpdatedAt = now
	if err := s.brains.Set(ctx, id, record); err != nil {
		return nil, fmt.Errorf("upsert channel brain: %w", err)
	}
	return &record, nil
}

func (s *slackCognitionStore) GetChannelBrain(ctx context.Context, workspaceID string, channelID string) (*SlackChannelBrain, error) {
	if s == nil || s.brains == nil || workspaceID == "" || channelID == "" {
		return nil, nil
	}
	record, ok, err := s.brains.Get(ctx, channelBrainID(workspaceID, channelID))
	if err != nil || !ok {
		return nil, err
	}
	record.Summary = sanitizeChannelBrainSummary(record.Summary)
	return &record, nil
}

func (s *slackCognitionStore) ListChannelBrains(ctx context.Context, limit int) ([]SlackChannelBrain, error) {
	if s == nil || s.brains == nil {
		return nil, nil
	}
	brains, err := s.brains.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list channel brains: %w", err)
	}
	for index := range brains {
		brains[index].Summary = sanitizeChannelBrainSummary(brains[index].Summary)
	}
	sort.SliceStable(brains, func(i, j int) bool { return brains[i].UpdatedAt > brains[j].UpdatedAt })
	if limit > 0 && len(brains) > limit {
		brains = brains[:limit]
	}
	return brains, nil
}

func (s *slackCognitionStore) RebuildChannelBrainSummary(ctx context.Context, workspaceID string, channelID string, limit int) error {
	records, err := s.ListRecentThreadLedgers(ctx, workspaceID, channelID, limit)
	if err != nil {
		return err
	}
	summary := buildChannelBrainSummary(records)
	brain, err := s.UpsertChannelBrainSummary(ctx, workspaceID, channelID, summary)
	if err != nil || brain == nil || len(records) == 0 || summary == "" {
		return err
	}
	brain.LastThreadTS = records[0].ThreadTS
	brain.LastSessionID = records[0].AssistantSessionID
	brain.UpdatedAt = firstNonEmpty(brain.UpdatedAt, nowRFC3339())
	return s.brains.Set(ctx, brain.ID, *brain)
}

func (s *slackCognitionStore) ThreadHasActivityAfter(ctx context.Context, channelID string, threadTS string, cutoff time.Time) bool {
	if s == nil || s.ledgers == nil || channelID == "" || threadTS == "" || cutoff.IsZero() {
		return false
	}
	records, err := s.ledgers.List(ctx)
	if err != nil {
		return false
	}
	for _, record := range records {
		if record.ChannelID != channelID || record.ThreadTS != threadTS {
			continue
		}
		if threadLedgerTimeAfter(record.LastUserMessageAt, cutoff) ||
			threadLedgerTimeAfter(record.LastAssistantMessageAt, cutoff) ||
			threadLedgerTimeAfter(record.UpdatedAt, cutoff) {
			return true
		}
	}
	return false
}

func (s *slackCognitionStore) ThreadHasAssistantActivityAfter(ctx context.Context, channelID string, threadTS string, cutoff time.Time) bool {
	if s == nil || s.ledgers == nil || channelID == "" || threadTS == "" || cutoff.IsZero() {
		return false
	}
	records, err := s.ledgers.List(ctx)
	if err != nil {
		return false
	}
	for _, record := range records {
		if record.ChannelID != channelID || record.ThreadTS != threadTS {
			continue
		}
		if threadLedgerTimeAfter(record.LastAssistantMessageAt, cutoff) {
			return true
		}
	}
	return false
}

func threadLedgerTimeAfter(value string, cutoff time.Time) bool {
	parsed := parseOptionalTime(value)
	return parsed != nil && parsed.After(cutoff.UTC())
}

func (s *slackCognitionStore) ListRecentThreadLedgers(ctx context.Context, workspaceID string, channelID string, limit int) ([]SlackThreadLedgerRecord, error) {
	if s == nil || s.ledgers == nil {
		return nil, nil
	}
	records, err := s.ledgers.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list thread ledgers: %w", err)
	}
	filtered := make([]SlackThreadLedgerRecord, 0, len(records))
	for _, record := range records {
		if record.WorkspaceID == workspaceID && record.ChannelID == channelID {
			filtered = append(filtered, record)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].UpdatedAt > filtered[j].UpdatedAt })
	if limit > 0 && len(filtered) > limit {
		filtered = filtered[:limit]
	}
	return filtered, nil
}

func (s *slackCognitionStore) ListRecentThreadLedgersForWorkspace(ctx context.Context, workspaceID string, limit int) ([]SlackThreadLedgerRecord, error) {
	if s == nil || s.ledgers == nil {
		return nil, nil
	}
	records, err := s.ledgers.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list workspace thread ledgers: %w", err)
	}
	filtered := make([]SlackThreadLedgerRecord, 0, len(records))
	for _, record := range records {
		if record.WorkspaceID == workspaceID {
			filtered = append(filtered, record)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].UpdatedAt > filtered[j].UpdatedAt })
	if limit > 0 && len(filtered) > limit {
		filtered = filtered[:limit]
	}
	return filtered, nil
}

func channelBrainID(workspaceID string, channelID string) string {
	return strings.Join([]string{firstNonEmpty(workspaceID, "workspace"), firstNonEmpty(channelID, "channel")}, ":")
}

func threadLedgerID(workspaceID string, channelID string, threadTS string) string {
	return strings.Join([]string{firstNonEmpty(workspaceID, "workspace"), firstNonEmpty(channelID, "channel"), firstNonEmpty(threadTS, "channel-root")}, ":")
}

func sanitizeThreadLedgerSummary(summary string) string {
	summary = strings.TrimSpace(slackUserMentionSummaryPattern.ReplaceAllString(summary, "@someone"))
	if summary == "" {
		return ""
	}
	if strings.Contains(summary, "\n") {
		if isStructuredThreadLedgerSummary(summary) {
			return summary
		}
		return ""
	}
	return truncateSlackContextText(strings.Join(strings.Fields(summary), " "), 500)
}

func isStructuredThreadLedgerSummary(summary string) bool {
	for _, rawLine := range strings.Split(summary, "\n") {
		line := strings.TrimSpace(strings.TrimLeft(rawLine, "-*• \t"))
		if line == "" {
			continue
		}
		if _, _, ok := parseStructuredChannelBrainNote(line); !ok {
			return false
		}
	}
	return true
}

func parseSlackTS(value string) time.Time {
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed
	}
	return time.Time{}
}
