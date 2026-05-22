package slackagent

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func normalizeMeetingWebhookPayload(payload MeetingWebhookPayload) NormalizedMeetingWebhookPayload {
	meetingID := int64Value(payload.MeetingID, payload.MeetingIDAlt, payload.ID)
	summary := payload.Summary
	if summary == nil && payload.Result != nil {
		summary = payload.Result.Summary
	}
	status := firstNonEmpty(payload.Status)
	if status == "" && summary != nil {
		status = "done"
	}
	title := firstNonEmpty(payload.Title)
	if title == "" {
		if meetingID > 0 {
			title = fmt.Sprintf("Meeting %d", meetingID)
		} else {
			title = "Meeting"
		}
	}
	return NormalizedMeetingWebhookPayload{
		Event:          strings.TrimSpace(payload.Event),
		MeetingID:      meetingID,
		Title:          title,
		Status:         status,
		Error:          firstNonEmpty(payload.Error, payload.Message),
		Summary:        summary,
		Artifacts:      payload.Artifacts,
		Transcript:     strings.TrimSpace(payload.Transcript),
		ChatTranscript: firstNonEmpty(payload.ChatTranscript, payload.ChatTranscriptAlt),
		TimeFrom:       firstNonEmpty(payload.TimeFrom, payload.TimeFromAlt),
		TimeTo:         firstNonEmpty(payload.TimeTo, payload.TimeToAlt),
		SlackRef:       meetingSlackRefFromPayload(payload),
		ForceDelivery:  payload.ForceDelivery,
	}
}

func meetingSlackRefFromPayload(payload MeetingWebhookPayload) MeetingSlackRef {
	source := payload.SlackRef
	if source == nil {
		source = payload.SlackRefAlt
	}
	if source == nil {
		source = payload.Slack
	}
	if source != nil {
		return MeetingSlackRef{
			ChannelID: firstNonEmpty(source.ChannelID, source.ChannelIDAlt, source.Channel, payload.ChannelID, payload.ChannelIDAlt, payload.Channel),
			ThreadTS:  firstNonEmpty(source.ThreadTS, source.ThreadTSAlt, source.TS, payload.ThreadTS, payload.ThreadTSAlt, payload.TS),
			Source:    "payload",
		}
	}
	channelID := firstNonEmpty(payload.ChannelID, payload.ChannelIDAlt, payload.Channel)
	if channelID == "" {
		return MeetingSlackRef{Source: "missing"}
	}
	return MeetingSlackRef{
		ChannelID: channelID,
		ThreadTS:  firstNonEmpty(payload.ThreadTS, payload.ThreadTSAlt, payload.TS),
		Source:    "payload",
	}
}

func buildMeetingJoinedPost(payload NormalizedMeetingWebhookPayload) (string, []map[string]any) {
	title := firstNonEmpty(payload.Title, "Untitled meeting")
	text := strings.Join([]string{
		fmt.Sprintf(":studio_microphone: *Joined: %s*", title),
		"Recording — summary will be posted when the meeting ends.",
		"",
		":robot_face: _Onee Sama Meeting Bot_",
	}, "\n")
	blocks := []map[string]any{
		{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": fmt.Sprintf(":studio_microphone: *Joined: %s*\nRecording — summary will be posted when the meeting ends.", title),
			},
		},
		{
			"type": "context",
			"elements": []map[string]any{{
				"type": "mrkdwn",
				"text": ":robot_face: _Onee Sama Meeting Bot_",
			}},
		},
	}
	return text, blocks
}

func buildMeetingFailurePost(payload NormalizedMeetingWebhookPayload) string {
	return fmt.Sprintf(":x: Meeting failed: %s", safeMeetingFailureError(payload.Error))
}

func safeMeetingFailureError(text string) string {
	trimmed := strings.TrimSpace(firstNonEmpty(text, "unknown error"))
	if slackVisibleTextContainsInternalLeak(trimmed) {
		return "meeting result was unavailable; I kept this visible for retry instead of exposing internal tool details"
	}
	return trimmed
}

