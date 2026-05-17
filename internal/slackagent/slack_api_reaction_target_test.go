package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSlackAPIToolAddReactionResolvesDigestMessageRef(t *testing.T) {
	t.Parallel()

	var gotChannel, gotTimestamp, gotName string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/reactions.add" {
			t.Fatalf("path = %q, want /reactions.add", r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		gotChannel = r.PostForm.Get("channel")
		gotTimestamp = r.PostForm.Get("timestamp")
		gotName = r.PostForm.Get("name")
		if err := json.NewEncoder(w).Encode(map[string]any{"ok": true}); err != nil {
			t.Fatalf("Encode: %v", err)
		}
	}))
	defer server.Close()

	targets, latest := slackAPIMessageTargetsFromArgs(map[string]any{
		"digest": strings.Join([]string{
			"=== Slack Activity ===",
			"",
			"#C123",
			`  • [ref:m1 msg_ts:1778765842.164299] <@U1>: "first"`,
			`  • [ref:m2 msg_ts:1778765843.164299] <@U2>: "second"`,
		}, "\n"),
	}, nil)
	tool := &slackAPITool{
		role:                  slackAPIRolePlanner,
		apiURL:                server.URL,
		token:                 "xoxb-test",
		messageTargets:        targets,
		latestTargetByChannel: latest,
	}

	result, err := tool.Execute(context.Background(), map[string]any{
		"action": "add_reaction",
		"params": map[string]any{
			"message_ref": "m2",
			"emoji":       ":eyes:",
		},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !result.Success {
		t.Fatalf("result = %#v, want success", result)
	}
	if gotChannel != "C123" || gotTimestamp != "1778765843.164299" || gotName != "eyes" {
		t.Fatalf("form channel=%q timestamp=%q name=%q", gotChannel, gotTimestamp, gotName)
	}
}

func TestSlackAPIToolAddReactionFallsBackToLatestDigestMessageForChannel(t *testing.T) {
	t.Parallel()

	var gotTimestamp string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		gotTimestamp = r.PostForm.Get("timestamp")
		if err := json.NewEncoder(w).Encode(map[string]any{"ok": true}); err != nil {
			t.Fatalf("Encode: %v", err)
		}
	}))
	defer server.Close()

	targets, latest := slackAPIMessageTargetsFromArgs(map[string]any{
		"digest": "#C123\n  • [ref:m1 msg_ts:1778765842.164299] <@U1>: \"first\"\n  • [ref:m2 msg_ts:1778765843.164299] <@U2>: \"second\"\n",
	}, nil)
	tool := &slackAPITool{
		role:                  slackAPIRolePlanner,
		apiURL:                server.URL,
		token:                 "xoxb-test",
		messageTargets:        targets,
		latestTargetByChannel: latest,
	}

	result, err := tool.Execute(context.Background(), map[string]any{
		"action": "add_reaction",
		"params": map[string]any{
			"channel":  "C123",
			"reaction": "white_check_mark",
		},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !result.Success {
		t.Fatalf("result = %#v, want success", result)
	}
	if gotTimestamp != "1778765843.164299" {
		t.Fatalf("timestamp = %q, want latest digest message", gotTimestamp)
	}
}

func TestSlackAPIToolAddReactionRejectsUnknownMessageRef(t *testing.T) {
	t.Parallel()

	tool := &slackAPITool{
		role:           slackAPIRolePlanner,
		messageTargets: map[string]slackAPIMessageTarget{"m1": {ChannelID: "C123", Timestamp: "1778765842.164299"}},
	}
	result, err := tool.Execute(context.Background(), map[string]any{
		"action": "add_reaction",
		"params": map[string]any{
			"message_ref": "m99",
			"name":        "eyes",
		},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if result.Success || !strings.Contains(result.Text, "Unknown message_ref") {
		t.Fatalf("result = %#v, want unknown message_ref failure", result)
	}
}
