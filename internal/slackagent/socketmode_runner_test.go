package slackagent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	"github.com/gorilla/websocket"
)

func TestSocketModeHandleSlashCommandAcksAvatarResponse(t *testing.T) {
	service := NewService(Config{})
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  service,
		AppToken: "app-token",
	})

	payload, err := json.Marshal(SlackSocketSlashCommand{
		Text:      "help",
		TeamID:    "T123",
		ChannelID: "C123",
		ThreadTS:  "123.456",
		UserID:    "U123",
		UserName:  "peng",
	})
	if err != nil {
		t.Fatalf("marshal slash command: %v", err)
	}

	var ackPayload any
	err = runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
		Type:       "slash_commands",
		EnvelopeID: "EnSlash",
		Payload:    payload,
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
	if !response.OK || !strings.Contains(response.Text, "Onee-sama commands:") {
		t.Fatalf("response = %#v, want avatar help", response)
	}
	if got := runner.Snapshot().SlashCommandsHandled; got != 1 {
		t.Fatalf("slash commands handled = %d, want 1", got)
	}
}

func TestSocketModeServeOnceDispatchesEventsAPI(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 4)}
	service := NewService(Config{
		Slack:  appconfig.SlackConfig{AppToken: "app-token"},
		Poster: poster,
		AgentRunner: appconfig.AgentRunnerConfig{
			Provider: "codex",
			DryRun:   true,
		},
	})

	upgrader := websocket.Upgrader{}
	ackCh := make(chan SlackSocketAck, 1)
	var socketURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/apps.connections.open":
			if got := r.Header.Get("Authorization"); got != "Bearer app-token" {
				t.Fatalf("authorization = %q, want bearer app-token", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"url":"` + socketURL + `"}`))
		case "/socket":
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				t.Fatalf("upgrade websocket: %v", err)
			}
			defer func() { _ = conn.Close() }()

			if err := conn.WriteJSON(SlackSocketEnvelope{Type: "hello"}); err != nil {
				t.Fatalf("write hello: %v", err)
			}
			if err := conn.WriteJSON(SlackSocketEnvelope{
				Type:       "events_api",
				EnvelopeID: "EnEvent",
				Payload:    []byte(`{"type":"event_callback","event_id":"EvSocket","team_id":"T123","event":{"type":"app_mention","user":"U123","text":"<@UBOT> help","channel":"C123","ts":"123.456"}}`),
			}); err != nil {
				t.Fatalf("write events_api: %v", err)
			}

			var ack SlackSocketAck
			if err := conn.ReadJSON(&ack); err != nil {
				t.Fatalf("read ack: %v", err)
			}
			ackCh <- ack
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	socketURL = "ws" + strings.TrimPrefix(server.URL, "http") + "/socket"

	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service: service,
		OpenClient: &SlackSocketModeClient{
			appToken: "app-token",
			openURL:  server.URL + "/api/apps.connections.open",
			client:   server.Client(),
		},
		Dialer: websocket.DefaultDialer,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() {
		_ = runner.serveOnce(ctx)
		close(done)
	}()

	select {
	case ack := <-ackCh:
		if ack.EnvelopeID != "EnEvent" {
			t.Fatalf("ack envelope_id = %q, want EnEvent", ack.EnvelopeID)
		}
		if ack.Payload != nil {
			t.Fatalf("ack payload = %#v, want nil for events_api", ack.Payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for socket ack")
	}

	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 {
		t.Fatalf("poster calls = %d, want 1", len(calls))
	}
	if calls[0].Channel != "C123" || !strings.Contains(calls[0].Text, "Onee-sama commands:") {
		t.Fatalf("post input = %#v, want app mention help reply", calls[0])
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for serveOnce to exit")
	}
}

func TestSocketModeEventsAPIBuffersPlainChannelMessages(t *testing.T) {
	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			EventBuffer: appconfig.SlackEventBufferConfig{
				Enabled:  true,
				Triage:   true,
				MaxBatch: 10,
				Debounce: time.Minute,
			},
		},
	})
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  service,
		AppToken: "app-token",
	})

	acked := false
	err := runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
		Type:       "events_api",
		EnvelopeID: "EnMessage",
		Payload:    []byte(`{"type":"event_callback","event_id":"EvPlainMessage","team_id":"T123","event":{"type":"message","channel_type":"channel","user":"U123","text":"please triage me","channel":"C123","ts":"123.456"}}`),
	}, func(payload any) error {
		acked = true
		if payload != nil {
			t.Fatalf("ack payload = %#v, want nil", payload)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("handle envelope: %v", err)
	}
	if !acked {
		t.Fatal("events_api envelope was not acknowledged")
	}
	status := service.InboundStatus().EventBuffer
	if status.BufferedMessages != 1 || status.Channels["C123"].Pending != 1 {
		t.Fatalf("inbound status = %#v, want plain channel message buffered", status)
	}
	if got := runner.Snapshot().EventsHandled; got != 1 {
		t.Fatalf("events handled = %d, want 1", got)
	}
}

func TestSocketModeReconnectDelayForAttemptCapsExponentially(t *testing.T) {
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		AppToken:       "app-token",
		ReconnectDelay: 1500 * time.Millisecond,
	})

	testCases := []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: 1, want: 1500 * time.Millisecond},
		{attempt: 2, want: 3 * time.Second},
		{attempt: 3, want: 6 * time.Second},
		{attempt: 4, want: 12 * time.Second},
		{attempt: 7, want: socketModeReconnectMaxDelay},
	}

	for _, testCase := range testCases {
		if got := runner.reconnectDelayForAttempt(testCase.attempt); got != testCase.want {
			t.Fatalf("attempt %d delay = %s, want %s", testCase.attempt, got, testCase.want)
		}
	}
}
