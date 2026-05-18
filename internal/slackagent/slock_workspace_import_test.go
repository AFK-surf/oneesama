package slackagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestImportSlockWorkspaceMemoryDryRunDoesNotWrite(t *testing.T) {
	sourceRoot := t.TempDir()
	targetWorkspace := t.TempDir()
	writeSlockWorkspaceFixtureFile(t, sourceRoot, "agent-alpha", "MEMORY.md", "# Alpha Agent\n\nAlpha remembers the OpenClaw Aha Moment.")
	writeSlockWorkspaceFixtureFile(t, sourceRoot, "agent-alpha", "notes/lesson.md", "A lesson that should be imported.")

	report, err := ImportSlockWorkspaceMemory(context.Background(), SlockWorkspaceImportOptions{
		SourceAgentsRoot:   sourceRoot,
		TargetWorkspaceDir: targetWorkspace,
		Write:              false,
	})
	if err != nil {
		t.Fatalf("ImportSlockWorkspaceMemory dry-run: %v", err)
	}
	if !report.DryRun {
		t.Fatalf("DryRun = false, want true")
	}
	if report.AgentsScanned != 1 || report.AgentsImported != 1 {
		t.Fatalf("agent counts = scanned %d imported %d, want 1/1", report.AgentsScanned, report.AgentsImported)
	}
	if report.FilesScanned != 2 || report.FilesWritten != 3 {
		t.Fatalf("file counts = scanned %d generated %d, want 2/3 including manifest", report.FilesScanned, report.FilesWritten)
	}
	if len(report.GeneratedFiles) == 0 {
		t.Fatalf("GeneratedFiles empty in dry-run")
	}
	if _, err := os.Stat(filepath.Join(targetWorkspace, "memory", "legacy", "slock-d")); !os.IsNotExist(err) {
		t.Fatalf("dry-run wrote target directory, stat err = %v", err)
	}
}

func TestImportSlockWorkspaceMemoryWritesPiSearchableEvidence(t *testing.T) {
	sourceRoot := t.TempDir()
	targetWorkspace := t.TempDir()
	writeSlockWorkspaceFixtureFile(t, sourceRoot, "agent-alpha", "MEMORY.md", "# Alpha Agent\n\nAlpha kept an OpenClaw Aha Moment about recalling workspace context.")
	writeSlockWorkspaceFixtureFile(t, sourceRoot, "agent-alpha", "notes/lesson.md", "Meeting Avatar should cite migrated Slock workspace memory before replying.")
	writeSlockWorkspaceFixtureFile(t, sourceRoot, "agent-alpha", "docs/runbook.md", "Workspace migration runbook: preserve source paths and line citations.")
	writeSlockWorkspaceFixtureFile(t, sourceRoot, "agent-alpha", "handoffs/handoff.md", "Handoff says Slock D workspace content is valuable memory.")
	writeSlockWorkspaceFixtureFile(t, sourceRoot, "agent-alpha", "attachments/ignored.md", "Attachment notes should not be imported.")
	writeSlockWorkspaceFixtureFile(t, sourceRoot, "agent-alpha", ".secrets/secret.md", "OPENAI_API_KEY=sk-this-must-not-import")

	report, err := ImportSlockWorkspaceMemory(context.Background(), SlockWorkspaceImportOptions{
		SourceAgentsRoot:   sourceRoot,
		TargetWorkspaceDir: targetWorkspace,
		Write:              true,
	})
	if err != nil {
		t.Fatalf("ImportSlockWorkspaceMemory write: %v", err)
	}
	if report.DryRun {
		t.Fatalf("DryRun = true, want false")
	}
	if report.FilesScanned != 4 || report.FilesWritten != 5 {
		t.Fatalf("file counts = scanned %d written %d, want 4/5 including manifest", report.FilesScanned, report.FilesWritten)
	}
	wantFiles := []string{
		"memory/legacy/slock-d/manifest.md",
		"memory/legacy/slock-d/agents/agent-alpha/MEMORY.md",
		"memory/legacy/slock-d/agents/agent-alpha/notes/lesson.md",
		"memory/legacy/slock-d/agents/agent-alpha/docs/runbook.md",
		"memory/legacy/slock-d/agents/agent-alpha/handoffs/handoff.md",
	}
	for _, rel := range wantFiles {
		if _, err := os.Stat(filepath.Join(targetWorkspace, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("expected generated file %s: %v", rel, err)
		}
	}
	if _, err := os.Stat(filepath.Join(targetWorkspace, "memory", "legacy", "slock-d", "agents", "agent-alpha", "attachments", "ignored.md")); !os.IsNotExist(err) {
		t.Fatalf("imported ignored attachment file, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(targetWorkspace, "memory", "legacy", "slock-d", "agents", "agent-alpha", ".secrets", "secret.md")); !os.IsNotExist(err) {
		t.Fatalf("imported ignored secret directory, stat err = %v", err)
	}

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: targetWorkspace},
	})
	result := service.SearchRelatedMemory("OpenClaw Aha workspace context", SlackRelatedMemorySearchOptions{Limit: 5})
	record := firstSlockWorkspaceRelatedMemory(result.Results)
	if record == nil {
		t.Fatalf("results = %#v, want imported Slock workspace evidence", result.Results)
	}
	if !strings.HasPrefix(record.SourcePath, "memory/legacy/slock-d/") {
		t.Fatalf("SourcePath = %q, want Slock workspace import path", record.SourcePath)
	}
	if record.StartLine <= 0 || record.EndLine < record.StartLine {
		t.Fatalf("line range = %d-%d, want source citation lines", record.StartLine, record.EndLine)
	}
}

func TestImportSlockWorkspaceMemoryRedactsSecrets(t *testing.T) {
	sourceRoot := t.TempDir()
	targetWorkspace := t.TempDir()
	writeSlockWorkspaceFixtureFile(t, sourceRoot, "agent-alpha", "MEMORY.md", "# Alpha Agent\n\nOPENAI_API_KEY=sk-thisshouldberemoved123456\ninline token xoxb-1234567890-secret")

	report, err := ImportSlockWorkspaceMemory(context.Background(), SlockWorkspaceImportOptions{
		SourceAgentsRoot:   sourceRoot,
		TargetWorkspaceDir: targetWorkspace,
		Write:              true,
	})
	if err != nil {
		t.Fatalf("ImportSlockWorkspaceMemory write: %v", err)
	}
	if report.RedactedLines != 2 {
		t.Fatalf("RedactedLines = %d, want 2", report.RedactedLines)
	}
	raw, err := os.ReadFile(filepath.Join(targetWorkspace, "memory", "legacy", "slock-d", "agents", "agent-alpha", "MEMORY.md"))
	if err != nil {
		t.Fatalf("Read generated memory: %v", err)
	}
	text := string(raw)
	if strings.Contains(text, "sk-thisshouldberemoved") || strings.Contains(text, "xoxb-1234567890-secret") {
		t.Fatalf("generated file leaked secret:\n%s", text)
	}
	if strings.Count(text, "<redacted>") < 2 {
		t.Fatalf("generated file = %q, want redaction markers", text)
	}
}

func writeSlockWorkspaceFixtureFile(t *testing.T, root, agentID, rel, content string) {
	t.Helper()
	path := filepath.Join(root, agentID, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", path, err)
	}
}

func firstSlockWorkspaceRelatedMemory(records []SlackRelatedMemoryRecord) *SlackRelatedMemoryRecord {
	for index := range records {
		if strings.HasPrefix(records[index].SourcePath, "memory/legacy/slock-d/") {
			return &records[index]
		}
	}
	return nil
}
