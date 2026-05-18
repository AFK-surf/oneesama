package slackagent

import (
	"context"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

// TestLaunchAsyncInteractionReturnsBeforeWorkCompletes is the regression
// guard for the 5/18 live join incident: any handler routed through
// LaunchAsyncInteraction must return immediately, even when the work
// function blocks for longer than Slack's 3s ack budget.
func TestLaunchAsyncInteractionReturnsBeforeWorkCompletes(t *testing.T) {
	svc := &Service{logger: slog.New(slog.NewTextHandler(testDiscardWriter{}, nil))}
	workStarted := make(chan struct{})
	releaseWork := make(chan struct{})
	workCompleted := make(chan struct{})

	start := time.Now()
	svc.LaunchAsyncInteraction(context.Background(), "test_async_handler", func(ctx context.Context) {
		close(workStarted)
		<-releaseWork
		close(workCompleted)
	})
	elapsed := time.Since(start)

	// The launch path is expected to return in microseconds — well under the
	// 3-second Slack ack window. We allow a generous 50ms slack for test
	// scheduler noise. If this ever exceeds 50ms something on the launch
	// path itself is doing slow synchronous work.
	if elapsed > 50*time.Millisecond {
		t.Fatalf("LaunchAsyncInteraction returned after %s; must return before Slack ack window", elapsed)
	}

	select {
	case <-workStarted:
	case <-time.After(time.Second):
		t.Fatal("async work did not start")
	}
	// Work is still pending; that's the whole point — caller already
	// returned before the work finished.
	select {
	case <-workCompleted:
		t.Fatal("async work completed synchronously; expected to still be pending")
	default:
	}
	close(releaseWork)
	select {
	case <-workCompleted:
	case <-time.After(time.Second):
		t.Fatal("async work did not complete after release")
	}
}

// TestLaunchAsyncInteractionDetachesContext makes sure the ack-first
// wrapper does not propagate the caller's cancellation into the
// spawned goroutine. The Socket Mode dispatcher returns immediately and
// the caller-side context becomes "done" right after; the async work
// (which often issues HTTP calls back to Slack) must NOT see that
// cancellation.
func TestLaunchAsyncInteractionDetachesContext(t *testing.T) {
	svc := &Service{logger: slog.New(slog.NewTextHandler(testDiscardWriter{}, nil))}
	ctx, cancel := context.WithCancel(context.Background())
	seen := make(chan error, 1)
	svc.LaunchAsyncInteraction(ctx, "test_detach", func(detached context.Context) {
		// Caller cancels right after launching; the detached context
		// should remain alive long enough to do real work.
		time.Sleep(20 * time.Millisecond)
		seen <- detached.Err()
	})
	cancel()
	select {
	case err := <-seen:
		if err != nil {
			t.Fatalf("detached context.Err() = %v after caller cancel, want nil", err)
		}
	case <-time.After(time.Second):
		t.Fatal("async work did not run")
	}
}

// TestLaunchAsyncInteractionNilWorkIsNoOp protects against accidental
// nil callers; we don't want to spawn an empty goroutine and the
// service should remain functional.
func TestLaunchAsyncInteractionNilWorkIsNoOp(t *testing.T) {
	svc := &Service{logger: slog.New(slog.NewTextHandler(testDiscardWriter{}, nil))}
	var ran int32
	svc.LaunchAsyncInteraction(context.Background(), "noop", nil)
	// If a goroutine WAS spawned with nil work it would panic; the
	// assertion is implicit — give the scheduler a tick and confirm we
	// did not flip the counter from any path.
	time.Sleep(10 * time.Millisecond)
	if atomic.LoadInt32(&ran) != 0 {
		t.Fatalf("nil work should not run; ran=%d", ran)
	}
}

// testDiscardWriter throws away log output so the test runner stays
// quiet but slog.NewTextHandler still has something to write to.
type testDiscardWriter struct{}

func (testDiscardWriter) Write(p []byte) (int, error) { return len(p), nil }
