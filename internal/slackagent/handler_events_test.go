package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type recordingPoster struct {
	mu     sync.Mutex
	calls  []PostMessageInput
	delay  time.Duration
	callCh chan struct{}
}

func (p *recordingPoster) PostMessage(_ context.Context, input PostMessageInput) PostMessageResult {
	if p.delay > 0 {
		time.Sleep(p.delay)
	}
	p.mu.Lock()
	p.calls = append(p.calls, input)
	p.mu.Unlock()
	if p.callCh != nil {
		select {
		case p.callCh <- struct{}{}:
		default:
		}
	}
	return PostMessageResult{
		OK:       true,
		Mock:     true,
		Channel:  input.Channel,
		ThreadTS: input.ThreadTS,
		DedupKey: input.DedupKey,
		Attempts: 1,
		Body: &SlackPostMessageBody{
			OK: true,
			Message: &SlackPostMessageMeta{
				ThreadTS: input.ThreadTS,
			},
		},
	}
}

func (p *recordingPoster) WaitForCalls(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		got := len(p.calls)
		p.mu.Unlock()
		if got >= want {
			return
		}
		if p.callCh != nil {
			select {
			case <-p.callCh:
			case <-time.After(10 * time.Millisecond):
			}
			continue
		}
		time.Sleep(10 * time.Millisecond)
	}
	p.mu.Lock()
	got := len(p.calls)
	p.mu.Unlock()
	t.Fatalf("poster calls = %d, want >= %d", got, want)
}

func (p *recordingPoster) Calls() []PostMessageInput {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]PostMessageInput(nil), p.calls...)
}

func TestHandleEventsURLVerification(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{SigningSecret: "secret"},
	})

	body := `{"type":"url_verification","challenge":"challenge-123"}`
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"challenge":"challenge-123"`) {
		t.Fatalf("body = %s, want challenge", response.Body.String())
	}
}

func TestHandleEventsRetryIsIgnored(t *testing.T) {
	poster := &recordingPoster{}
	router := newTestRouter(t, Config{
		Slack:  appconfig.SlackConfig{SigningSecret: "secret"},
		Poster: poster,
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			DryRun:   true,
		},
	})

	body := `{"type":"event_callback","event_id":"EvRetry","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> help","channel":"C123","ts":"123.456"}}`
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	request.Header.Set("X-Slack-Retry-Num", "1")
	request.Header.Set("X-Slack-Retry-Reason", "http_timeout")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"reason":"retry_request"`) {
		t.Fatalf("body = %s, want retry_request", response.Body.String())
	}
	if len(poster.calls) != 0 {
		t.Fatalf("poster calls = %d, want 0", len(poster.calls))
	}
}

func TestHandleEventsAppMentionPostsAvatarResponse(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	router := newTestRouter(t, Config{
		Slack:  appconfig.SlackConfig{SigningSecret: "secret"},
		Poster: poster,
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			DryRun:   true,
		},
	})

	body := `{"type":"event_callback","event_id":"EvMention","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> help","channel":"C123","ts":"123.456"}}`
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}

	var payload SlackEventResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || !payload.Handled || payload.Mode != "app_mention" {
		t.Fatalf("payload = %#v, want handled app_mention", payload)
	}
	if payload.Posted == nil || !payload.Posted.Queued {
		t.Fatalf("payload.Posted = %#v, want queued dispatch", payload.Posted)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 {
		t.Fatalf("poster calls = %d, want 1", len(calls))
	}
	if calls[0].Channel != "C123" || calls[0].ThreadTS != "123.456" {
		t.Fatalf("post input = %#v, want channel/thread", calls[0])
	}
	if !strings.Contains(calls[0].Text, "Onee-sama commands:") {
		t.Fatalf("posted text = %q, want avatar help", calls[0].Text)
	}
}

func TestHandleEventsDedupesEventID(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	router := newTestRouter(t, Config{
		Slack:  appconfig.SlackConfig{SigningSecret: "secret"},
		Poster: poster,
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			DryRun:   true,
		},
	})

	body := `{"type":"event_callback","event_id":"EvDup","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> help","channel":"C123","ts":"123.456"}}`
	timestamp, signature := signedSlackJSONBody("secret", body)

	for attempt := 0; attempt < 2; attempt++ {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/slack/events", bytes.NewBufferString(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Slack-Request-Timestamp", timestamp)
		request.Header.Set("X-Slack-Signature", signature)
		router.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("attempt %d status = %d, want 200", attempt, response.Code)
		}
		if attempt == 1 && !strings.Contains(response.Body.String(), `"reason":"duplicate_event_id"`) {
			t.Fatalf("second body = %s, want duplicate_event_id", response.Body.String())
		}
	}

	poster.WaitForCalls(t, 1)
	if len(poster.Calls()) != 1 {
		t.Fatalf("poster calls = %d, want 1", len(poster.Calls()))
	}
}

func TestHandleEventsAssistantThreadStarted(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{SigningSecret: "secret"},
	})

	body := `{"type":"event_callback","event_id":"EvAssistant","team_id":"T123","event":{"type":"assistant_thread_started","channel":"C123","ts":"123.999","assistant_thread":{"channel_id":"C123","thread_ts":"123.999","user_id":"U123"}}}`
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"mode":"assistant_thread_started"`) {
		t.Fatalf("body = %s, want assistant_thread_started mode", response.Body.String())
	}
}

func TestHandleEventsReturnsBeforeSlowPosterCompletes(t *testing.T) {
	poster := &recordingPoster{
		delay:  200 * time.Millisecond,
		callCh: make(chan struct{}, 4),
	}
	router := newTestRouter(t, Config{
		Slack:  appconfig.SlackConfig{SigningSecret: "secret"},
		Poster: poster,
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			DryRun:   true,
		},
	})

	body := `{"type":"event_callback","event_id":"EvAsync","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> help","channel":"C123","ts":"123.456"}}`
	timestamp, signature := signedSlackJSONBody("secret", body)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)

	startedAt := time.Now()
	router.ServeHTTP(response, request)
	elapsed := time.Since(startedAt)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if elapsed >= poster.delay {
		t.Fatalf("elapsed = %s, want < %s to prove async ACK", elapsed, poster.delay)
	}
	poster.WaitForCalls(t, 1)
}

func signedSlackJSONBody(secret string, body string) (string, string) {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	return timestamp, SignSlackRequestBody(secret, timestamp, body)
}
