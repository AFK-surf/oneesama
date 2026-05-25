package meetingagent

import "testing"

func TestJoinSessionLifecycleStatusSpecs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		status        string
		terminal      bool
		redeliverable bool
	}{
		{name: "queued", status: "queued"},
		{name: "prepared", status: "prepared"},
		{name: "waiting", status: "waiting"},
		{name: "joined", status: "joined"},
		{name: "stopped", status: "stopped", terminal: true, redeliverable: true},
		{name: "done", status: "done", terminal: true, redeliverable: true},
		{name: "failed", status: "failed", terminal: true, redeliverable: true},
		{name: "removed from meeting", status: "removed_from_meeting", terminal: true, redeliverable: true},
		{name: "stale", status: "stale", terminal: true, redeliverable: true},
		{name: "canceled", status: "canceled", terminal: true},
		{name: "cancelled", status: "cancelled", terminal: true},
		{name: "case and whitespace normalized", status: " Stale ", terminal: true, redeliverable: true},
		{name: "unknown active state is non-terminal", status: "active"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isTerminalJoinSessionStatus(tt.status); got != tt.terminal {
				t.Fatalf("isTerminalJoinSessionStatus(%q) = %v, want %v", tt.status, got, tt.terminal)
			}
			if got := isRedeliverableJoinSessionStatus(tt.status); got != tt.redeliverable {
				t.Fatalf("isRedeliverableJoinSessionStatus(%q) = %v, want %v", tt.status, got, tt.redeliverable)
			}
		})
	}
}

func TestRuntimeMeetPageStatusUsesJoinLifecycleStatuses(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		active any
		want   joinSessionStatus
	}{
		{
			name:   "cannot join maps failed without joined evidence",
			active: map[string]any{"meetPage": map[string]any{"cannotJoin": true}},
			want:   joinSessionStatusFailed,
		},
		{
			name:   "joined evidence wins over stale cannot join text",
			active: map[string]any{"meetPage": map[string]any{"cannotJoin": true, "inMeeting": true, "participantCount": 18}},
			want:   joinSessionStatusJoined,
		},
		{
			name:   "waiting for admit maps waiting",
			active: map[string]any{"meetPage": map[string]any{"waitingForAdmit": true}},
			want:   joinSessionStatusWaiting,
		},
		{
			name:   "in meeting maps joined",
			active: map[string]any{"meetPage": map[string]any{"inMeeting": true}},
			want:   joinSessionStatusJoined,
		},
		{
			name: "navigated away after kick maps removed even with stale captions",
			active: map[string]any{
				"meetPage": map[string]any{
					"url":       "https://workspace.google.com/products/meet/",
					"textHead":  "AI powered video calls",
					"inMeeting": false,
				},
				"captions": map[string]any{"count": 42},
			},
			want: joinSessionStatusRemoved,
		},
		{
			name: "closed meet page maps stale before stale captions can fake joined",
			active: map[string]any{
				"meetPage": map[string]any{
					"ok":    false,
					"error": "page.evaluate: Target page, context or browser has been closed",
				},
				"captions": map[string]any{"count": 733},
			},
			want: joinSessionStatusStale,
		},
		{
			name:   "unknown page maps empty",
			active: map[string]any{"meetPage": map[string]any{"preJoin": true}},
			want:   "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := runtimeMeetPageStatus(tt.active); got != joinSessionStatusString(tt.want) {
				t.Fatalf("runtimeMeetPageStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}
