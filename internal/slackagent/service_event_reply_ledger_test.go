package slackagent

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

// ledgerRecordingPoster captures the inputs each PostMessage receives and returns
// a configurable canned result. Reused across the event-reply-ledger tests.
type ledgerRecordingPoster struct {
	mu     sync.Mutex
	calls  []PostMessageInput
	result PostMessageResult
}

func (p *ledgerRecordingPoster) PostMessage(ctx context.Context, input PostMessageInput) PostMessageResult {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, input)
	result := p.result
	if result.Channel == "" {
		result.Channel = input.Channel
	}
	if result.ThreadTS == "" {
		result.ThreadTS = input.ThreadTS
	}
	return result
}

func newLedgerTestService(t *testing.T, posterOK bool) (*Service, *ledgerRecordingPoster) {
	t.Helper()
	dir := t.TempDir()
	cfg := appconfig.PersistenceConfig{
		Provider:   "memory",
		DataDir:    dir,
		SQLitePath: filepath.Join(dir, "test.db"),
	}
	cognition := newSlackCognitionStore(cfg, slog.Default())
	if cognition == nil {
		t.Fatalf("newSlackCognitionStore returned nil")
	}
	poster := &ledgerRecordingPoster{result: PostMessageResult{OK: posterOK, TS: "1700.001", ThreadTS: ""}}
	return &Service{
		logger:    slog.Default(),
		poster:    poster,
		cognition: cognition,
	}, poster
}

// TestDispatchEventReplyWithLedgerRecordsOutboundOnSuccess pins the
// happy-path semantics: when chat.postMessage succeeds, the cognition
// ledger gains a thread-outbound row carrying the supplied summary.
func TestDispatchEventReplyWithLedgerRecordsOutboundOnSuccess(t *testing.T) {
	svc, poster := newLedgerTestService(t, true)
	ctx := context.Background()
	svc.dispatchEventReplyWithLedger(ctx, "workspace", PostMessageInput{
		Channel:  "C123",
		ThreadTS: "1699999999.000001",
		Text:     "Reply body",
		DedupKey: "evt-1",
	}, "app_mention: Reply body", "1699999999.000001")

	if got := poster.calls; len(got) != 1 {
		t.Fatalf("expected exactly 1 poster call, got %d", len(got))
	}
	ledgers, err := svc.cognition.ListRecentThreadLedgersForWorkspace(ctx, "workspace", 5)
	if err != nil {
		t.Fatalf("ListRecentThreadLedgersForWorkspace: %v", err)
	}
	if len(ledgers) != 1 {
		t.Fatalf("expected 1 ledger row, got %d", len(ledgers))
	}
	if ledgers[0].ChannelID != "C123" || ledgers[0].ThreadTS != "1699999999.000001" {
		t.Fatalf("ledger row addressing wrong: %+v", ledgers[0])
	}
	if !strings.Contains(ledgers[0].Summary, "Reply body") {
		t.Fatalf("ledger summary missing reply body: %q", ledgers[0].Summary)
	}
}

// TestDispatchEventReplyWithLedgerSkipsOnFailure verifies the ledger is
// NOT touched when the public post failed, so we never advertise an
// outbound that the user never saw.
func TestDispatchEventReplyWithLedgerSkipsOnFailure(t *testing.T) {
	svc, _ := newLedgerTestService(t, false)
	svc.poster.(*ledgerRecordingPoster).result = PostMessageResult{OK: false, Error: "channel_not_found"}
	ctx := context.Background()
	svc.dispatchEventReplyWithLedger(ctx, "workspace", PostMessageInput{
		Channel:  "C123",
		ThreadTS: "1699999999.000001",
		Text:     "Reply body",
		DedupKey: "evt-2",
	}, "app_mention: Reply body", "1699999999.000001")

	ledgers, err := svc.cognition.ListRecentThreadLedgersForWorkspace(ctx, "workspace", 5)
	if err != nil {
		t.Fatalf("ListRecent: %v", err)
	}
	if len(ledgers) != 0 {
		t.Fatalf("expected ledger to stay empty on failed post, got %d rows", len(ledgers))
	}
}

