package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCanvasPublisherWritesFileManifest(t *testing.T) {
	publisher := mustCanvasPublisher(t, CanvasPublisherConfig{
		Provider: "file",
		OutDir:   t.TempDir(),
	})

	result := publishWithCanvasPublisher(t, publisher, CanvasPublishInput{
		Artifact: CanvasArtifact{
			ID:      "artifact_1",
			Title:   "Daily sync",
			MeetURL: "https://meet.google.com/example",
			Summary: &CanvasArtifactSummary{
				Highlights: []string{"Ship it"},
			},
		},
	})
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
	publisher := mustCanvasPublisher(t, CanvasPublisherConfig{
		Provider: "slack-thread",
		OutDir:   t.TempDir(),
		Poster:   NewPoster(PosterConfig{Mock: true, BotToken: "x"}),
	})

	result := publishWithCanvasPublisher(t, publisher, CanvasPublishInput{
		ArtifactID: "artifact_1",
		Title:      "Daily sync",
		Channel:    "C123",
		ThreadTS:   "123.456",
	})
	if !result.OK || result.Surface != "mock-slack-thread" || result.Slack == nil || !result.Slack.Mock {
		t.Fatalf("Publish() = %#v, want mock slack-thread manifest", result)
	}
}

func TestCanvasPublisherCreatesSlackCanvas(t *testing.T) {
	server := newCanvasSlackAPIServer(t, "T123", "canvas_123", false)

	publisher := mustCanvasPublisher(t, CanvasPublisherConfig{
		Provider:   "slack-canvas",
		OutDir:     t.TempDir(),
		BotToken:   "xoxb-test",
		APIBaseURL: server.URL,
		Client:     server.Client(),
	})

	result := publishWithCanvasPublisher(t, publisher, CanvasPublishInput{
		ArtifactID: "artifact_1",
		Title:      "Daily sync",
		Channel:    "C123",
	})
	if !result.OK || result.Canvas == nil || result.Canvas.CanvasID != "canvas_123" {
		t.Fatalf("Publish() = %#v, want slack canvas result", result)
	}
	if result.Canvas.Permalink != "https://app.slack.com/docs/T123/canvas_123" {
		t.Fatalf("canvas permalink = %q", result.Canvas.Permalink)
	}
}

