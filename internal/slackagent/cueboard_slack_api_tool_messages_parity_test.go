//go:build cueboardparity

package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCueboardParitySlackAPIToolPostThreadReplyGuidesAssistantToChatPostMessage(t *testing.T) {
	tool := &slackAPITool{role: slackAPIRoleAssistant}

	result, err := tool.Execute(context.Background(), map[string]any{
		"method": "slack.postThreadReply",
		"params": map[string]any{
			"channel":   "C123",
			"thread_ts": "1774519200.123456",
			"text":      "hello",
		},
	})
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if result.Success {
		t.Fatal("assistant post_thread_reply should be rejected")
	}
	got := result.GetTextOutput()
	if !strings.Contains(got, "chat.postMessage") || !strings.Contains(got, "Retry NOW") {
		t.Fatalf("expected corrective chat.postMessage guidance, got %q", got)
	}
}

func TestCueboardParitySlackAPIToolPostMessageAllowsAssistantChannelPostsWithoutThread(t *testing.T) {
	var gotChannel, gotThreadTS, gotText string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		gotChannel = r.PostForm.Get("channel")
		gotThreadTS = r.PostForm.Get("thread_ts")
		gotText = r.PostForm.Get("text")
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"channel": "C123",
			"ts":      "1774520000.000001",
			"message": map[string]any{"text": gotText},
		}); err != nil {
			t.Fatalf("Encode: %v", err)
		}
	}))
	defer server.Close()

	tool := &slackAPITool{
		role:   slackAPIRoleAssistant,
		apiURL: server.URL,
		token:  "test-token",
	}

	result, err := tool.Execute(context.Background(), map[string]any{
		"method": "chat.postMessage",
		"params": map[string]any{
			"channel": "C123",
			"text":    "scheduled diary ready",
		},
	})
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if !result.Success {
		t.Fatalf("expected success, got %q", result.GetTextOutput())
	}
	if gotChannel != "C123" {
		t.Fatalf("channel = %q, want C123", gotChannel)
	}
	if gotThreadTS != "" {
		t.Fatalf("thread_ts = %q, want empty for channel post", gotThreadTS)
	}
	if gotText != "scheduled diary ready" {
		t.Fatalf("text = %q, want scheduled diary ready", gotText)
	}
}
