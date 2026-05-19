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

// Canvas suggest_action parity — assistant is allowed to propose create_canvas
// and edit_canvas writes through a confirmation flow with strict validation.
// Direct slack_api(create_canvas / edit_canvas) is also active for old Agent D
// parity; these tests cover the consent-first suggest path.

func TestCueboardParitySuggestActionNormalizeCreateCanvasRequiresMarkdown(t *testing.T) {
	tool := &slackSuggestActionTool{}

	_, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeCreateCanvas,
		"title":       "Project canvas",
		"params": map[string]any{
			"canvas_title": "Project canvas",
		},
	})
	if result == nil || result.Success {
		t.Fatal("expected missing markdown to fail")
	}
	if !strings.Contains(result.Text, "create_canvas requires params.markdown") {
		t.Fatalf("unexpected validation message: %q", result.Text)
	}
}

func TestCueboardParitySuggestActionNormalizeCreateCanvasAcceptsTopLevelTitleAsCanvasTitle(t *testing.T) {
	tool := &slackSuggestActionTool{}

	req, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeCreateCanvas,
		"title":       "Project plan",
		"params": map[string]any{
			"markdown": "# Plan\n\nDraft.",
		},
	})
	if result != nil {
		t.Fatalf("normalizeRequest returned failure: %q", result.Text)
	}
	if req == nil {
		t.Fatal("expected request, got nil")
	}
	if got := strings.TrimSpace(stringFromAny(req.Params["markdown"])); got != "# Plan\n\nDraft." {
		t.Fatalf("markdown lost: %q", got)
	}
}

func TestCueboardParitySuggestActionNormalizeEditCanvasRequiresFileID(t *testing.T) {
	tool := &slackSuggestActionTool{}

	_, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeEditCanvas,
		"title":       "Edit project canvas",
		"params": map[string]any{
			"markdown": "Adding section.",
		},
	})
	if result == nil || result.Success {
		t.Fatal("expected edit_canvas without file_id to be rejected")
	}
	if !strings.Contains(result.Text, "edit_canvas requires params.file_id") {
		t.Fatalf("unexpected validation message: %q", result.Text)
	}
}

func TestCueboardParitySuggestActionNormalizeEditCanvasRequiresMarkdown(t *testing.T) {
	tool := &slackSuggestActionTool{}

	_, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeEditCanvas,
		"title":       "Edit project canvas",
		"params": map[string]any{
			"file_id": "F0123456",
		},
	})
	if result == nil || result.Success {
		t.Fatal("expected edit_canvas without markdown to be rejected")
	}
	if !strings.Contains(result.Text, "edit_canvas requires params.markdown") {
		t.Fatalf("unexpected validation message: %q", result.Text)
	}
}

func TestCueboardParitySuggestActionNormalizeEditCanvasRejectsUnknownOp(t *testing.T) {
	tool := &slackSuggestActionTool{}

	_, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeEditCanvas,
		"title":       "Edit project canvas",
		"params": map[string]any{
			"file_id":  "F0123456",
			"markdown": "Adding section.",
			"op":       "delete_everything",
		},
	})
	if result == nil || result.Success {
		t.Fatal("expected edit_canvas to reject unsupported op")
	}
	if !strings.Contains(result.Text, `edit_canvas op "delete_everything" is not allowed`) {
		t.Fatalf("unexpected validation message: %q", result.Text)
	}
}

func TestCueboardParitySuggestActionNormalizeEditCanvasDefaultsOpToInsertAtEnd(t *testing.T) {
	tool := &slackSuggestActionTool{}

	req, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeEditCanvas,
		"title":       "Edit project canvas",
		"params": map[string]any{
			"file_id":  "F0123456",
			"markdown": "Adding section.",
		},
	})
	if result != nil {
		t.Fatalf("normalizeRequest returned failure: %q", result.Text)
	}
	if req == nil {
		t.Fatal("expected request, got nil")
	}
	if got := stringFromAny(req.Params["op"]); got != "insert_at_end" {
		t.Fatalf("default op = %q, want insert_at_end", got)
	}
}

func TestCueboardParitySuggestActionNormalizeEditCanvasNormalizesOpCase(t *testing.T) {
	tool := &slackSuggestActionTool{}

	req, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeEditCanvas,
		"title":       "Edit project canvas",
		"params": map[string]any{
			"file_id":  "F0123456",
			"markdown": "Replacing canvas.",
			"op":       "Replace",
		},
	})
	if result != nil {
		t.Fatalf("normalizeRequest returned failure: %q", result.Text)
	}
	if req == nil {
		t.Fatal("expected request, got nil")
	}
	if got := stringFromAny(req.Params["op"]); got != "replace" {
		t.Fatalf("op = %q, want lowercased replace", got)
	}
}

func TestCueboardParitySuggestActionNormalizeEditCanvasAcceptsCanvasIDAlias(t *testing.T) {
	tool := &slackSuggestActionTool{}

	req, result := tool.normalizeRequest(context.Background(), map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeEditCanvas,
		"title":       "Edit project canvas",
		"params": map[string]any{
			"canvas_id": "F0123456",
			"markdown":  "Adding section.",
		},
	})
	if result != nil {
		t.Fatalf("normalizeRequest returned failure: %q", result.Text)
	}
	if req == nil {
		t.Fatal("expected request, got nil")
	}
	// canvas_id alias should be accepted but the executor reads
	// firstNonEmpty(file_id, fileId, canvas_id, canvasId) — the
	// normalize stage doesn't have to rewrite the key. Just confirm
	// the request was accepted; the executor test covers the alias
	// resolution.
}
