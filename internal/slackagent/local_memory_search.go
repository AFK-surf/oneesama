package slackagent

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

func (m *localSlackMemory) fileSearchResults(keywords []string, limit int) []SlackMemoryResult {
	var results []SlackMemoryResult
	for _, relPath := range m.listWorkspaceMemoryFiles() {
		raw, err := os.ReadFile(filepath.Join(m.workspaceDir, filepath.FromSlash(relPath)))
		if err != nil {
			continue
		}
		score := scoreMemoryText(string(raw), keywords)
		if score <= 0 {
			continue
		}
		results = append(results, SlackMemoryResult{
			Kind:    "memory_file",
			Source:  relPath,
			Score:   score,
			Content: memorySnippet(string(raw)),
		})
	}
	sortMemoryResults(results)
	return limitMemoryResults(results, limit)
}

func (m *localSlackMemory) seedSearchResults(keywords []string, limit int) []SlackMemoryResult {
	collections := []struct {
		kind string
		rows []any
	}{
		{"channel_brain", arrayFromAny(m.seed["channelBrain"])},
		{"thread_ledger", arrayFromAny(m.seed["threadLedger"])},
		{"feedback", arrayFromAny(m.seed["feedbackEntries"])},
		{"triage", arrayFromAny(m.seed["triageRuns"])},
	}
	var results []SlackMemoryResult
	for _, collection := range collections {
		for _, item := range collection.rows {
			row, ok := item.(map[string]any)
			if !ok {
				continue
			}
			content := memoryRowText(row)
			score := scoreMemoryText(content, keywords)
			if score <= 0 {
				continue
			}
			results = append(results, SlackMemoryResult{
				Kind:    collection.kind,
				Source:  memoryRowSource(row, collection.kind),
				Score:   score,
				Content: memorySnippet(content),
				Row:     row,
			})
		}
	}
	sortMemoryResults(results)
	return limitMemoryResults(results, limit)
}

func workspaceMemoryFileSearchResults(workspaceDir string, keywords []string, limit int) []SlackMemoryResult {
	var results []SlackMemoryResult
	for _, relPath := range listDirectWorkspaceMemoryFiles(workspaceDir) {
		raw, err := os.ReadFile(filepath.Join(workspaceDir, filepath.FromSlash(relPath)))
		if err != nil {
			continue
		}
		score := scoreMemoryText(string(raw), keywords)
		if score <= 0 {
			continue
		}
		score += workspaceMemoryFileBoost(relPath, keywords)
		results = append(results, SlackMemoryResult{
			Kind:    "workspace_memory_file",
			Source:  "workspace:" + relPath,
			Score:   score,
			Content: memorySnippet(string(raw)),
		})
	}
	sortMemoryResults(results)
	return limitMemoryResults(results, limit)
}

func workspaceTriageMemoryResults(workspaceDir string, keywords []string, limit int) []SlackMemoryResult {
	contexts := workspaceTriageContextsForMemory(workspaceDir)
	var results []SlackMemoryResult
	for _, context := range contexts {
		if slackTriageContextSuppressesMemoryProjection(context) {
			continue
		}
		content := triageContextMemoryText(context)
		score := scoreMemoryText(content, keywords)
		if score <= 0 {
			continue
		}
		results = append(results, SlackMemoryResult{
			Kind:    "triage_projection",
			Source:  triageMemorySource(context),
			Score:   score,
			Content: memorySnippet(content),
			Row: map[string]any{
				"session_id": context.SessionID,
				"status":     context.Status,
				"timestamp":  context.Timestamp,
				"channels":   strings.Join(context.Channels, ","),
				"summary":    context.Summary,
				"mutations":  context.Mutations,
				"failures":   context.Failures,
			},
		})
	}
	sortMemoryResults(results)
	return limitMemoryResults(results, limit)
}

func workspaceMemoryFileBoost(relPath string, keywords []string) float64 {
	kind := relatedMemoryKindForPath(relPath)
	if kind != "team_fact" && kind != "team_meeting" {
		return 0
	}
	tokenSet := make(map[string]struct{}, len(keywords))
	for _, keyword := range keywords {
		tokenSet[strings.ToLower(strings.TrimSpace(keyword))] = struct{}{}
	}
	for _, value := range []string{"quota", "reset", "配额", "额度", "付费", "免费", "用户", "站会", "meeting"} {
		if _, ok := tokenSet[value]; ok {
			return 0.35
		}
	}
	return 0
}

func workspaceTriageContextsForMemory(workspaceDir string) []SlackTriageContext {
	if strings.TrimSpace(workspaceDir) == "" {
		return nil
	}
	contexts := append([]SlackTriageContext(nil), loadTriageContextsFromProjection(workspaceDir)...)
	archiveDir := filepath.Join(workspaceDir, "memory", "triage-archive")
	_ = filepath.WalkDir(archiveDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		var archived []SlackTriageContext
		if json.Unmarshal(raw, &archived) == nil {
			contexts = append(contexts, archived...)
		}
		return nil
	})
	sort.SliceStable(contexts, func(i, j int) bool {
		return contexts[i].Timestamp > contexts[j].Timestamp
	})
	return contexts
}

