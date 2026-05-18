package slackagent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const slockWorkspaceTargetRoot = "memory/legacy/slock-d"

type SlockWorkspaceImportOptions struct {
	SourceAgentsRoot   string
	TargetWorkspaceDir string
	Write              bool
	MaxFileBytes       int64
}

type SlockWorkspaceImportReport struct {
	DryRun             bool
	SourceAgentsRoot   string
	TargetWorkspaceDir string
	AgentsScanned      int
	AgentsImported     int
	FilesScanned       int
	FilesWritten       int
	BytesWritten       int64
	RedactedLines      int
	GeneratedFiles     []string
	Warnings           []string
}

type slockWorkspaceAgent struct {
	ID    string
	Title string
	Dir   string
	Files []string
}

func ImportSlockWorkspaceMemory(ctx context.Context, opts SlockWorkspaceImportOptions) (SlockWorkspaceImportReport, error) {
	report := SlockWorkspaceImportReport{
		DryRun:             !opts.Write,
		SourceAgentsRoot:   strings.TrimSpace(opts.SourceAgentsRoot),
		TargetWorkspaceDir: strings.TrimSpace(opts.TargetWorkspaceDir),
	}
	if report.SourceAgentsRoot == "" {
		return report, errors.New("source agents root is required")
	}
	if report.TargetWorkspaceDir == "" {
		return report, errors.New("target workspace dir is required")
	}
	maxFileBytes := opts.MaxFileBytes
	if maxFileBytes <= 0 {
		maxFileBytes = 1024 * 1024
	}
	agents, err := listSlockWorkspaceAgents(report.SourceAgentsRoot)
	if err != nil {
		return report, err
	}
	report.AgentsScanned = len(agents)
	generated := map[string][]byte{}
	var manifest strings.Builder
	manifest.WriteString("# Slock D workspace import\n\n")
	manifest.WriteString("These files are a curated import of Slock agent workspace knowledge into Oneesama/Pi related memory.\n")
	manifest.WriteString("Cueboard parity note: Cueboard's Slack Agent D treated workspace files (MEMORY.md, SOUL.md, AGENTS.md, CODEX guidance, docs, and daily notes) as part of the assistant behavior contract via prompt injection and memory tools. This import keeps Slock agent knowledge line-citable under workspace memory without overwriting Oneesama's active top-level workspace files.\n\n")
	fmt.Fprintf(&manifest, "- Imported at: %s\n", timeNow().UTC().Format(time.RFC3339))
	fmt.Fprintf(&manifest, "- Source agents root: %s\n", report.SourceAgentsRoot)
	fmt.Fprintf(&manifest, "- Max file bytes: %d\n\n", maxFileBytes)
	manifest.WriteString("## Agents\n\n")

	for _, agent := range agents {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		report.FilesScanned += len(agent.Files)
		if len(agent.Files) == 0 {
			continue
		}
		report.AgentsImported++
		fmt.Fprintf(&manifest, "### %s\n\n", firstNonEmpty(agent.Title, agent.ID))
		legacySlackWriteBullet(&manifest, "Agent ID", agent.ID)
		legacySlackWriteBullet(&manifest, "Files", fmt.Sprint(len(agent.Files)))
		manifest.WriteString("\n")
		for _, rel := range agent.Files {
			sourcePath := filepath.Join(agent.Dir, filepath.FromSlash(rel))
			raw, readErr := readSlockWorkspaceFile(sourcePath, maxFileBytes)
			if readErr != nil {
				report.Warnings = append(report.Warnings, fmt.Sprintf("read %s/%s: %v", agent.ID, rel, readErr))
				continue
			}
			content, redacted := redactSlockWorkspaceSecrets(string(raw))
			report.RedactedLines += redacted
			targetRel := filepath.ToSlash(filepath.Join(slockWorkspaceTargetRoot, "agents", sanitizeSlockWorkspacePathComponent(agent.ID), filepath.FromSlash(rel)))
			body := renderSlockWorkspaceImportedFile(agent, rel, content)
			generated[targetRel] = []byte(body)
			report.GeneratedFiles = append(report.GeneratedFiles, targetRel)
			report.BytesWritten += int64(len([]byte(body)))
			fmt.Fprintf(&manifest, "- `%s` -> `%s`\n", rel, targetRel)
		}
		manifest.WriteString("\n")
	}

	manifestRel := filepath.ToSlash(filepath.Join(slockWorkspaceTargetRoot, "manifest.md"))
	generated[manifestRel] = []byte(manifest.String())
	report.GeneratedFiles = append(report.GeneratedFiles, manifestRel)
	report.FilesWritten = len(generated)
	sort.Strings(report.GeneratedFiles)

	if opts.Write {
		for rel, body := range generated {
			if err := legacySlackWriteGeneratedFile(report.TargetWorkspaceDir, rel, body, true); err != nil {
				report.Warnings = append(report.Warnings, fmt.Sprintf("write %s: %v", rel, err))
				continue
			}
		}
	}
	return report, nil
}

