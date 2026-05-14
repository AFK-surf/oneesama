package slackagent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestHandleInteractionRunsAvatarCommand(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{SigningSecret: "secret"},
	})

	payload := signAvatarCommand(t, "secret", url.Values{
		"payload": {`{"team":{"id":"T123"},"channel":{"id":"C123"},"user":{"id":"U123","username":"peng"},"message":{"thread_ts":"123.456"},"actions":[{"value":"help"}]}`},
	})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/interactions", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), "Onee-sama commands:") {
		t.Fatalf("body = %s, want avatar help", response.Body.String())
	}
}

func TestHandleInteractionSupportsActionAliasAndEmbeddedJSON(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{SigningSecret: "secret"},
	})

	payload := signAvatarCommand(t, "secret", url.Values{
		"payload": {`{"team_id":"T123","channel_id":"C123","user_id":"U123","message":{"ts":"123.789"},"actions":[{"value":"{\"commandText\":\"status\"}"}]}`},
	})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/actions", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"response_type":"ephemeral"`) {
		t.Fatalf("body = %s, want avatar response", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"service":"slack-agent"`) {
		t.Fatalf("body = %s, want status metadata", response.Body.String())
	}
}

func TestHandleInteractionJoinSetupCallsMeetingAgentWithSelectedOptions(t *testing.T) {
	meetURL := "https://meet.google.com/abc-defg-hij"
	joinRequestCh := make(chan meetingAgentJoinRequest, 1)
	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/join/google-meet" {
			t.Fatalf("path = %s, want /join/google-meet", request.URL.Path)
		}
		var body meetingAgentJoinRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		joinRequestCh <- body
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"ok":true,"accepted":true,"started":true,"session":{"id":"session_realtime","meeting_url":"` + meetURL + `","status":"joined"}}`))
	}))
	defer meetingAgent.Close()
	finalResponseCh := make(chan string, 1)
	responseURLServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		raw, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read response url body: %v", err)
		}
		finalResponseCh <- string(raw)
		response.WriteHeader(http.StatusOK)
	}))
	defer responseURLServer.Close()
	assistant := &recordingAssistant{}
	router := newTestRouter(t, Config{
		MeetingAgentURL: meetingAgent.URL,
		Assistant:       assistant,
		Slack: appconfig.SlackConfig{
			SigningSecret:   "secret",
			InternalAuthKey: "secret-key",
		},
	})

	buttonValue := joinSetupActionValueJSON(joinSetupActionValue{
		Kind:        joinSetupKind,
		MeetingURL:  meetURL,
		DryRun:      false,
		Realtime:    true,
		ConfirmJoin: true,
	})
	rawPayload := fmt.Sprintf(`{
		"team":{"id":"T123"},
		"channel":{"id":"C123"},
		"user":{"id":"U123","username":"peng"},
		"message":{"thread_ts":"123.456"},
		"response_url":%q,
		"actions":[{"action_id":%q,"value":%q}],
		"state":{"values":{%q:{%q:{"selected_option":{"value":"Chinese (Simplified)"}}}}}
	}`, responseURLServer.URL, joinSetupRealtimeActionID, buttonValue, joinSetupCaptionBlockID, joinSetupCaptionActionID)
	payload := signAvatarCommand(t, "secret", url.Values{"payload": {rawPayload}})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/interactions", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"replace_original":true`) ||
		!strings.Contains(response.Body.String(), "Bot is joining *Google Meet*") ||
		!strings.Contains(response.Body.String(), ":hourglass_flowing_sand: *Joining Google Meet*") ||
		strings.Contains(response.Body.String(), "Joining "+meetURL) {
		t.Fatalf("body = %s, want compact immediate card replacement", response.Body.String())
	}

	var body meetingAgentJoinRequest
	select {
	case body = <-joinRequestCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for meeting-agent join request")
	}
	if body.MeetingURL != meetURL || body.DryRun {
		t.Fatalf("join body = %#v, want real join for meet url", body)
	}
	if !body.CaptureCaptions || body.CaptionLanguage != "Chinese (Simplified)" {
		t.Fatalf("caption flags = %#v, want capture in selected language", body)
	}
	if !body.RecordMeeting {
		t.Fatalf("record_meeting = false, want ordinary join to record audio artifact")
	}
	if !body.InstallRealtimeBridge || !body.InstallWorkerResultBridge {
		t.Fatalf("realtime flags = %#v, want realtime bridge pair", body)
	}
	if body.RealtimeBridgeMode != "webrtc" || !body.AutoConnectRealtime ||
		!body.SendRealtimeSessionUpdate || !body.ForwardMeetAudioToRealtime {
		t.Fatalf("realtime connect fields = %#v, want live OpenAI Realtime bridge", body)
	}

	select {
	case finalBody := <-finalResponseCh:
		if !strings.Contains(finalBody, `"replace_original":true`) ||
			!strings.Contains(finalBody, ":studio_microphone: *Joined: Google Meet*") ||
			!strings.Contains(finalBody, "Recording — summary will be posted when the meeting ends.") ||
			strings.Contains(finalBody, "Session session_realtime created") {
			t.Fatalf("final body = %s, want cueboard-style joined replacement without visible session id", finalBody)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for response_url update")
	}
	assertStatusCalls(t, assistant.Calls(), []string{"Recording meeting..."})
}

