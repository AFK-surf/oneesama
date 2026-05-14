//go:build cueboardparity

package slackagent

import (
	"testing"
	"time"
)

func TestCueboardParityMeetingScannerLookahead(t *testing.T) {
	t.Parallel()

	if got := meetingScannerLookahead(time.Minute); got != 2*time.Minute+15*time.Second {
		t.Fatalf("lookahead = %s, want %s", got, 2*time.Minute+15*time.Second)
	}
}

func TestCueboardParityShouldSuggestMeetingApprovalAt(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.March, 20, 15, 0, 0, 0, time.UTC)
	interval := time.Minute

	tests := []struct {
		name     string
		start    time.Time
		wantPost bool
	}{
		{name: "too early", start: now.Add(2 * time.Minute), wantPost: false},
		{name: "within lead time", start: now.Add(45 * time.Second), wantPost: true},
		{name: "slightly late still okay", start: now.Add(-30 * time.Second), wantPost: true},
		{name: "too late", start: now.Add(-(interval + 16*time.Second)), wantPost: false},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := shouldSuggestMeetingApprovalAt(now, tt.start, interval); got != tt.wantPost {
				t.Fatalf("shouldSuggestMeetingApprovalAt() = %t, want %t", got, tt.wantPost)
			}
		})
	}
}
