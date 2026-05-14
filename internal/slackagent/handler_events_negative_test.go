package slackagent

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleEventsRejectsInvalidSignature(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{SigningSecret: "secret"},
	})

	body := `{"type":"event_callback","event_id":"EvBadSig","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> help","channel":"C123","ts":"123.456"}}`
	timestamp, _ := signedSlackJSONBody("secret", body)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", "v0=bad")
	router.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	if !strings.Contains(response.Body.String(), "signature_mismatch") {
		t.Fatalf("body = %s, want signature mismatch reason", response.Body.String())
	}
}

func TestHandleEventsIgnoresUnsupportedMessageChannelType(t *testing.T) {
	poster := &recordingPoster{}
	router := newTestRouter(t, Config{
		Slack:  appconfig.SlackConfig{SigningSecret: "secret"},
		Poster: poster,
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			DryRun:   true,
		},
	})

	body := `{"type":"event_callback","event_id":"EvChannel","team_id":"T123","event":{"type":"message","user":"U123","text":"delegate summarize this","channel":"C123","channel_type":"channel","ts":"123.456"}}`
	timestamp, signature := signedSlackJSONBody("secret", body)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"reason":"unsupported_message_channel_type"`) {
		t.Fatalf("body = %s, want unsupported_message_channel_type", response.Body.String())
	}
	if len(poster.Calls()) != 0 {
		t.Fatalf("poster calls = %d, want 0", len(poster.Calls()))
	}
}

func TestHandleEventsIgnoresBotSubtype(t *testing.T) {
	poster := &recordingPoster{}
	router := newTestRouter(t, Config{
		Slack:  appconfig.SlackConfig{SigningSecret: "secret"},
		Poster: poster,
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			DryRun:   true,
		},
	})

	body := `{"type":"event_callback","event_id":"EvBot","team_id":"T123","event":{"type":"app_mention","user":"U123","bot_id":"B123","text":"<@UBOT> help","channel":"C123","ts":"123.456"}}`
	timestamp, signature := signedSlackJSONBody("secret", body)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/events", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Slack-Request-Timestamp", timestamp)
	request.Header.Set("X-Slack-Signature", signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"reason":"bot_or_subtype"`) {
		t.Fatalf("body = %s, want bot_or_subtype", response.Body.String())
	}
	if len(poster.Calls()) != 0 {
		t.Fatalf("poster calls = %d, want 0", len(poster.Calls()))
	}
}