func triageContextMemoryText(context SlackTriageContext) string {
	parts := []string{
		"Slack triage memory",
		"timestamp: " + context.Timestamp,
		"session: " + context.SessionID,
		"status: " + context.Status,
		"channels: " + strings.Join(context.Channels, ", "),
		"summary: " + context.Summary,
	}
	if context.Mutations > 0 || context.Failures > 0 {
		parts = append(parts, fmt.Sprintf("mutations: %d failures: %d", context.Mutations, context.Failures))
	}
	if strings.TrimSpace(context.Digest) != "" {
		parts = append(parts, "digest:\n"+context.Digest)
	}
	return strings.Join(parts, "\n")
}

func triageMemorySource(context SlackTriageContext) string {
	id := strings.TrimSpace(context.SessionID)
	if id == "" {
		id = strings.TrimSpace(context.Timestamp)
	}
	if id == "" {
		id = "unknown"
	}
	return "workspace:memory/" + triageContextFile + "#" + id
}

func listDirectWorkspaceMemoryFiles(workspaceDir string) []string {
	var files []string
	if strings.TrimSpace(workspaceDir) == "" {
		return files
	}
	_ = filepath.WalkDir(workspaceDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(workspaceDir, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if isAllowedMemoryPath(rel) {
			files = append(files, rel)
		}
		return nil
	})
	sort.Strings(files)
	return files
}

func memoryKeywords(query string) []string {
	seen := map[string]struct{}{}
	var out []string
	candidates := append(strings.Fields(strings.ToLower(strings.TrimSpace(query))), relatedMemoryTokens(query)...)
	for _, field := range candidates {
		field = strings.ToLower(strings.TrimSpace(field))
		if field == "" {
			continue
		}
		if _, ok := seen[field]; ok {
			continue
		}
		seen[field] = struct{}{}
		out = append(out, field)
	}
	return out
}

func isAllowedMemoryPath(memoryPath string) bool {
	rel := filepath.ToSlash(memoryPath)
	if rel == "" || rel != filepath.ToSlash(path.Clean(rel)) || rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
		return false
	}
	return rel == "MEMORY.md" || strings.HasPrefix(rel, "memory/") && strings.HasSuffix(rel, ".md")
}

func scoreMemoryText(content string, keywords []string) float64 {
	lower := strings.ToLower(content)
	score := 0
	for _, keyword := range keywords {
		if strings.Contains(lower, keyword) {
			score++
		}
	}
	return float64(score) / float64(maxInt(len(keywords), 1))
}

func memorySnippet(text string) string {
	compact := strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
	for strings.Contains(compact, "\n\n\n") {
		compact = strings.ReplaceAll(compact, "\n\n\n", "\n\n")
	}
	runes := []rune(compact)
	if len(runes) <= slackMemorySnippetLimit {
		return compact
	}
	return strings.TrimSpace(string(runes[:slackMemorySnippetLimit])) + "..."
}

func memoryRowText(row map[string]any) string {
	var parts []string
	for _, value := range row {
		if text := strings.TrimSpace(memoryValueText(value)); text != "" {
			parts = append(parts, text)
		}
	}
	sort.Strings(parts)
	return strings.Join(parts, "\n")
}

func memoryRowSource(row map[string]any, fallback string) string {
	parts := []string{memoryValueText(row["channel_id"]), memoryValueText(row["thread_ts"]), memoryValueText(row["id"])}
	var kept []string
	for _, part := range parts {
		if strings.TrimSpace(part) != "" {
			kept = append(kept, strings.TrimSpace(part))
		}
	}
	if len(kept) == 0 {
		return fallback
	}
	return strings.Join(kept, ":")
}

func memoryValueText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func sortMemoryResults(results []SlackMemoryResult) {
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].Score == results[j].Score {
			return results[i].Source < results[j].Source
		}
		return results[i].Score > results[j].Score
	})
}

func limitMemoryResults(results []SlackMemoryResult, limit int) []SlackMemoryResult {
	if limit <= 0 {
		limit = 8
	}
	if len(results) > limit {
		return results[:limit]
	}
	return results
}

func dedupeMemoryResults(results []SlackMemoryResult) []SlackMemoryResult {
	if len(results) == 0 {
		return nil
	}
	out := make([]SlackMemoryResult, 0, len(results))
	seen := map[string]struct{}{}
	for _, result := range results {
		key := result.Kind + "\x00" + result.Source + "\x00" + result.Content
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, result)
	}
	return out
}
