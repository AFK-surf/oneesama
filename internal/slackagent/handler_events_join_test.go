package slackagent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleEventsJoinPostsMeetingOptionCard(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		t.Fatalf("meeting agent should not be called before join options are selected: %s", request.URL.Path)
	}))
	defer meetingAgent.Close()
	router := newTestRouter(t, Config{
		MeetingAgentURL:        meetingAgent.URL,
		DefaultCaptionLanguage: "English",
		Slack:                  appconfig.SlackConfig{SigningSecret: "secret", BotUserID: "UBOT"},
		Poster:                 poster,
		AgentRunner:            appconfig.AgentRunnerConfig{Provider: "codex", DryRun: true},
	})

	body := `{"type":"event_callback","event_id":"EvJoinCard","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> join <https://meet.google.com/abc-defg-hij> --dry-run false","channel":"C123","ts":"123.456"}}`
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
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 {
		t.Fatalf("poster calls = %d, want 1", len(calls))
	}
	if !strings.Contains(calls[0].Text, "Join Google Meet") {
		t.Fatalf("posted text = %q, want join setup fallback", calls[0].Text)
	}
	if len(calls[0].Blocks) != 3 {
		t.Fatalf("blocks = %#v, want join setup card", calls[0].Blocks)
	}
	rawBlocks, _ := json.Marshal(calls[0].Blocks)
	if !strings.Contains(string(rawBlocks), joinSetupCaptionActionID) || !strings.Contains(string(rawBlocks), joinSetupRealtimeActionID) {
		t.Fatalf("blocks = %s, want caption select and realtime button", string(rawBlocks))
	}
	if strings.Contains(string(rawBlocks), `"type":"input"`) ||
		strings.Contains(string(rawBlocks), "ASR") ||
		!strings.Contains(string(rawBlocks), `"style":"primary"`) ||
		!strings.Contains(string(rawBlocks), "transcript, audio, and Canvas notes") {
		t.Fatalf("blocks = %s, want compact cueboard-style action card", string(rawBlocks))
	}
}

func TestHandleEventsJoinPostsCardFromSlackLabeledMeetLink(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		t.Fatalf("meeting agent should not be called before join options are selected: %s", request.URL.Path)
	}))
	defer meetingAgent.Close()
	router := newTestRouter(t, Config{
		MeetingAgentURL:        meetingAgent.URL,
		DefaultCaptionLanguage: "English",
		Slack:                  appconfig.SlackConfig{SigningSecret: "secret", BotUserID: "UBOT"},
		Poster:                 poster,
		AgentRunner:            appconfig.AgentRunnerConfig{Provider: "codex", DryRun: true},
	})

	body := `{"type":"event_callback","event_id":"EvJoinCardLabeledLink","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> join <https://meet.google.com/abc-defg-hij|https://meet.google.com/abc-defg-hij>","channel":"C123","ts":"123.456"}}`
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
	poster.WaitForCalls(t, 1)
	if calls := poster.Calls(); len(calls) != 1 || !strings.Contains(calls[0].Text, "Join Google Meet") {
		t.Fatalf("poster calls = %#v, want one join setup card", calls)
	}
}

func TestHandleEventsJoinMentionDedupeAcrossAppMentionAndMessage(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		t.Fatalf("meeting agent should not be called before join options are selected: %s", request.URL.Path)
	}))
	defer meetingAgent.Close()
	router := newTestRouter(t, Config{
		MeetingAgentURL:        meetingAgent.URL,
		DefaultCaptionLanguage: "English",
		Slack:                  appconfig.SlackConfig{SigningSecret: "secret", BotUserID: "UBOT"},
		Poster:                 poster,
		AgentRunner:            appconfig.AgentRunnerConfig{Provider: "codex", DryRun: true},
	})

	send := func(body string) SlackEventResponse {
		t.Helper()
		timestamp, signature := signedSlackJSONBody("secret", body)
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/slack/events", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Slack-Request-Timestamp", timestamp)
		request.Header.Set("X-Slack-Signature", signature)
		router.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
		}
		var payload SlackEventResponse
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return payload
	}

	appMention := `{"type":"event_callback","event_id":"EvJoinCardAppMention","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> join https://meet.google.com/abc-defg-hij","channel":"C123","ts":"123.456"}}`
	messageMention := `{"type":"event_callback","event_id":"EvJoinCardMessageMention","team_id":"T123","event":{"type":"message","channel_type":"channel","user":"U123","text":"<@UBOT> join https://meet.google.com/abc-defg-hij","channel":"C123","ts":"123.456"}}`

	first := send(appMention)
	if !first.Handled || first.Mode != "app_mention" {
		t.Fatalf("first response = %#v, want app_mention handled", first)
	}
	second := send(messageMention)
	if !second.Ignored || second.Reason != "duplicate_mention_event" {
		t.Fatalf("second response = %#v, want duplicate mention ignored", second)
	}

	poster.WaitForCalls(t, 1)
	if calls := poster.Calls(); len(calls) != 1 {
		t.Fatalf("poster calls = %d, want one join card", len(calls))
	}
}