func TestHandleInteractionJoinSetupFailureKeepsMetadataNilSafe(t *testing.T) {
	meetURL := "https://meet.google.com/abc-defg-hij"
	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/join/google-meet" {
			t.Fatalf("path = %s, want /join/google-meet", request.URL.Path)
		}
		http.Error(response, "join worker timed out", http.StatusInternalServerError)
	}))
	defer meetingAgent.Close()
	finalResponseCh := make(chan string, 1)
	responseURLServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		raw, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read response url body: %v", err)
		}
		finalResponseCh <- string(raw)
		response.WriteHeader(http.StatusOK)
	}))
	defer responseURLServer.Close()
	router := newTestRouter(t, Config{
		MeetingAgentURL: meetingAgent.URL,
		Slack: appconfig.SlackConfig{
			SigningSecret:   "secret",
			InternalAuthKey: "secret-key",
		},
	})

	buttonValue := joinSetupActionValueJSON(joinSetupActionValue{
		Kind:        joinSetupKind,
		MeetingURL:  meetURL,
		DryRun:      false,
		Realtime:    false,
		ConfirmJoin: true,
	})
	rawPayload := fmt.Sprintf(`{
		"team":{"id":"T123"},
		"channel":{"id":"C123"},
		"user":{"id":"U123","username":"peng"},
		"message":{"thread_ts":"123.456"},
		"response_url":%q,
		"actions":[{"action_id":%q,"value":%q}]
	}`, responseURLServer.URL, joinSetupPlainActionID, buttonValue)
	payload := signAvatarCommand(t, "secret", url.Values{"payload": {rawPayload}})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/interactions", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}

	select {
	case finalBody := <-finalResponseCh:
		if !strings.Contains(finalBody, `"replace_original":true`) ||
			!strings.Contains(finalBody, "Join failed: meeting-agent /join/google-meet returned 500: join worker timed out") ||
			!strings.Contains(finalBody, `"join_setup"`) {
			t.Fatalf("final body = %s, want failed replacement with join_setup metadata", finalBody)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for response_url failure update")
	}
}

func TestHandleInteractionRejectsInvalidPayload(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{SigningSecret: "secret"},
	})

	payload := signAvatarCommand(t, "secret", url.Values{
		"payload": {"{not-json"},
	})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/interactions", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
	if !strings.Contains(response.Body.String(), "Invalid Slack interaction payload.") {
		t.Fatalf("body = %s, want invalid payload message", response.Body.String())
	}
}

func TestHandleInteractionReturnsEmptyActionMessage(t *testing.T) {
	router := newTestRouter(t, Config{
		Slack: appconfig.SlackConfig{SigningSecret: "secret"},
	})

	payload := signAvatarCommand(t, "secret", url.Values{
		"payload": {`{"team_id":"T123","channel_id":"C123","user_id":"U123","actions":[{"value":""}]}`},
	})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/interactions", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if !strings.Contains(response.Body.String(), "Action received. This interactive control has no meeting-avatar command attached yet.") {
		t.Fatalf("body = %s, want empty action guidance", response.Body.String())
	}
}

func TestHandleInteractionUpdatesPendingTriageAction(t *testing.T) {
	router := newTestRouter(t, Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			SigningSecret: "secret",
			Triage: appconfig.SlackTriageConfig{
				PostActions:       false,
				HeuristicFallback: true,
			},
		},
		Runner: &fakeRunner{job: agentrunner.Job{
			ID:       "job_triage_interaction",
			Provider: "codex",
			Status:   agentrunner.StatusCompleted,
			Result:   `{"summary":"owner follow-up needed","actions":[{"type":"follow_up","title":"Follow up with owner","message":"请确认 owner 并跟进。","confidence":0.82,"requiresConfirmation":true}]}`,
		}},
	})

	triageResponse := httptest.NewRecorder()
	triageRequest := httptest.NewRequest(http.MethodPost, "/slack/triage/run", strings.NewReader(`{"team_id":"T123","channel_id":"C123","user_id":"U123","text":"please follow up with owner","ts":"123.456"}`))
	triageRequest.Header.Set("Content-Type", "application/json")
	triageRequest.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(triageResponse, triageRequest)
	if triageResponse.Code != http.StatusOK {
		t.Fatalf("triage status = %d, want 200: %s", triageResponse.Code, triageResponse.Body.String())
	}
	var triageBody struct {
		Triage SlackTriageStartResult `json:"triage"`
	}
	if err := json.Unmarshal(triageResponse.Body.Bytes(), &triageBody); err != nil {
		t.Fatalf("decode triage: %v", err)
	}
	if triageBody.Triage.Finalization == nil || len(triageBody.Triage.Finalization.PendingActions) != 1 {
		t.Fatalf("triage = %#v, want pending action", triageBody.Triage)
	}
	pendingID := triageBody.Triage.Finalization.PendingActions[0].PendingAction.ID

	payload := signAvatarCommand(t, "secret", url.Values{
		"payload": {`{"team_id":"T123","channel_id":"C123","user_id":"U123","actions":[{"block_id":"mab_pending_action:` + strconv.FormatInt(pendingID, 10) + `","action_id":"mab_pending_action_confirm","value":"{\"kind\":\"mab_pending_action\",\"id\":` + strconv.FormatInt(pendingID, 10) + `,\"status\":\"confirmed\"}"}]}`},
	})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/slack/interactions", bytes.NewBufferString(payload.body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("X-Slack-Request-Timestamp", payload.timestamp)
	request.Header.Set("X-Slack-Signature", payload.signature)
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "marked confirmed") || !strings.Contains(response.Body.String(), `"status":"confirmed"`) {
		t.Fatalf("body = %s, want pending action confirmed", response.Body.String())
	}
}
