package slackagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Service) BuildHeartbeatContext(ctx context.Context) (string, error) {
	if s.followups == nil || s.cognition == nil {
		return strings.Join([]string{
			heartbeatEmpty([]string{"Server-selected candidate tasks (work these first, in order):"}),
			heartbeatEmpty([]string{"Open follow-ups:"}),
			heartbeatEmpty([]string{"Recent bot-touched Slack threads (last 6h):"}),
			heartbeatEmpty([]string{"Recent meeting carry-overs for the bot:"}),
			heartbeatEmpty([]string{"Recent heartbeat surfaces (avoid repeating these):"}),
		}, "\n\n"), nil
	}
	followups, err := s.followups.ListFollowups(ctx, "open", 20)
	if err != nil {
		return "", err
	}
	recentThreads, err := s.cognition.ListRecentThreadLedgersForWorkspace(ctx, "workspace", 5)
	if err != nil {
		return "", err
	}
	recentSurfaces, err := s.followups.ListSurfaces(ctx, 5)
	if err != nil {
		return "", err
	}
	sections := []string{
		formatHeartbeatCandidateDigest(followups, 3),
		formatHeartbeatFollowupDigest(followups),
		formatHeartbeatRecentThreadsDigest(recentThreads),
		formatHeartbeatMeetingDigest(loadRecentMeetingActionItems(s.workspaceDir, timeNow(), 3)),
		formatHeartbeatRecentSurfaceDigest(recentSurfaces),
	}
	return strings.Join(sections, "\n\n"), nil
}

func formatHeartbeatCandidateDigest(followups []SlackHeartbeatFollowup, limit int) string {
	lines := []string{"Server-selected candidate tasks (work these first, in order):"}
	if len(followups) == 0 {
		return heartbeatEmpty(lines)
	}
	for index, item := range limitFollowups(followups, limit) {
		lines = append(lines, fmt.Sprintf("%d. %s (priority=%s)", index+1, firstNonEmpty(item.Title, item.Summary), item.Priority))
	}
	return strings.Join(lines, "\n")
}

func formatHeartbeatFollowupDigest(followups []SlackHeartbeatFollowup) string {
	lines := []string{"Open follow-ups:"}
	if len(followups) == 0 {
		return heartbeatEmpty(lines)
	}
	for _, item := range followups {
		line := fmt.Sprintf("- #%d [%s] %s", item.ID, item.Kind, item.Title)
		if item.Summary != "" && item.Summary != item.Title {
			line += " — " + item.Summary
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func formatHeartbeatRecentThreadsDigest(records []SlackThreadLedgerRecord) string {
	lines := []string{"Recent bot-touched Slack threads (last 6h):"}
	if len(records) == 0 {
		return heartbeatEmpty(lines)
	}
	for _, record := range records {
		lines = append(lines, fmt.Sprintf("- %s/%s — %s", record.ChannelID, record.ThreadTS, firstNonEmpty(record.Summary, record.LastActionType, "recent activity without a durable summary")))
	}
	return strings.Join(lines, "\n")
}

func formatHeartbeatMeetingDigest(items []string) string {
	lines := []string{"Recent meeting carry-overs for the bot:"}
	if len(items) == 0 {
		return heartbeatEmpty(lines)
	}
	for _, item := range items {
		lines = append(lines, "- "+item)
	}
	return strings.Join(lines, "\n")
}

func formatHeartbeatRecentSurfaceDigest(records []SlackHeartbeatSurface) string {
	lines := []string{"Recent heartbeat surfaces (avoid repeating these):"}
	if len(records) == 0 {
		return heartbeatEmpty(lines)
	}
	for _, record := range records {
		lines = append(lines, fmt.Sprintf("- %s via %s — %s", firstNonEmpty(record.Title, record.Summary), firstNonEmpty(record.DeliveredSurface, record.RequestedSurface, "auto"), record.Status))
	}
	return strings.Join(lines, "\n")
}

func heartbeatEmpty(lines []string) string {
	return strings.Join(append(lines, "- none"), "\n")
}

func loadRecentMeetingActionItems(workspaceDir string, now time.Time, limit int) []string {
	actionDir := filepath.Join(workspaceDir, "memory", "team", "actions")
	entries, err := os.ReadDir(actionDir)
	if err != nil {
		return nil
	}
	var out []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(actionDir, entry.Name()))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "- "))
			lower := strings.ToLower(line)
			if line != "" && (strings.Contains(lower, "onee") || strings.Contains(lower, "bot") || strings.Contains(lower, "assistant") || strings.Contains(lower, "cueboard")) {
				out = append(out, line)
				if len(out) >= limit {
					return out
				}
			}
		}
	}
	return out
}
