package slackagent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	teamMemoryMeetingsDir  = "memory/team/meetings"
	teamMemoryDecisionsDir = "memory/team/decisions"
	teamMemoryActionsDir   = "memory/team/actions"
	teamMemoryQuestionsDir = "memory/team/questions"
	teamMemoryFactsDir     = "memory/team/facts"
)

func (s *Service) projectMeetingResultToTeamMemory(ctx context.Context, payload NormalizedMeetingWebhookPayload, ref MeetingSlackRef) {
	if s == nil || strings.TrimSpace(s.workspaceDir) == "" || payload.Summary == nil {
		return
	}
	source := teamMemorySource{
		Title:      strings.TrimSpace(payload.Title),
		SourceType: "meeting",
		SourceRef:  fmt.Sprintf("meeting:%d", payload.MeetingID),
		ChannelID:  strings.TrimSpace(ref.ChannelID),
		ThreadTS:   strings.TrimSpace(ref.ThreadTS),
		Timestamp:  timeNow().In(shanghaiLocation()),
		Confidence: "high",
		Tags:       compactUniqueStrings([]string{"meeting", "team-memory", normalizeMemoryTag(payload.Title)}),
	}
	if err := projectMeetingSummaryToTeamMemory(s.workspaceDir, payload.MeetingID, payload.Summary, source); err != nil {
		s.logger.Warn("slack team memory projection failed", "meeting_id", payload.MeetingID, "error", err)
	}
	if err := refreshPeopleMemoryProjection(ctx, s.workspaceDir); err != nil {
		s.logger.Warn("slack people memory projection failed", "meeting_id", payload.MeetingID, "error", err)
	}
}

type teamMemorySource struct {
	Title           string
	SourceType      string
	SourceRef       string
	ChannelID       string
	ThreadTS        string
	ThreadPermalink string
	Timestamp       time.Time
	Confidence      string
	Tags            []string
}

func projectMeetingSummaryToTeamMemory(workspaceDir string, meetingID int64, summary *MeetingSummaryData, source teamMemorySource) error {
	title := firstNonEmpty(source.Title, summary.Title, fmt.Sprintf("Meeting %d", meetingID))
	facts := compactUniqueStrings(firstNStrings(firstNonEmptySlice(summary.KeyPoints, summary.Highlights), 5))
	decisions := compactUniqueStrings(summary.Decisions)
	questions := compactUniqueStrings(summary.OpenQuestions)
	actionLines := formatMeetingMemoryActionItems(summary.ActionItems)
	baseName := fmt.Sprintf("meeting-%d.md", meetingID)
	writes := map[string]string{
		filepath.ToSlash(filepath.Join(teamMemoryMeetingsDir, baseName)):  buildMeetingTeamMemoryDoc(title, source, summary, facts, decisions, actionLines, questions),
		filepath.ToSlash(filepath.Join(teamMemoryDecisionsDir, baseName)): buildCategoryMemoryDoc("Decision Memory", title, source, decisions, "Decisions"),
		filepath.ToSlash(filepath.Join(teamMemoryActionsDir, baseName)):   buildCategoryMemoryDoc("Action Item Memory", title, source, actionLines, "Action Items"),
		filepath.ToSlash(filepath.Join(teamMemoryQuestionsDir, baseName)): buildCategoryMemoryDoc("Open Question Memory", title, source, questions, "Open Questions"),
		filepath.ToSlash(filepath.Join(teamMemoryFactsDir, baseName)):     buildCategoryMemoryDoc("Stable Fact Memory", title, source, facts, "Stable Context"),
	}
	for relPath, content := range writes {
		if strings.TrimSpace(content) == "" {
			if err := removeWorkspaceMemoryFile(workspaceDir, relPath); err != nil {
				return err
			}
			continue
		}
		if err := writeWorkspaceMemoryFile(workspaceDir, relPath, content); err != nil {
			return err
		}
	}
	return nil
}

func removeWorkspaceMemoryFile(workspaceDir string, relPath string) error {
	target, err := safeWorkspaceMemoryPath(workspaceDir, relPath)
	if err != nil {
		return err
	}
	if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func writeWorkspaceMemoryFile(workspaceDir string, relPath string, content string) error {
	target, err := safeWorkspaceMemoryPath(workspaceDir, relPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, []byte(strings.TrimSpace(content)+"\n"), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func safeWorkspaceMemoryPath(workspaceDir string, relPath string) (string, error) {
	root, err := filepath.Abs(workspaceDir)
	if err != nil {
		return "", err
	}
	target := filepath.Join(root, filepath.FromSlash(relPath))
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("memory path escapes workspace: %s", relPath)
	}
	return target, nil
}

func normalizeMemoryTag(raw string) string {
	value := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(raw, " ", "-")))
	value = regexp.MustCompile(`[^a-z0-9-]+`).ReplaceAllString(value, "")
	return strings.Trim(value, "-")
}
