package slackagent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/persona"
)

func TestSanitizeSlackVisibleTextRemovesPersonaMarkers(t *testing.T) {
	input := "[[REACT]]👀[[/REACT]] 第一段[[MSG_BREAK]]第二段[[MSGBREAK]]第三段[[WORLD_BRIEF]]internal only[[/WORLD_BRIEF]]"
	got := sanitizeSlackVisibleText(input)
	if strings.Contains(got, "MSG_BREAK") || strings.Contains(got, "MSGBREAK") || strings.Contains(got, "WORLD_BRIEF") || strings.Contains(got, "internal only") {
		t.Fatalf("sanitized text leaked persona marker/content: %q", got)
	}
	if !strings.Contains(got, "👀") || !strings.Contains(got, "第一段\n\n第二段\n\n第三段") {
		t.Fatalf("sanitized text = %q, want reaction and paragraph breaks", got)
	}
}

func TestPosterSanitizesVisibleTextAndBlocks(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &captured); err != nil {
			t.Fatalf("decode request: %v\n%s", err, string(raw))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "ts": "123.456"})
	}))
	defer server.Close()

	poster := NewPoster(PosterConfig{BotToken: "xoxb-test", Endpoint: server.URL, Client: server.Client()})
	result := poster.PostMessage(context.Background(), PostMessageInput{
		Channel: "C123",
		Text:    "one[[MSG_BREAK]]two",
		Blocks: []map[string]any{{
			"type": "section",
			"text": map[string]any{"type": "mrkdwn", "text": "alpha[[MSG_BREAK]]beta"},
		}},
	})
	if !result.OK {
		t.Fatalf("PostMessage = %#v, want ok", result)
	}
	if got := stringFromAny(captured["text"]); got != "one\n\ntwo" {
		t.Fatalf("payload text = %q, want sanitized paragraph break", got)
	}
	encoded, _ := json.Marshal(captured["blocks"])
	if strings.Contains(string(encoded), "MSG_BREAK") || !strings.Contains(string(encoded), `alpha\n\nbeta`) {
		t.Fatalf("payload blocks not sanitized: %s", string(encoded))
	}
}

func TestPosterRendersBareSlackIDsAsMentions(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &captured); err != nil {
			t.Fatalf("decode request: %v\n%s", err, string(raw))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "ts": "123.456"})
	}))
	defer server.Close()

	poster := NewPoster(PosterConfig{BotToken: "xoxb-test", Endpoint: server.URL, Client: server.Client()})
	result := poster.PostMessage(context.Background(), PostMessageInput{
		Channel: "C123",
		Text:    "请 @U09KNU8QD1V 看 #2035，不要改已有 <@U09KY0GE28K>。",
		Blocks: []map[string]any{{
			"type": "section",
			"text": map[string]any{"type": "mrkdwn", "text": "同步到 @C09KVPBMLJ3 和 @G09ABCDEF12"},
		}},
	})
	if !result.OK {
		t.Fatalf("PostMessage = %#v, want ok", result)
	}
	if got := stringFromAny(captured["text"]); got != "请 <@U09KNU8QD1V> 看 #2035，不要改已有 <@U09KY0GE28K>。" {
		t.Fatalf("payload text = %q, want Slack mention rendering", got)
	}
	encoded, _ := json.Marshal(captured["blocks"])
	if got := string(encoded); !strings.Contains(got, `#C09KVPBMLJ3`) || !strings.Contains(got, `#G09ABCDEF12`) || strings.Contains(got, `@C09KVPBMLJ3`) {
		t.Fatalf("payload blocks did not render channel mentions: %s", got)
	}
}

func TestSlackAPIToolPostMessageSanitizesVisibleMarkers(t *testing.T) {
	var captured url.Values
	transport := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(req.Body)
		values, err := url.ParseQuery(string(raw))
		if err != nil {
			t.Fatalf("parse form: %v", err)
		}
		captured = values
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader(`{"ok":true,"ts":"1.000001"}`)),
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Request:    req,
		}, nil
	})

	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
	}
	result, err := tool.actionPostMessage(context.Background(), map[string]any{
		"channel": "C123",
		"text":    "one[[MSG_BREAK]]two",
		"blocks": []any{
			map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn", "text": "alpha[[MSG_BREAK]]beta"}},
		},
	})
	if err != nil {
		t.Fatalf("actionPostMessage: %v", err)
	}
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	if got := captured.Get("text"); got != "one\n\ntwo" {
		t.Fatalf("form text = %q, want sanitized paragraph break", got)
	}
	blocks := captured.Get("blocks")
	if strings.Contains(blocks, "MSG_BREAK") || !strings.Contains(blocks, `alpha\n\nbeta`) {
		t.Fatalf("form blocks not sanitized: %s", blocks)
	}
}

func TestPersonaShadowSanitizesVisibleMarkers(t *testing.T) {
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "one[[MSG_BREAK]]two",
		Reason:      "because[[MSGBREAK]]why",
	}}
	result := callPersonaShadow(context.Background(), runtime, "triage", persona.Request{
		ID: "req1",
		Anchor: persona.Anchor{
			ChannelID: "C123",
			ThreadTS:  "123.456",
		},
	})
	if result.VisibleText != "one\n\ntwo" || result.Reason != "because\n\nwhy" {
		t.Fatalf("persona result = %#v, want sanitized visible text and reason", result)
	}
}
