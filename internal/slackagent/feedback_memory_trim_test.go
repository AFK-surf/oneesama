package slackagent

import (
	"strings"
	"testing"
)

func makeEntry(date, time, action string) SlackFeedbackEntry {
	return SlackFeedbackEntry{
		EntryDate:  date,
		EntryTime:  time,
		Action:     action,
		ActionType: "feedback",
		Channel:    "C123",
		Summary:    "feedback note",
		UserID:     "U123",
	}
}

func TestRenderFeedbackDayBlocksGroupsByDate(t *testing.T) {
	entries := []SlackFeedbackEntry{
		makeEntry("2026-05-15", "09:00", "👍"),
		makeEntry("2026-05-15", "10:00", "👎"),
		makeEntry("2026-05-16", "09:30", "👍"),
	}
	blocks := renderFeedbackDayBlocks(entries)
	if len(blocks) != 2 {
		t.Fatalf("expected 2 day blocks, got %d (%+v)", len(blocks), blocks)
	}
	if !strings.HasPrefix(blocks[0], "#### 2026-05-15") {
		t.Fatalf("expected first block to be 2026-05-15, got %q", blocks[0])
	}
	if !strings.Contains(blocks[0], "👍") || !strings.Contains(blocks[0], "👎") {
		t.Fatalf("expected first block to contain both entries, got %q", blocks[0])
	}
	if !strings.HasPrefix(blocks[1], "#### 2026-05-16") {
		t.Fatalf("expected second block to be 2026-05-16, got %q", blocks[1])
	}
}

func TestTrimFeedbackDaysToBudgetKeepsNewestFirst(t *testing.T) {
	blocks := []string{
		"#### 2026-05-10\n- a",
		"#### 2026-05-15\n- b",
		"#### 2026-05-16\n- c",
	}
	// Each block is 19 bytes; two newest blocks plus their `\n\n` join cost
	// 40 bytes total, while the oldest day adds another 21 (block + join).
	// A 50-byte budget therefore exercises the trim path cleanly.
	out := trimFeedbackDaysToBudget(blocks, 50)
	if strings.Contains(out, "2026-05-10") {
		t.Fatalf("expected oldest day to be trimmed, got %q", out)
	}
	if !strings.Contains(out, "2026-05-15") || !strings.Contains(out, "2026-05-16") {
		t.Fatalf("expected newest two days to survive, got %q", out)
	}
	if !strings.HasPrefix(out, "[older feedback omitted") {
		t.Fatalf("expected omission marker on trimmed output, got %q", out)
	}
}

func TestTrimFeedbackDaysToBudgetKeepsAtLeastNewestEvenIfOversize(t *testing.T) {
	massive := "#### 2026-05-15\n- " + strings.Repeat("x", 8000)
	blocks := []string{
		"#### 2026-05-10\n- a",
		massive,
	}
	out := trimFeedbackDaysToBudget(blocks, 1000)
	if !strings.Contains(out, "2026-05-15") {
		t.Fatalf("expected newest day to survive even when oversize, got %q", out)
	}
	if strings.Contains(out, "2026-05-10") {
		t.Fatalf("expected older day to be dropped, got %q", out)
	}
}

func TestTrimFeedbackDaysToBudgetNoopWhenAllFit(t *testing.T) {
	blocks := []string{
		"#### 2026-05-15\n- a",
		"#### 2026-05-16\n- b",
	}
	out := trimFeedbackDaysToBudget(blocks, 4096)
	if !strings.Contains(out, "2026-05-15") || !strings.Contains(out, "2026-05-16") {
		t.Fatalf("expected both days to survive, got %q", out)
	}
	if strings.Contains(out, "older feedback omitted") {
		t.Fatalf("expected no omission marker when all blocks fit, got %q", out)
	}
}

func TestTrimFeedbackDaysToBudgetReturnsEmptyForEmptyInput(t *testing.T) {
	if got := trimFeedbackDaysToBudget(nil, 4096); got != "" {
		t.Fatalf("expected empty string for nil input, got %q", got)
	}
}
