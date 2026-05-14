//go:build cueboardparity

package slackagent

import (
	"context"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityStoreOutboundActionReservationLifecycle(t *testing.T) {
	ctx := context.Background()
	store := newSlackHeartbeatStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())

	first, err := store.ReserveOutboundAction(ctx, SlackOutboundAction{
		ActionType: "dm",
		Target:     "U1",
		Reference:  "C1:123",
		SessionID:  "sess-1",
		Summary:    "hello",
		Status:     "pending",
	})
	if err != nil {
		t.Fatalf("first ReserveOutboundAction: %v", err)
	}
	if first == nil || first.ID == 0 {
		t.Fatalf("first reservation = %#v, want non-zero id", first)
	}

	duplicate, err := store.ReserveOutboundAction(ctx, SlackOutboundAction{
		ActionType: "dm",
		Target:     "U1",
		Reference:  "C1:123",
		SessionID:  "sess-1",
		Summary:    "hello again",
		Status:     "pending",
	})
	if err != nil {
		t.Fatalf("duplicate ReserveOutboundAction: %v", err)
	}
	if duplicate != nil {
		t.Fatalf("duplicate reservation = %#v, want blocked", duplicate)
	}

	different, err := store.ReserveOutboundAction(ctx, SlackOutboundAction{
		ActionType: "dm",
		Target:     "U1",
		Reference:  "C1:456",
		SessionID:  "sess-1",
		Summary:    "different",
		Status:     "pending",
	})
	if err != nil {
		t.Fatalf("different ReserveOutboundAction: %v", err)
	}
	if different == nil || different.ID == 0 {
		t.Fatalf("different reservation = %#v, want allowed", different)
	}

	if err := store.FailOutboundAction(ctx, first.ID); err != nil {
		t.Fatalf("FailOutboundAction: %v", err)
	}
	retry, err := store.ReserveOutboundAction(ctx, SlackOutboundAction{
		ActionType: "dm",
		Target:     "U1",
		Reference:  "C1:123",
		SessionID:  "sess-1",
		Summary:    "retry",
		Status:     "pending",
	})
	if err != nil {
		t.Fatalf("retry ReserveOutboundAction: %v", err)
	}
	if retry == nil || retry.ID == 0 {
		t.Fatalf("retry reservation = %#v, want allowed after fail", retry)
	}
	if err := store.ConfirmOutboundAction(ctx, retry.ID); err != nil {
		t.Fatalf("ConfirmOutboundAction: %v", err)
	}
	blocked, err := store.ReserveOutboundAction(ctx, SlackOutboundAction{
		ActionType: "dm",
		Target:     "U1",
		Reference:  "C1:123",
		SessionID:  "sess-1",
		Summary:    "after confirmed",
		Status:     "pending",
	})
	if err != nil {
		t.Fatalf("confirmed duplicate ReserveOutboundAction: %v", err)
	}
	if blocked != nil {
		t.Fatalf("confirmed reservation duplicate = %#v, want blocked", blocked)
	}
}

func TestCueboardParityStoreCleanupStalePendingOutboundActions(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC)
	withCueboardParityClock(t, now)
	store := newSlackHeartbeatStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())

	stale, err := store.ReserveOutboundAction(ctx, SlackOutboundAction{
		ActionType: "dm",
		Target:     "U1",
		Reference:  "C1:old",
		Status:     "pending",
		CreatedAt:  now.Add(-20 * time.Minute).Format(time.RFC3339Nano),
	})
	if err != nil || stale == nil {
		t.Fatalf("reserve stale: record=%#v err=%v", stale, err)
	}
	fresh, err := store.ReserveOutboundAction(ctx, SlackOutboundAction{
		ActionType: "dm",
		Target:     "U1",
		Reference:  "C1:fresh",
		Status:     "pending",
		CreatedAt:  now.Add(-2 * time.Minute).Format(time.RFC3339Nano),
	})
	if err != nil || fresh == nil {
		t.Fatalf("reserve fresh: record=%#v err=%v", fresh, err)
	}

	cleaned, err := store.CleanupStalePendingActions(ctx, 10*time.Minute)
	if err != nil {
		t.Fatalf("CleanupStalePendingActions: %v", err)
	}
	if cleaned != 1 {
		t.Fatalf("cleaned = %d, want 1", cleaned)
	}
	retry, err := store.ReserveOutboundAction(ctx, SlackOutboundAction{ActionType: "dm", Target: "U1", Reference: "C1:old", Status: "pending"})
	if err != nil || retry == nil {
		t.Fatalf("retry after cleanup = %#v err=%v, want allowed", retry, err)
	}
	stillBlocked, err := store.ReserveOutboundAction(ctx, SlackOutboundAction{ActionType: "dm", Target: "U1", Reference: "C1:fresh", Status: "pending"})
	if err != nil {
		t.Fatalf("fresh duplicate after cleanup: %v", err)
	}
	if stillBlocked != nil {
		t.Fatalf("fresh duplicate = %#v, want still blocked", stillBlocked)
	}
}

