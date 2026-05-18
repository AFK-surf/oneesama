package slackagent

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestImportLegacySlackAgentDMemoryDryRunDoesNotWrite(t *testing.T) {
	sourceWorkspace := t.TempDir()
	targetWorkspace := t.TempDir()
	writeLegacyMemoryFixtureFile(t, sourceWorkspace, "memory/2026-03-20.md", "Old Agent D remembered an Aha Moment.")
	dbPath := writeLegacySlackDBFixture(t)

	report, err := ImportLegacySlackAgentDMemory(context.Background(), LegacySlackMemoryImportOptions{
		SourceWorkspaceDir: sourceWorkspace,
		SourceDBPath:       dbPath,
		TargetWorkspaceDir: targetWorkspace,
		Write:              false,
	})
	if err != nil {
		t.Fatalf("ImportLegacySlackAgentDMemory dry-run: %v", err)
	}
	if !report.DryRun {
		t.Fatalf("DryRun = false, want true")
	}
	if report.WorkspaceFilesScanned != 1 || report.WorkspaceFilesWritten != 1 {
		t.Fatalf("workspace counts = scanned %d written %d, want 1/1", report.WorkspaceFilesScanned, report.WorkspaceFilesWritten)
	}
	if len(report.GeneratedFiles) == 0 {
		t.Fatalf("GeneratedFiles empty in dry-run")
	}
	if _, err := os.Stat(filepath.Join(targetWorkspace, "memory", "legacy", "slack-agent-d")); !os.IsNotExist(err) {
		t.Fatalf("dry-run wrote target directory, stat err = %v", err)
	}
}

func TestImportLegacySlackAgentDMemoryWritesPiSearchableEvidence(t *testing.T) {
	sourceWorkspace := t.TempDir()
	targetWorkspace := t.TempDir()
	writeLegacyMemoryFixtureFile(t, sourceWorkspace, "MEMORY.md", "# Legacy index\n\nOld Slack Agent D kept the Aha Moment recall habit.")
	writeLegacyMemoryFixtureFile(t, sourceWorkspace, "memory/2026-03-20.md", "# 2026-03-20\n\nAha Moment: oneesama should recall related topics before replying.")
	writeLegacyMemoryFixtureFile(t, sourceWorkspace, "docs/ignore.md", "Docs are not workspace memory and should not be imported.")
	dbPath := writeLegacySlackDBFixture(t)

	report, err := ImportLegacySlackAgentDMemory(context.Background(), LegacySlackMemoryImportOptions{
		SourceWorkspaceDir: sourceWorkspace,
		SourceDBPath:       dbPath,
		TargetWorkspaceDir: targetWorkspace,
		Write:              true,
		MaxTriageRuns:      5,
	})
	if err != nil {
		t.Fatalf("ImportLegacySlackAgentDMemory write: %v", err)
	}
	if report.DryRun {
		t.Fatalf("DryRun = true, want false")
	}
	if report.WorkspaceFilesWritten != 2 {
		t.Fatalf("WorkspaceFilesWritten = %d, want 2", report.WorkspaceFilesWritten)
	}
	if report.ChannelBrainRows != 1 || report.ThreadLedgerRows != 1 || report.FeedbackRows != 1 || report.TriageRunRows != 1 {
		t.Fatalf("db counts = %+v, want 1 row from each table", report)
	}
	wantFiles := []string{
		"memory/legacy/slack-agent-d/workspace/MEMORY.md",
		"memory/legacy/slack-agent-d/workspace/memory/2026-03-20.md",
		"memory/legacy/slack-agent-d/db/channel-brain.md",
		"memory/legacy/slack-agent-d/db/thread-ledger.md",
		"memory/legacy/slack-agent-d/db/feedback.md",
		"memory/legacy/slack-agent-d/db/triage-runs.md",
		"memory/legacy/slack-agent-d/db/manifest.md",
	}
	for _, rel := range wantFiles {
		if _, err := os.Stat(filepath.Join(targetWorkspace, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("expected generated file %s: %v", rel, err)
		}
	}
	if _, err := os.Stat(filepath.Join(targetWorkspace, "memory", "legacy", "slack-agent-d", "workspace", "docs", "ignore.md")); !os.IsNotExist(err) {
		t.Fatalf("imported non-memory docs file, stat err = %v", err)
	}

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: targetWorkspace},
	})
	result := service.SearchRelatedMemory("Aha Moment related topics", SlackRelatedMemorySearchOptions{Limit: 5})
	record := firstLegacyRelatedMemory(result.Results)
	if record == nil {
		t.Fatalf("results = %#v, want imported legacy memory evidence", result.Results)
	}
	if !strings.HasPrefix(record.SourcePath, "memory/legacy/slack-agent-d/") {
		t.Fatalf("SourcePath = %q, want legacy import path", record.SourcePath)
	}
	if record.StartLine <= 0 || record.EndLine < record.StartLine {
		t.Fatalf("line range = %d-%d, want source citation lines", record.StartLine, record.EndLine)
	}

	dbResult := service.SearchRelatedMemory("review quality feedback", SlackRelatedMemorySearchOptions{Limit: 5})
	dbRecord := firstLegacyRelatedMemory(dbResult.Results)
	if dbRecord == nil || !strings.Contains(dbRecord.SourcePath, "feedback.md") {
		t.Fatalf("db results = %#v, want generated feedback evidence", dbResult.Results)
	}
}

