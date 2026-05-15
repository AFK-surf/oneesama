package slackagent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSlackAppMentionContextFetchesExternalLinksBeforeAgentReply(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("Title: X post from steipete\n\nMarkdown Content:\nPeter asks whether agents can fetch Twitter content by themselves."))
	}))
	defer server.Close()

	oldClient := slackExternalLinkHTTPClient
	oldReaderURL := slackExternalLinkReaderURL
	slackExternalLinkHTTPClient = server.Client()
	slackExternalLinkReaderURL = func(rawURL string) string { return server.URL + "/reader" }
	defer func() {
		slackExternalLinkHTTPClient = oldClient
		slackExternalLinkReaderURL = oldReaderURL
	}()

	service := NewService(Config{})
	context := service.buildSlackAppMentionContext(context.Background(), "W1", SlackEventPayload{
		Channel: "C123",
		User:    "U1",
		TS:      "1778767510.917049",
		Text:    "<@UBOT> https://x.com/steipete/status/2054850632067019173 这个怎么看",
		Replies: []SlackMessage{{
			Channel: "C123",
			User:    "U1",
			TS:      "1778767510.917049",
			Text:    "<@UBOT> https://x.com/steipete/status/2054850632067019173 这个怎么看",
		}},
	})

	if len(context.ExternalLinks) != 1 {
		t.Fatalf("external links len = %d, want 1: %#v", len(context.ExternalLinks), context.ExternalLinks)
	}
	for _, want := range []string{
		"Fetched external link context:",
		"https://x.com/steipete/status/2054850632067019173",
		"title: X post from steipete",
		"Peter asks whether agents can fetch Twitter content by themselves.",
	} {
		if !strings.Contains(context.Prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, context.Prompt)
		}
	}
	if strings.Contains(context.Prompt, "是否读取") {
		t.Fatalf("mention prompt should fetch/read links directly, not ask for permission:\n%s", context.Prompt)
	}
}
