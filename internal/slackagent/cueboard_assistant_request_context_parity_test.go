//go:build cueboardparity

package slackagent

import "testing"

func testAssistantHistoryMessages(text string) []slackHistoryMessage {
	return []slackHistoryMessage{{
		Type: slackHistoryMessageTypeMessage,
		Role: slackHistoryRoleUser,
		Content: []slackHistoryMessageContent{{
			Type: slackHistoryContentTypeText,
			Text: text,
		}},
	}}
}

func TestCueboardParityLatestAssistantRequestContext(t *testing.T) {
	history := testAssistantHistoryMessages(
		"Thread metadata:\n- channel: C123\n- thread_ts: 123.456\n- thread_permalink: https://cue-3kl2780.slack.com/archives/C123/p123456000456\n- thread started by: Peng Xiao\n\nThread context:\n\n[ts:123.456] Peng Xiao: old\n\n---\nUser <@U1> says:\n创建一个，这是新的 glass 实现引入的",
	)

	got := latestAssistantRequestContext(history)
	if got.Channel != "C123" || got.ThreadTS != "123.456" {
		t.Fatalf("unexpected thread metadata: %+v", got)
	}
	if got.ThreadPermalink != "https://cue-3kl2780.slack.com/archives/C123/p123456000456" {
		t.Fatalf("thread permalink = %q", got.ThreadPermalink)
	}
	if got.UserText != "创建一个，这是新的 glass 实现引入的" {
		t.Fatalf("user text = %q", got.UserText)
	}
}

func TestCueboardParityExplicitlyRequestsIssueCreation(t *testing.T) {
	tests := []struct {
		text string
		want bool
	}{
		{text: "创建一个，这是新的 glass 实现引入的", want: true},
		{text: "我让你明确创建，你不用让我确认", want: true},
		{text: "please create a new issue for this", want: true},
		{text: "不要创建 issue", want: false},
		{text: "先看看有没有相关 issue", want: false},
	}

	for _, tt := range tests {
		if got := explicitlyRequestsIssueCreation(tt.text); got != tt.want {
			t.Fatalf("explicitlyRequestsIssueCreation(%q) = %v, want %v", tt.text, got, tt.want)
		}
	}
}

func TestCueboardParityResolveSlackUploadTargetUsesAssistantContext(t *testing.T) {
	history := testAssistantHistoryMessages(
		"Thread metadata:\n- channel: C123\n- thread_ts: 123.456\n\n---\nUser <@U1> says:\n把截图发回来",
	)

	channel, threadTS := resolveSlackUploadTarget(history, map[string]any{"path": "/tmp/test.png"})
	if channel != "C123" || threadTS != "123.456" {
		t.Fatalf("resolveSlackUploadTarget() = (%q, %q), want (%q, %q)", channel, threadTS, "C123", "123.456")
	}
}
