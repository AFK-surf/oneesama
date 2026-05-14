package slackagent

import (
	"fmt"
	"os"
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

func memoryKeywords(query string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, field := range strings.Fields(strings.ToLower(strings.TrimSpace(query))) {
		if _, ok := seen[field]; ok {
			continue
		}
		seen[field] = struct{}{}
		out = append(out, field)
	}
	return out
}

func isAllowedMemoryPath(path string) bool {
	rel := filepath.ToSlash(path)
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
