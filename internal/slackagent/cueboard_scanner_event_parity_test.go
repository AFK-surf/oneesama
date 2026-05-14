//go:build cueboardparity

package slackagent

import "testing"

func TestCueboardParityReconcileScannerCommitsPendingCursorWhenNoGaps(t *testing.T) {
	t.Parallel()

	const (
		channelID       = "C123"
		committedCursor = "1709812345.100000"
		pendingCursor   = "1709812347.000001"
	)
	buffer := newCueboardParityInboundBuffer()
	buffer.SetCursor(channelID, committedCursor)
	buffer.markTriaged(channelID, []string{"1709812346.000001", pendingCursor})

	result := buffer.reconcileHistory(channelID, []SlackInboundMessage{
		{UserID: "U1", Text: "first", TS: "1709812346.000001"},
		{UserID: "U2", Text: "second", TS: pendingCursor},
	}, pendingCursor, nil)

	if result.MissedCount != 0 {
		t.Fatalf("missed count = %d, want 0", result.MissedCount)
	}
	if cursor := buffer.Cursor(channelID); cursor != pendingCursor {
		t.Fatalf("cursor = %q, want %q", cursor, pendingCursor)
	}

	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if len(buffer.triagedSets[channelID]) != 0 {
		t.Fatalf("triaged set should be pruned after commit, got %d entries", len(buffer.triagedSets[channelID]))
	}
}

func TestCueboardParityReconcileScannerPreservesCursorWhenHistoryShowsMissedMessage(t *testing.T) {
	t.Parallel()

	const (
		channelID       = "C123"
		committedCursor = "1709812345.100000"
		pendingCursor   = "1709812347.000001"
	)
	buffer := newCueboardParityInboundBuffer()
	buffer.SetCursor(channelID, committedCursor)
	buffer.markTriaged(channelID, []string{pendingCursor})

	result := buffer.reconcileHistory(channelID, []SlackInboundMessage{
		{UserID: "U1", Text: "missed", TS: "1709812346.000001"},
		{UserID: "U2", Text: "triaged", TS: pendingCursor},
	}, pendingCursor, nil)

	if result.MissedCount != 1 {
		t.Fatalf("missed count = %d, want 1", result.MissedCount)
	}
	if cursor := buffer.Cursor(channelID); cursor != committedCursor {
		t.Fatalf("cursor = %q, want committed cursor %q while missed message remains", cursor, committedCursor)
	}

	missed := buffer.Drain(channelID)
	if len(missed) != 1 {
		t.Fatalf("expected 1 missed message to be re-buffered, got %d", len(missed))
	}
	if missed[0].TS != "1709812346.000001" {
		t.Fatalf("missed message ts = %q, want 1709812346.000001", missed[0].TS)
	}
}
