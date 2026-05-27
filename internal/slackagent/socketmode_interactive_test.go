package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSocketModeInteractiveJoinSetupUsesSharedInteractionPath(t *testing.T) {
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
		_, _ = response.Write([]byte(`{"ok":true,"accepted":true,"started":true,"session":{"id":"session_socket_realtime","meeting_url":"` + meetURL + `","status":"joined"}}`))
	}))
	defer meetingAgent.Close()

	finalResponseCh := make(chan string, 1)
	responseURLServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		raw, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read response_url body: %v", err)
		}
		finalResponseCh <- string(raw)
		response.WriteHeader(http.StatusOK)
	}))
	defer responseURLServer.Close()

	assistant := &recordingAssistant{}
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	service := NewService(Config{
		MeetingAgentURL: meetingAgent.URL,
		Assistant:       assistant,
		Poster:          poster,
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
		},
	})
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  service,
		AppToken: "app-token",
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
		"state":{"values":{%q:{%q:{"selected_option":{"value":"Japanese"}}}}}
	}`, responseURLServer.URL, joinSetupRealtimeActionID, buttonValue, joinSetupCaptionBlockID, joinSetupCaptionActionID)

	var ackPayload any
	err := runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
		Type:       "interactive",
		EnvelopeID: "EnInteractiveJoin",
		Payload:    []byte(rawPayload),
	}, func(payload any) error {
		ackPayload = payload
		return nil
	})
	if err != nil {
		t.Fatalf("handle envelope: %v", err)
	}

	rawAck, err := json.Marshal(ackPayload)
	if err != nil {
		t.Fatalf("marshal ack payload: %v", err)
	}
	if !strings.Contains(string(rawAck), `"replace_original":true`) ||
		!strings.Contains(string(rawAck), "Bot is joining *Google Meet*") ||
		!strings.Contains(string(rawAck), "*Joining Google Meet*") {
		t.Fatalf("ack payload = %s, want compact card replacement", string(rawAck))
	}
	if got := runner.Snapshot().InteractionsHandled; got != 1 {
		t.Fatalf("interactions handled = %d, want 1", got)
	}

	select {
	case immediateBody := <-finalResponseCh:
		if !strings.Contains(immediateBody, `"replace_original":true`) ||
			!strings.Contains(immediateBody, "Bot is joining *Google Meet*") ||
			!strings.Contains(immediateBody, "*Joining Google Meet*") ||
			strings.Contains(immediateBody, `"response_type":"ephemeral"`) ||
			strings.Contains(immediateBody, "Joining "+meetURL) {
			t.Fatalf("immediate body = %s, want compact response_url card replacement", immediateBody)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for immediate response_url update")
	}

	var body meetingAgentJoinRequest
	select {
	case body = <-joinRequestCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for meeting-agent join request")
	}
	if body.MeetingURL != meetURL || body.DryRun {
		t.Fatalf("join body = %#v, want real join", body)
	}
	if !body.CaptureCaptions || body.CaptionLanguage != "Japanese" {
		t.Fatalf("caption flags = %#v, want Realtime join to keep caption fallback available", body)
	}
	if !body.InstallRealtimeBridge || !body.InstallWorkerResultBridge {
		t.Fatalf("realtime flags = %#v, want realtime bridge pair", body)
	}
	if body.RealtimeBridgeMode != "webrtc" || !body.AutoConnectRealtime ||
		!body.SendRealtimeSessionUpdate || !body.IncludeParticipantAudio || !body.ForwardMeetAudioToRealtime {
		t.Fatalf("realtime connect fields = %#v, want live OpenAI Realtime bridge", body)
	}

	select {
	case finalBody := <-finalResponseCh:
		if !strings.Contains(finalBody, `"replace_original":true`) ||
			!strings.Contains(finalBody, ":studio_microphone: *Joined: Google Meet*") ||
			!strings.Contains(finalBody, "Recording — summary will be posted when the meeting ends.") ||
			strings.Contains(finalBody, `"response_type":"ephemeral"`) ||
			strings.Contains(finalBody, "Session session_socket_realtime created") {
			t.Fatalf("final body = %s, want cueboard-style response_url final replacement without visible session id", finalBody)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for response_url update")
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("extra thread posts = %#v, want joined only through response_url card update", calls)
	}
	assertStatusCalls(t, assistant.Calls(), []string{"Recording meeting..."})
}

func TestSocketModeInteractiveCaptionSelectUpdatesCardAckFirst(t *testing.T) {
	meetURL := "https://meet.google.com/abc-defg-hij"
	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		t.Fatalf("meeting agent should not be called by caption selection: %s", request.URL.Path)
	}))
	defer meetingAgent.Close()

	responseURLCh := make(chan string, 1)
	responseURLServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		raw, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read response_url body: %v", err)
		}
		responseURLCh <- string(raw)
		response.WriteHeader(http.StatusOK)
	}))
	defer responseURLServer.Close()

	service := NewService(Config{
		MeetingAgentURL: meetingAgent.URL,
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
		},
	})
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  service,
		AppToken: "app-token",
	})
	blocks, err := json.Marshal(buildJoinSetupBlocks(
		parsedAvatarCommand{MeetURL: meetURL, ValidMeetURL: true},
		"English",
		joinSetupCardContext{
			CardID:    "join-card:C123:123.456:https___meet.google.com_abc-defg-hij",
			ChannelID: "C123",
			ThreadTS:  "123.456",
			MessageTS: "123.456",
		},
	))
	if err != nil {
		t.Fatalf("marshal blocks: %v", err)
	}
	rawPayload := fmt.Sprintf(`{
		"team":{"id":"T123"},
		"channel":{"id":"C123"},
		"user":{"id":"U123","username":"peng"},
		"message":{"ts":"123.789","thread_ts":"123.456","blocks":%s},
		"response_url":%q,
		"actions":[{"action_id":%q,"selected_option":{"value":"Chinese (Simplified)"}}]
	}`, string(blocks), responseURLServer.URL, joinSetupCaptionActionID)

	var ackPayload any
	err = runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
		Type:       "interactive",
		EnvelopeID: "EnInteractiveCaptionSelect",
		Payload:    []byte(rawPayload),
	}, func(payload any) error {
		ackPayload = payload
		return nil
	})
	if err != nil {
		t.Fatalf("handle envelope: %v", err)
	}
	if ackPayload != nil {
		t.Fatalf("ack payload = %#v, want nil socket envelope ack", ackPayload)
	}

	select {
	case body := <-responseURLCh:
		if !strings.Contains(body, `"replace_original":true`) ||
			!strings.Contains(body, "Chinese (Simplified)") ||
			strings.Contains(body, "Action received.") ||
			strings.Contains(body, ":closed_caption:") ||
			strings.Contains(body, ":page_facing_up:") {
			t.Fatalf("response_url body = %s, want caption card update without raw emoji codes", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for caption selection response_url update")
	}
}

func TestSocketModeInteractivePendingThreadReplyUpdatesCardViaResponseURL(t *testing.T) {
	responseURLCh := make(chan string, 1)
	responseURLServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		raw, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read response_url body: %v", err)
		}
		responseURLCh <- string(raw)
		response.WriteHeader(http.StatusOK)
	}))
	defer responseURLServer.Close()

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
		},
	})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeThreadReply,
		Params: map[string]any{
			"title":   "Review triage reply",
			"message": "这条回复需要 Peng confirm 后才发。",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  service,
		AppToken: "app-token",
	})
	rawPayload := fmt.Sprintf(`{
		"team":{"id":"T123"},
		"channel":{"id":"D_PENG"},
		"user":{"id":"U_PENG","username":"peng"},
		"message":{"ts":"177.000","thread_ts":"177.000"},
		"response_url":%q,
		"actions":[{"block_id":"mab_pending_action:%d","action_id":"mab_pending_action_confirm","value":"{\"kind\":\"mab_pending_action\",\"id\":%d,\"status\":\"confirmed\",\"channelId\":\"C123\",\"threadTs\":\"123.456\"}"}]
	}`, responseURLServer.URL, record.ID, record.ID)

	var ackPayload any
	err = runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
		Type:       "interactive",
		EnvelopeID: "EnInteractivePendingReply",
		Payload:    []byte(rawPayload),
	}, func(payload any) error {
		ackPayload = payload
		return nil
	})
	if err != nil {
		t.Fatalf("handle envelope: %v", err)
	}
	if ackPayload != nil {
		t.Fatalf("ack payload = %#v, want nil socket envelope ack", ackPayload)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "C123" || calls[0].ThreadTS != "123.456" || !strings.Contains(calls[0].Text, "Peng confirm") {
		t.Fatalf("poster calls = %#v, want original thread reply", calls)
	}
	select {
	case body := <-responseURLCh:
		for _, want := range []string{`"replace_original":true`, "已发送", "原 thread"} {
			if !strings.Contains(body, want) {
				t.Fatalf("response_url body = %s, missing %q", body, want)
			}
		}
		for _, unwanted := range []string{"Triage suggestion", "post_thread_reply", "Persona"} {
			if strings.Contains(body, unwanted) {
				t.Fatalf("response_url body = %s, unexpectedly contains %q", body, unwanted)
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for pending action response_url update")
	}
}

func TestSocketModeInteractiveJoinSetupAcksBeforeResponseURLUpdate(t *testing.T) {
	meetURL := "https://meet.google.com/abc-defg-hij"
	releaseResponseURL := make(chan struct{})
	responseURLHit := make(chan struct{}, 1)
	responseURLServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		select {
		case responseURLHit <- struct{}{}:
		default:
		}
		<-releaseResponseURL
		response.WriteHeader(http.StatusOK)
	}))
	defer responseURLServer.Close()
	defer close(releaseResponseURL)

	meetingAgent := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"ok":true,"accepted":true,"started":true,"session":{"id":"session_socket_ack","meeting_url":"` + meetURL + `","status":"joined"}}`))
	}))
	defer meetingAgent.Close()

	service := NewService(Config{
		MeetingAgentURL: meetingAgent.URL,
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
		},
	})
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  service,
		AppToken: "app-token",
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

	ackCh := make(chan any, 1)
	done := make(chan error, 1)
	go func() {
		done <- runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
			Type:       "interactive",
			EnvelopeID: "EnInteractiveJoinAckFirst",
			Payload:    []byte(rawPayload),
		}, func(payload any) error {
			ackCh <- payload
			return nil
		})
	}()

	select {
	case payload := <-ackCh:
		rawAck, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal ack payload: %v", err)
		}
		if !strings.Contains(string(rawAck), `"replace_original":true`) ||
			!strings.Contains(string(rawAck), "Bot is joining *Google Meet*") ||
			!strings.Contains(string(rawAck), "*Joining Google Meet*") {
			t.Fatalf("ack payload = %s, want compact card replacement", string(rawAck))
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("timed out waiting for socket ack before response_url update completed")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("handle envelope: %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("socket handler did not return after ack")
	}
	select {
	case <-responseURLHit:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async response_url update to start")
	}
}

