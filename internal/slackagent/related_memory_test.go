package slackagent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSearchRelatedMemoryReturnsTypedWorkspaceEvidence(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/questions/meeting-memory.md", strings.Join([]string{
		"# Meeting memory question",
		"",
		"Bridge long-term memory depends on memory_write and related-topic recall.",
		"It should cite the prior Slack thread before answering Aha Moment questions.",
	}, "\n"))
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("为什么 bridge memory_write 不能回答 Aha Moment", SlackRelatedMemorySearchOptions{Limit: 5})

	if result.Status != "ok" || result.NoRelevantMemory {
		t.Fatalf("result = %#v, want relevant memory", result)
	}
	record := firstRelatedMemoryKind(result.Results, "team_question")
	if record == nil {
		t.Fatalf("results = %#v, want team_question record", result.Results)
	}
	if record.SourcePath != "memory/team/questions/meeting-memory.md" {
		t.Fatalf("SourcePath = %q, want memory/team/questions/meeting-memory.md", record.SourcePath)
	}
	if record.StartLine != 1 || record.EndLine < 3 {
		t.Fatalf("line range = %d-%d, want markdown evidence range", record.StartLine, record.EndLine)
	}
	if record.UpdatedAt == "" {
		t.Fatalf("UpdatedAt empty for file-backed memory record: %#v", *record)
	}
	if !strings.Contains(record.Content, "memory_write") {
		t.Fatalf("Content = %q, want matching evidence", record.Content)
	}
	if !relatedMemoryReasonsContain(record.Reasons, "family_boost:team_question") {
		t.Fatalf("Reasons = %#v, want team_question family boost", record.Reasons)
	}
}

func TestSearchRelatedMemoryBoostsPersonProfileForOwnerQuery(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/people/haowen.md", strings.Join([]string{
		"# Haowen",
		"",
		"Haowen is the review owner for cueboard memory migration PRs.",
		"Ask Haowen when the review path needs a final approval signal.",
	}, "\n"))
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/actions/review.md", strings.Join([]string{
		"# Review queue",
		"",
		"Cueboard memory migration PRs need review before merge.",
	}, "\n"))
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("找谁 review cueboard memory migration PR", SlackRelatedMemorySearchOptions{Limit: 5})

	record := firstRelatedMemoryKind(result.Results, "person_profile")
	if record == nil {
		t.Fatalf("results = %#v, want person_profile record", result.Results)
	}
	if !strings.Contains(record.Content, "Haowen") {
		t.Fatalf("Content = %q, want person evidence", record.Content)
	}
	if !relatedMemoryReasonsContain(record.Reasons, "family_boost:person_profile") {
		t.Fatalf("Reasons = %#v, want person profile family boost", record.Reasons)
	}
}

func TestSearchRelatedMemoryIncludesTriageProjection(t *testing.T) {
	workspaceDir := t.TempDir()
	projection := []SlackTriageContext{{
		SessionID: "triage-run-123",
		Timestamp: "2026-05-18T09:10:00Z",
		Status:    "ok",
		Channels:  []string{"C123"},
		Summary:   "Delayed no-reply caught a bridge memory Aha Moment question.",
		Digest:    "C123:1779000000.000001 asked why related-topic recall did not surface.",
	}}
	raw, err := json.Marshal(projection)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(workspaceDir, "memory"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspaceDir, "memory", triageContextFile), raw, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("related-topic recall Aha Moment", SlackRelatedMemorySearchOptions{Limit: 5})

	record := firstRelatedMemoryKind(result.Results, "triage_projection")
	if record == nil {
		t.Fatalf("results = %#v, want triage_projection record", result.Results)
	}
	if record.SourceRef != "triage-run-123" || !strings.Contains(record.Source, "triage-run-123") {
		t.Fatalf("record = %#v, want triage projection provenance", *record)
	}
}

