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
		formatHeartbeatUpcomingDigest(followups, timeNow(), heartbeatUpcomingHorizon),
		formatHeartbeatRecentThreadsDigest(recentThreads),
		formatHeartbeatMeetingDigest(loadRecentMeetingActionItems(s.workspaceDir, timeNow(), 3)),
		formatHeartbeatRecentSurfaceDigest(recentSurfaces),
	}
	return strings.Join(sections, "\n\n"), nil
}

// heartbeatUpcomingHorizon is the look-ahead window for the "upcoming
// deadlines" section. Cueboard's analog used 24h; we keep the same default
// so the heartbeat prompt highlights work that is due before the next
// scheduled wake-up rather than burying it inside the open-followup list.
const heartbeatUpcomingHorizon = 24 * time.Hour

// formatHeartbeatUpcomingDigest emits the "Upcoming follow-up deadlines"
// section the BuildHeartbeatContext prompt was missing. We sort open
// followups whose NextCheckAt (or DueAt) falls inside the next `horizon`
// window in ascending order and emit one line each so the assistant can see
// which item is most urgent without re-parsing the longer open-followup
// list.
func formatHeartbeatUpcomingDigest(followups []SlackHeartbeatFollowup, now time.Time, horizon time.Duration) string {
	lines := []string{"Upcoming follow-up deadlines (next " + horizon.String() + "):"}
	upcoming := selectUpcomingHeartbeatFollowups(followups, now, horizon)
	if len(upcoming) == 0 {
		return heartbeatEmpty(lines)
	}
	for _, item := range upcoming {
		deadlineRaw, source := firstHeartbeatDeadline(item)
		deadlineLabel := deadlineRaw
		if parsed, err := time.Parse(time.RFC3339Nano, deadlineRaw); err == nil {
			deadlineLabel = parsed.UTC().Format("2006-01-02 15:04Z")
		} else if parsed, err := time.Parse(time.RFC3339, deadlineRaw); err == nil {
			deadlineLabel = parsed.UTC().Format("2006-01-02 15:04Z")
		}
		lines = append(lines, fmt.Sprintf("- #%d %s — due %s (%s)", item.ID, firstNonEmpty(item.Title, item.Summary), deadlineLabel, source))
	}
	return strings.Join(lines, "\n")
}

// selectUpcomingHeartbeatFollowups filters followups whose effective deadline
// (NextCheckAt or DueAt) is between now and now+horizon. Items with no
// parseable deadline are excluded — the open-followups list already covers
// those.
func selectUpcomingHeartbeatFollowups(followups []SlackHeartbeatFollowup, now time.Time, horizon time.Duration) []SlackHeartbeatFollowup {
	if horizon <= 0 || len(followups) == 0 {
		return nil
	}
	endsAt := now.Add(horizon)
	type ranked struct {
		item     SlackHeartbeatFollowup
		deadline time.Time
	}
	var ordered []ranked
	for _, item := range followups {
		deadlineRaw, _ := firstHeartbeatDeadline(item)
		if strings.TrimSpace(deadlineRaw) == "" {
			continue
		}
		var deadline time.Time
		var err error
		deadline, err = time.Parse(time.RFC3339Nano, deadlineRaw)
		if err != nil {
			deadline, err = time.Parse(time.RFC3339, deadlineRaw)
		}
		if err != nil {
			continue
		}
		if deadline.Before(now) || deadline.After(endsAt) {
			continue
		}
		ordered = append(ordered, ranked{item: item, deadline: deadline})
	}
	if len(ordered) == 0 {
		return nil
	}
	// Stable insertion sort keeps deterministic output for tests with the
	// same deadline timestamps.
	for i := 1; i < len(ordered); i++ {
		for j := i; j > 0 && ordered[j].deadline.Before(ordered[j-1].deadline); j-- {
			ordered[j], ordered[j-1] = ordered[j-1], ordered[j]
		}
	}
	out := make([]SlackHeartbeatFollowup, 0, len(ordered))
	for _, entry := range ordered {
		out = append(out, entry.item)
	}
	return out
}

// firstHeartbeatDeadline returns the NextCheckAt timestamp if set, otherwise
// the DueAt timestamp, plus a label so the digest line can tell the reader
// which clock fired.
func firstHeartbeatDeadline(item SlackHeartbeatFollowup) (string, string) {
	if strings.TrimSpace(item.NextCheckAt) != "" {
		return item.NextCheckAt, "next_check_at"
	}
	if strings.TrimSpace(item.DueAt) != "" {
		return item.DueAt, "due_at"
	}
	return "", ""
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