func TestCueboardParityStoreMeetingResultDeliveryLifecycle(t *testing.T) {
	ctx := context.Background()
	store := newMeetingWebhookStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())

	reserved, _, err := store.ReserveResult(ctx, 42)
	if err != nil || !reserved {
		t.Fatalf("first ReserveResult reserved=%v err=%v, want true", reserved, err)
	}
	reserved, _, err = store.ReserveResult(ctx, 42)
	if err != nil {
		t.Fatalf("duplicate ReserveResult: %v", err)
	}
	if reserved {
		t.Fatal("duplicate ReserveResult should be blocked")
	}
	if err := store.FailResult(ctx, 42); err != nil {
		t.Fatalf("FailResult: %v", err)
	}
	reserved, _, err = store.ReserveResult(ctx, 42)
	if err != nil || !reserved {
		t.Fatalf("ReserveResult after fail reserved=%v err=%v, want true", reserved, err)
	}
	if _, err := store.ConfirmResult(ctx, 42); err != nil {
		t.Fatalf("ConfirmResult: %v", err)
	}
	reserved, _, err = store.ReserveResult(ctx, 42)
	if err != nil {
		t.Fatalf("ReserveResult after confirm: %v", err)
	}
	if reserved {
		t.Fatal("confirmed ReserveResult should be blocked")
	}
	if err := store.ResetResult(ctx, 42); err != nil {
		t.Fatalf("ResetResult: %v", err)
	}
	reserved, _, err = store.ReserveResult(ctx, 42)
	if err != nil || !reserved {
		t.Fatalf("ReserveResult after reset reserved=%v err=%v, want true", reserved, err)
	}
}

func TestCueboardParityStoreCleansStaleMeetingResultReservations(t *testing.T) {
	ctx := context.Background()
	store := newMeetingWebhookStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())

	reserved, record, err := store.ReserveResult(ctx, 42)
	if err != nil || !reserved || record == nil {
		t.Fatalf("ReserveResult reserved=%v record=%#v err=%v", reserved, record, err)
	}
	record.CreatedAt = time.Now().UTC().Add(-20 * time.Minute).Format(time.RFC3339Nano)
	if err := store.deliveries.Set(ctx, record.ID, *record); err != nil {
		t.Fatalf("backdate reservation: %v", err)
	}

	cleaned, err := store.CleanupStaleReservations(ctx, 10*time.Minute)
	if err != nil {
		t.Fatalf("CleanupStaleReservations: %v", err)
	}
	if cleaned != 1 {
		t.Fatalf("cleaned = %d, want 1", cleaned)
	}
	reserved, _, err = store.ReserveResult(ctx, 42)
	if err != nil || !reserved {
		t.Fatalf("ReserveResult after cleanup reserved=%v err=%v, want true", reserved, err)
	}
}

