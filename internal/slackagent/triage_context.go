package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	triageContextFile       = ".triage-context.json"
	triageContextMaxSize    = 20
	adminTriageMaxSize      = 100
	triageContextCharBudget = 1600
)

var channelNameRe = regexp.MustCompile(`#(\S+)\s+\(C[A-Z0-9]+\):`)

func persistTriageContext(workspaceDir string, context SlackTriageContext) {
	if strings.TrimSpace(workspaceDir) == "" {
		return
	}
	dir := filepath.Join(workspaceDir, "memory")
	filePath := filepath.Join(dir, triageContextFile)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	entries := loadTriageContextsFromProjection(workspaceDir)
	entries = append(entries, context)
	if len(entries) > triageContextMaxSize {
		evicted := append([]SlackTriageContext(nil), entries[:len(entries)-triageContextMaxSize]...)
		archiveTriageEntries(workspaceDir, evicted)
		entries = entries[len(entries)-triageContextMaxSize:]
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return
	}
	tmpPath := filePath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return
	}
	if err := os.Rename(tmpPath, filePath); err != nil {
		_ = os.Remove(tmpPath)
	}
}

func loadTriageContextsFromProjection(workspaceDir string) []SlackTriageContext {
	if strings.TrimSpace(workspaceDir) == "" {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(workspaceDir, "memory", triageContextFile))
	if err != nil {
		return nil
	}
	var entries []SlackTriageContext
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil
	}
	return entries
}

func loadTriageContexts(store *slackTriageStore, workspaceDir string) []SlackTriageContext {
	return loadTriageContextsWithLimit(store, workspaceDir, triageContextMaxSize)
}

func loadAdminTriageContexts(store *slackTriageStore, workspaceDir string) []SlackTriageContext {
	return loadTriageContextsWithLimit(store, workspaceDir, adminTriageMaxSize)
}

func loadTriageContextsWithLimit(store *slackTriageStore, workspaceDir string, limit int) []SlackTriageContext {
	if limit <= 0 {
		limit = triageContextMaxSize
	}
	if store != nil {
		if contexts, err := store.ListRuns(context.Background(), limit); err == nil {
			return contexts
		}
	}
	contexts := loadTriageContextsFromProjection(workspaceDir)
	if len(contexts) > limit {
		contexts = contexts[len(contexts)-limit:]
	}
	return contexts
}

func archiveTriageEntries(workspaceDir string, entries []SlackTriageContext) {
	if len(entries) == 0 || strings.TrimSpace(workspaceDir) == "" {
		return
	}
	archiveDir := filepath.Join(workspaceDir, "memory", "triage-archive")
	if err := os.MkdirAll(archiveDir, 0o755); err != nil {
		return
	}
	byDate := make(map[string][]SlackTriageContext)
	for _, entry := range entries {
		timestamp := parseTriageTimestamp(entry.Timestamp)
		if timestamp.IsZero() {
			timestamp = time.Now().UTC()
		}
		date := timestamp.In(time.FixedZone("CST", 8*3600)).Format("2006-01-02")
		byDate[date] = append(byDate[date], entry)
	}
	for date, dayEntries := range byDate {
		archivePath := filepath.Join(archiveDir, date+".json")
		var existing []SlackTriageContext
		if data, err := os.ReadFile(archivePath); err == nil {
			_ = json.Unmarshal(data, &existing)
		}
		existing = append(existing, dayEntries...)
		data, err := json.MarshalIndent(existing, "", "  ")
		if err != nil {
			continue
		}
		_ = os.WriteFile(archivePath, data, 0o644)
	}
}

func formatTriageContexts(contexts []SlackTriageContext) string {
	if len(contexts) == 0 {
		return ""
	}
	contexts = filterPromptRelevantTriageContexts(contexts)
	if len(contexts) == 0 {
		return ""
	}

	var builder strings.Builder
	builder.WriteString("=== Previous Triage ===\n")
	for _, context := range contexts {
		builder.WriteString(formatTriageContextLine(context))
		builder.WriteString("\n")
		if builder.Len() > triageContextCharBudget {
			break
		}
	}
	builder.WriteString("===")

	result := builder.String()
	if len(result) > triageContextCharBudget {
		result = result[:triageContextCharBudget-3] + "..."
	}
	return result
}

