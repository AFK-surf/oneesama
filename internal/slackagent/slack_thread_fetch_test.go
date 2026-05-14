package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackMentionThreadFetchUsesConversationsRepliesQuery(t *testing.T) {
	var gotMethod string
	var gotAuth string
	var gotQueryChannel string
	var gotQueryTS string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotAuth = r.Header.Get("Authorization")
		gotQueryChannel = r.URL.Query().Get("channel")
		gotQueryTS = r.URL.Query().Get("ts")
		if r.Header.Get("Content-Type") == "application/json; charset=utf-8" {
			t.Fatalf("Content-Type = %q, want Slack-compatible query request", r.Header.Get("Content-Type"))
		}
		_ = json.NewEncoder(w).Encode(slackRepliesResponse{
			OK: true,
			Messages: []SlackMessage{
				{TS: "123.000", User: "U1", Text: "parent"},
				{TS: "123.456", User: "U2", Text: "<@UBOT> summarize"},
			},
		})
	}))
	defer server.Close()

	oldBaseURL := slackThreadFetchAPIBaseURL
	slackThreadFetchAPIBaseURL = server.URL
	defer func() { slackThreadFetchAPIBaseURL = oldBaseURL }()

	service := NewService(Config{
		Slack: appconfig.SlackConfig{BotToken: "xoxb-test"},
	})
	messages, source, ok, fetchErr := service.fetchSlackMentionThreadMessages(context.Background(), SlackEventPayload{
		Channel:  "C123",
		TS:       "123.456",
		ThreadTS: "123.000",
		Text:     "<@UBOT> summarize",
	})
	if !ok || fetchErr != "" || source != "slack_web_api" {
		t.Fatalf("fetch ok=%v source=%q err=%q", ok, source, fetchErr)
	}
	if len(messages) != 2 || messages[0].Text != "parent" {
		t.Fatalf("messages = %#v, want fetched thread", messages)
	}
	if gotMethod != http.MethodGet || gotAuth != "Bearer xoxb-test" || gotQueryChannel != "C123" || gotQueryTS != "123.000" {
		t.Fatalf("method/auth/query = %q %q %q %q", gotMethod, gotAuth, gotQueryChannel, gotQueryTS)
	}
}
