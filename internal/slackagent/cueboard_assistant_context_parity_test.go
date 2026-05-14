//go:build cueboardparity

package slackagent

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityFormatSlackDurableContextIncludesLedgerAndChannelBrain(t *testing.T) {
	ledger := &SlackThreadLedgerRecord{
		Status:           "awaiting_confirmation",
		OwnerUserID:      "UOWNER",
		LastUserID:       "UREQUESTER",
		LastActionType:   "create_issue",
		LastActionStatus: "pending",
		Summary:          "created Linear issue CUE-123",
	}
	brain := &SlackChannelBrain{
		Summary:        "Team prefers Linear for bug tracking.\nFriday demos usually happen in #general.",
		SummaryVersion: 2,
	}
	got := formatSlackDurableContext(ledger, brain, func(userID string) string {
		switch userID {
		case "UOWNER":
			return "Owner User"
		case "UREQUESTER":
			return "Requester User"
		default:
			return userID
		}
	})

	for _, want := range []string{
		"Thread ledger:",
		"- thread status: awaiting_confirmation",
		"- last requested action: create_issue (pending)",
		"- recent handled task: created Linear issue CUE-123",
		"Channel brain:",
		"- version: 2",
		"Team prefers Linear for bug tracking.",
		"Friday demos usually happen in #general.",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("durable context missing %q:\n%s", want, got)
		}
	}
}

func TestCueboardParityBuildSlackAssistantMessageIncludesDurableAndLiveContext(t *testing.T) {
	ledger := &SlackThreadLedgerRecord{
		Status:  "active",
		Summary: "Assistant already summarized the blocker once.",
	}
	brain := &SlackChannelBrain{
		Summary: "This channel tracks launch coordination.",
	}

	got := buildSlackAssistantMessage(
		"C123",
		"123.456",
		"https://cue-3kl2780.slack.com/archives/C123/p123456000456",
		"U777",
		"what's still blocked?",
		nil,
		"[ts:123.456] Alice: launch update",
		"Meeting is live",
		"UBOT",
		SlackAssistantThreadParentInfo{UserID: "UBOT"},
		ledger,
		brain,
		func(userID string) string {
			if userID == "UBOT" {
				return "Cuebot"
			}
			return userID
		},
	)

	for _, want := range []string{
		"Thread metadata:",
		"- channel: C123",
		"- thread_ts: 123.456",
		"- thread_permalink: https://cue-3kl2780.slack.com/archives/C123/p123456000456",
		"- thread started by: Cuebot (assistant or app message)",
		"Durable context:",
		"Thread ledger:",
		"Channel brain:",
		"Thread context:",
		"[ts:123.456] Alice: launch update",
		"Live meeting status:",
		"Meeting is live",
		"User <@U777> says:",
		"what's still blocked?",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("assistant message missing %q:\n%s", want, got)
		}
	}
}

func TestCueboardParityBuildSlackAssistantMessageSuppressesDuplicateLedgerSummaryFromTranscript(t *testing.T) {
	ledger := &SlackThreadLedgerRecord{
		Status:  "active",
		Summary: "Need to fix **system prompt** and improve progress updates.",
	}

	got := buildSlackAssistantMessage(
		"C123",
		"123.456",
		"",
		"U777",
		"any concrete ideas?",
		nil,
		"[ts:123.456] Cuebot [assistant]: Need to fix *system prompt* and improve progress updates.",
		"",
		"UBOT",
		SlackAssistantThreadParentInfo{UserID: "U123"},
		ledger,
		nil,
		func(userID string) string { return userID },
	)

	if strings.Contains(got, "- recent handled task:") {
		t.Fatalf("duplicate recent handled task should be suppressed:\n%s", got)
	}
	if !strings.Contains(got, "Thread ledger:\n- thread status: active") {
		t.Fatalf("thread ledger status should still be present:\n%s", got)
	}
}

