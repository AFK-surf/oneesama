package slackagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const (
	slackFeedbackEntriesCollection = "slack_feedback_entries"
	replyFeedbackHelpful           = "helpful"
	replyFeedbackNotHelpful        = "not_helpful"
	replyFeedbackActionType        = "reply_quality"
)

type SlackFeedbackEntry struct {
	ID         int64  `json:"id"`
	EntryDate  string `json:"entry_date"`
	EntryTime  string `json:"entry_time"`
	Action     string `json:"action"`
	Channel    string `json:"channel"`
	ThreadTS   string `json:"thread_ts,omitempty"`
	ActionType string `json:"action_type"`
	Summary    string `json:"summary"`
	UserID     string `json:"user_id"`
	CreatedAt  string `json:"created_at"`
}

type slackFeedbackStore struct {
	mu      sync.Mutex
	entries *persistence.TypedCollection[SlackFeedbackEntry]
}

var feedbackProjectionMu sync.Mutex

func newSlackFeedbackStore(cfg appconfig.PersistenceConfig, logger warnLogger) *slackFeedbackStore {
	collection, err := persistence.OpenTyped[SlackFeedbackEntry](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackFeedbackEntriesCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack feedback store init failed", "error", err)
		return nil
	}
	return &slackFeedbackStore{entries: collection}
}

func (s *slackFeedbackStore) InsertEntry(ctx context.Context, entry SlackFeedbackEntry) (*SlackFeedbackEntry, error) {
	if s == nil || s.entries == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry = normalizeSlackFeedbackEntry(entry)
	if entry.Action == "" || entry.Channel == "" || entry.ActionType == "" {
		return nil, fmt.Errorf("feedback action/channel/action_type are required")
	}
	if entry.ID == 0 {
		entry.ID = newHeartbeatID()
	}
	if err := s.entries.Set(ctx, heartbeatKey(entry.ID), entry); err != nil {
		return nil, fmt.Errorf("record feedback entry: %w", err)
	}
	return &entry, nil
}

func (s *slackFeedbackStore) ListEntries(ctx context.Context, limit int) ([]SlackFeedbackEntry, error) {
	if s == nil || s.entries == nil {
		return nil, nil
	}
	records, err := s.entries.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list feedback entries: %w", err)
	}
	sortFeedbackEntries(records)
	if limit > 0 && len(records) > limit {
		records = records[:limit]
	}
	return append([]SlackFeedbackEntry(nil), records...), nil
}

func (s *slackFeedbackStore) CountEntries(ctx context.Context) (int, error) {
	if s == nil || s.entries == nil {
		return 0, nil
	}
	records, err := s.entries.List(ctx)
	if err != nil {
		return 0, fmt.Errorf("count feedback entries: %w", err)
	}
	return len(records), nil
}

func (s *slackFeedbackStore) SearchResults(ctx context.Context, keywords []string, limit int) []SlackMemoryResult {
	entries, err := s.ListEntries(ctx, 0)
	if err != nil {
		return nil
	}
	var results []SlackMemoryResult
	for _, entry := range entries {
		content := feedbackEntryMemoryText(entry)
		score := scoreMemoryText(content, keywords)
		if score <= 0 {
			continue
		}
		results = append(results, SlackMemoryResult{
			Kind:    "feedback",
			Source:  feedbackEntrySource(entry),
			Score:   score,
			Content: memorySnippet(content),
			Row: map[string]any{
				"id":          entry.ID,
				"entry_date":  entry.EntryDate,
				"entry_time":  entry.EntryTime,
				"action":      entry.Action,
				"channel":     entry.Channel,
				"thread_ts":   entry.ThreadTS,
				"action_type": entry.ActionType,
				"summary":     entry.Summary,
				"user_id":     entry.UserID,
			},
		})
	}
	sortMemoryResults(results)
	return limitMemoryResults(results, limit)
}