func TestCanvasPublisherForcedSlackCanvasPostsThreadNotification(t *testing.T) {
	server := newCanvasSlackAPIServer(t, "T456", "canvas_456", true)

	publisher := mustCanvasPublisher(t, CanvasPublisherConfig{
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

	result := publishWithCanvasPublisher(t, publisher, CanvasPublishInput{
		ArtifactID:       "meeting_1",
		Title:            "Daily sync",
		SummaryMarkdown:  "**Duration:** 5 minutes\n",
		NotificationText: ":memo: *Meeting Summary: Daily sync* · 5 min\n{{canvas_link}}",
		Channel:          "C123",
		ThreadTS:         "123.456",
		DedupKey:         "dedupe-meeting-1",
		ForceSlackCanvas: true,
	})
	if !result.OK || result.Surface != "slack-canvas" || result.Canvas == nil || result.Slack == nil {
		t.Fatalf("Publish() = %#v, want native canvas plus thread post", result)
	}
	if server.postedThreadTS != "123.456" {
		t.Fatalf("posted thread_ts = %q", server.postedThreadTS)
	}
	if want := "<https://app.slack.com/docs/T456/canvas_456|View full notes>"; !strings.Contains(server.postedText, want) {
		t.Fatalf("posted text = %q, want canvas link %q", server.postedText, want)
	}
}

func TestServicePublishCanvasBlocksStaleThreadBeforeSlackNotification(t *testing.T) {
	snapshotTS, newerTS, restore := installNewerHumanReplyFixture(t, "帮忙整理成 canvas", "不用发了，我已经整理好了。")
	defer restore()

	service := newCanvasTestService(t, Config{
		Slack: appconfig.SlackConfig{
			BotToken:  "xoxb-test",
			BotUserID: "U_BOT",
		},
		CanvasPublisherConfig: CanvasPublisherConfig{
			Provider: "slack-thread",
			OutDir:   t.TempDir(),
			Poster:   NewPoster(PosterConfig{Mock: true, BotToken: "xoxb-test"}),
		},
	})
	result := publishCanvasForTest(t, service, testCanvasPublishInput(snapshotTS, ""))
	if !result.Blocked || result.BlockReason != "thread_has_newer_activity" || result.BlockedTS != newerTS {
		t.Fatalf("PublishCanvas() = %#v, want stale thread block", result)
	}
	if result.Slack != nil || result.Canvas != nil || result.OK {
		t.Fatalf("PublishCanvas() = %#v, want no Slack/canvas publication", result)
	}
}

func TestServicePublishCanvasRoutesSlackThreadThroughPublicReplyDelivery(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	publisher := &recordingCanvasPublisher{}
	service := newCanvasTestService(t, Config{
		Poster: poster,
		CanvasPublisherConfig: CanvasPublisherConfig{
			Provider: "slack-thread",
		},
		CanvasPublisher: publisher,
	})

	result := publishCanvasForTest(t, service, testCanvasPublishInput("", "canvas-dedup-1"))
	if !result.OK || result.Slack == nil || !result.Slack.OK {
		t.Fatalf("PublishCanvas() = %#v, want controlled Slack post", result)
	}
	inputs := publisher.Inputs()
	if len(inputs) != 1 || !inputs[0].SuppressSlackPost {
		t.Fatalf("publisher inputs = %#v, want raw Slack post suppressed", inputs)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "C123" || calls[0].ThreadTS != "1700000000.000001" || calls[0].DedupKey != "canvas-dedup-1" {
		t.Fatalf("poster calls = %#v, want public reply delivery post", calls)
	}
}

func TestServicePublishCanvasPersistsControlledSlackPostResult(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := newCanvasTestService(t, Config{
		Poster: poster,
		CanvasPublisherConfig: CanvasPublisherConfig{
			Provider: "slack-thread",
			OutDir:   t.TempDir(),
		},
	})

	result := publishCanvasForTest(t, service, testCanvasPublishInput("", "canvas-dedup-1"))
	if result.Slack == nil || !result.Slack.OK {
		t.Fatalf("PublishCanvas() = %#v, want controlled Slack result", result)
	}

	manifests, err := service.ListPublishedCanvas()
	if err != nil {
		t.Fatalf("ListPublishedCanvas() error = %v", err)
	}
	if len(manifests) != 1 {
		t.Fatalf("ListPublishedCanvas() = %#v, want one manifest", manifests)
	}
	if manifests[0].Slack == nil || !manifests[0].Slack.OK || manifests[0].Slack.DedupKey != "canvas-dedup-1" {
		t.Fatalf("persisted manifest = %#v, want final controlled Slack result", manifests[0])
	}
}

func TestServicePublishCanvasUsesExplicitCanvasPosterForControlledPost(t *testing.T) {
	var canvasPosterCalls atomic.Int32
	canvasPosterServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		canvasPosterCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"ts":"111.000001","message":{"thread_ts":"1700000000.000001"}}`))
	}))
	defer canvasPosterServer.Close()

	service := newCanvasTestService(t, Config{
		Poster: &recordingPoster{},
		CanvasPublisherConfig: CanvasPublisherConfig{
			Provider: "slack-thread",
			OutDir:   t.TempDir(),
			Poster: NewPoster(PosterConfig{
				BotToken: "xoxb-canvas",
				Endpoint: canvasPosterServer.URL,
				Client:   canvasPosterServer.Client(),
			}),
		},
	})

	result := publishCanvasForTest(t, service, testCanvasPublishInput("", "canvas-dedup-1"))
	if result.Slack == nil || !result.Slack.OK || result.Slack.TS != "111.000001" {
		t.Fatalf("PublishCanvas() = %#v, want explicit canvas poster result", result)
	}
	if got := canvasPosterCalls.Load(); got != 1 {
		t.Fatalf("canvas poster calls = %d, want 1", got)
	}
	if calls := service.poster.(*recordingPoster).Calls(); len(calls) != 0 {
		t.Fatalf("service poster calls = %#v, want none", calls)
	}
}

func testCanvasPublishInput(threadTS string, dedupKey string) CanvasPublishInput {
	if threadTS == "" {
		threadTS = "1700000000.000001"
	}
	return CanvasPublishInput{
		ArtifactID:      "artifact_1",
		Title:           "Daily sync",
		SummaryMarkdown: "# Daily sync\n",
		Channel:         "C123",
		ThreadTS:        threadTS,
		SnapshotTS:      threadTS,
		DedupKey:        dedupKey,
	}
}

func newCanvasTestService(t *testing.T, config Config) *Service {
	t.Helper()
	config.Persistence = appconfig.PersistenceConfig{Provider: "memory"}
	return NewService(config)
}

func publishCanvasForTest(t *testing.T, service *Service, input CanvasPublishInput) PublishedCanvasManifest {
	t.Helper()
	result, err := service.PublishCanvas(context.Background(), input)
	if err != nil {
		t.Fatalf("PublishCanvas() error = %v", err)
	}
	return result
}

func mustCanvasPublisher(t *testing.T, config CanvasPublisherConfig) *CanvasPublisher {
	t.Helper()
	publisher, err := NewCanvasPublisher(config)
	if err != nil {
		t.Fatalf("NewCanvasPublisher() error = %v", err)
	}
	return publisher
}

func publishWithCanvasPublisher(t *testing.T, publisher *CanvasPublisher, input CanvasPublishInput) PublishedCanvasManifest {
	t.Helper()
	result, err := publisher.Publish(context.Background(), input)
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	return result
}

type canvasSlackAPIServer struct {
	*httptest.Server
	postedText     string
	postedThreadTS string
}

func newCanvasSlackAPIServer(t *testing.T, teamID string, canvasID string, capturePost bool) *canvasSlackAPIServer {
	t.Helper()
	server := &canvasSlackAPIServer{}
	server.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth.test":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "team_id": teamID})
		case "/canvases.create":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "canvas_id": canvasID})
		case "/chat.postMessage":
			if !capturePost {
				t.Fatalf("unexpected path %q", r.URL.Path)
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode post body: %v", err)
			}
			server.postedText, _ = body["text"].(string)
			server.postedThreadTS, _ = body["thread_ts"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "ts": "111.222", "message": map[string]any{"thread_ts": server.postedThreadTS}})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestCanvasPublisherReadsSummaryMarkdownFile(t *testing.T) {
	tempDir := t.TempDir()
	summaryPath := filepath.Join(tempDir, "summary.md")
	if err := os.WriteFile(summaryPath, []byte("# summary\n"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	publisher := mustCanvasPublisher(t, CanvasPublisherConfig{
		Provider: "file",
		OutDir:   tempDir,
	})

	result := publishWithCanvasPublisher(t, publisher, CanvasPublishInput{
		ArtifactID:  "artifact_1",
		SummaryPath: summaryPath,
	})

	raw, err := os.ReadFile(result.MarkdownPath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(raw) != "# summary\n" {
		t.Fatalf("markdown = %q, want %q", string(raw), "# summary\n")
	}
}
