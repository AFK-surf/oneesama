package slackagent

import (
	"context"
	"path/filepath"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func newServiceWithThreadCases(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	cfg := appconfig.PersistenceConfig{
		Provider:   "memory",
		DataDir:    dir,
		SQLitePath: filepath.Join(dir, "test.db"),
	}
	store := newSlackThreadCaseStore(cfg, nil)
	if store == nil {
		t.Fatalf("newSlackThreadCaseStore returned nil")
	}
	return &Service{
		threadCases:  store,
		mentionQueue: newSlackMentionQueue(),
	}
}

// TestServiceIsActiveMentionThreadReportsClaimLifecycle exercises the live
// callback that slackAPITool.activeThread uses to refuse chat.postMessage on
// the same thread while a mention worker is running.
func TestServiceIsActiveMentionThreadReportsClaimLifecycle(t *testing.T) {
	svc := newServiceWithThreadCases(t)
	ctx := context.Background()

	if svc.isActiveMentionThread("C1", "ts-1") {
		t.Fatalf("expected unclaimed thread to be inactive")
	}
	svc.beginMentionThreadCase(ctx, "C1", "ts-1", "evt-1")
	if !svc.isActiveMentionThread("C1", "ts-1") {
		t.Fatalf("expected mention claim to make thread active")
	}
	svc.endMentionThreadCase(ctx, "workspace", "C1", "ts-1", "evt-1")
	if svc.isActiveMentionThread("C1", "ts-1") {
		t.Fatalf("expected MarkClosed to release thread")
	}
}

// TestFilterMessagesActiveMentionThreadsDropsClaimedThreadReplies verifies
// the scanner suppression helper drops reply messages that belong to a
// currently-active mention thread, while leaving unrelated messages intact.
func TestFilterMessagesActiveMentionThreadsDropsClaimedThreadReplies(t *testing.T) {
	svc := newServiceWithThreadCases(t)
	ctx := context.Background()
	svc.beginMentionThreadCase(ctx, "C1", "1700000000.000100", "evt-mention")

	messages := []SlackMessage{
		{TS: "1700000000.000101", ThreadTS: "1700000000.000100", Text: "follow-up inside mention thread"},
		{TS: "1700000000.000200", Text: "unrelated top-level message"},
		{TS: "1700000000.000300", ThreadTS: "1700000000.000300", Text: "self-threaded root message"},
		{TS: "1700000000.000301", ThreadTS: "1700000000.000999", Text: "reply on different thread"},
	}
	filtered, suppressed := svc.filterMessagesActiveMentionThreads(ctx, "C1", messages)
	if suppressed != 1 {
		t.Fatalf("suppressed = %d, want 1", suppressed)
	}
	if len(filtered) != 3 {
		t.Fatalf("filtered = %d entries, want 3 (%+v)", len(filtered), filtered)
	}
	for _, message := range filtered {
		if message.Text == "follow-up inside mention thread" {
			t.Fatalf("expected mention-thread follow-up to be suppressed, but it survived")
		}
	}
}

// TestFilterMessagesActiveMentionThreadsNoopWhenStoreMissing keeps the helper
// safe to call from services that have no thread case store (e.g. tests).
func TestFilterMessagesActiveMentionThreadsNoopWhenStoreMissing(t *testing.T) {
	svc := &Service{}
	ctx := context.Background()
	messages := []SlackMessage{{TS: "1.000001", ThreadTS: "1.000000", Text: "msg"}}
	filtered, suppressed := svc.filterMessagesActiveMentionThreads(ctx, "C1", messages)
	if suppressed != 0 {
		t.Fatalf("suppressed = %d, want 0 when no thread case store", suppressed)
	}
	if len(filtered) != len(messages) {
		t.Fatalf("filtered length = %d, want %d", len(filtered), len(messages))
	}
}

// TestMentionQueueCoalescesSameThreadIntoSingleWorker pins the dedupe contract
// the live handler relies on: the first mention starts a worker, the second
// piggybacks with a one-time ack, the third is silently merged.
func TestMentionQueueCoalescesSameThreadIntoSingleWorker(t *testing.T) {
	queue := newSlackMentionQueue()

	start1, ack1 := queue.enqueue("workspace", "C1", "ts-1", SlackEventPayload{})
	if !start1 || ack1 {
		t.Fatalf("first enqueue start=%v ack=%v, want start=true ack=false", start1, ack1)
	}
	start2, ack2 := queue.enqueue("workspace", "C1", "ts-1", SlackEventPayload{})
	if start2 || !ack2 {
		t.Fatalf("second enqueue start=%v ack=%v, want start=false ack=true", start2, ack2)
	}
	start3, ack3 := queue.enqueue("workspace", "C1", "ts-1", SlackEventPayload{})
	if start3 || ack3 {
		t.Fatalf("third enqueue start=%v ack=%v, want start=false ack=false (already acked)", start3, ack3)
	}
	if !queue.hasQueued("workspace", "C1", "ts-1") {
		t.Fatalf("expected queued mentions to remain pending after coalescing")
	}
	batch, more := queue.dequeueOrStop("workspace", "C1", "ts-1")
	if !more {
		t.Fatalf("dequeueOrStop more=false, want true (queue had pending mentions)")
	}
	if len(batch) != 3 {
		// Current queue semantics keep every enqueued event in pending
		// (including the one that started the worker); the worker is
		// expected to dedupe by event id when replaying the batch.
		t.Fatalf("dequeued batch len = %d, want 3 (full pending list)", len(batch))
	}
	_, more = queue.dequeueOrStop("workspace", "C1", "ts-1")
	if more {
		t.Fatalf("second dequeue more=true after queue drained, want false")
	}
}

// TestBeginMentionThreadCaseSurvivesNilStores keeps the live handler safe to
// call even when the thread case store fails to init.
func TestBeginMentionThreadCaseSurvivesNilStores(t *testing.T) {
	svc := &Service{}
	svc.beginMentionThreadCase(context.Background(), "C1", "ts-1", "evt-1")
	svc.endMentionThreadCase(context.Background(), "workspace", "C1", "ts-1", "evt-1")
	if svc.isActiveMentionThread("C1", "ts-1") {
		t.Fatalf("nil-store service must never report active mention claims")
	}
}

// TestEndMentionThreadCaseDequeuesQueueEntries verifies the worker exit hook
// also flushes the mention queue so future mentions on the same thread can
// claim ownership without leaking pending counts.
func TestEndMentionThreadCaseDequeuesQueueEntries(t *testing.T) {
	svc := newServiceWithThreadCases(t)
	if start, _ := svc.mentionQueue.enqueue("workspace", "C1", "ts-1", SlackEventPayload{}); !start {
		t.Fatalf("first enqueue must start a worker")
	}
	if _, ack := svc.mentionQueue.enqueue("workspace", "C1", "ts-1", SlackEventPayload{}); !ack {
		t.Fatalf("second enqueue must request an ack")
	}
	svc.beginMentionThreadCase(context.Background(), "C1", "ts-1", "evt-1")
	svc.endMentionThreadCase(context.Background(), "workspace", "C1", "ts-1", "evt-1")
	if svc.mentionQueue.hasQueued("workspace", "C1", "ts-1") {
		t.Fatalf("expected mention queue to be drained after end hook")
	}
	if svc.isActiveMentionThread("C1", "ts-1") {
		t.Fatalf("thread case must report inactive after end hook")
	}
}
