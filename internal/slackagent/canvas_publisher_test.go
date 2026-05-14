package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCanvasPublisherWritesFileManifest(t *testing.T) {
	publisher, err := NewCanvasPublisher(CanvasPublisherConfig{
		Provider: "file",
		OutDir:   t.TempDir(),
	})
	if err != nil {
		t.Fatalf("NewCanvasPublisher() error = %v", err)
	}

	result, err := publisher.Publish(context.Background(), CanvasPublishInput{
		Artifact: CanvasArtifact{
			ID:      "artifact_1",
			Title:   "Daily sync",
			MeetURL: "https://meet.google.com/example",
			Summary: &CanvasArtifactSummary{
				Highlights: []string{"Ship it"},
			},
		},
	})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	if !result.OK || result.Surface != "file" {
		t.Fatalf("Publish() = %#v, want file manifest", result)
	}
	if _, err := os.Stat(result.MarkdownPath); err != nil {
		t.Fatalf("Stat(markdown) error = %v", err)
	}

	manifests, err := publisher.ListPublished()
	if err != nil {
		t.Fatalf("ListPublished() error = %v", err)
	}
	if len(manifests) != 1 || manifests[0].ID != result.ID {
		t.Fatalf("ListPublished() = %#v, want %#v", manifests, result)
	}
}

func TestCanvasPublisherUsesPosterForSlackThread(t *testing.T) {
	publisher, err := NewCanvasPublisher(CanvasPublisherConfig{
		Provider: "slack-thread",
		OutDir:   t.TempDir(),
		Poster:   NewPoster(PosterConfig{Mock: true, BotToken: "x"}),
	})
	if err != nil {
		t.Fatalf("NewCanvasPublisher() error = %v", err)
	}

	result, err := publisher.Publish(context.Background(), CanvasPublishInput{
		ArtifactID: "artifact_1",
		Title:      "Daily sync",
		Channel:    "C123",
		ThreadTS:   "123.456",
	})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	if !result.OK || result.Surface != "mock-slack-thread" || result.Slack == nil || !result.Slack.Mock {
		t.Fatalf("Publish() = %#v, want mock slack-thread manifest", result)
	}
}

func TestCanvasPublisherCreatesSlackCanvas(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/auth.test" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":      true,
				"team_id": "T123",
			})
			return
		}
		if r.URL.Path != "/canvases.create" {
			t.Fatalf("path = %q, want /canvases.create", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":        true,
			"canvas_id": "canvas_123",
		})
	}))
	defer server.Close()

	publisher, err := NewCanvasPublisher(CanvasPublisherConfig{
		Provider:   "slack-canvas",
		OutDir:     t.TempDir(),
		BotToken:   "xoxb-test",
		APIBaseURL: server.URL,
		Client:     server.Client(),
	})
	if err != nil {
		t.Fatalf("NewCanvasPublisher() error = %v", err)
	}

	result, err := publisher.Publish(context.Background(), CanvasPublishInput{
		ArtifactID: "artifact_1",
		Title:      "Daily sync",
		Channel:    "C123",
	})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	if !result.OK || result.Canvas == nil || result.Canvas.CanvasID != "canvas_123" {
		t.Fatalf("Publish() = %#v, want slack canvas result", result)
	}
	if result.Canvas.Permalink != "https://app.slack.com/docs/T123/canvas_123" {
		t.Fatalf("canvas permalink = %q", result.Canvas.Permalink)
	}
}

func TestCanvasPublisherForcedSlackCanvasPostsThreadNotification(t *testing.T) {
	var postedText string
	var postedThreadTS string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/canvases.create":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "canvas_id": "canvas_456"})
		case "/auth.test":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "team_id": "T456"})
		case "/chat.postMessage":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode post body: %v", err)
			}
			postedText, _ = body["text"].(string)
			postedThreadTS, _ = body["thread_ts"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "ts": "111.222", "message": map[string]any{"thread_ts": postedThreadTS}})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer server.Close()

	publisher, err := NewCanvasPublisher(CanvasPublisherConfig{
		Provider:   "file",
		OutDir:     t.TempDir(),
		BotToken:   "xoxb-test",
		APIBaseURL: server.URL,
		Client:     server.Client(),
		Poster: NewPoster(PosterConfig{
			BotToken: "xoxb-test",
			Endpoint: server.URL + "/chat.postMessage",
			Client:   server.Client(),
		}),
	})
	if err != nil {
		t.Fatalf("NewCanvasPublisher() error = %v", err)
	}

	result, err := publisher.Publish(context.Background(), CanvasPublishInput{
		ArtifactID:       "meeting_1",
		Title:            "Daily sync",
		SummaryMarkdown:  "**Duration:** 5 minutes\n",
		NotificationText: ":memo: *Meeting Summary: Daily sync* · 5 min\n{{canvas_link}}",
		Channel:          "C123",
		ThreadTS:         "123.456",
		DedupKey:         "dedupe-meeting-1",
		ForceSlackCanvas: true,
	})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	if !result.OK || result.Surface != "slack-canvas" || result.Canvas == nil || result.Slack == nil {
		t.Fatalf("Publish() = %#v, want native canvas plus thread post", result)
	}
	if postedThreadTS != "123.456" {
		t.Fatalf("posted thread_ts = %q", postedThreadTS)
	}
	if want := "<https://app.slack.com/docs/T456/canvas_456|View full notes>"; !strings.Contains(postedText, want) {
		t.Fatalf("posted text = %q, want canvas link %q", postedText, want)
	}
}

func TestCanvasPublisherReadsSummaryMarkdownFile(t *testing.T) {
	tempDir := t.TempDir()
	summaryPath := filepath.Join(tempDir, "summary.md")
	if err := os.WriteFile(summaryPath, []byte("# summary\n"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	publisher, err := NewCanvasPublisher(CanvasPublisherConfig{
		Provider: "file",
		OutDir:   tempDir,
	})
	if err != nil {
		t.Fatalf("NewCanvasPublisher() error = %v", err)
	}

	result, err := publisher.Publish(context.Background(), CanvasPublishInput{
		ArtifactID:  "artifact_1",
		SummaryPath: summaryPath,
	})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	raw, err := os.ReadFile(result.MarkdownPath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(raw) != "# summary\n" {
		t.Fatalf("markdown = %q, want %q", string(raw), "# summary\n")
	}
}