func TestCueboardParityStoreThreadLedgerAndChannelBrainLifecycle(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 3, 19, 9, 30, 0, 0, time.UTC)
	withCueboardParityClock(t, now)
	store := newSlackCognitionStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())

	if err := store.RecordInbound(ctx, "W1", SlackInboundMessage{
		ChannelID: "C1",
		ThreadTS:  "123.456",
		UserID:    "U-owner",
		TS:        "123.456",
		Text:      "please create the launch blocker issue",
	}); err != nil {
		t.Fatalf("RecordInbound: %v", err)
	}
	if err := store.RecordAction(ctx, "W1", "C1", "123.456", "create_issue", "pending"); err != nil {
		t.Fatalf("RecordAction pending: %v", err)
	}
	if err := store.RecordOutbound(ctx, "W1", "C1", "123.456", "Open loop: launch blocker still needs a clear owner."); err != nil {
		t.Fatalf("RecordOutbound: %v", err)
	}

	ledger, err := store.GetThreadLedger(ctx, "W1", "C1", "123.456")
	if err != nil {
		t.Fatalf("GetThreadLedger: %v", err)
	}
	if ledger == nil || ledger.Status != "awaiting_confirmation" || ledger.OwnerUserID != "U-owner" {
		t.Fatalf("ledger = %#v, want awaiting confirmation owned by requester", ledger)
	}
	if ledger.LastActionType != "create_issue" || ledger.LastActionStatus != "pending" {
		t.Fatalf("ledger action = %#v, want pending create_issue", ledger)
	}
	if ledger.Summary != "Open loop: launch blocker still needs a clear owner." {
		t.Fatalf("ledger summary = %q", ledger.Summary)
	}

	brain, err := store.GetChannelBrain(ctx, "W1", "C1")
	if err != nil {
		t.Fatalf("GetChannelBrain: %v", err)
	}
	if err := store.RecordAction(ctx, "W1", "C1", "123.456", "create_issue", "confirmed"); err != nil {
		t.Fatalf("RecordAction confirmed: %v", err)
	}
	ledger, err = store.GetThreadLedger(ctx, "W1", "C1", "123.456")
	if err != nil {
		t.Fatalf("GetThreadLedger confirmed: %v", err)
	}
	if ledger.Status != "active" || ledger.LastActionStatus != "confirmed" {
		t.Fatalf("ledger after confirm = %#v, want active confirmed", ledger)
	}
	brain, err = store.GetChannelBrain(ctx, "W1", "C1")
	if err != nil {
		t.Fatalf("GetChannelBrain: %v", err)
	}
	if brain == nil || brain.SummaryVersion != 1 || !strings.Contains(brain.Summary, "launch blocker still needs a clear owner") {
		t.Fatalf("brain = %#v, want versioned open loop summary", brain)
	}
	if err := store.RebuildChannelBrainSummary(ctx, "W1", "C1", 6); err != nil {
		t.Fatalf("RebuildChannelBrainSummary no-op: %v", err)
	}
	brain, err = store.GetChannelBrain(ctx, "W1", "C1")
	if err != nil {
		t.Fatalf("GetChannelBrain after no-op: %v", err)
	}
	if brain.SummaryVersion != 1 {
		t.Fatalf("summary version after no-op rebuild = %d, want 1", brain.SummaryVersion)
	}
}

func TestCueboardParityStoreChannelBrainSummaryExtractsFactsAndOpenLoops(t *testing.T) {
	lastUserAt := time.Date(2026, 3, 19, 9, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	lastAssistantAt := time.Date(2026, 3, 19, 9, 3, 0, 0, time.UTC).Format(time.RFC3339Nano)

	got := buildChannelBrainSummary([]SlackThreadLedgerRecord{
		{
			ThreadTS:               "123.456",
			Status:                 "awaiting_confirmation",
			LastActionType:         "create_issue",
			LastActionStatus:       "pending",
			LastUserMessageAt:      lastUserAt,
			LastAssistantMessageAt: lastAssistantAt,
			Summary:                "Need to create follow-up issue after confirmation.",
		},
		{
			ThreadTS: "234.567",
			Status:   "active",
			Summary:  "Open loop: launch blocker still needs a clear owner.",
		},
		{
			ThreadTS: "345.678",
			Status:   "active",
			Summary:  "Decision: Use Linear for launch blockers.",
		},
		{ThreadTS: "456.789"},
	})

	for _, want := range []string{
		"Shared open loops:",
		"[thread 234.567]",
		"launch blocker still needs a clear owner.",
		"Shared facts and conventions:",
		"Use Linear for launch blockers.",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("channel brain summary missing %q:\n%s", want, got)
		}
	}
	for _, unwanted := range []string{"123.456", "Need to create follow-up issue", "456.789"} {
		if strings.Contains(got, unwanted) {
			t.Fatalf("channel brain summary should exclude %q:\n%s", unwanted, got)
		}
	}
}

