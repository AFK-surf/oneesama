package slackagent

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func renderCanvasMarkdown(input CanvasPublishInput) (string, error) {
	if strings.TrimSpace(input.SummaryMarkdown) != "" {
		return input.SummaryMarkdown, nil
	}
	if strings.TrimSpace(input.SummaryPath) != "" {
		raw, err := os.ReadFile(input.SummaryPath)
		if err != nil {
			return "", fmt.Errorf("read summary markdown: %w", err)
		}
		return string(raw), nil
	}
	if input.Artifact.Files != nil && strings.TrimSpace(input.Artifact.Files.Summary) != "" {
		raw, err := os.ReadFile(input.Artifact.Files.Summary)
		if err != nil {
			return "", fmt.Errorf("read artifact summary markdown: %w", err)
		}
		return string(raw), nil
	}

	lines := []string{
		"- Meeting: " + firstNonEmpty(input.Artifact.MeetURL, "unknown"),
		"- Artifact: " + firstNonEmpty(input.ArtifactID, input.Artifact.ID, "unknown"),
	}
	if input.Artifact.Summary != nil {
		duration := firstNonZero(input.Artifact.Summary.DurationMinutes, input.Artifact.Summary.DurationMinutes2)
		if duration > 0 {
			lines = append(lines, fmt.Sprintf("- **Duration:** %d minutes", duration))
		}
		if len(input.Artifact.Summary.Attendees) > 0 {
			lines = append(lines, "- **Attendees:** "+strings.Join(input.Artifact.Summary.Attendees, ", "))
		}
	}
	if input.Artifact.Files != nil && strings.TrimSpace(input.Artifact.Files.Transcript) != "" {
		lines = append(lines, "- Transcript: "+input.Artifact.Files.Transcript)
	}
	if input.Artifact.Files != nil && strings.TrimSpace(input.Artifact.Files.Audio) != "" {
		lines = append(lines, "- Audio: "+input.Artifact.Files.Audio)
	}

	lines = append(lines, "", "## Highlights", "")
	lines = appendBulletSection(lines, input.Artifact.Summary, func(summary *CanvasArtifactSummary) []string {
		if summary == nil {
			return nil
		}
		return summary.Highlights
	}, "No highlights captured yet.")

	lines = append(lines, "", "## Decisions", "")
	lines = appendBulletSection(lines, input.Artifact.Summary, func(summary *CanvasArtifactSummary) []string {
		if summary == nil {
			return nil
		}
		return summary.Decisions
	}, "No explicit decisions captured.")

	lines = append(lines, "", "## Action Items", "")
	lines = appendBulletSection(lines, input.Artifact.Summary, func(summary *CanvasArtifactSummary) []string {
		if summary == nil {
			return nil
		}
		return summary.ActionItems
	}, "No explicit action items captured.")

	return strings.Join(lines, "\n") + "\n", nil
}

func appendBulletSection(lines []string, summary *CanvasArtifactSummary, getter func(*CanvasArtifactSummary) []string, fallback string) []string {
	items := getter(summary)
	if len(items) == 0 {
		return append(lines, "- "+fallback)
	}
	for _, item := range items {
		lines = append(lines, "- "+normalizeCanvasListLine(item))
	}
	return lines
}

func normalizeCanvasListLine(value string) string {
	trimmed := strings.TrimSpace(value)
	if strings.HasPrefix(trimmed, "* ") {
		return strings.TrimSpace(trimmed[2:])
	}
	if idx, ok := canvasNumberedListPrefix(trimmed); ok {
		return strings.TrimSpace(trimmed[idx+1:])
	}
	return trimmed
}

func canvasNumberedListPrefix(value string) (int, bool) {
	dot := strings.Index(value, ".")
	if dot <= 0 || dot > 3 {
		return 0, false
	}
	prefix := value[:dot]
	if _, err := strconv.Atoi(prefix); err != nil {
		return 0, false
	}
	if dot+1 < len(value) && value[dot+1] != ' ' && value[dot+1] != '\t' {
		return 0, false
	}
	return dot, true
}

func sanitizeCanvasID(value string) string {
	safe := strings.ToLower(strings.TrimSpace(value))
	safe = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= '0' && r <= '9':
			return r
		case r == '.', r == '_', r == '-':
			return r
		default:
			return '-'
		}
	}, safe)
	safe = strings.Trim(safe, "-")
	if len(safe) > 90 {
		safe = safe[:90]
	}
	if safe == "" {
		return "canvas"
	}
	return safe
}

func defaultCanvasDedupKey(artifactID string, channel string, threadTS string) string {
	return fmt.Sprintf("post-meeting:%s:%s:%s", artifactID, channel, threadTS)
}

func truncateSlackText(markdown string) string {
	if len(markdown) <= 3500 {
		return markdown
	}
	return markdown[:3500]
}

func slackCanvasMarkdownLink(result SlackCanvasAPIResult) string {
	permalink := strings.TrimSpace(result.Permalink)
	if permalink == "" {
		permalink = slackCanvasPermalink(result.TeamID, result.CanvasID)
	}
	if permalink == "" {
		return "Canvas published"
	}
	return fmt.Sprintf("<%s|View full notes>", permalink)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func writeJSONFile(path string, value any) error {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal canvas manifest: %w", err)
	}
	if err := os.WriteFile(path, append(payload, '\n'), 0o644); err != nil {
		return fmt.Errorf("write canvas manifest: %w", err)
	}
	return nil
}

func nowRFC3339() string {
	return timeNow().UTC().Format(time.RFC3339Nano)
}

var timeNow = func() time.Time {
	return time.Now()
}
