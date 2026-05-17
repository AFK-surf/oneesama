package slackagent

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// dispatchEventFakePoster records every PostMessage call and returns either a
// success or a configured failure. The test inspects the recorded inputs to
// confirm the fallback fires on the failure path and is skipped on success.
type dispatchEventFakePoster struct {
	mu             sync.Mutex
	publicCalls    []PostMessageInput
	pilotCalls     []PostMessageInput
	debugCalls     []PostMessageInput
	publicFailure  PostMessageResult
	publicOK       bool
	pilotChannelID string
	debugChannelID string
}

func (p *dispatchEventFakePoster) PostMessage(ctx context.Context, input PostMessageInput) PostMessageResult {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch input.Channel {
	case p.pilotChannelID:
		p.pilotCalls = append(p.pilotCalls, input)
		return PostMessageResult{OK: true, Channel: input.Channel}
	case p.debugChannelID:
		p.debugCalls = append(p.debugCalls, input)
		return PostMessageResult{OK: true, Channel: input.Channel}
	default:
		p.publicCalls = append(p.publicCalls, input)
		if p.publicOK {
			return PostMessageResult{OK: true, Channel: input.Channel}
		}
		return p.publicFailure
	}
}

func (p *dispatchEventFakePoster) publicCount() int { p.mu.Lock(); defer p.mu.Unlock(); return len(p.publicCalls) }
func (p *dispatchEventFakePoster) pilotCount() int  { p.mu.Lock(); defer p.mu.Unlock(); return len(p.pilotCalls) }
func (p *dispatchEventFakePoster) debugCount() int  { p.mu.Lock(); defer p.mu.Unlock(); return len(p.debugCalls) }
func (p *dispatchEventFakePoster) firstDebug() PostMessageInput {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.debugCalls) == 0 {
		return PostMessageInput{}
	}
	return p.debugCalls[0]
}

func newDispatchEventService(pilot, debug string, publicOK bool, failure PostMessageResult) (*Service, *dispatchEventFakePoster) {
	poster := &dispatchEventFakePoster{
		publicFailure:  failure,
		publicOK:       publicOK,
		pilotChannelID: "DPILOT",
		debugChannelID: debug,
	}
	dm := newSlackDMPoster()
	if pilot != "" {
		dm.CacheDM(pilot, "DPILOT")
	}
	return &Service{
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
	}, poster
}

// TestDispatchEventPostFallsBackToPilotOnFailure asserts that the operator
// fallback fires the configured pilot DM (and debug channel) when the public
// post returns a non-OK result, and that the fallback messages carry context
// about the original failure.
func TestDispatchEventPostFallsBackToPilotOnFailure(t *testing.T) {
	svc, poster := newDispatchEventService("U1", "CDEBUG", false, PostMessageResult{
		OK:     false,
		Error:  "rate_limited",
		Detail: "slack returned 429",
		Status: 429,
	})
	svc.dispatchEventPost(context.Background(), PostMessageInput{
		Channel:  "C123",
		ThreadTS: "1700000000.000001",
		Text:     "original public reply",
		DedupKey: "dedup-xyz",
	})
	if poster.publicCount() != 1 {
		t.Fatalf("expected one public attempt, got %d", poster.publicCount())
	}
	if poster.pilotCount() != 1 {
		t.Fatalf("expected pilot DM fallback to fire, got %d", poster.pilotCount())
	}
	if poster.debugCount() != 1 {
		t.Fatalf("expected debug channel fallback to fire, got %d", poster.debugCount())
	}
	debugMsg := poster.firstDebug()
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

// TestDispatchEventPostSkipsFallbackWhenOperatorChannelsUnconfigured keeps
// the helper inert for deployments that haven't set Pilot/Debug envs.
func TestDispatchEventPostSkipsFallbackWhenOperatorChannelsUnconfigured(t *testing.T) {
	svc, poster := newDispatchEventService("", "", false, PostMessageResult{OK: false, Error: "rate_limited"})
	svc.dispatchEventPost(context.Background(), PostMessageInput{Channel: "C123", Text: "hi"})
	if poster.pilotCount() != 0 || poster.debugCount() != 0 {
		t.Fatalf("expected no fallback calls when unconfigured, got pilot=%d debug=%d", poster.pilotCount(), poster.debugCount())
	}
}

// TestDispatchEventPostDoesNotFallbackOnSuccess keeps the operator inbox
// quiet when posts succeed normally.
func TestDispatchEventPostDoesNotFallbackOnSuccess(t *testing.T) {
	svc, poster := newDispatchEventService("U1", "CDEBUG", true, PostMessageResult{})
	svc.dispatchEventPost(context.Background(), PostMessageInput{Channel: "C123", Text: "hi"})
	if poster.publicCount() != 1 {
		t.Fatalf("expected exactly 1 public call, got %d", poster.publicCount())
	}
	if poster.pilotCount() != 0 {
		t.Fatalf("expected no pilot fallback on success, got %d", poster.pilotCount())
	}
	if poster.debugCount() != 0 {
		t.Fatalf("expected no debug fallback on success, got %d", poster.debugCount())
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
