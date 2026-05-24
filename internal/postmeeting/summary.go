package postmeeting

import (
	"fmt"
	"strings"
)

func buildFallbackSummary(input PostProcessInput, segments []NormalizedSegment, participants []string) Summary {
	if input.Summary != nil {
		return *input.Summary
	}
	if summary := summaryFromText(firstNonEmpty(input.SummaryText, input.Transcript.Text, input.Text)); summary != nil {
		summary.Title = firstNonEmpty(summary.Title, input.Title, "Meeting summary")
		summary.MeetURL = firstNonEmpty(summary.MeetURL, input.MeetURL)
		if len(summary.Participants) == 0 {
			summary.Participants = participants
		}
		return *summary
	}

	highlights := collectHighlights(segments, 5)
	decisions := collectTaggedLines(segments, []string{"decision", "decided", "agreed", "agree"}, 3)
	actionItems := collectTaggedLines(segments, []string{"action item", "todo", "follow up", "follow-up", "next step"}, 5)
	title := firstNonEmpty(input.Title, "Meeting summary")

	return Summary{
		Title:        title,
		MeetURL:      firstNonEmpty(input.MeetURL),
		Participants: participants,
		Highlights:   highlights,
		Decisions:    decisions,
		ActionItems:  actionItems,
		SummaryText:  strings.Join(highlights, "\n"),
	}
}

func summaryFromText(text string) *Summary {
	cleaned := cleanResponseText(text)
	if strings.TrimSpace(cleaned) == "" {
		return nil
	}
	var summary Summary
	if !parseSummaryJSON(extractJSONCandidate(cleaned), &summary) {
		return nil
	}
	return &summary
}

func renderSummaryMarkdown(summary Summary, artifact ArtifactManifest) string {
	lines := []string{
		fmt.Sprintf("# %s", firstNonEmpty(summary.Title, artifact.Title, "Meeting summary")),
		fmt.Sprintf("- Meeting: %s", firstNonEmpty(artifact.MeetURL, summary.MeetURL, "unknown")),
	}
	if len(summary.Participants) > 0 {
		lines = append(lines, fmt.Sprintf("- Participants: %s", strings.Join(summary.Participants, ", ")))
	}
	if len(artifact.Warnings) > 0 {
		lines = append(lines, "", "## Processing Warnings")
		for _, warning := range artifact.Warnings {
			line := "- " + firstNonEmpty(warning.Message, warning.Code)
			if warning.Code != "" {
				line += " (`" + warning.Code + "`)"
			}
			lines = append(lines, line)
		}
	}

	lines = append(lines, "", "## Highlights")
	if len(summary.Highlights) == 0 {
		lines = append(lines, "- No highlights captured yet.")
	} else {
		for _, item := range summary.Highlights {
			lines = append(lines, "- "+item)
		}
	}

	lines = append(lines, "", "## Decisions")
	if len(summary.Decisions) == 0 {
		lines = append(lines, "- No explicit decisions captured.")
	} else {
		for _, item := range summary.Decisions {
			lines = append(lines, "- "+item)
		}
	}

	lines = append(lines, "", "## Action Items")
	if len(summary.ActionItems) == 0 {
		lines = append(lines, "- No explicit action items captured.")
	} else {
		for _, item := range summary.ActionItems {
			lines = append(lines, "- "+item)
		}
	}

	return strings.Join(lines, "\n") + "\n"
}

func collectHighlights(segments []NormalizedSegment, limit int) []string {
	highlights := make([]string, 0, limit)
	for _, segment := range segments {
		for _, highlight := range fallbackHighlightsFromText(segment.Text, limit-len(highlights)) {
			highlights = append(highlights, highlight)
			if len(highlights) >= limit {
				break
			}
		}
		if len(highlights) >= limit {
			break
		}
	}
	return dedupeStrings(highlights)
}

func collectTaggedLines(segments []NormalizedSegment, keywords []string, limit int) []string {
	matches := make([]string, 0, limit)
	for _, segment := range segments {
		lower := strings.ToLower(segment.Text)
		for _, keyword := range keywords {
			if strings.Contains(lower, keyword) {
				matches = append(matches, segment.Text)
				break
			}
		}
		if len(matches) >= limit {
			break
		}
	}
	return dedupeStrings(matches)
}

func fallbackHighlightText(text string) string {
	if looksLikeStructuredSummaryPayload(text) {
		return "Structured summary generation failed to parse cleanly. Please review the transcript and artifacts."
	}
	return truncateRunes(text, 240)
}

func fallbackHighlightsFromText(text string, limit int) []string {
	text = strings.TrimSpace(text)
	if text == "" || limit <= 0 {
		return nil
	}
	if looksLikeStructuredSummaryPayload(text) {
		return []string{fallbackHighlightText(text)}
	}
	sentences := splitSummarySentences(text)
	if len(sentences) == 0 {
		return []string{fallbackHighlightText(text)}
	}
	highlights := make([]string, 0, minInt(limit, len(sentences)))
	for _, sentence := range sentences {
		highlight := fallbackHighlightText(sentence)
		if highlight == "" {
			continue
		}
		highlights = append(highlights, highlight)
		if len(highlights) >= limit {
			break
		}
	}
	return highlights
}

func splitSummarySentences(text string) []string {
	text = strings.Join(strings.Fields(text), " ")
	var sentences []string
	start := 0
	for index, r := range text {
		if !summarySentenceBoundary(r) {
			continue
		}
		sentence := strings.TrimSpace(text[start : index+len(string(r))])
		if sentence != "" {
			sentences = append(sentences, sentence)
		}
		start = index + len(string(r))
	}
	if tail := strings.TrimSpace(text[start:]); tail != "" {
		sentences = append(sentences, tail)
	}
	return sentences
}

func summarySentenceBoundary(r rune) bool {
	switch r {
	case '.', '!', '?', '。', '！', '？', ';', '；':
		return true
	default:
		return false
	}
}

func looksLikeStructuredSummaryPayload(value string) bool {
	trimmed := strings.TrimSpace(value)
	if !strings.HasPrefix(trimmed, "{") {
		return false
	}
	return strings.Contains(trimmed, `"title"`) &&
		strings.Contains(trimmed, `"key_points"`) &&
		strings.Contains(trimmed, `"action_items"`)
}

func truncateRunes(value string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes]) + "..."
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}
