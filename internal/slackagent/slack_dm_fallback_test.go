package slackagent

import (
	"context"
	"net/http"
	"sync"
	"testing"
)

// fakePoster is a PosterService stub that records the inputs and reports a
// canned PostMessageResult. We do NOT depend on the real Poster here so the
// tests run without HTTP.
type fakePoster struct {
	mu     sync.Mutex
	calls  []PostMessageInput
	result PostMessageResult
}

func (f *fakePoster) PostMessage(ctx context.Context, input PostMessageInput) PostMessageResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, input)
	return f.result
}

func (f *fakePoster) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func newTestOperatorFallback(pilotUserID, debugChannelID string, posterOK bool) (*SlackOperatorFallback, *fakePoster) {
	poster := &fakePoster{result: PostMessageResult{OK: posterOK, Channel: "X"}}
	dm := newSlackDMPoster()
	if pilotUserID != "" {
		dm.CacheDM(pilotUserID, "D"+pilotUserID)
	}
	fallback := &SlackOperatorFallback{
		BotToken:       "xoxb-test",
		APIBaseURL:     "https://slack.example",
		Client:         &http.Client{},
		PilotUserID:    pilotUserID,
		DebugChannelID: debugChannelID,
		Poster:         poster,
		PublicNotice: func(ctx context.Context, input slackPublicNotificationDelivery) slackPublicNotificationDeliveryResult {
			return slackPublicNotificationDeliveryResult{Post: poster.PostMessage(ctx, PostMessageInput{
				Channel:  input.ChannelID,
				ThreadTS: input.ThreadTS,
				Text:     input.Text,
				Blocks:   input.Blocks,
				DedupKey: input.DedupKey,
			})}
		},
		DM: dm,
	}
	return fallback, poster
}

func TestPostPilotDMNoopWhenUserNotConfigured(t *testing.T) {
	fallback, poster := newTestOperatorFallback("", "", true)
	result := fallback.PostPilotDM(context.Background(), "hi")
	if result.OK {
		t.Fatalf("expected ok=false when pilot user not configured")
	}
	if !result.Skipped {
		t.Fatalf("expected skipped=true, got %+v", result)
	}
	if result.Reason != "pilot_user_id_not_configured" {
		t.Fatalf("reason = %q, want pilot_user_id_not_configured", result.Reason)
	}
	if poster.callCount() != 0 {
		t.Fatalf("expected zero poster calls when no pilot configured, got %d", poster.callCount())
	}
}

func TestPostPilotDMPostsOnceAndDedupes(t *testing.T) {
	fallback, poster := newTestOperatorFallback("U1", "", true)
	first := fallback.PostPilotDM(context.Background(), "fallback after public failure")
	if !first.OK {
		t.Fatalf("first call should succeed, got %+v", first)
	}
	if poster.callCount() != 1 {
		t.Fatalf("first call should hit poster once, got %d", poster.callCount())
	}
	second := fallback.PostPilotDM(context.Background(), "fallback after public failure")
	if !second.OK {
		t.Fatalf("dedupe should still report ok, got %+v", second)
	}
	if !second.Skipped {
		t.Fatalf("expected duplicate to be skipped, got %+v", second)
	}
	if poster.callCount() != 1 {
		t.Fatalf("dedupe must suppress the second post, got %d calls", poster.callCount())
	}
	if !fallback.DM.HasDedupeHash("DU1", "fallback after public failure") {
		t.Fatalf("expected dedupe hash to be recorded")
	}
}

func TestPostPilotDMSkipsEmptyText(t *testing.T) {
	fallback, poster := newTestOperatorFallback("U1", "", true)
	result := fallback.PostPilotDM(context.Background(), "  ")
	if !result.Skipped || result.Reason != "empty_text" {
		t.Fatalf("expected skipped+empty_text, got %+v", result)
	}
	if poster.callCount() != 0 {
		t.Fatalf("expected zero poster calls for empty text")
	}
}

func TestPostDebugChannelNoopWhenChannelMissing(t *testing.T) {
	fallback, poster := newTestOperatorFallback("U1", "", true)
	result := fallback.PostDebugChannel(context.Background(), "operator note")
	if !result.Skipped {
		t.Fatalf("expected skip when debug channel missing, got %+v", result)
	}
	if result.Reason != "debug_channel_id_not_configured" {
		t.Fatalf("reason = %q", result.Reason)
	}
	if poster.callCount() != 0 {
		t.Fatalf("expected zero poster calls")
	}
}

func TestPostDebugChannelPostsOnceAndDedupes(t *testing.T) {
	fallback, poster := newTestOperatorFallback("U1", "CDEBUG", true)
	first := fallback.PostDebugChannel(context.Background(), "operator note")
	if !first.OK {
		t.Fatalf("expected ok, got %+v", first)
	}
	if poster.callCount() != 1 {
		t.Fatalf("expected 1 poster call, got %d", poster.callCount())
	}
	dup := fallback.PostDebugChannel(context.Background(), "operator note")
	if !dup.Skipped {
		t.Fatalf("expected duplicate to be skipped, got %+v", dup)
	}
	if poster.callCount() != 1 {
		t.Fatalf("dedupe must hold steady at 1 call, got %d", poster.callCount())
	}
}

func TestSlackDMDedupKeyStableAcrossWhitespace(t *testing.T) {
	a := slackDMDedupKey("DU1", "hi there")
	b := slackDMDedupKey("DU1", "  hi there  ")
	if a != b {
		t.Fatalf("expected dedupe key to be whitespace-insensitive, got %q vs %q", a, b)
	}
	c := slackDMDedupKey("DU2", "hi there")
	if a == c {
		t.Fatalf("dedupe key should depend on channel: %q == %q", a, c)
	}
}

func TestShouldSendOnceEvictsOlderHashesUnderPressure(t *testing.T) {
	dm := newSlackDMPoster()
	for i := 0; i < slackDMDedupHashes*2; i++ {
		_ = dm.shouldSendOnce("C", "note-"+itoa(i))
	}
	dm.mu.Lock()
	size := len(dm.dedupe)
	dm.mu.Unlock()
	if size > slackDMDedupHashes {
		t.Fatalf("dedupe cache grew unbounded: %d entries (cap %d)", size, slackDMDedupHashes)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	out := ""
	neg := i < 0
	if neg {
		i = -i
	}
	for i > 0 {
		out = string('0'+rune(i%10)) + out
		i /= 10
	}
	if neg {
		out = "-" + out
	}
	return out
}
