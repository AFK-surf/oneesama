package slackagent

import (
	"fmt"
	"strings"
	"time"
)

type meetingApprovalChannel struct {
	ID   string
	Name string
}

type meetingApprovalBrief struct {
	Title    string
	StartAt  string
	EventURL string
	MeetURL  string
}

func normalizeSlackChannelName(value string) string {
	return strings.TrimPrefix(strings.TrimSpace(value), "#")
}

func resolveMeetingApprovalChannelID(configured string, channels []meetingApprovalChannel) (string, error) {
	targetName := normalizeSlackChannelName(configured)
	if targetName == "" {
		return "", fmt.Errorf("meeting approval channel is not configured")
	}
	for _, channel := range channels {
		if normalizeSlackChannelName(channel.Name) == targetName {
			return channel.ID, nil
		}
	}
	return "", fmt.Errorf("meeting approval channel #%s not found in synced Slack channels", targetName)
}

func formatMeetingApprovalAnchorText(brief meetingApprovalBrief) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, ":calendar: Upcoming meeting: *%s*", brief.Title)
	if start := formatMeetingBriefStart(brief.StartAt); start != "" {
		fmt.Fprintf(&builder, "\nStarts at %s.", start)
	}
	if links := formatMeetingLinks(brief.EventURL, brief.MeetURL); links != "" {
		fmt.Fprintf(&builder, "\n%s", links)
	}
	builder.WriteString("\nConfirm in thread if Onee Sama should join and summarize it.")
	return builder.String()
}

func formatMeetingApprovalSummary(brief meetingApprovalBrief) string {
	var builder strings.Builder
	builder.WriteString("Onee Sama found an upcoming invited meeting in Google Calendar")
	if start := formatMeetingBriefStart(brief.StartAt); start != "" {
		fmt.Fprintf(&builder, " starting at %s", start)
	}
	builder.WriteString(".")
	if links := formatMeetingLinks(brief.EventURL, brief.MeetURL); links != "" {
		fmt.Fprintf(&builder, "\n%s", links)
	}
	builder.WriteString("\nConfirm if it should join and post a summary in this thread.")
	return builder.String()
}

func formatMeetingJoinAckText(brief meetingApprovalBrief) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, ":calendar: Joining meeting: *%s*", brief.Title)
	if links := formatMeetingLinks(brief.EventURL, brief.MeetURL); links != "" {
		fmt.Fprintf(&builder, "\n%s", links)
	}
	builder.WriteString("\nI'll post a summary here when it ends.")
	return builder.String()
}

func formatMeetingLinks(eventURL, meetURL string) string {
	parts := make([]string, 0, 2)
	if strings.TrimSpace(eventURL) != "" {
		parts = append(parts, fmt.Sprintf("<%s|Open event>", strings.TrimSpace(eventURL)))
	}
	if strings.TrimSpace(meetURL) != "" {
		parts = append(parts, fmt.Sprintf("<%s|Join Meet>", strings.TrimSpace(meetURL)))
	}
	return strings.Join(parts, " | ")
}

func formatMeetingBriefStart(startAt string) string {
	if strings.TrimSpace(startAt) == "" {
		return ""
	}
	startTime, err := time.Parse(time.RFC3339, startAt)
	if err != nil {
		return ""
	}
	return startTime.In(shanghaiLocation()).Format("2006-01-02 15:04 MST")
}