func listSlockWorkspaceAgents(root string) ([]slockWorkspaceAgent, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var agents []slockWorkspaceAgent
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		id := entry.Name()
		if strings.HasPrefix(id, ".") {
			continue
		}
		dir := filepath.Join(root, id)
		files, err := slockWorkspaceKnowledgeFiles(dir)
		if err != nil {
			continue
		}
		agents = append(agents, slockWorkspaceAgent{
			ID:    id,
			Title: slockWorkspaceAgentTitle(dir),
			Dir:   dir,
			Files: files,
		})
	}
	sort.SliceStable(agents, func(i, j int) bool {
		if len(agents[i].Files) == len(agents[j].Files) {
			return agents[i].ID < agents[j].ID
		}
		return len(agents[i].Files) > len(agents[j].Files)
	})
	return agents, nil
}

func slockWorkspaceKnowledgeFiles(agentDir string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(agentDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", ".slock", ".secrets", "node_modules", "vendor", "attachments", "artifacts", "tmp", "output", "build", "dist", "worktrees":
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(agentDir, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if isSlockWorkspaceKnowledgePath(rel) {
			files = append(files, rel)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

func isSlockWorkspaceKnowledgePath(rel string) bool {
	clean := filepath.ToSlash(filepath.Clean(rel))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || clean != rel {
		return false
	}
	switch clean {
	case "MEMORY.md", "AGENTS.md", "CLAUDE.md", "CODEX_GUIDANCE.md", "SOUL.md":
		return true
	}
	if !strings.HasSuffix(clean, ".md") {
		return false
	}
	for _, prefix := range []string{"notes/", "docs/", "handoffs/"} {
		if strings.HasPrefix(clean, prefix) {
			return true
		}
	}
	return false
}

func slockWorkspaceAgentTitle(agentDir string) string {
	raw, err := os.ReadFile(filepath.Join(agentDir, "MEMORY.md"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") {
			return strings.TrimSpace(strings.TrimLeft(line, "#"))
		}
	}
	return ""
}

func readSlockWorkspaceFile(path string, maxBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return nil, err
	}
	limit := maxBytes + 1
	if stat.Size() < limit {
		limit = stat.Size()
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maxBytes {
		raw = raw[:maxBytes]
	}
	if stat.Size() > maxBytes {
		raw = append(raw, []byte("\n\n[truncated by oneesama-slock-workspace-import]\n")...)
	}
	return raw, nil
}

var slockWorkspaceSecretLinePattern = regexp.MustCompile(`(?i)^(\s*(?:[-*]\s*)?[^:=\n]*(?:api[_ -]?key|token|secret|password|credential|authorization|bearer)[^:=\n]*\s*[:=]\s*).+$`)
var slockWorkspaceInlineSecretPattern = regexp.MustCompile(`(?i)(xox[abprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9_]{16,})`)

func redactSlockWorkspaceSecrets(content string) (string, int) {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(content, "\n")
	redacted := 0
	for i, line := range lines {
		next := slockWorkspaceSecretLinePattern.ReplaceAllString(line, "${1}<redacted>")
		next2 := slockWorkspaceInlineSecretPattern.ReplaceAllString(next, "<redacted>")
		if next2 != line {
			redacted++
		}
		lines[i] = next2
	}
	return strings.Join(lines, "\n"), redacted
}

func renderSlockWorkspaceImportedFile(agent slockWorkspaceAgent, rel string, content string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Slock D workspace import: %s / %s\n\n", firstNonEmpty(agent.Title, agent.ID), rel)
	legacySlackWriteBullet(&b, "Source agent ID", agent.ID)
	legacySlackWriteBullet(&b, "Source agent title", agent.Title)
	legacySlackWriteBullet(&b, "Source file", rel)
	legacySlackWriteBullet(&b, "Imported at", timeNow().UTC().Format(time.RFC3339))
	b.WriteString("\nCueboard parity: this file is imported as workspace memory so Oneesama/Pi can retrieve it with related-memory search and cite its path/lines. It does not overwrite the active workspace's top-level instructions.\n\n")
	b.WriteString("## Original content\n\n")
	b.WriteString(strings.TrimSpace(content))
	b.WriteString("\n")
	return b.String()
}

func sanitizeSlockWorkspacePathComponent(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), ".-")
	if out == "" {
		return "unknown"
	}
	return out
}