func filterPromptRelevantTriageContexts(contexts []SlackTriageContext) []SlackTriageContext {
	out := make([]SlackTriageContext, 0, len(contexts))
	for _, context := range contexts {
		if strings.EqualFold(context.Status, "ok") && len(context.Actions) == 0 {
			continue
		}
		out = append(out, context)
	}
	return out
}

func formatTriageContextLine(context SlackTriageContext) string {
	return fmt.Sprintf("[%s] %s", triageContextClock(context.Timestamp), strings.Join(formatTriageChannelSummaries(context), " | "))
}

func formatTriageChannelSummaries(context SlackTriageContext) []string {
	channelActions, channels := triageChannelActions(context)
	parts := make([]string, 0, len(channels))
	for _, channel := range channels {
		parts = append(parts, formatTriageChannelSummary(channel, channelActions[channel], context.Status))
	}
	return parts
}

func triageChannelActions(context SlackTriageContext) (map[string][]string, []string) {
	channelActions := make(map[string][]string, len(context.Channels))
	for _, channel := range context.Channels {
		channelActions[channel] = nil
	}
	for _, action := range context.Actions {
		channel := triageActionChannel(action)
		channelActions[channel] = append(channelActions[channel], formatTriageActionSummary(action))
	}
	channels := make([]string, 0, len(channelActions))
	for channel := range channelActions {
		channels = append(channels, channel)
	}
	sort.Strings(channels)
	return channelActions, channels
}

func formatTriageActionSummary(action SlackTriageAction) string {
	return fmt.Sprintf("%s %q", action.Tool, action.Brief)
}

func triageActionChannel(action SlackTriageAction) string {
	if strings.TrimSpace(action.Channel) == "" {
		return "unknown"
	}
	return strings.TrimSpace(action.Channel)
}

func formatTriageChannelSummary(channel string, actions []string, status string) string {
	if len(actions) == 0 {
		return fmt.Sprintf("#%s: %s", channel, triagePromptFallbackLabel(status))
	}
	return fmt.Sprintf("#%s: %s", channel, strings.Join(actions, " | "))
}

func triagePromptFallbackLabel(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed", "error":
		return "FAILED"
	case "timeout":
		return "TIMEOUT"
	case "ok":
		return "ACTIONLESS"
	default:
		return "ACTIONLESS"
	}
}

func compactTriageSummary(context SlackTriageContext) string {
	if len(context.Actions) > 0 {
		summaries := make([]string, 0, len(context.Actions))
		for _, action := range context.Actions {
			summaries = append(summaries, compactTriageActionSummary(action))
			if len(summaries) >= 3 {
				break
			}
		}
		return truncateSlackContextText(strings.Join(summaries, " | "), 280)
	}
	return compactTriageStatusSummary(context)
}

func compactTriageStatusSummary(context SlackTriageContext) string {
	if strings.EqualFold(context.Status, "ok") || strings.EqualFold(context.Status, "success") {
		summary := normalizeTriageText(context.Summary)
		if summary != "" {
			return truncateSlackContextText(summary, 280)
		}
		return "Scanned, no action taken."
	}
	if errText := normalizeTriageText(context.Error); errText != "" {
		return truncateSlackContextText(fmt.Sprintf("%s: %s", strings.ToUpper(context.Status), errText), 280)
	}
	summary := normalizeTriageText(context.Summary)
	if summary != "" {
		return truncateSlackContextText(summary, 280)
	}
	return triagePromptFallbackLabel(context.Status)
}

func normalizeTriageText(value string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
}

func compactTriageActionSummary(action SlackTriageAction) string {
	channel := triageActionChannel(action)
	brief := strings.TrimSpace(action.Brief)
	if brief == "" {
		brief = strings.TrimSpace(action.Tool)
	}
	return fmt.Sprintf("#%s %s", channel, brief)
}

func triageContextClock(value string) string {
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.UTC().Format("15:04")
	}
	if len(value) >= 16 {
		return value[11:16]
	}
	return "00:00"
}

func extractChannelNames(digest string) []string {
	matches := channelNameRe.FindAllStringSubmatch(digest, -1)
	seen := make(map[string]bool)
	var names []string
	for _, match := range matches {
		name := match[1]
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	return names
}
