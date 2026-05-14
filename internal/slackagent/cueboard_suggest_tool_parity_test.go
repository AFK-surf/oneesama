//go:build cueboardparity

package slackagent

import (
	"context"
	"strings"
	"testing"
)

func TestCueboardParitySuggestActionNormalizeJoinMeetingInfersMeetURLFromThread(t *testing.T) {
	tool := &slackSuggestActionTool{
		fetchThreadTranscript: func(context.Context, string, string) (string, error) {
			return `[ts:123.456] Peng: <https://meet.google.com/yuf-wnes-yqt> <@U123>`, nil
		},
	}

	req, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeJoinMeeting,
		"title":       "Join Google Meet to record and summarize",
	})
	if result != nil {
		t.Fatalf("normalizeRequest returned failure: %q", result.Text)
	}
	if req.Summary != req.Title {
		t.Fatalf("summary = %q, want title %q", req.Summary, req.Title)
	}
	if got := req.Params["meet_url"]; got != "https://meet.google.com/yuf-wnes-yqt" {
		t.Fatalf("meet_url = %#v, want inferred thread URL", got)
	}
}

func TestCueboardParitySuggestActionNormalizeJoinMeetingFailsWithoutMeetURL(t *testing.T) {
	tool := &slackSuggestActionTool{
		fetchThreadTranscript: func(context.Context, string, string) (string, error) {
			return `[ts:123.456] Peng: no meeting link here`, nil
		},
	}

	_, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeJoinMeeting,
		"title":       "Join Google Meet to record and summarize",
	})
	if result == nil || result.Success {
		t.Fatal("expected validation failure")
	}
	if !strings.Contains(result.Text, "join_meeting requires params.meet_url") {
		t.Fatalf("unexpected validation message: %q", result.Text)
	}
}

func TestCueboardParitySuggestActionNormalizeCreateIssueRequiresParams(t *testing.T) {
	tool := &slackSuggestActionTool{}

	_, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeCreateIssue,
		"title":       "Create Linear issue",
	})
	if result == nil || result.Success {
		t.Fatal("expected missing params validation failure")
	}
	if !strings.Contains(result.Text, "params is required") {
		t.Fatalf("unexpected validation message: %q", result.Text)
	}
}

func TestCueboardParitySuggestActionNormalizeRejectsUnknownActionType(t *testing.T) {
	tool := &slackSuggestActionTool{}

	_, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": "launch_missiles",
		"title":       "Definitely not supported",
		"params":      map[string]any{},
	})
	if result == nil || result.Success {
		t.Fatal("expected unsupported action_type validation failure")
	}
	if !strings.Contains(result.Text, `unsupported action_type "launch_missiles"`) {
		t.Fatalf("unexpected validation message: %q", result.Text)
	}
}

func TestCueboardParitySuggestActionNormalizeCreateIssueRejectsExplicitDirectAuthorization(t *testing.T) {
	tool := &slackSuggestActionTool{
		role:           slackSuggestRoleAssistant,
		latestUserText: "创建一个，这是新的 glass 实现引入的",
	}

	_, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeCreateIssue,
		"title":       "Create Linear issue",
		"params": map[string]any{
			"title": "Chat window header flickers during drag",
		},
	})
	if result == nil || result.Success {
		t.Fatal("expected direct-create gate to reject suggest_action")
	}
	if !strings.Contains(result.Text, "call linear_api issueCreate directly") {
		t.Fatalf("unexpected direct-create gate message: %q", result.Text)
	}
}