func (s *slackFeedbackStore) RecentMarkdown(ctx context.Context, limit int) string {
	entries, err := s.ListEntries(ctx, limit)
	if err != nil || len(entries) == 0 {
		return ""
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].EntryDate != entries[j].EntryDate {
			return entries[i].EntryDate < entries[j].EntryDate
		}
		if entries[i].EntryTime != entries[j].EntryTime {
			return entries[i].EntryTime < entries[j].EntryTime
		}
		return entries[i].ID < entries[j].ID
	})
	var out []string
	currentDate := ""
	for _, entry := range entries {
		if entry.EntryDate != currentDate {
			currentDate = entry.EntryDate
			out = append(out, "#### "+currentDate)
		}
		out = append(out, fmt.Sprintf("- [%s] %s %s #%s — %q — by %s",
			entry.EntryTime, entry.Action, entry.ActionType, entry.Channel, entry.Summary, entry.UserID))
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func normalizeSlackFeedbackEntry(entry SlackFeedbackEntry) SlackFeedbackEntry {
	now := timeNow().In(shanghaiLocation())
	entry.Action = strings.TrimSpace(entry.Action)
	entry.Channel = strings.TrimPrefix(strings.TrimSpace(entry.Channel), "#")
	entry.ThreadTS = strings.TrimSpace(entry.ThreadTS)
	entry.ActionType = strings.TrimSpace(entry.ActionType)
	entry.Summary = truncateSlackContextText(strings.TrimSpace(entry.Summary), 180)
	entry.UserID = strings.TrimSpace(entry.UserID)
	if entry.EntryDate == "" {
		entry.EntryDate = now.Format("2006-01-02")
	}
	if entry.EntryTime == "" {
		entry.EntryTime = now.Format("15:04")
	}
	if entry.CreatedAt == "" {
		entry.CreatedAt = now.UTC().Format(time.RFC3339Nano)
	}
	if entry.Summary == "" {
		entry.Summary = "n/a"
	}
	return entry
}

func sortFeedbackEntries(entries []SlackFeedbackEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].EntryDate != entries[j].EntryDate {
			return entries[i].EntryDate > entries[j].EntryDate
		}
		if entries[i].EntryTime != entries[j].EntryTime {
			return entries[i].EntryTime > entries[j].EntryTime
		}
		return entries[i].ID > entries[j].ID
	})
}

func feedbackEntryMemoryText(entry SlackFeedbackEntry) string {
	parts := []string{
		"Slack feedback memory",
		"date: " + entry.EntryDate,
		"time: " + entry.EntryTime,
		"action: " + entry.Action,
		"action_type: " + entry.ActionType,
		"channel: " + entry.Channel,
		"summary: " + entry.Summary,
		"user: " + entry.UserID,
	}
	if entry.ThreadTS != "" {
		parts = append(parts, "thread: "+entry.ThreadTS)
	}
	return strings.Join(parts, "\n")
}

func feedbackEntrySource(entry SlackFeedbackEntry) string {
	parts := []string{entry.Channel, entry.ThreadTS, fmt.Sprint(entry.ID)}
	var kept []string
	for _, part := range parts {
		if strings.TrimSpace(part) != "" {
			kept = append(kept, strings.TrimSpace(part))
		}
	}
	if len(kept) == 0 {
		return "feedback"
	}
	return strings.Join(kept, ":")
}

func writeFeedbackProjection(workspaceDir string, entry SlackFeedbackEntry) error {
	if strings.TrimSpace(workspaceDir) == "" {
		return nil
	}
	entry = normalizeSlackFeedbackEntry(entry)
	line := fmt.Sprintf("- [%s] %s %s #%s — %q — by %s\n",
		entry.EntryTime, entry.Action, entry.ActionType, entry.Channel, entry.Summary, entry.UserID)
	dir := filepath.Join(workspaceDir, "memory", "feedback")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, entry.EntryDate+".md")
	feedbackProjectionMu.Lock()
	defer feedbackProjectionMu.Unlock()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(line)
	return err
}

func selectedReplyFeedbackKind(action SlackInteractionAction) string {
	value := strings.TrimSpace(selectedOptionValue(action.SelectedOption))
	if value == "" {
		value = strings.TrimSpace(action.Value)
	}
	switch value {
	case replyFeedbackHelpful, replyFeedbackNotHelpful:
		return value
	default:
		return ""
	}
}
