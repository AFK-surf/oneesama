//go:build cueboardparity

package slackagent

import "testing"

func TestCueboardParitySummarizeHandledThreadAction(t *testing.T) {
	tests := []struct {
		name       string
		actionType string
		resultText string
		want       string
	}{
		{
			name:       "create issue",
			actionType: slackActionTypeCreateIssue,
			resultText: "Created *CUE-123*: Fix mention memory\nhttps://linear.app/...",
			want:       "created Linear issue CUE-123",
		},
		{
			name:       "add comment",
			actionType: slackActionTypeAddComment,
			resultText: "Comment added to *CUE-123*",
			want:       "added comment to CUE-123",
		},
		{
			name:       "create event",
			actionType: slackActionTypeCreateEvent,
			resultText: "Created meeting: *Weekly Sync*\nhttps://meet.google.com/...",
			want:       "created meeting Weekly Sync",
		},
		{
			name:       "join meeting",
			actionType: slackActionTypeJoinMeeting,
			resultText: "Bot is joining *Design Review*\nMeeting ID: 12 — summary will be posted here when it ends.",
			want:       "joined meeting Design Review",
		},
		{
			name:       "create channel",
			actionType: slackActionTypeCreateChannel,
			resultText: "Created channel *#ops-war-room*",
			want:       "created Slack channel #ops-war-room",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := summarizeHandledThreadAction(tt.actionType, tt.resultText); got != tt.want {
				t.Fatalf("summarizeHandledThreadAction() = %q, want %q", got, tt.want)
			}
		})
	}
}
