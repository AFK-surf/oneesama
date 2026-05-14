package slackagent

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleEventsBuffersChannelMessageWhenEnabled(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{
			SigningSecret: "secret",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
	})

	body := `{"type":"event_callback","event_id":"EvInbound","team_id":"T123","event":{"type":"message","channel_type":"channel","user":"U123","text":"ship the thing","channel":"C123","ts":"123.456"}}`
	response := signedSlackEventRequest(t, router, body)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}

	var payload SlackEventResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.Handled || payload.Mode != "event_buffer" || payload.Inbound == nil || !payload.Inbound.Buffered {
		t.Fatalf("payload = %#v, want buffered event", payload)
	}
	if payload.Inbound.Pending != 1 || payload.Inbound.ChannelID != "C123" {
		t.Fatalf("inbound = %#v, want pending C123", payload.Inbound)
	}

	status := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/slack/inbound/status", nil)
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(status, request)
	if status.Code != http.StatusOK {
		t.Fatalf("status route = %d, want 200", status.Code)
	}
	if !strings.Contains(status.Body.String(), `"pending":1`) {
		t.Fatalf("status body = %s, want pending message", status.Body.String())
	}
}

func TestHandleInboundFlushReturnsDigest(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			SigningSecret: "secret",
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
			Triage: appconfig.SlackTriageConfig{
				HeuristicFallback: true,
			},
		},
	})
	body := `{"type":"event_callback","event_id":"EvFlush","team_id":"T123","event":{"type":"message","channel_type":"channel","user":"U123","text":"need a digest","channel":"C123","ts":"123.456"}}`
	_ = signedSlackEventRequest(t, router, body)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/inbound/flush", strings.NewReader(`{"channel_id":"C123"}`))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("flush status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "=== Slack Activity ===") || !strings.Contains(response.Body.String(), "need a digest") {
		t.Fatalf("flush body = %s, want digest", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"status":"success"`) || !strings.Contains(response.Body.String(), `"slack-triage"`) {
		t.Fatalf("flush body = %s, want completed triage job", response.Body.String())
	}
}

func TestHandleScannerSweepFlushesFixtureMessages(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
	})

	body := `{"workspace_id":"T123","channels":[{"id":"C123","type":"channel","messages":[{"user":"U1","text":"first","ts":"2026-05-13T01:00:00Z"},{"user":"U2","text":"second","event_ts":"2026-05-13T01:00:01Z"}]}]}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/scanner/sweep", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("sweep status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"buffered":2`) || !strings.Contains(response.Body.String(), `"count":2`) {
		t.Fatalf("sweep body = %s, want buffered and flushed counts", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "first") || !strings.Contains(response.Body.String(), "second") {
		t.Fatalf("sweep body = %s, want fixture messages", response.Body.String())
	}

	retry := httptest.NewRecorder()
	retryRequest := httptest.NewRequest(http.MethodPost, "/slack/scanner/sweep", bytes.NewBufferString(body))
	retryRequest.Header.Set("Content-Type", "application/json")
	retryRequest.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(retry, retryRequest)
	if retry.Code != http.StatusOK {
		t.Fatalf("retry sweep status = %d, want 200: %s", retry.Code, retry.Body.String())
	}
	if !strings.Contains(retry.Body.String(), `"previousCursor":"2026-05-13T01:00:01Z"`) || !strings.Contains(retry.Body.String(), `"buffered":0`) {
		t.Fatalf("retry sweep body = %s, want cursor dedupe", retry.Body.String())
	}
}

func signedSlackEventRequest(t *testing.T, router http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)
	return response
}
