package postmeeting

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWebhookSenderSendsSignedPayload(t *testing.T) {
	t.Parallel()

	var seenSignature string
	var seenEvent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenSignature = r.Header.Get("X-Webhook-Signature")
		seenEvent = r.Header.Get("X-Meeting-Avatar-Event")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	sender := NewWebhookSender(server.Client())
	result, err := sender.Send(context.Background(), DigestWebhookRequest{
		URL:    server.URL,
		Secret: "secret",
		Payload: map[string]any{
			"event": "meeting.digest",
			"text":  "hello",
		},
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if !result.OK || result.Attempts != 1 {
		t.Fatalf("result = %#v, want ok in one attempt", result)
	}
	if seenSignature == "" {
		t.Fatalf("seen signature empty")
	}
	if seenEvent != "meeting.digest" {
		t.Fatalf("seen event = %q, want meeting.digest", seenEvent)
	}
}

func TestWebhookSenderRetriesAfterFailure(t *testing.T) {
	t.Parallel()

	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			http.Error(w, "try again", http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	sender := NewWebhookSender(server.Client())
	result, err := sender.Send(context.Background(), DigestWebhookRequest{
		URL:          server.URL,
		Payload:      map[string]any{"event": "meeting.digest"},
		MaxAttempts:  2,
		RetryDelayMS: 1,
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if !result.OK || result.Attempts != 2 {
		t.Fatalf("result = %#v, want success after retry", result)
	}
}
