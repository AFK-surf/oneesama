package slackagent

import (
	"fmt"
	"strings"
)

func buildMeetingTeamMemoryDoc(title string, source teamMemorySource, summary *MeetingSummaryData, facts, decisions, actions, questions []string) string {
	var sb strings.Builder
	appendTeamMemoryHeader(&sb, "Team Memory", title, source)
	if summary.DurationMinutes > 0 {
		_, _ = fmt.Fprintf(&sb, "- Duration: %d minutes\n", summary.DurationMinutes)
	}
	if len(summary.Attendees) > 0 {
		_, _ = fmt.Fprintf(&sb, "- Participants: %s\n", strings.Join(compactUniqueStrings(summary.Attendees), ", "))
	}
	if len(summary.Blockers) > 0 {
		_, _ = fmt.Fprintf(&sb, "- Blockers present: %d\n", len(summary.Blockers))
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
	_, _ = fmt.Fprintf(sb, "# %s: %s\n\n", kind, title)
	if source.SourceType != "" {
		_, _ = fmt.Fprintf(sb, "- Source type: %s\n", source.SourceType)
	}
	if source.SourceRef != "" {
		_, _ = fmt.Fprintf(sb, "- Source ref: %s\n", source.SourceRef)
	}
	if !source.Timestamp.IsZero() {
		_, _ = fmt.Fprintf(sb, "- Captured at: %s\n", source.Timestamp.Format("2006-01-02 15:04 MST"))
	}
	if source.ChannelID != "" {
		_, _ = fmt.Fprintf(sb, "- Slack channel: %s\n", source.ChannelID)
	}
	if source.ThreadTS != "" {
		_, _ = fmt.Fprintf(sb, "- Slack thread_ts: %s\n", source.ThreadTS)
	}
	if source.ThreadPermalink != "" {
		_, _ = fmt.Fprintf(sb, "- Slack thread permalink: %s\n", source.ThreadPermalink)
	}
	if source.Confidence != "" {
		_, _ = fmt.Fprintf(sb, "- Confidence: %s\n", source.Confidence)
	}
	if len(source.Tags) > 0 {
		_, _ = fmt.Fprintf(sb, "- Tags: %s\n", strings.Join(source.Tags, ", "))
	}
	sb.WriteString("\n")
}

func appendMemoryBullets(sb *strings.Builder, title string, items []string) {
	items = compactUniqueStrings(items)
	if len(items) == 0 {
		return
	}
	_, _ = fmt.Fprintf(sb, "## %s\n\n", title)
	for _, item := range items {
		sb.WriteString("- " + item + "\n")
	}
	sb.WriteString("\n")
}