func writeLegacyMemoryFixtureFile(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", path, err)
	}
}

func writeLegacySlackDBFixture(t *testing.T) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "slack.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("Open sqlite fixture: %v", err)
	}
	defer db.Close()
	statements := []string{
		`create table channel_brain (workspace_id text, channel_id text, summary text, summary_version integer, last_session_id text, last_thread_ts text, created_at text, updated_at text)`,
		`create table thread_ledger (workspace_id text, channel_id text, thread_ts text, assistant_session_id text, status text, owner_user_id text, last_user_id text, last_user_message_at text, last_assistant_message_at text, last_action_type text, last_action_status text, summary text, created_at text, updated_at text)`,
		`create table feedback_entry (id integer primary key autoincrement, entry_date text, entry_time text, action text, channel text, action_type text, summary text, user_id text, created_at text)`,
		`create table triage_run (id integer primary key autoincrement, session_id text, occurred_at text, status text, summary text, error text, digest text, steps integer, duration_seconds real, mutations integer, failures integer, tokens_used integer, channels_json text, created_at text)`,
		`insert into channel_brain values ('workspace','CLEGACY','Channel brain remembers review quality and Aha Moment context.',1,'session-1','1773920368.257829','2026-03-20T01:00:00Z','2026-03-20T02:00:00Z')`,
		`insert into thread_ledger values ('workspace','CLEGACY','1773920368.257829','session-1','active','UOWNER','UUSER','2026-03-20T01:00:00Z','2026-03-20T02:00:00Z','reply','ok','Aha Moment thread should cite old Slack Agent D memory.','2026-03-20T01:00:00Z','2026-03-20T02:00:00Z')`,
		`insert into feedback_entry(entry_date, entry_time, action, channel, action_type, summary, user_id, created_at) values ('2026-03-20','09:37','not_helpful','CLEGACY','reply_quality','Review quality feedback said the answer missed memory recall evidence.','UFEEDBACK','2026-03-20T09:37:00Z')`,
		`insert into triage_run(session_id, occurred_at, status, summary, error, digest, steps, duration_seconds, mutations, failures, tokens_used, channels_json, created_at) values ('triage-1','2026-03-20T10:00:00Z','ok','Triage recalled related topic memory.','','Digest includes Aha Moment and review quality.',3,1.25,1,0,120,'["CLEGACY"]','2026-03-20T10:00:00Z')`,
	}
	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("Exec fixture statement %q: %v", stmt, err)
		}
	}
	return dbPath
}

func firstLegacyRelatedMemory(records []SlackRelatedMemoryRecord) *SlackRelatedMemoryRecord {
	for index := range records {
		if strings.HasPrefix(records[index].SourcePath, "memory/legacy/slack-agent-d/") {
			return &records[index]
		}
	}
	return nil
}
