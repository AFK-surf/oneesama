package slackagent

import (
	"fmt"
	"strings"
)

func buildMeetingTeamMemoryDoc(title string, source teamMemorySource, summary *MeetingSummaryData, facts, decisions, actions, questions []string) string {
	var sb strings.Builder
	appendTeamMemoryHeader(&sb, "Team Memory", title, source)
	if summary.DurationMinutes > 0 {
		sb.WriteString(fmt.Sprintf("- Duration: %d minutes\n", summary.DurationMinutes))
	}
	if len(summary.Attendees) > 0 {
		sb.WriteString(fmt.Sprintf("- Participants: %s\n", strings.Join(compactUniqueStrings(summary.Attendees), ", ")))
	}
	if len(summary.Blockers) > 0 {
		sb.WriteString(fmt.Sprintf("- Blockers present: %d\n", len(summary.Blockers)))
	}
	sb.WriteString("\n")
	appendMemoryBullets(&sb, "Stable Context", facts)
	appendMemoryBullets(&sb, "Decisions", decisions)
	appendMemoryBullets(&sb, "Action Items", actions)
	appendMemoryBullets(&sb, "Open Questions", questions)
	appendMemoryBullets(&sb, "Blockers", compactUniqueStrings(summary.Blockers))
	return strings.TrimSpace(sb.String())
}

func buildCategoryMemoryDoc(kind, title string, source teamMemorySource, entries []string, sectionTitle string) string {
	entries = compactUniqueStrings(entries)
	if len(entries) == 0 {
		return ""
	}
	var sb strings.Builder
	appendTeamMemoryHeader(&sb, kind, title, source)
	appendMemoryBullets(&sb, sectionTitle, entries)
	return strings.TrimSpace(sb.String())
}

func appendTeamMemoryHeader(sb *strings.Builder, kind string, title string, source teamMemorySource) {
	sb.WriteString(fmt.Sprintf("# %s: %s\n\n", kind, title))
	if source.SourceType != "" {
		sb.WriteString(fmt.Sprintf("- Source type: %s\n", source.SourceType))
	}
	if source.SourceRef != "" {
		sb.WriteString(fmt.Sprintf("- Source ref: %s\n", source.SourceRef))
	}
	if !source.Timestamp.IsZero() {
		sb.WriteString(fmt.Sprintf("- Captured at: %s\n", source.Timestamp.Format("2006-01-02 15:04 MST")))
	}
	if source.ChannelID != "" {
		sb.WriteString(fmt.Sprintf("- Slack channel: %s\n", source.ChannelID))
	}
	if source.ThreadTS != "" {
		sb.WriteString(fmt.Sprintf("- Slack thread_ts: %s\n", source.ThreadTS))
	}
	if source.ThreadPermalink != "" {
		sb.WriteString(fmt.Sprintf("- Slack thread permalink: %s\n", source.ThreadPermalink))
	}
	if source.Confidence != "" {
		sb.WriteString(fmt.Sprintf("- Confidence: %s\n", source.Confidence))
	}
	if len(source.Tags) > 0 {
		sb.WriteString(fmt.Sprintf("- Tags: %s\n", strings.Join(source.Tags, ", ")))
	}
	sb.WriteString("\n")
}

func appendMemoryBullets(sb *strings.Builder, title string, items []string) {
	items = compactUniqueStrings(items)
	if len(items) == 0 {
		return
	}
	sb.WriteString(fmt.Sprintf("## %s\n\n", title))
	for _, item := range items {
		sb.WriteString("- " + item + "\n")
	}
	sb.WriteString("\n")
}
