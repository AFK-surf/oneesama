package slackagent

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/internalauth"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestAvatarCommandUsageMatchesLegacySurface(t *testing.T) {
	want := strings.Join([]string{
		"Onee-sama commands:",
		"join <meet-url> [--bot-name name] [--dry-run false]",
		"status [session-id]",
		"stop [session-id] [--reason text]",
		"help",
		"Or just mention me with what you need.",
	}, "\n")
	if got := avatarCommandUsage(); got != want {
		t.Fatalf("usage = %q, want %q", got, want)
	}

	parsed := parseAvatarCommand("")
	if parsed.Action != "help" {
		t.Fatalf("empty command action = %q, want help", parsed.Action)
	}
}

func TestParseJoinDefaultsToRealJoin(t *testing.T) {
	parsed := parseAvatarCommand("join https://meet.google.com/abc-defg-hij")
	if parsed.DryRunJoiner {
		t.Fatalf("DryRunJoiner = true, want default real join")
	}
	if parsed := parseAvatarCommand("join https://meet.google.com/abc-defg-hij --dry-run"); !parsed.DryRunJoiner {
		t.Fatalf("DryRunJoiner = false, want explicit dry-run")
	}
	if parsed := parseAvatarCommand("join https://meet.google.com/abc-defg-hij --dry-run=false"); parsed.DryRunJoiner {
		t.Fatalf("DryRunJoiner = true, want explicit false to keep real join")
	}
	if parsed := parseAvatarCommand("join https://meet.google.com/abc-defg-hij --dry-run --real"); parsed.DryRunJoiner {
		t.Fatalf("DryRunJoiner = true, want --real to restore real join")
	}
}

func TestParseJoinUnwrapsSlackMeetLinks(t *testing.T) {
	cases := []string{
		"join <https://meet.google.com/abc-defg-hij>",
		"join <https://meet.google.com/abc-defg-hij|https://meet.google.com/abc-defg-hij>",
		"join --meet-url <https://meet.google.com/abc-defg-hij>",
		"join --meet-url=<https://meet.google.com/abc-defg-hij|Join Meet>",
	}
	for _, input := range cases {
		t.Run(input, func(t *testing.T) {
			parsed := parseAvatarCommand(input)
			if parsed.MeetURL != "https://meet.google.com/abc-defg-hij" || !parsed.ValidMeetURL {
				t.Fatalf("parseAvatarCommand(%q) = meetURL %q valid=%v, want unwrapped valid Meet URL", input, parsed.MeetURL, parsed.ValidMeetURL)
			}
		})
	}
}

func TestHandleAvatarCommandJoinCallsMeetingAgent(t *testing.T) {
	meetURL := "https://meet.google.com/abc-defg-hij?authuser=0"
	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/join/google-meet" {
			t.Fatalf("path = %s, want /join/google-meet", request.URL.Path)
		}
		if request.Header.Get(internalauth.HeaderName) != "secret-key" {
			t.Fatalf("internal auth header = %q, want secret-key", request.Header.Get(internalauth.HeaderName))
		}
		var body meetingAgentJoinRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body.MeetingURL != meetURL || body.DisplayName != "Onee-sama" {
			t.Fatalf("join body = %#v, want meeting url and bot name", body)
		}
		if body.DryRun || !body.InstallRealtimeBridge || !body.InstallWorkerResultBridge {
			t.Fatalf("join flags = %#v, want real join with active meeting bridges by default", body)
		}
		if body.RealtimeBridgeMode != "webrtc" || !body.AutoConnectRealtime ||
			!body.SendRealtimeSessionUpdate || !body.IncludeParticipantAudio || !body.ForwardMeetAudioToRealtime {
			t.Fatalf("realtime connect fields = %#v, want active meeting bridge", body)
		}
		if body.CaptureCaptions || body.CaptionLanguage != "English" {
			t.Fatalf("caption flags = %#v, want Realtime join to keep live persona on pure audio", body)
		}
		if !body.RecordMeeting {
			t.Fatalf("record_meeting = false, want ordinary join to record audio artifact")
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"ok":true,"accepted":true,"started":true,"session":{"id":"session_live","meeting_url":"` + meetURL + `","status":"joined"}}`))
	}))
	defer meetingAgent.Close()

	assistant := &recordingAssistant{}
	router := newTestRouter(t, Config{
		MeetingAgentURL:        meetingAgent.URL,
		DefaultCaptionLanguage: "English",
		Assistant:              assistant,
		Slack: appconfig.SlackConfig{
			SigningSecret:   "secret",
			InternalAuthKey: "secret-key",
		},
	})
	payload := signAvatarCommand(t, "secret", url.Values{
		"text":       {`join ` + meetURL + ` --bot-name Onee-sama --dry-run false`},
		"channel_id": {"C123"},
		"thread_ts":  {"123.456"},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/commands/avatar", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	bodyText := response.Body.String()
	if !strings.Contains(bodyText, ":studio_microphone: *Joined: Google Meet*") ||
		!strings.Contains(bodyText, "Recording — summary will be posted when the meeting ends.") ||
		strings.Contains(bodyText, "Session session_live created") {
		t.Fatalf("body = %s, want cueboard-style joined response without visible session id", bodyText)
	}
	assertStatusCalls(t, assistant.Calls(), []string{"Recording meeting..."})
}

func TestHandleAvatarCommandStopCallsMeetingAgent(t *testing.T) {
	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/join/stop" {
			t.Fatalf("path = %s, want /join/stop", request.URL.Path)
		}
		var body meetingAgentStopRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body.SessionID != "session_live" || body.Reason != "manual-check" {
			t.Fatalf("stop body = %#v, want session and reason", body)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"ok":true,"stopped":true,"session":{"id":"session_live","status":"stopped"}}`))
	}))
	defer meetingAgent.Close()

	router := newTestRouter(t, Config{
		MeetingAgentURL: meetingAgent.URL,
		Slack: appconfig.SlackConfig{
			SigningSecret:   "secret",
			InternalAuthKey: "secret-key",
		},
	})
	payload := signAvatarCommand(t, "secret", url.Values{
		"text": {`stop session_live --reason manual-check`},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/commands/avatar", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), "Stop requested for session_live.") {
		t.Fatalf("body = %s, want legacy stop response", response.Body.String())
	}
}
