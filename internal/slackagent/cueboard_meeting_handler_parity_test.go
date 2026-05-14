//go:build cueboardparity

package slackagent

import (
	"strings"
	"testing"
)

func TestCueboardParityResolveMeetingApprovalChannelID(t *testing.T) {
	t.Parallel()

	channelID, err := resolveMeetingApprovalChannelID("#general", []meetingApprovalChannel{{ID: "C123", Name: "general"}})
	if err != nil {
		t.Fatalf("resolveMeetingApprovalChannelID: %v", err)
	}
	if channelID != "C123" {
		t.Fatalf("channelID = %q, want C123", channelID)
	}
}

func TestCueboardParityResolveMeetingApprovalChannelIDMissing(t *testing.T) {
	t.Parallel()

	if _, err := resolveMeetingApprovalChannelID("general", nil); err == nil {
		t.Fatal("expected missing channel error")
	}
}

func TestCueboardParityNormalizeSlackChannelName(t *testing.T) {
	t.Parallel()

	if got := normalizeSlackChannelName(" #general "); got != "general" {
		t.Fatalf("normalizeSlackChannelName = %q, want general", got)
	}
}

func TestCueboardParityFormatMeetingApprovalTextsIncludeLinks(t *testing.T) {
	t.Parallel()

	brief := meetingApprovalBrief{
		Title:    "Weekly Sync",
		StartAt:  "2026-03-20T15:59:00+08:00",
		EventURL: "https://calendar.google.com/calendar/event?eid=abc",
		MeetURL:  "https://meet.google.com/abc-defg-hij",
	}

	anchor := formatMeetingApprovalAnchorText(brief)
	for _, want := range []string{
		"Upcoming meeting: *Weekly Sync*",
		"Starts at 2026-03-20 15:59 CST.",
		"<https://calendar.google.com/calendar/event?eid=abc|Open event> | <https://meet.google.com/abc-defg-hij|Join Meet>",
	} {
		if !strings.Contains(anchor, want) {
			t.Fatalf("anchor %q missing %q", anchor, want)
		}
	}
	if strings.Contains(anchor, "Cueboard") {
		t.Fatalf("anchor should use Onee Sama branding, got %q", anchor)
	}

	summary := formatMeetingApprovalSummary(brief)
	for _, want := range []string{
		"Onee Sama found an upcoming invited meeting in Google Calendar starting at 2026-03-20 15:59 CST.",
		"<https://calendar.google.com/calendar/event?eid=abc|Open event> | <https://meet.google.com/abc-defg-hij|Join Meet>",
		"Confirm if it should join and post a summary in this thread.",
	} {
		if !strings.Contains(summary, want) {
			t.Fatalf("summary %q missing %q", summary, want)
		}
	}
}

func TestCueboardParityFormatMeetingJoinAckTextIncludesLinks(t *testing.T) {
	t.Parallel()

	brief := meetingApprovalBrief{
		Title:    "Weekly Sync",
		EventURL: "https://calendar.google.com/calendar/event?eid=abc",
		MeetURL:  "https://meet.google.com/abc-defg-hij",
	}

	ack := formatMeetingJoinAckText(brief)
	if !strings.Contains(ack, ":calendar: Joining meeting: *Weekly Sync*") {
		t.Fatalf("ack %q missing title", ack)
	}
	if !strings.Contains(ack, "<https://calendar.google.com/calendar/event?eid=abc|Open event> | <https://meet.google.com/abc-defg-hij|Join Meet>") {
		t.Fatalf("ack %q missing links", ack)
	}
}
