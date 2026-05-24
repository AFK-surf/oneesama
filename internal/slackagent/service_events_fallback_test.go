package slackagent

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

func newDispatchEventService(pilot, debug string) (*Service, *recordingPoster) {
	poster := &recordingPoster{}
	dm := newSlackDMPoster()
	if pilot != "" {
		dm.CacheDM(pilot, "DPILOT")
	}
	svc := &Service{
		logger: slog.Default(),
		poster: poster,
		operatorFallback: &SlackOperatorFallback{
			BotToken:       "xoxb-test",
			APIBaseURL:     "https://slack.example",
			Client:         &http.Client{},
			PilotUserID:    pilot,
			DebugChannelID: debug,
			Poster:         poster,
			DM:             dm,
		},
	}
	svc.operatorFallback.PublicNotice = svc.deliverSlackPublicNotification
	return svc, poster
}

func TestNotifyOperatorPostFailureFallsBackToPilotAndDebug(t *testing.T) {
	svc, poster := newDispatchEventService("U1", "CDEBUG")
	svc.notifyOperatorPostFailure(context.Background(), PostMessageInput{
		Channel:  "C123",
		ThreadTS: "1700000000.000001",
		Text:     "original public reply",
		DedupKey: "dedup-xyz",
	}, PostMessageResult{
		OK:     false,
		Error:  "rate_limited",
		Detail: "slack returned 429",
		Status: 429,
	})
	if countCallsForChannel(poster.Calls(), "DPILOT") != 1 {
		t.Fatalf("expected pilot DM fallback to fire, got %d", countCallsForChannel(poster.Calls(), "DPILOT"))
	}
	if countCallsForChannel(poster.Calls(), "CDEBUG") != 1 {
		t.Fatalf("expected debug channel fallback to fire, got %d", countCallsForChannel(poster.Calls(), "CDEBUG"))
	}
	debugMsg := firstCallForChannel(poster.Calls(), "CDEBUG")
	if !strings.Contains(debugMsg.Text, "rate_limited") {
		t.Fatalf("expected fallback summary to mention error, got %q", debugMsg.Text)
	}
	if !strings.Contains(debugMsg.Text, "C123") {
		t.Fatalf("expected fallback summary to mention original channel, got %q", debugMsg.Text)
	}
	if !strings.Contains(debugMsg.Text, "dedup-xyz") {
		t.Fatalf("expected fallback summary to include dedup key, got %q", debugMsg.Text)
	}
}

func TestNotifyOperatorPostFailureSkipsWhenOperatorChannelsUnconfigured(t *testing.T) {
	svc, poster := newDispatchEventService("", "")
	svc.notifyOperatorPostFailure(context.Background(), PostMessageInput{Channel: "C123", Text: "hi"}, PostMessageResult{OK: false, Error: "rate_limited"})
	if len(poster.Calls()) != 0 {
		t.Fatalf("expected no fallback calls when unconfigured, got %d", len(poster.Calls()))
	}
}

func TestDispatchEventQueuedAckBlocksNewerThreadActivity(t *testing.T) {
	restore := installSlackRepliesFixture(t, []SlackMessage{
		{TS: "1700000000.000001", User: "U1", Text: "first mention"},
		{TS: "1700000000.000002", User: "U2", Text: "actually, never mind"},
	})
	defer restore()

	svc, poster := newDispatchEventService("", "")
	svc.botToken = "xoxb-test"
	svc.botUserID = "U_BOT"
	svc.dispatchEventQueuedAck(context.Background(), "T1", PostMessageInput{
		Channel:  "C123",
		ThreadTS: "1700000000.000001",
		Text:     "Got it",
		DedupKey: "evt-1:queued_ack",
	}, "1700000000.000001")
	if len(poster.Calls()) != 0 {
		t.Fatalf("queued ack should be blocked before fallback, got %d", len(poster.Calls()))
	}
}

// TestNotifyOperatorPostFailureHandlesNilFallback keeps the helper crash-free
// when the service was constructed without an operator fallback (defensive
// path for older callers / tests).
func TestNotifyOperatorPostFailureHandlesNilFallback(t *testing.T) {
	svc := &Service{logger: slog.Default()}
	// Should not panic.
	svc.notifyOperatorPostFailure(context.Background(), PostMessageInput{Channel: "C"}, PostMessageResult{Error: "x"})
}

func countCallsForChannel(calls []PostMessageInput, channel string) int {
	count := 0
	for _, call := range calls {
		if call.Channel == channel {
			count++
		}
	}
	return count
}

func firstCallForChannel(calls []PostMessageInput, channel string) PostMessageInput {
	for _, call := range calls {
		if call.Channel == channel {
			return call
		}
	}
	return PostMessageInput{}
}
