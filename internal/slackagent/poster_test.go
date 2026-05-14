package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestPosterReturnsMockMessageWithoutToken(t *testing.T) {
	poster := NewPoster(PosterConfig{})
	result := poster.PostMessage(context.Background(), PostMessageInput{
		Channel:  "C123",
		Text:     "hello",
		ThreadTS: "123.456",
	})

	if !result.OK || !result.Mock {
		t.Fatalf("PostMessage() = %#v, want mock success", result)
	}
	if result.ThreadTS != "123.456" {
		t.Fatalf("ThreadTS = %q, want %q", result.ThreadTS, "123.456")
	}
}

func TestPosterDedupsByKey(t *testing.T) {
	poster := NewPoster(PosterConfig{Mock: true, BotToken: "x"})

	first := poster.PostMessage(context.Background(), PostMessageInput{
		Channel:  "C123",
		Text:     "hello",
		DedupKey: "same",
	})
	second := poster.PostMessage(context.Background(), PostMessageInput{
		Channel:  "C123",
		Text:     "hello",
		DedupKey: "same",
	})

	if !second.Deduped || second.TS != first.TS {
		t.Fatalf("second result = %#v, want deduped copy of first %#v", second, first)
	}
}

func TestPosterRetriesThenSucceeds(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count := attempts.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if count == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "internal_error"})
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "ts": "123.456"})
	}))
	defer server.Close()

	poster := NewPoster(PosterConfig{
		BotToken:    "xoxb-test",
		Endpoint:    server.URL,
		Client:      server.Client(),
		MaxAttempts: 3,
		RetryDelay:  time.Millisecond,
	})

	result := poster.PostMessage(context.Background(), PostMessageInput{
		Channel: "C123",
		Text:    "hello",
	})
	if !result.OK || result.Attempts != 2 {
		t.Fatalf("PostMessage() = %#v, want success on second attempt", result)
	}
}

func TestPosterDoesNotRetryBadRequest(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "channel_not_found"})
	}))
	defer server.Close()

	poster := NewPoster(PosterConfig{
		BotToken:    "xoxb-test",
		Endpoint:    server.URL,
		Client:      server.Client(),
		MaxAttempts: 3,
		RetryDelay:  time.Millisecond,
	})

	result := poster.PostMessage(context.Background(), PostMessageInput{
		Channel: "C123",
		Text:    "hello",
	})
	if result.OK || result.Attempts != 1 || attempts.Load() != 1 {
		t.Fatalf("PostMessage() = %#v, attempts=%d; want one-shot failure", result, attempts.Load())
	}
}
