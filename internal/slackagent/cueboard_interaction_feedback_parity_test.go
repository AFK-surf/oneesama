//go:build cueboardparity

package slackagent

import "testing"

func TestCueboardParityPendingActionFeedbackSummaryUsesReadableCreateIssueSummary(t *testing.T) {
	t.Parallel()

	action := &SlackPendingAction{
		ActionType: slackActionTypeCreateIssue,
		Params:     map[string]any{"title": "macOS 14.x 闪退 — 需要明确最低版本限制或提示"},
	}

	if got := pendingActionFeedbackSummary(action, ""); got != "macOS 14.x 闪退 — 需要明确最低版本限制或提示" {
		t.Fatalf("dismiss summary = %q", got)
	}

	result := "Created *CUE-123*: macOS 14.x 闪退 — 需要明确最低版本限制或提示\nhttps://linear.app/cue/issue/CUE-123"
	if got := pendingActionFeedbackSummary(action, result); got != "Created *CUE-123*: macOS 14.x 闪退 — 需要明确最低版本限制或提示" {
		t.Fatalf("confirm summary = %q", got)
	}
}

func TestCueboardParityPendingActionFeedbackSummaryUsesCreateChannelName(t *testing.T) {
	t.Parallel()

	action := &SlackPendingAction{
		ActionType: slackActionTypeCreateChannel,
		Params:     map[string]any{"channel_name": "cue-launch-ops"},
	}

	if got := pendingActionFeedbackSummary(action, ""); got != "#cue-launch-ops" {
		t.Fatalf("summary = %q", got)
	}
}