func TestDispatchEventReplyWithLedgerBlocksNewerThreadActivity(t *testing.T) {
	now := time.Date(2026, time.May, 24, 10, 0, 0, 0, time.UTC)
	snapshotTS := formatSlackTimestamp(now)
	newerTS := formatSlackTimestamp(now.Add(time.Second))
	restore := installSlackRepliesFixture(t, []SlackMessage{
		{TS: snapshotTS, User: "U_ASKER", Text: "你帮我回一下"},
		{TS: newerTS, User: "U_HUMAN", Text: "我自己已经补充了。"},
	})
	defer restore()

	svc, poster := newLedgerTestService(t, true)
	svc.botToken = "xoxb-test"
	svc.botUserID = "U_BOT"
	ctx := context.Background()
	svc.dispatchEventReplyWithLedger(ctx, "workspace", PostMessageInput{
		Channel:  "C123",
		ThreadTS: snapshotTS,
		Text:     "Reply body",
		DedupKey: "evt-stale",
	}, "app_mention: Reply body", snapshotTS)

	if len(poster.calls) != 0 {
		t.Fatalf("poster calls = %#v, want stale event reply suppressed", poster.calls)
	}
	ledgers, err := svc.cognition.ListRecentThreadLedgersForWorkspace(ctx, "workspace", 5)
	if err != nil {
		t.Fatalf("ListRecent: %v", err)
	}
	if len(ledgers) != 0 {
		t.Fatalf("expected ledger to stay empty on blocked post, got %d rows", len(ledgers))
	}
}

// TestRecordSlackOutboundLedgerNoOpWhenSummaryEmpty keeps the helper
// inert for transient surfaces (status / ack / queued ack) that pass an
// empty ledger summary.
func TestRecordSlackOutboundLedgerNoOpWhenSummaryEmpty(t *testing.T) {
	svc, _ := newLedgerTestService(t, true)
	ctx := context.Background()
	svc.recordSlackOutboundLedger(ctx, "workspace", PostMessageInput{
		Channel:  "C123",
		ThreadTS: "1700.001",
	}, PostMessageResult{OK: true}, "")
	ledgers, _ := svc.cognition.ListRecentThreadLedgersForWorkspace(ctx, "workspace", 5)
	if len(ledgers) != 0 {
		t.Fatalf("expected empty summary to skip ledger write, got %d rows", len(ledgers))
	}
}

// TestRecordSlackOutboundLedgerFallsBackToResultTS handles event posts
// whose input did not carry a thread TS (top-level channel post). The
// helper should still record outbound using the TS returned by the
// PostMessage result.
func TestRecordSlackOutboundLedgerFallsBackToResultTS(t *testing.T) {
	svc, _ := newLedgerTestService(t, true)
	ctx := context.Background()
	svc.recordSlackOutboundLedger(ctx, "workspace", PostMessageInput{
		Channel: "C123",
	}, PostMessageResult{OK: true, TS: "1700.999"}, "worker_result: hello")
	ledgers, _ := svc.cognition.ListRecentThreadLedgersForWorkspace(ctx, "workspace", 5)
	if len(ledgers) != 1 {
		t.Fatalf("expected 1 ledger row, got %d", len(ledgers))
	}
	if ledgers[0].ThreadTS != "1700.999" {
		t.Fatalf("expected thread_ts to fall back to result.TS, got %q", ledgers[0].ThreadTS)
	}
}

// TestRecordSlackOutboundLedgerTruncatesLongSummaries keeps the ledger
// row size bounded even when the assistant produced a long reply.
func TestRecordSlackOutboundLedgerTruncatesLongSummaries(t *testing.T) {
	svc, _ := newLedgerTestService(t, true)
	ctx := context.Background()
	long := strings.Repeat("x", 2000)
	svc.recordSlackOutboundLedger(ctx, "workspace", PostMessageInput{
		Channel:  "C123",
		ThreadTS: "1700.001",
	}, PostMessageResult{OK: true}, long)
	ledgers, _ := svc.cognition.ListRecentThreadLedgersForWorkspace(ctx, "workspace", 5)
	if len(ledgers) != 1 {
		t.Fatalf("expected 1 ledger row, got %d", len(ledgers))
	}
	if len(ledgers[0].Summary) > 410 {
		t.Fatalf("expected ledger summary to be truncated under ~400 bytes, got %d", len(ledgers[0].Summary))
	}
}

// TestSlackEventReplyLedgerSummaryFormatsModePrefix pins the wire
// format so future readers can grep ledger rows by source mode.
func TestSlackEventReplyLedgerSummaryFormatsModePrefix(t *testing.T) {
	cases := []struct {
		mode  string
		text  string
		want  string
		strip bool
	}{
		{"app_mention", "Hello there\nSecond line", "app_mention: Hello there", false},
		{"dm_command", "    DM body    ", "dm_command: DM body", false},
		{"", "fallback text", "event_reply: fallback text", false},
		{"app_mention", "  \n  ", "app_mention", false},
	}
	for _, tc := range cases {
		got := slackEventReplyLedgerSummary(tc.mode, tc.text)
		if got != tc.want {
			t.Errorf("slackEventReplyLedgerSummary(%q, %q) = %q, want %q", tc.mode, tc.text, got, tc.want)
		}
	}
}