func buildMeetingResultPost(payload NormalizedMeetingWebhookPayload) string {
	summary := normalizeMeetingSummary(payload.Summary, payload.Title)
	duration := ""
	if summary.DurationMinutes > 0 {
		duration = fmt.Sprintf(" · %d min", summary.DurationMinutes)
	}
	lines := []string{fmt.Sprintf(":memo: *Meeting Summary: %s*%s", firstNonEmpty(summary.Title, payload.Title, "Untitled meeting"), duration)}
	if len(summary.Attendees) > 0 {
		lines = append(lines, ":busts_in_silhouette: "+strings.Join(summary.Attendees, ", "))
	}
	lines = appendMeetingList(lines, "Key points", summary.KeyPoints)
	lines = appendMeetingList(lines, "Decisions", summary.Decisions)
	lines = appendMeetingList(lines, "Action items", formatMeetingActionItems(summary.ActionItems))
	lines = appendMeetingList(lines, "Open questions", summary.OpenQuestions)
	lines = appendMeetingList(lines, "Blockers", summary.Blockers)
	if len(lines) == 1 {
		lines = append(lines, "", "No structured summary was included in the webhook payload.")
	}
	return strings.Join(lines, "\n") + "\n"
}

func buildMeetingResultNotification(payload NormalizedMeetingWebhookPayload) string {
	summary := normalizeMeetingSummary(payload.Summary, payload.Title)
	duration := meetingDurationMinutes(payload, summary)
	durationText := ""
	if duration > 0 {
		durationText = fmt.Sprintf(" · %d min", duration)
	}
	lines := []string{fmt.Sprintf(":memo: *Meeting Summary: %s*%s", firstNonEmpty(summary.Title, payload.Title, "Untitled meeting"), durationText)}
	if len(summary.Attendees) > 0 {
		lines = append(lines, ":busts_in_silhouette: "+strings.Join(summary.Attendees, ", "))
	}
	lines = append(lines, "{{canvas_link}}")
	return strings.Join(lines, "\n")
}

func buildMeetingCanvasMarkdown(payload NormalizedMeetingWebhookPayload) string {
	summary := normalizeMeetingSummary(payload.Summary, payload.Title)
	duration := meetingDurationMinutes(payload, summary)

	var sb strings.Builder
	if duration > 0 {
		fmt.Fprintf(&sb, "**Duration:** %d minutes\n\n", duration)
	}
	if len(summary.Attendees) > 0 {
		fmt.Fprintf(&sb, "**Participants:** %s\n\n", strings.Join(summary.Attendees, ", "))
	}
	appendCanvasBulletSection(&sb, "Key Points", summary.KeyPoints)
	appendCanvasActionItemSection(&sb, summary.ActionItems)
	appendCanvasBulletSection(&sb, "Decisions", summary.Decisions)
	appendCanvasBulletSection(&sb, "Open Questions", summary.OpenQuestions)
	appendCanvasBulletSection(&sb, "Blockers", summary.Blockers)
	sb.WriteString("---\n_Generated by Onee Sama Meeting Bot_\n")
	return sb.String()
}

func meetingCanvasArtifact(payload NormalizedMeetingWebhookPayload) CanvasArtifact {
	summary := normalizeMeetingSummary(payload.Summary, payload.Title)
	return CanvasArtifact{
		ID:    fmt.Sprintf("meeting-%d", payload.MeetingID),
		Title: firstNonEmpty(summary.Title, payload.Title, "Meeting summary"),
		Summary: &CanvasArtifactSummary{
			Highlights:      summary.KeyPoints,
			Decisions:       summary.Decisions,
			ActionItems:     formatMeetingActionItems(summary.ActionItems),
			Attendees:       summary.Attendees,
			DurationMinutes: summary.DurationMinutes,
		},
		Files: &CanvasArtifactFiles{
			Transcript: firstNonEmpty(payload.Artifacts.TranscriptPath, payload.Artifacts.TranscriptPathAlt, payload.Artifacts.Transcript),
			Audio:      firstNonEmpty(payload.Artifacts.AudioPath, payload.Artifacts.AudioPathAlt, payload.Artifacts.Audio),
		},
	}
}

func meetingDurationMinutes(payload NormalizedMeetingWebhookPayload, summary MeetingSummaryData) int {
	if summary.DurationMinutes > 0 {
		return summary.DurationMinutes
	}
	start, startErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(payload.TimeFrom))
	end, endErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(payload.TimeTo))
	if startErr != nil || endErr != nil || !end.After(start) {
		return 0
	}
	duration := end.Sub(start)
	minutes := int(duration / time.Minute)
	if duration%time.Minute != 0 {
		minutes++
	}
	return minutes
}

func meetingDurationText(payload NormalizedMeetingWebhookPayload, summary MeetingSummaryData) string {
	minutes := meetingDurationMinutes(payload, summary)
	if minutes <= 0 {
		return "unknown"
	}
	if minutes == 1 {
		return "1 minute"
	}
	return fmt.Sprintf("%d minutes", minutes)
}