func TestCueboardParityStoreSanitizesThreadLedgerSummaries(t *testing.T) {
	if got := sanitizeThreadLedgerSummary("给 <@U123> 总结一下"); got != "给 @someone 总结一下" {
		t.Fatalf("single-line summary = %q, want redacted mention", got)
	}
	longReply := strings.Join([]string{
		"好了，会议纪要拿到了。",
		"**主要议题：**",
		"- 文件交付方案",
		"- 自动化流水线",
		"- 部署进展",
	}, "\n")
	if got := sanitizeThreadLedgerSummary(longReply); got != "" {
		t.Fatalf("large multi-line reply should be dropped, got %q", got)
	}
	structured := strings.Join([]string{
		"Open loop: launch blocker still needs a clear owner.",
		"Decision: Use Linear for launch blockers.",
	}, "\n")
	if got := sanitizeThreadLedgerSummary(structured); got != structured {
		t.Fatalf("structured summary = %q, want original structured text", got)
	}
}

func TestCueboardParityStoreTriageRunsPreserveToolCallsAndSortByAbsoluteTime(t *testing.T) {
	ctx := context.Background()
	store := newSlackTriageStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())

	earlierLocal := SlackTriageContext{
		SessionID: "sess-local",
		Timestamp: time.Date(2026, 3, 25, 11, 35, 2, 0, time.FixedZone("CST", 8*3600)).
			Format(time.RFC3339Nano),
		Status:   "ok",
		Channels: []string{"local"},
		Summary:  "older absolute time",
	}
	laterUTC := SlackTriageContext{
		SessionID: "sess-utc",
		Timestamp: time.Date(2026, 3, 25, 7, 52, 51, 0, time.UTC).Format(time.RFC3339Nano),
		Status:    "failed",
		Channels:  []string{"utc"},
		Summary:   "newer absolute time",
		RawOutput: "raw",
		Error:     "boom",
		Digest:    "digest",
		Actions: []SlackTriageAction{{
			Tool:    "suggest_action",
			Channel: "utc",
			Brief:   "create_issue",
		}},
		ToolCalls: []SlackTriageToolCall{{
			Tool:    "slack_api",
			Action:  "post_thread_reply",
			Args:    "channel=utc",
			Success: true,
			Brief:   "hello",
			Result:  "full result",
		}},
	}
	if _, err := store.RecordRun(ctx, earlierLocal); err != nil {
		t.Fatalf("RecordRun earlier: %v", err)
	}
	if _, err := store.RecordRun(ctx, laterUTC); err != nil {
		t.Fatalf("RecordRun later: %v", err)
	}

	contexts, err := store.ListRuns(ctx, 20)
	if err != nil {
		t.Fatalf("ListRuns: %v", err)
	}
	if len(contexts) != 2 {
		t.Fatalf("contexts len = %d, want 2", len(contexts))
	}
	if contexts[0].SessionID != "sess-utc" || contexts[1].SessionID != "sess-local" {
		t.Fatalf("contexts order = %+v, want newest absolute timestamp first", contexts)
	}
	if contexts[0].Error != "boom" || contexts[0].RawOutput != "raw" || len(contexts[0].Actions) != 1 || len(contexts[0].ToolCalls) != 1 {
		t.Fatalf("stored triage context lost fields: %+v", contexts[0])
	}
}

func TestCueboardParityStoreEventCursorRoundTrip(t *testing.T) {
	buffer := newSlackInboundBuffer(appconfig.SlackEventBufferConfig{Enabled: true}, nil)
	if cursor := buffer.Cursor("C123"); cursor != "" {
		t.Fatalf("initial cursor = %q, want empty", cursor)
	}
	buffer.SetCursor("C123", "1709812345.123456")
	if cursor := buffer.Cursor("C123"); cursor != "1709812345.123456" {
		t.Fatalf("cursor = %q, want 1709812345.123456", cursor)
	}
	buffer.SetCursor("C123", "1709812340.000000")
	if cursor := buffer.Cursor("C123"); cursor != "1709812345.123456" {
		t.Fatalf("cursor moved backwards to %q", cursor)
	}
}
