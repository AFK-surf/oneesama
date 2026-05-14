//go:build cueboardparity

package slackagent

import (
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityNewInboundBuffer(t *testing.T) {
	t.Parallel()

	buffer := newSlackInboundBuffer(appconfig.SlackEventBufferConfig{Enabled: true, MaxBatch: 20, Debounce: 30 * time.Second}, nil)
	if buffer.maxBatch != 20 {
		t.Errorf("maxBatch = %d, want 20", buffer.maxBatch)
	}
	if buffer.debounce != 30*time.Second {
		t.Errorf("debounce = %v, want 30s", buffer.debounce)
	}
	if buffer.channels == nil {
		t.Fatal("channels map should not be nil")
	}
}

func TestCueboardParityInboundBufferDrainEmpty(t *testing.T) {
	t.Parallel()

	buffer := newCueboardParityInboundBuffer()
	if messages := buffer.Drain("C123"); messages != nil {
		t.Errorf("drain on empty buffer should return nil, got %d messages", len(messages))
	}
}

func TestCueboardParityInboundBufferDrainWithMessages(t *testing.T) {
	t.Parallel()

	buffer := newCueboardParityInboundBuffer()
	buffer.inject("C123", []SlackInboundMessage{
		{TS: "1.0", Text: "hello"},
		{TS: "2.0", Text: "world"},
	})

	messages := buffer.Drain("C123")
	if len(messages) != 2 {
		t.Fatalf("drain should return 2 messages, got %d", len(messages))
	}
	if messages[0].Text != "hello" || messages[1].Text != "world" {
		t.Errorf("unexpected message content: %v", messages)
	}
	if messages = buffer.Drain("C123"); messages != nil {
		t.Errorf("second drain should return nil, got %d messages", len(messages))
	}
}

func TestCueboardParityInboundBufferPendingCursor(t *testing.T) {
	t.Parallel()

	buffer := newCueboardParityInboundBuffer()
	if cursor := buffer.Cursor("C1"); cursor != "" {
		t.Errorf("expected empty cursor, got %q", cursor)
	}

	buffer.SetCursor("C1", "100.0")
	if cursor := buffer.Cursor("C1"); cursor != "100.0" {
		t.Errorf("cursor = %q, want 100.0", cursor)
	}
	buffer.SetCursor("C1", "50.0")
	if cursor := buffer.Cursor("C1"); cursor != "100.0" {
		t.Errorf("cursor should not go backwards: got %q, want 100.0", cursor)
	}
	buffer.SetCursor("C1", "200.0")
	if cursor := buffer.Cursor("C1"); cursor != "200.0" {
		t.Errorf("cursor = %q, want 200.0", cursor)
	}
}

func TestCueboardParityInboundBufferTriagedTracking(t *testing.T) {
	t.Parallel()

	buffer := newCueboardParityInboundBuffer()
	buffer.markTriaged("C1", []string{"1.0", "2.0", "3.0"})

	missed := buffer.findMissed("C1", []SlackInboundMessage{{TS: "1.0"}, {TS: "2.0"}})
	if len(missed) != 0 {
		t.Errorf("expected 0 missed, got %d", len(missed))
	}

	missed = buffer.findMissed("C1", []SlackInboundMessage{{TS: "1.0"}, {TS: "2.0"}, {TS: "4.0"}})
	if len(missed) != 1 || missed[0].TS != "4.0" {
		t.Errorf("expected 1 missed message (4.0), got %v", missed)
	}
}

func TestCueboardParityInboundBufferFindMissedNoSet(t *testing.T) {
	t.Parallel()

	buffer := newCueboardParityInboundBuffer()
	missed := buffer.findMissed("C_UNKNOWN", []SlackInboundMessage{{TS: "1.0"}})
	if len(missed) != 1 {
		t.Errorf("expected 1 missed with no set, got %d", len(missed))
	}
}

func TestCueboardParityInboundBufferPruneTriagedBefore(t *testing.T) {
	t.Parallel()

	buffer := newCueboardParityInboundBuffer()
	buffer.markTriaged("C1", []string{"1.0", "2.0", "3.0", "4.0"})
	buffer.pruneTriagedBefore("C1", "2.0")

	buffer.mu.Lock()
	set := buffer.triagedSets["C1"]
	buffer.mu.Unlock()

	if _, ok := set["1.0"]; ok {
		t.Error("1.0 should have been pruned")
	}
	if _, ok := set["2.0"]; ok {
		t.Error("2.0 should have been pruned")
	}
	if _, ok := set["3.0"]; !ok {
		t.Error("3.0 should still be in the set")
	}
	if _, ok := set["4.0"]; !ok {
		t.Error("4.0 should still be in the set")
	}
}

func TestCueboardParityInboundBufferInject(t *testing.T) {
	t.Parallel()

	buffer := newCueboardParityInboundBuffer()
	buffer.inject("C1", []SlackInboundMessage{{TS: "1.0", Text: "missed"}})

	drained := buffer.Drain("C1")
	if len(drained) != 1 || drained[0].Text != "missed" {
		t.Errorf("inject + drain mismatch: got %v", drained)
	}
}

func TestCueboardParitySlackTSGreater(t *testing.T) {
	t.Parallel()

	cases := []struct {
		a    string
		b    string
		want bool
	}{
		{"100.0", "50.0", true},
		{"50.0", "100.0", false},
		{"100.0", "100.0", false},
		{"1709812345.123456", "1709812345.123455", true},
		{"1709812345.123456", "1709812346.000000", false},
		{"9.0", "10.0", false},
		{"10.0", "9.0", true},
	}
	for _, tc := range cases {
		if got := slackTSGreater(tc.a, tc.b); got != tc.want {
			t.Errorf("slackTSGreater(%q, %q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestCueboardParityInboundBufferInjectAndScheduleRetry(t *testing.T) {
	t.Parallel()

	buffer := newSlackInboundBuffer(appconfig.SlackEventBufferConfig{Enabled: true, MaxBatch: 10, Debounce: 50 * time.Millisecond}, nil)
	flushed := make(chan struct{}, 1)
	buffer.injectAndScheduleRetry("C1", []SlackInboundMessage{{TS: "1.0", Text: "retry me"}}, func() {
		flushed <- struct{}{}
	})

	buffer.mu.Lock()
	count := len(buffer.channels["C1"].messages)
	hasTimer := buffer.channels["C1"].timer != nil
	buffer.mu.Unlock()
	if count != 1 {
		t.Errorf("expected 1 buffered message, got %d", count)
	}
	if !hasTimer {
		t.Error("expected timer to be set")
	}
	select {
	case <-flushed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("retry timer did not fire within 500ms")
	}
}

func TestCueboardParityInboundBufferInjectAppends(t *testing.T) {
	t.Parallel()

	buffer := newCueboardParityInboundBuffer()
	buffer.inject("C1", []SlackInboundMessage{{TS: "1.0"}})
	buffer.inject("C1", []SlackInboundMessage{{TS: "2.0"}})

	if drained := buffer.Drain("C1"); len(drained) != 2 {
		t.Errorf("expected 2 messages after double inject, got %d", len(drained))
	}
}

func newCueboardParityInboundBuffer() *slackInboundBuffer {
	return newSlackInboundBuffer(appconfig.SlackEventBufferConfig{Enabled: true, MaxBatch: 10, Debounce: time.Second}, nil)
}