func TestSearchRelatedMemoryIncludesFeedbackSignals(t *testing.T) {
	workspaceDir := t.TempDir()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})
	entry := SlackFeedbackEntry{
		Action:     "not_helpful",
		ActionType: "reply_quality",
		Channel:    "CFEEDBACK",
		ThreadTS:   "1779000000.000001",
		UserID:     "UFEEDBACK",
		Summary:    "The delayed no-reply answer missed the memory recall evidence.",
		CreatedAt:  time.Date(2026, 5, 18, 11, 0, 0, 0, time.UTC).Format(time.RFC3339),
	}
	if _, err := service.feedback.InsertEntry(context.Background(), entry); err != nil {
		t.Fatalf("InsertEntry: %v", err)
	}

	result := service.SearchRelatedMemory("memory recall evidence", SlackRelatedMemorySearchOptions{Limit: 5})

	record := firstRelatedMemoryKind(result.Results, "feedback")
	if record == nil {
		t.Fatalf("results = %#v, want feedback record", result.Results)
	}
	if !strings.Contains(record.Content, "memory recall evidence") {
		t.Fatalf("Content = %q, want feedback evidence", record.Content)
	}
	if record.CreatedAt != entry.CreatedAt || record.UpdatedAt != entry.CreatedAt {
		t.Fatalf("record timestamps = %q/%q, want feedback CreatedAt %q", record.CreatedAt, record.UpdatedAt, entry.CreatedAt)
	}
}

func TestSearchRelatedMemoryNoRelevantMemory(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/facts/unrelated.md", "Only deployment notes live here.")
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("calendar approval scanner", SlackRelatedMemorySearchOptions{Limit: 5})

	if result.Status != "no_relevant_memory" || !result.NoRelevantMemory || len(result.Results) != 0 {
		t.Fatalf("result = %#v, want no relevant memory", result)
	}
}

func TestSearchRelatedMemoryBoostsRecentDailyNote(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/2026-05-18.md", "Today discussed related memory recall and Aha Moment answers.")
	writeRelatedMemoryFile(t, workspaceDir, "memory/2026-05-10.md", "Earlier discussed related memory recall and Aha Moment answers.")
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("related memory recall Aha Moment", SlackRelatedMemorySearchOptions{
		Limit: 5,
		Now:   time.Date(2026, 5, 18, 12, 0, 0, 0, shanghaiLocation()),
	})

	if len(result.Results) < 2 {
		t.Fatalf("results = %#v, want daily notes", result.Results)
	}
	if result.Results[0].SourcePath != "memory/2026-05-18.md" {
		t.Fatalf("top result = %#v, want today's daily note first", result.Results[0])
	}
	if !relatedMemoryReasonsContain(result.Results[0].Reasons, "recent_memory") {
		t.Fatalf("Reasons = %#v, want recent_memory boost", result.Results[0].Reasons)
	}
	if result.Results[0].CreatedAt == "" {
		t.Fatalf("top result = %#v, want best-effort CreatedAt from daily note path", result.Results[0])
	}
}

func TestSearchRelatedMemoryExtractsRepoSignalsFromPRURLs(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/decisions/cueboard-review.md", strings.Join([]string{
		"# Cueboard review policy",
		"",
		"Cueboard PR review requests are workflow routing, not article opinion prompts.",
	}, "\n"))
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("https://github.com/AFK-surf/cueboard/pull/1917 来 review", SlackRelatedMemorySearchOptions{Limit: 5})

	record := firstRelatedMemoryKind(result.Results, "team_decision")
	if record == nil {
		t.Fatalf("results = %#v, want repo/project related decision", result.Results)
	}
	if !relatedMemoryReasonsContain(record.Reasons, "project_or_repo_boost") {
		t.Fatalf("Reasons = %#v, want project/repo boost from PR URL", record.Reasons)
	}
}

func writeRelatedMemoryFile(t *testing.T, workspaceDir, relPath, content string) {
	t.Helper()
	fullPath := filepath.Join(workspaceDir, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", filepath.Dir(fullPath), err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", fullPath, err)
	}
}

func firstRelatedMemoryKind(records []SlackRelatedMemoryRecord, kind string) *SlackRelatedMemoryRecord {
	for index := range records {
		if records[index].Kind == kind {
			return &records[index]
		}
	}
	return nil
}

func relatedMemoryReasonsContain(reasons []string, want string) bool {
	for _, reason := range reasons {
		if reason == want {
			return true
		}
	}
	return false
}
