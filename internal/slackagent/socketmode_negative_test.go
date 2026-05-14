package slackagent

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
)

func TestSocketModeHandleMessageInvalidJSONSetsLastError(t *testing.T) {
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  NewService(Config{}),
		AppToken: "app-token",
	})

	if err := runner.handleMessage(context.Background(), nil, []byte("{")); err != nil {
		t.Fatalf("handle message error = %v, want nil", err)
	}
	if got := runner.Snapshot().LastError; !strings.Contains(got, "invalid_socket_mode_json") {
		t.Fatalf("last error = %q, want invalid_socket_mode_json", got)
	}
}

func TestSocketModeHandleEnvelopeDisconnectReturnsSentinel(t *testing.T) {
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  NewService(Config{}),
		AppToken: "app-token",
	})

	err := runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
		Type:   "disconnect",
		Reason: "maintenance",
	}, func(any) error { return nil })
	if !errors.Is(err, errSlackSocketDisconnect) {
		t.Fatalf("handle envelope error = %v, want errSlackSocketDisconnect", err)
	}
	if got := runner.Snapshot().LastError; got != "maintenance" {
		t.Fatalf("last error = %q, want maintenance", got)
	}
}

func TestSocketModeHandleEnvelopeUnknownTypeAcksAndCountsIgnored(t *testing.T) {
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  NewService(Config{}),
		AppToken: "app-token",
	})

	acked := false
	err := runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
		Type:       "mystery",
		EnvelopeID: "EnUnknown",
	}, func(payload any) error {
		acked = true
		if payload != nil {
			t.Fatalf("ack payload = %#v, want nil", payload)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("handle envelope error = %v", err)
	}
	if !acked {
		t.Fatal("expected unknown envelope ack")
	}
	if got := runner.Snapshot().IgnoredEnvelopes; got != 1 {
		t.Fatalf("ignored envelopes = %d, want 1", got)
	}
}

func TestSocketModeHandleSlashCommandInvalidPayloadAcksEphemeralError(t *testing.T) {
	runner := NewSocketModeRunner(SocketModeRunnerConfig{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Service:  NewService(Config{}),
		AppToken: "app-token",
	})

	var ackPayload any
	err := runner.handleEnvelope(context.Background(), SlackSocketEnvelope{
		Type:       "slash_commands",
		EnvelopeID: "EnSlashBad",
		Payload:    []byte("{"),
	}, func(payload any) error {
		ackPayload = payload
		return nil
	})
	if err != nil {
		t.Fatalf("handle envelope error = %v", err)
	}

	response, ok := ackPayload.(AvatarCommandResponse)
	if !ok {
		t.Fatalf("ack payload = %#v, want AvatarCommandResponse", ackPayload)
	}
	if response.OK || !strings.Contains(response.Text, "Invalid socket mode slash command payload.") {
		t.Fatalf("response = %#v, want invalid payload error", response)
	}
	if got := runner.Snapshot().SlashCommandsHandled; got != 1 {
		t.Fatalf("slash commands handled = %d, want 1", got)
	}
}
