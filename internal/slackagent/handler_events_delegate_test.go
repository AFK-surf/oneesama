package slackagent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleEventsSuppressesRunningDelegateAck(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	router := newTestRouter(t, Config{
		Slack:  appconfig.SlackConfig{SigningSecret: "secret"},
		Poster: poster,
		Runner: &fakeRunner{
			job: agentrunner.Job{
				ID:       "job_running_123",
				Provider: "codex",
				Status:   agentrunner.StatusRunning,
				Task:     "summarize this",
			},
		},
	})

	response := postSignedEvent(t, router, "secret", `{"type":"event_callback","event_id":"EvDelegateRunning","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> summarize this","channel":"C123","ts":"123.456"}}`)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var payload SlackEventResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || !payload.Handled {
		t.Fatalf("payload = %#v, want handled ok response", payload)
	}
	if payload.Response == nil || !strings.Contains(payload.Response.Text, "我来处理") {
		t.Fatalf("payload.Response = %#v, want internal worker metadata preserved without exposing delegate", payload.Response)
	}
	if payload.Posted != nil {
		t.Fatalf("payload.Posted = %#v, want nil for running delegate ack suppression", payload.Posted)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want 0", got)
	}
}

func TestHandleEventsPostsFailedDelegateFallback(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	router := newTestRouter(t, Config{
		Slack:  appconfig.SlackConfig{SigningSecret: "secret"},
		Poster: poster,
		Runner: &fakeRunner{
			job: agentrunner.Job{
				ID:       "job_failed_123",
				Provider: "codex",
				Status:   agentrunner.StatusFailed,
				Task:     "summarize this",
			},
		},
	})

	response := postSignedEvent(t, router, "secret", `{"type":"event_callback","event_id":"EvDelegateFailed","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> summarize this","channel":"C123","ts":"123.456"}}`)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 {
		t.Fatalf("poster calls = %d, want 1", len(calls))
	}
	if calls[0].Text != slackImmediateWorkerFailureText {
		t.Fatalf("posted text = %q, want TS failed-job fallback", calls[0].Text)
	}
}

func postSignedEvent(t *testing.T, router http.Handler, secret string, body string) *httptest.ResponseRecorder {
	t.Helper()

	timestamp, signature := signedSlackJSONBody(secret, body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)
	return response
}