func TestSocketModeInteractiveJoinSetupFallsBackToMessageBlockValue(t *testing.T) {
	meetURL := "https://meet.google.com/czf-aaws-fgv"
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
		_, _ = response.Write([]byte(`{"ok":true,"accepted":true,"started":true,"session":{"id":"session_socket_realtime","meeting_url":"` + meetURL + `","status":"joined"}}`))
	}))
	defer meetingAgent.Close()

	responseURLServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusOK)
	}))
	defer responseURLServer.Close()

	service := NewService(Config{
		MeetingAgentURL: meetingAgent.URL,
		Slack: appconfig.SlackConfig{
			InternalAuthKey: "secret-key",
		},
	})
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  service,
		AppToken: "app-token",
	})
	blocks, err := json.Marshal(buildJoinSetupBlocks(
		parsedAvatarCommand{MeetURL: meetURL, ValidMeetURL: true},
		"English",
		joinSetupCardContext{
			CardID:    "join-card:C0ALMF2AD70:1778943765.480529:https___meet.google.com_czf-aaws-fgv",
			ChannelID: "C0ALMF2AD70",
			ThreadTS:  "1778943765.480529",
			MessageTS: "1778943765.480529",
		},
	))
	if err != nil {
		t.Fatalf("marshal blocks: %v", err)
	}
	rawPayload := fmt.Sprintf(`{
		"team":{"id":"T123"},
		"channel":{"id":"C0ALMF2AD70"},
		"user":{"id":"U123","username":"peng"},
		"message":{"ts":"1778943770.350779","thread_ts":"1778943765.480529","blocks":%s},
		"response_url":%q,
		"actions":[{"action_id":%q,"value":""}]
	}`, string(blocks), responseURLServer.URL, joinSetupRealtimeActionID)

	var ackPayload any
	err = runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
		Type:       "interactive",
		EnvelopeID: "EnInteractiveJoinMissingValue",
		Payload:    []byte(rawPayload),
	}, func(payload any) error {
		ackPayload = payload
		return nil
	})
	if err != nil {
		t.Fatalf("handle envelope: %v", err)
	}
	rawAck, err := json.Marshal(ackPayload)
	if err != nil {
		t.Fatalf("marshal ack payload: %v", err)
	}
	if !strings.Contains(string(rawAck), `"replace_original":true`) ||
		!strings.Contains(string(rawAck), "Bot is joining *Google Meet*") ||
		!strings.Contains(string(rawAck), "*Joining Google Meet*") {
		t.Fatalf("ack payload = %s, want compact card replacement", string(rawAck))
	}

	select {
	case body := <-joinRequestCh:
		if body.MeetingURL != meetURL || !body.InstallRealtimeBridge || !body.AutoConnectRealtime {
			t.Fatalf("join body = %#v, want realtime join from message block fallback", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for meeting-agent join request")
	}
}

func TestSocketModeInteractiveInvalidPayloadAcksEphemeralError(t *testing.T) {
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  NewService(Config{}),
		AppToken: "app-token",
	})

	var ackPayload any
	err := runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
		Type:       "interactive",
		EnvelopeID: "EnInteractiveBad",
		Payload:    []byte("{"),
	}, func(payload any) error {
		ackPayload = payload
		return nil
	})
	if err != nil {
		t.Fatalf("handle envelope: %v", err)
	}

	response, ok := ackPayload.(AvatarCommandResponse)
	if !ok {
		t.Fatalf("ack payload = %#v, want AvatarCommandResponse", ackPayload)
	}
	if response.OK || !strings.Contains(response.Text, "Invalid socket mode interaction payload.") {
		t.Fatalf("response = %#v, want invalid payload error", response)
	}
	if got := runner.Snapshot().InteractionsHandled; got != 1 {
		t.Fatalf("interactions handled = %d, want 1", got)
	}
}