func meetingParticipantsText(summary MeetingSummaryData) string {
	if len(summary.Attendees) == 0 {
		return "unknown"
	}
	return strings.Join(summary.Attendees, ", ")
}

type meetingCanvasAttachmentLink struct {
	Name      string
	Permalink string
}

func appendCanvasBulletSection(sb *strings.Builder, title string, items []string) {
	if len(items) == 0 {
		return
	}
	sb.WriteString("## " + title + "\n\n")
	for _, item := range items {
		if trimmed := normalizeCanvasListLine(strings.TrimSpace(item)); trimmed != "" {
			if strings.HasPrefix(trimmed, "- ") {
				fmt.Fprintln(sb, trimmed)
			} else {
				fmt.Fprintf(sb, "- %s\n", trimmed)
			}
		}
	}
	sb.WriteString("\n")
}

func appendCanvasActionItemSection(sb *strings.Builder, items []MeetingActionItem) {
	if len(items) == 0 {
		return
	}
	sb.WriteString("## Action Items\n\n")
	for _, item := range items {
		line := formatMeetingCanvasActionItem(item)
		if line != "" {
			sb.WriteString("- " + line + "\n")
		}
	}
	sb.WriteString("\n")
}

func appendCanvasAttachmentSection(sb *strings.Builder, artifacts []meetingCanvasAttachmentLink) {
	if len(artifacts) == 0 {
		return
	}
	sb.WriteString("## Attachments\n\n")
	for _, artifact := range artifacts {
		if strings.TrimSpace(artifact.Permalink) != "" {
			fmt.Fprintf(sb, "![%s](%s)\n\n", artifact.Name, artifact.Permalink)
		}
	}
}

func appendCanvasSection(lines []string, title string, items []string, fallback string) []string {
	lines = append(lines, "", "## "+title)
	return appendCanvasList(lines, items, fallback)
}

func appendCanvasList(lines []string, items []string, fallback string) []string {
	if len(items) == 0 {
		return append(lines, "- "+fallback)
	}
	for _, item := range items {
		if trimmed := normalizeCanvasListLine(item); trimmed != "" {
			lines = append(lines, "- "+trimmed)
		}
	}
	return lines
}

func formatMeetingCanvasActionItems(items []MeetingActionItem) []string {
	formatted := make([]string, 0, len(items))
	for _, item := range items {
		if line := formatMeetingCanvasActionItem(item); line != "" {
			formatted = append(formatted, line)
		}
	}
	return formatted
}

func formatMeetingCanvasActionItem(item MeetingActionItem) string {
	description := firstNonEmpty(item.Description, item.Text, item.Title)
	if description == "" {
		return ""
	}
	parts := []string{description}
	if owner := strings.TrimSpace(item.Owner); owner != "" {
		parts = append(parts, "**Owner:** "+owner)
	}
	if deadline := firstNonEmpty(item.Deadline, item.Due); deadline != "" {
		parts = append(parts, "**Deadline:** "+deadline)
	}
	return strings.Join(parts, " — ")
}

func meetingCanvasAttachmentLinks(artifacts MeetingWebhookArtifacts) []meetingCanvasAttachmentLink {
	var links []meetingCanvasAttachmentLink
	if transcript := firstNonEmpty(artifacts.TranscriptPath, artifacts.TranscriptPathAlt, artifacts.Transcript); transcript != "" {
		if permalink := meetingCanvasAttachmentPermalink(transcript); permalink != "" {
			links = append(links, meetingCanvasAttachmentLink{Name: "transcript.txt", Permalink: permalink})
		}
	}
	if audio := firstNonEmpty(artifacts.AudioPath, artifacts.AudioPathAlt, artifacts.Audio); audio != "" {
		if permalink := meetingCanvasAttachmentPermalink(audio); permalink != "" {
			links = append(links, meetingCanvasAttachmentLink{Name: meetingAudioUploadName(audio), Permalink: permalink})
		}
	}
	return links
}

func meetingCanvasAttachmentPermalink(target string) string {
	target = strings.TrimSpace(target)
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") || strings.HasPrefix(target, "slack://") {
		return target
	}
	return ""
}

func meetingTranscriptText(payload NormalizedMeetingWebhookPayload) string {
	if strings.TrimSpace(payload.Transcript) != "" {
		return strings.TrimSpace(payload.Transcript)
	}
	path := firstNonEmpty(payload.Artifacts.TranscriptPath, payload.Artifacts.TranscriptPathAlt, payload.Artifacts.Transcript)
	if strings.TrimSpace(path) == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return transcriptTextFromArtifact(raw)
}

