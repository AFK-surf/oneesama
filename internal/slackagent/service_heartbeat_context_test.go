package slackagent

import (
	"strings"
	"testing"
	"time"
)

func TestFormatHeartbeatUpcomingDigestEmptyWhenNoDeadlines(t *testing.T) {
	now := time.Date(2026, 5, 18, 0, 0, 0, 0, time.UTC)
	followups := []SlackHeartbeatFollowup{
		{ID: 1, Title: "no deadline", Status: "open"},
	}
	got := formatHeartbeatUpcomingDigest(followups, now, 24*time.Hour)
	if !strings.HasSuffix(got, "- none") {
		t.Fatalf("expected empty-marker output, got %q", got)
	}
}

func TestFormatHeartbeatUpcomingDigestSortsByDeadline(t *testing.T) {
	now := time.Date(2026, 5, 18, 0, 0, 0, 0, time.UTC)
	followups := []SlackHeartbeatFollowup{
		{ID: 1, Title: "later", NextCheckAt: now.Add(10 * time.Hour).Format(time.RFC3339Nano)},
		{ID: 2, Title: "sooner", NextCheckAt: now.Add(2 * time.Hour).Format(time.RFC3339Nano)},
		{ID: 3, Title: "well later", NextCheckAt: now.Add(20 * time.Hour).Format(time.RFC3339Nano)},
	}
	got := formatHeartbeatUpcomingDigest(followups, now, 24*time.Hour)
	idxSooner := strings.Index(got, "#2 sooner")
	idxLater := strings.Index(got, "#1 later")
	idxWell := strings.Index(got, "#3 well later")
	if idxSooner < 0 || idxLater < 0 || idxWell < 0 {
		t.Fatalf("expected all 3 followups present in output, got %q", got)
	}
	if idxSooner >= idxLater || idxLater >= idxWell {
		t.Fatalf("expected sooner→later→well-later order, got %q", got)
	}
}

func TestFormatHeartbeatUpcomingDigestExcludesPastAndFuture(t *testing.T) {
	now := time.Date(2026, 5, 18, 0, 0, 0, 0, time.UTC)
	followups := []SlackHeartbeatFollowup{
		{ID: 10, Title: "past", NextCheckAt: now.Add(-2 * time.Hour).Format(time.RFC3339Nano)},
		{ID: 11, Title: "future-outside", NextCheckAt: now.Add(48 * time.Hour).Format(time.RFC3339Nano)},
		{ID: 12, Title: "inside", NextCheckAt: now.Add(6 * time.Hour).Format(time.RFC3339Nano)},
	}
	got := formatHeartbeatUpcomingDigest(followups, now, 24*time.Hour)
	if !strings.Contains(got, "#12 inside") {
		t.Fatalf("expected inside-window item, got %q", got)
	}
	if strings.Contains(got, "#10 past") {
		t.Fatalf("expected past item to be excluded, got %q", got)
	}
	if strings.Contains(got, "#11 future-outside") {
		t.Fatalf("expected outside-horizon item to be excluded, got %q", got)
	}
}

func TestFirstHeartbeatDeadlinePrefersNextCheckAtOverDueAt(t *testing.T) {
	item := SlackHeartbeatFollowup{
		NextCheckAt: "2026-05-18T01:00:00Z",
		DueAt:       "2026-05-18T02:00:00Z",
	}
	deadline, source := firstHeartbeatDeadline(item)
	if deadline != "2026-05-18T01:00:00Z" || source != "next_check_at" {
		t.Fatalf("firstHeartbeatDeadline = (%q, %q), want NextCheckAt", deadline, source)
	}
}

func TestFirstHeartbeatDeadlineFallsBackToDueAt(t *testing.T) {
	item := SlackHeartbeatFollowup{DueAt: "2026-05-18T03:00:00Z"}
	deadline, source := firstHeartbeatDeadline(item)
	if deadline != "2026-05-18T03:00:00Z" || source != "due_at" {
		t.Fatalf("firstHeartbeatDeadline = (%q, %q), want DueAt fallback", deadline, source)
	}
}

func TestSelectUpcomingHeartbeatFollowupsSkipsUnparseable(t *testing.T) {
	now := time.Date(2026, 5, 18, 0, 0, 0, 0, time.UTC)
	followups := []SlackHeartbeatFollowup{
		{ID: 1, Title: "bad ts", NextCheckAt: "not-a-time"},
		{ID: 2, Title: "good", NextCheckAt: now.Add(3 * time.Hour).Format(time.RFC3339Nano)},
	}
	got := selectUpcomingHeartbeatFollowups(followups, now, 24*time.Hour)
	if len(got) != 1 || got[0].ID != 2 {
		t.Fatalf("expected only the parseable followup, got %+v", got)
	}
}
