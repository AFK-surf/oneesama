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

func TestSearchRelatedMemoryLabelsPersonaMemoryWrites(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/persona/writes/2026-05-20/episode-abcdef123456.md", strings.Join([]string{
		"# Persona memory write",
		"",
		"Peng asked Oneesama to remember that Pi foreground memory must be cited on future link commentary.",
		"Source: slack:C1:123.456",
	}, "\n"))
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/facts/generic.md", "Pi foreground memory can be used for future link commentary.")
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("Pi foreground memory future link commentary", SlackRelatedMemorySearchOptions{Limit: 5})

	record := firstRelatedMemoryKind(result.Results, "persona_memory_write")
	if record == nil {
		t.Fatalf("results = %#v, want persona_memory_write evidence", result.Results)
	}
	if record.SourcePath != "memory/persona/writes/2026-05-20/episode-abcdef123456.md" {
		t.Fatalf("SourcePath = %q, want persona memory write path", record.SourcePath)
	}
	if !relatedMemoryReasonsContain(record.Reasons, "family_boost:persona_memory_write") {
		t.Fatalf("Reasons = %#v, want persona memory write family boost", record.Reasons)
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

func TestSearchRelatedMemorySplitsMixedCJKEnglishTokens(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/meetings/jc-case-study.md", strings.Join([]string{
		"# Meeting 45",
		"Jc discussed a product launch video with five use case demos.",
		"It was a promo video project, not a recorded Case Study video set.",
	}, "\n"))
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("jc说之前录制了5个Case Study的视频，这个有吗？", SlackRelatedMemorySearchOptions{Limit: 5})

	record := firstRelatedMemoryKind(result.Results, "team_meeting")
	if record == nil {
		t.Fatalf("results = %#v, want mixed CJK/English token match", result.Results)
	}
	if !strings.Contains(record.Content, "recorded Case Study video set") {
		t.Fatalf("Content = %q, want case study evidence", record.Content)
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

func TestSearchRelatedMemoryIgnoresURLSchemeNoiseForEntityAttribution(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/2026-05-19.md", strings.Join([]string{
		"# Busy daily note",
		"",
		"Generic AI and HTTPS maintenance notes should not beat entity evidence from a URL question.",
	}, "\n"))
	writeRelatedMemoryFile(t, workspaceDir, "memory/legacy/slack-agent-d/workspace/memory/triage-archive/2026-05-19.md", strings.Join([]string{
		"# Legacy Slack Agent D triage archive 2026-05-19",
		"",
		"Old Agent D answered the Cumora question by checking public search results.",
		"It found GitHub yetone (@yetone), @Isoform, Alma releases, and no visible Cumora link.",
	}, "\n"))
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("https://cumora.ai/ 这是 yetone 搞得吗", SlackRelatedMemorySearchOptions{
		Limit: 5,
		Now:   time.Date(2026, 5, 19, 12, 0, 0, 0, shanghaiLocation()),
	})

	if len(result.Results) == 0 {
		t.Fatalf("results empty, want entity evidence")
	}
	top := result.Results[0]
	if top.Kind != "legacy_triage_archive" {
		t.Fatalf("top kind = %q, want legacy_triage_archive; top = %#v", top.Kind, top)
	}
	if !strings.Contains(top.SourcePath, "triage-archive/2026-05-19.md") {
		t.Fatalf("top result = %#v, want legacy triage archive entity evidence before generic URL noise; all results = %#v", top, result.Results)
	}
	for _, want := range []string{"yetone", "Isoform", "Alma"} {
		if !strings.Contains(top.Content, want) {
			t.Fatalf("top evidence missing %q:\n%s", want, top.Content)
		}
	}
}

func TestSearchRelatedMemoryRanksLegacyToolTraceAboveGenericRecentNote(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/2026-05-19.md", strings.Join([]string{
		"# Daily queue note",
		"",
		"Twitter reply review workflow exists as a routine scheduled queue.",
		"Generic queue notes should not outrank an old Agent D trace that captured the actual decision.",
	}, "\n"))
	writeRelatedMemoryFile(t, workspaceDir, "memory/legacy/slack-agent-d/workspace/memory/triage-archive/2026-05-17.md", strings.Join([]string{
		"# Legacy Slack Agent D triage archive 2026-05-17",
		"",
		"## Triage archive run 49eeb085-e5e1-43a3-b458-d935df43a5d6",
		"",
		"Summary:",
		"> Assistant turn 1 Tool calls: - memory_get {\"path\":\"memory/2026-05-17.md\"} - slack_api {\"method\":\"conversations.replies\",\"params\":{\"channel\":\"C0B3BFQ3KQX\",\"ts\":\"1778993634.351379\"}} Assistant turn 2 Tool calls: - memory_search {\"query\":\"Twitter reply review workflow\"}",
		"",
		"Raw output:",
		"> Assistant turn 2",
		"> Tool calls:",
		"> - memory_search {\"query\":\"Twitter reply review workflow\"}",
		">",
		"> Assistant turn 3",
		"> Text:",
		"> This is a Twitter reply review card waiting for human approval — not something I should act on.",
		"> The draft reply looks reasonable, but approving brand communications needs a human in the loop.",
	}, "\n"))
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("Twitter reply review workflow", SlackRelatedMemorySearchOptions{
		Limit: 5,
		Now:   time.Date(2026, 5, 19, 14, 0, 0, 0, shanghaiLocation()),
	})

	if len(result.Results) < 2 {
		t.Fatalf("results = %#v, want both generic note and legacy trace", result.Results)
	}
	top := result.Results[0]
	if top.Kind != "legacy_triage_archive" {
		t.Fatalf("top kind = %q, want legacy_triage_archive above generic recent note; all results = %#v", top.Kind, result.Results)
	}
	if !strings.Contains(top.Content, "waiting for human approval") {
		t.Fatalf("top evidence = %q, want old Agent D decision trace", top.Content)
	}
	if !relatedMemoryReasonsContain(top.Reasons, "legacy_tool_trace_boost") {
		t.Fatalf("Reasons = %#v, want legacy tool trace boost", top.Reasons)
	}
}

func TestSearchRelatedMemorySuppressesLegacyActionlessPolicyTrace(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/facts/current-policy.md", "Current Oneesama workspace policy treats product context as deployment-specific evidence.")
	writeRelatedMemoryFile(t, workspaceDir, "memory/legacy/slack-agent-d/workspace/memory/triage-archive/2026-05-19.md", strings.Join([]string{
		"# Legacy Slack Agent D triage archive 2026-05-19",
		"",
		"## Triage archive run old-actionless-policy",
		"",
		"Actions:",
		"> []",
		"",
		"Summary:",
		"> product context was skipped because this is watercooler and the office helper should not join pure technical chatter.",
		"",
		"Raw output:",
		"> SKIP — product context in watercooler. No action.",
	}, "\n"))
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
	})

	result := service.SearchRelatedMemory("product context office helper watercooler", SlackRelatedMemorySearchOptions{Limit: 5})

	for _, record := range result.Results {
		if record.Kind == "legacy_triage_archive" && strings.Contains(record.Content, "office helper") {
			t.Fatalf("related memory surfaced imported actionless policy trace: %#v", record)
		}
	}
	if firstRelatedMemoryKind(result.Results, "team_fact") == nil {
		t.Fatalf("results = %#v, want current non-legacy evidence to remain", result.Results)
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