func transcriptTextFromArtifact(raw []byte) string {
	var artifact struct {
		Text     string `json:"text"`
		Segments []struct {
			Speaker string `json:"speaker"`
			Text    string `json:"text"`
		} `json:"segments"`
	}
	if err := json.Unmarshal(raw, &artifact); err == nil {
		if strings.TrimSpace(artifact.Text) != "" {
			return strings.TrimSpace(artifact.Text)
		}
		var lines []string
		for _, segment := range artifact.Segments {
			text := strings.TrimSpace(segment.Text)
			if text == "" {
				continue
			}
			if speaker := strings.TrimSpace(segment.Speaker); speaker != "" {
				text = speaker + ": " + text
			}
			lines = append(lines, text)
		}
		if len(lines) > 0 {
			return strings.Join(lines, "\n")
		}
	}
	return strings.TrimSpace(string(raw))
}

func truncateMeetingTranscript(transcript string) string {
	const maxTranscriptRunes = 12000
	runes := []rune(strings.TrimSpace(transcript))
	if len(runes) <= maxTranscriptRunes {
		return string(runes)
	}
	return string(runes[:maxTranscriptRunes]) + "\n[transcript truncated]"
}

func normalizeMeetingSummary(summary *MeetingSummaryData, fallbackTitle string) MeetingSummaryData {
	if summary == nil {
		return MeetingSummaryData{Title: fallbackTitle}
	}
	normalized := *summary
	normalized.Title = firstNonEmpty(normalized.Title, fallbackTitle)
	normalized.DurationMinutes = firstNonZero(normalized.DurationMinutes, normalized.DurationMinutesAlt)
	normalized.KeyPoints = firstNonEmptySlice(normalized.KeyPoints, normalized.KeyPointsAlt, normalized.Highlights)
	normalized.ActionItems = firstNonEmptyActionItems(normalized.ActionItems, normalized.ActionItemsAlt)
	normalized.OpenQuestions = firstNonEmptySlice(normalized.OpenQuestions, normalized.OpenQuestionsAlt)
	return normalized
}

func appendMeetingList(lines []string, title string, items []string) []string {
	if len(items) == 0 {
		return lines
	}
	lines = append(lines, "", "*"+title+"*")
	for _, item := range items {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			lines = append(lines, "- "+trimmed)
		}
	}
	return lines
}

func formatMeetingActionItems(items []MeetingActionItem) []string {
	formatted := make([]string, 0, len(items))
	for _, item := range items {
		description := firstNonEmpty(item.Description, item.Text, item.Title)
		if description == "" {
			continue
		}
		suffix := strings.Join(nonEmptyStrings(
			prefixedValue("owner: ", item.Owner),
			prefixedValue("due: ", firstNonEmpty(item.Deadline, item.Due)),
		), ", ")
		if suffix != "" {
			description += " (" + suffix + ")"
		}
		formatted = append(formatted, description)
	}
	return formatted
}

func meetingArtifactLines(artifacts MeetingWebhookArtifacts) []string {
	var lines []string
	if transcript := firstNonEmpty(artifacts.TranscriptPath, artifacts.TranscriptPathAlt, artifacts.Transcript); transcript != "" {
		lines = append(lines, "Transcript: "+transcript)
	}
	if audio := firstNonEmpty(artifacts.AudioPath, artifacts.AudioPathAlt, artifacts.Audio); audio != "" {
		lines = append(lines, "Audio: "+audio)
	}
	return lines
}

func int64Value(values ...any) int64 {
	for _, value := range values {
		switch typed := value.(type) {
		case int64:
			if typed != 0 {
				return typed
			}
		case float64:
			if typed != 0 {
				return int64(typed)
			}
		case json.Number:
			parsed, err := typed.Int64()
			if err == nil && parsed != 0 {
				return parsed
			}
		case string:
			parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
			if err == nil && parsed != 0 {
				return parsed
			}
		}
	}
	return 0
}

func firstNonZero(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func firstNonEmptySlice(values ...[]string) []string {
	for _, value := range values {
		if len(value) > 0 {
			return value
		}
	}
	return nil
}

func firstNonEmptyActionItems(values ...[]MeetingActionItem) []MeetingActionItem {
	for _, value := range values {
		if len(value) > 0 {
			return value
		}
	}
	return nil
}

func prefixedValue(prefix string, value string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return prefix + trimmed
	}
	return ""
}

func nonEmptyStrings(values ...string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, value)
		}
	}
	return result
}
