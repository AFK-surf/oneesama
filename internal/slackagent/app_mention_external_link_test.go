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

func TestSlackAppMentionContextHydratesLinkedSlackThreadCanvas(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/conversations.replies" {
			t.Fatalf("unexpected Slack API path %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("channel"); got != "C0AKGM5HCBA" {
			t.Fatalf("channel = %q, want linked thread channel", got)
		}
		if got := r.URL.Query().Get("ts"); got != "1779125153.086369" {
			t.Fatalf("ts = %q, want permalink root ts", got)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U1","text":"这里是 what's new 原讨论","ts":"1779125153.086369","files":[{"id":"F0B4GEERALD","title":"What's New 草稿","filetype":"quip","mimetype":"application/vnd.slack-docs","permalink":"https://cue-3kl2780.slack.com/docs/T/F0B4GEERALD"}]},{"type":"message","user":"U2","text":"第一版要写进 Canvas。","ts":"1779125200.000000","thread_ts":"1779125153.086369"}]}`))
	}))
	defer server.Close()

	oldBase := slackThreadFetchAPIBaseURL
	slackThreadFetchAPIBaseURL = server.URL
	defer func() { slackThreadFetchAPIBaseURL = oldBase }()

	service := NewService(Config{})
	service.botToken = "xoxb-test"
	context := service.buildSlackAppMentionContext(context.Background(), "W1", SlackEventPayload{
		Channel:  "C0ALMF2AD70",
		User:     "U123",
		TS:       "1779158086.310079",
		ThreadTS: "1779158086.310079",
		Text:     "<@UBOT> https://cue-3kl2780.slack.com/archives/C0AKGM5HCBA/p1779125153086369 给一版本 what's new，写 canvas 里",
		Replies: []SlackMessage{{
			Channel:  "C0ALMF2AD70",
			User:     "U123",
			TS:       "1779158086.310079",
			ThreadTS: "1779158086.310079",
			Text:     "<@UBOT> https://cue-3kl2780.slack.com/archives/C0AKGM5HCBA/p1779125153086369 给一版本 what's new，写 canvas 里",
		}},
	})

	if len(context.LinkedSlackThreads) != 1 {
		t.Fatalf("linked threads len = %d, want 1: %#v", len(context.LinkedSlackThreads), context.LinkedSlackThreads)
	}
	if len(context.CanvasFiles) != 1 || context.CanvasFiles[0].ID != "F0B4GEERALD" {
		t.Fatalf("canvas files = %#v, want linked canvas", context.CanvasFiles)
	}
	for _, want := range []string{
		"Linked Slack thread context:",
		"channel: C0AKGM5HCBA thread_ts: 1779125153.086369",
		"[canvas: \"What's New 草稿\" canvas_id=F0B4GEERALD]",
		"第一版要写进 Canvas。",
	} {
		if !strings.Contains(context.Prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, context.Prompt)
		}
	}
}

func TestParseSlackArchivePermalinkPrefersThreadTSQuery(t *testing.T) {
	ref, ok := parseSlackArchivePermalink("https://cue-3kl2780.slack.com/archives/C09KVPBMLJ3/p1779087000012769?thread_ts=1779086895.918119&cid=C09KVPBMLJ3")
	if !ok {
		t.Fatal("expected Slack archive permalink to parse")
	}
	if ref.ChannelID != "C09KVPBMLJ3" || ref.ThreadTS != "1779086895.918119" {
		t.Fatalf("ref = %#v, want channel root thread_ts from query", ref)
	}
}
