package slackagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityReplyFeedbackPersistsMemoryAndImprovementSignal(t *testing.T) {
	withFeedbackMemoryClock(t, time.Date(2026, 5, 17, 13, 30, 0, 0, shanghaiLocation()))
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true, Dir: t.TempDir()},
		},
	})

	response := service.HandleSlackInteraction(context.Background(), SlackInteractionPayload{
		Channel: &SlackInteractionChannel{ID: "C123"},
		User:    &SlackInteractionUser{ID: "UFEEDBACK"},
		Message: &SlackInteractionMessage{
			TS:       "1779000000.000001",
			ThreadTS: "1779000000.000001",
			Blocks: []SlackBlock{
				{Type: "section", Text: &SlackBlockText{Text: "This answer missed the memory write path."}},
				{Type: "section", BlockID: replyFeedbackBlockID, Text: &SlackBlockText{Text: "feedback footer"}},
			},
		},
		Actions: []SlackInteractionAction{{
			ActionID:       "reply_feedback",
			SelectedOption: &SlackInteractionSelectedValue{Value: replyFeedbackNotHelpful},
		}},
	})
	if !response.OK || !strings.Contains(response.Text, "Feedback saved") {
		t.Fatalf("response = %#v, want feedback saved acknowledgement", response)
	}

	entries, err := service.feedback.ListEntries(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v, want one feedback entry", entries)
	}
	entry := entries[0]
	if entry.Action != replyFeedbackNotHelpful || entry.ActionType != replyFeedbackActionType || entry.Channel != "C123" || entry.UserID != "UFEEDBACK" {
		t.Fatalf("entry = %#v, want cueboard-style reply feedback row", entry)
	}
	if strings.Contains(entry.Summary, "feedback footer") || !strings.Contains(entry.Summary, "memory write path") {
		t.Fatalf("summary = %q, want assistant reply summary without footer", entry.Summary)
	}

	projection := readFeedbackTestFile(t, filepath.Join(workspaceDir, "memory", "feedback", "2026-05-17.md"))
	for _, want := range []string{"[13:30]", "not_helpful reply_quality #C123", "memory write path", "by UFEEDBACK"} {
		if !strings.Contains(projection, want) {
			t.Fatalf("projection = %q, missing %q", projection, want)
		}
	}

	signals, err := service.improvements.ListSignals(context.Background(), 10, nil, time.Time{})
	if err != nil {
		t.Fatalf("ListSignals: %v", err)
	}
	if len(signals) != 1 || signals[0].Topic != improvementTopicReplyQuality || signals[0].SignalType != improvementSignalTypeDismiss {
		t.Fatalf("signals = %#v, want reply_quality dismiss signal", signals)
	}

	summary := service.MemorySummary()
	if summary.FeedbackEntries != 1 {
		t.Fatalf("summary = %#v, want dynamic feedback count", summary)
	}
	results := service.SearchLocalMemory("memory write path", 5)
	if !memoryResultsContainKind(results, "feedback") || !memoryResultsContainKind(results, "workspace_memory_file") {
		t.Fatalf("results = %#v, want stored feedback and projection searchable", results)
	}
	agentContext := service.buildLocalSlackMemoryContext("unrelated query", 5)
	if !strings.Contains(agentContext.RecentFeedback, "not_helpful reply_quality #C123") {
		t.Fatalf("recent feedback = %q, want cueboard-style feedback injected into memory context", agentContext.RecentFeedback)
	}
}

func TestCueboardParityPendingActionChoicePersistsFeedbackMemory(t *testing.T) {
	withFeedbackMemoryClock(t, time.Date(2026, 5, 17, 14, 5, 0, 0, shanghaiLocation()))
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true, Dir: t.TempDir()},
		},
	})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "COPS",
		ThreadTS:   "1779000010.000002",
		ActionType: slackActionTypeCreateIssue,
		Params: map[string]any{
			"title": "Record memory feedback parity gap",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:        record.ID,
		Status:    "dismissed",
		UserID:    "UOWNER",
		ChannelID: "COPS",
		ThreadTS:  "1779000010.000002",
	})
	if !response.OK || !strings.Contains(response.Text, "marked dismissed") {
		t.Fatalf("response = %#v, want pending action dismissed", response)
	}

	entries, err := service.feedback.ListEntries(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v, want one feedback entry", entries)
	}
	entry := entries[0]
	if entry.Action != "dismissed" || entry.ActionType != slackActionTypeCreateIssue || !strings.Contains(entry.Summary, "Record memory feedback") {
		t.Fatalf("entry = %#v, want pending action feedback summary", entry)
	}
	projection := readFeedbackTestFile(t, filepath.Join(workspaceDir, "memory", "feedback", "2026-05-17.md"))
	if !strings.Contains(projection, "dismissed create_issue #COPS") || !strings.Contains(projection, "by UOWNER") {
		t.Fatalf("projection = %q, want pending action feedback projection", projection)
	}

	signals, err := service.improvements.ListSignals(context.Background(), 10, nil, time.Time{})
	if err != nil {
		t.Fatalf("ListSignals: %v", err)
	}
	if len(signals) != 1 || signals[0].Topic != improvementTopicActionSuggestion || signals[0].SignalType != improvementSignalTypeDismiss {
		t.Fatalf("signals = %#v, want action suggestion dismiss signal", signals)
	}
}

func TestCueboardParityMemoryGetWriteUsesLiveWorkspace(t *testing.T) {
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true, Dir: t.TempDir()},
		},
	})

	writeResult := service.executeMemoryWriteTool(map[string]any{
		"path":    "memory/team/decisions.md",
		"content": "# Decisions\n\nUse live workspace memory.",
	})
	if !writeResult.OK {
		t.Fatalf("write result = %#v, want ok", writeResult)
	}
	if _, err := os.Stat(filepath.Join(workspaceDir, "memory", "team", "decisions.md")); err != nil {
		t.Fatalf("live workspace memory file not written: %v", err)
	}
	getResult := service.executeMemoryGetTool(map[string]any{"path": "memory/team/decisions.md"})
	resultMap, _ := getResult.Result.(map[string]any)
	if !getResult.OK || !strings.Contains(stringFromAny(resultMap["content"]), "live workspace memory") {
		t.Fatalf("get result = %#v, want live workspace content", getResult)
	}
}

func readFeedbackTestFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

func withFeedbackMemoryClock(t *testing.T, now time.Time) {
	t.Helper()
	previous := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previous })
}

func memoryResultsContainKind(results []SlackMemoryResult, kind string) bool {
	for _, result := range results {
		if result.Kind == kind {
			return true
		}
	}
	return false
}