func TestCueboardParityBuildSlackAssistantMessageIncludesOutstandingRequests(t *testing.T) {
	got := buildSlackAssistantMessage(
		"C123",
		"123.456",
		"",
		"U777",
		"那现在谁来推进？",
		[]string{
			"先帮我看看有没有相关 issue",
			"如果没有的话顺手建一个",
		},
		"[ts:123.456] Alice: launch update",
		"",
		"UBOT",
		SlackAssistantThreadParentInfo{UserID: "U123"},
		nil,
		nil,
		func(userID string) string { return userID },
	)

	for _, want := range []string{
		"Outstanding user requests from <@U777> earlier in this thread",
		"- 先帮我看看有没有相关 issue",
		"- 如果没有的话顺手建一个",
		"User <@U777> says:\n那现在谁来推进？",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("assistant message missing %q:\n%s", want, got)
		}
	}
}

func TestCueboardParityBuildSlackAssistantMessageColdStartUsesPersistedDurableState(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store := newSlackCognitionStore(appconfig.PersistenceConfig{Provider: "json-file", DataDir: dataDir}, cueboardParityDiscardLogger())
	userAt := time.Date(2026, 3, 19, 10, 0, 0, 0, time.UTC)
	if err := store.RecordInbound(ctx, "W1", SlackInboundMessage{
		ChannelID: "C123",
		ThreadTS:  "123.456",
		UserID:    "UASKER",
		TS:        userAt.Format(time.RFC3339Nano),
		Text:      "what's left for launch?",
	}); err != nil {
		t.Fatalf("RecordInbound: %v", err)
	}
	if err := store.RecordOutbound(ctx, "W1", "C123", "123.456", "Open loop: launch blocker still needs a clear owner."); err != nil {
		t.Fatalf("RecordOutbound: %v", err)
	}
	if store.brains != nil {
		_ = store.brains.Close()
	}
	if store.ledgers != nil {
		_ = store.ledgers.Close()
	}

	reopened := newSlackCognitionStore(appconfig.PersistenceConfig{Provider: "json-file", DataDir: dataDir}, cueboardParityDiscardLogger())
	t.Cleanup(func() {
		if reopened.brains != nil {
			_ = reopened.brains.Close()
		}
		if reopened.ledgers != nil {
			_ = reopened.ledgers.Close()
		}
	})

	got := reopened.BuildAssistantMessageForThread(
		ctx,
		"W1",
		"C123",
		"123.456",
		"UASKER",
		"what's left for launch?",
		nil,
		"[ts:123.456] Alice: launch update",
		"",
		SlackAssistantThreadParentInfo{UserID: "UBOT", IsBotParent: true},
		func(userID string) string {
			if userID == "UBOT" {
				return "Cuebot"
			}
			if userID == "UASKER" {
				return "Asker User"
			}
			return userID
		},
	)

	for _, want := range []string{
		"Thread metadata:",
		"- thread started by: Cuebot (assistant or app message)",
		"Durable context:",
		"Thread ledger:",
		"- thread status: active",
		"Channel brain:",
		"Shared open loops:",
		"launch blocker still needs a clear owner.",
		"Thread context:",
		"User <@UASKER> says:",
		"what's left for launch?",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("cold-start assistant message missing %q:\n%s", want, got)
		}
	}
}

func TestCueboardParityFormatSlackThreadLedgerContextUsesConfirmedActionWhenSummaryMissing(t *testing.T) {
	ledger := &SlackThreadLedgerRecord{
		Status:           "active",
		LastActionType:   "create_issue",
		LastActionStatus: "confirmed",
	}

	got := formatSlackDurableContext(ledger, nil, nil)
	if !strings.Contains(got, "- recent handled task: create_issue (confirmed)") {
		t.Fatalf("recent handled task missing confirmed action fallback:\n%s", got)
	}
	if strings.Contains(got, "last requested action") {
		t.Fatalf("pending action line should not appear for confirmed actions:\n%s", got)
	}
}

func cueboardParityDiscardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
