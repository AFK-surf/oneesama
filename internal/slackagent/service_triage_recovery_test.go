package slackagent

import (
	"context"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestRecoverOrphanedPersonaForegroundTriageClosesQueuedRun(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 21, 1, 2, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	service.startedAt = now
	recorded, err := service.triage.RecordRun(context.Background(), SlackTriageContext{
		ID:        123,
		SessionID: "triage:C123:1779296099440",
		Timestamp: now.Add(-time.Minute).Format(time.RFC3339Nano),
		Status:    "pending",
		Channels:  []string{"C123"},
		Summary:   "Pi-first foreground triage pending for 1 Slack message(s) in C123",
		Digest:    `• [ref:m1 msg_ts:1779295981.074899] <@U1>: "can someone look at this?"`,
		Metadata: map[string]any{
			"persona_foreground_queued": true,
			"foreground_chain":          slackTriageForegroundChainPiFirstLive,
			"workspace_id":              "T123",
			"channel_id":                "C123",
		},
	})
	if err != nil {
		t.Fatalf("RecordRun: %v", err)
	}
	if recorded == nil {
		t.Fatal("RecordRun returned nil")
	}

	if !service.recoverOneOrphanedPersonaForegroundTriage(context.Background(), *recorded) {
		t.Fatal("recoverOneOrphanedPersonaForegroundTriage returned false")
	}
	updated, err := service.triage.GetRun(context.Background(), recorded.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if updated == nil {
		t.Fatal("updated run missing")
	}
	if updated.Status != "failed" || !strings.Contains(updated.Error, "orphaned after slack-agent restart") {
		t.Fatalf("updated status/error = %q/%q, want recovered failure", updated.Status, updated.Error)
	}
	if boolFromAny(updated.Metadata["persona_foreground_queued"], true) {
		t.Fatalf("metadata = %#v, queued flag should be cleared", updated.Metadata)
	}
	if !boolFromAny(updated.Metadata["persona_foreground_orphaned_after_restart"], false) ||
		!boolFromAny(updated.Metadata["persona_foreground_orphan_needs_retry"], false) {
		t.Fatalf("metadata = %#v, want orphan recovery retry markers", updated.Metadata)
	}
	foreground, ok := mapFromAny(updated.Metadata["persona_foreground"])
	if !ok || boolFromAny(foreground["success"], true) || boolFromAny(foreground["shadow_only"], true) {
		t.Fatalf("persona_foreground = %#v, want fail-closed non-shadow result", updated.Metadata["persona_foreground"])
	}
	var sawForegroundFailure bool
	for _, call := range updated.ToolCalls {
		if call.Tool == "persona_runtime" && call.Action == "foreground_triage" && !call.Success {
			sawForegroundFailure = true
		}
	}
	if !sawForegroundFailure {
		t.Fatalf("tool calls = %#v, want failed persona_runtime foreground call", updated.ToolCalls)
	}
	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 || followups[0].Kind != slackTriageEmptyFinalFollowupKind || followups[0].ChannelID != "C123" || followups[0].ThreadTS != "1779295981.074899" {
		t.Fatalf("followups = %#v, want one retry followup on digest msg_ts", followups)
	}
}

func TestRecordPersonaForegroundTimeoutMarksRetryScheduled(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 21, 1, 5, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	recorded, err := service.triage.RecordRun(context.Background(), SlackTriageContext{
		ID:        456,
		SessionID: "triage:C456:1779290000000",
		Timestamp: now.Format(time.RFC3339Nano),
		Status:    "pending",
		Channels:  []string{"C456"},
		Summary:   "Pi-first foreground triage pending for 1 Slack message(s) in C456",
		Metadata: map[string]any{
			"persona_foreground_queued": true,
			"workspace_id":              "T456",
			"channel_id":                "C456",
			"thread_ts":                 "1779290000.000000",
		},
	})
	if err != nil {
		t.Fatalf("RecordRun: %v", err)
	}
	result := SlackPersonaShadowResult{
		RequestID:  "triage:C456:1779290000000",
		Source:     "triage",
		ChannelID:  "C456",
		ThreadTS:   "1779290000.000000",
		Success:    false,
		ShadowOnly: true,
		Error:      `call persona runtime: Post "http://127.0.0.1:8799/persona/decide": context deadline exceeded`,
	}
	if err := service.recordSlackTriagePersonaForegroundResult(context.Background(), "T456", recorded.ID, result, nil, nil, 0, 0); err != nil {
		t.Fatalf("recordSlackTriagePersonaForegroundResult: %v", err)
	}
	updated, err := service.triage.GetRun(context.Background(), recorded.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if updated == nil || updated.Status != "failed" || !boolFromAny(updated.Metadata["triage_timeout_needs_retry"], false) || !boolFromAny(updated.Metadata["persona_foreground_timeout_needs_retry"], false) {
		t.Fatalf("updated = %#v, want timeout retry markers", updated)
	}
	report := buildSlackTriageAuditReport([]SlackTriageContext{*updated}, time.Hour)
	if report.PersonaQuality.Failures != 1 || report.PersonaQuality.RetryScheduledFailures != 1 || report.PersonaQuality.ShadowOnlyResponses != 0 {
		t.Fatalf("persona quality = %#v, want retry-scheduled failure without shadow-only red count", report.PersonaQuality)
	}
	report.PersonaRuntime = SlackTriagePersonaRuntime{ForegroundEnabled: true, Provider: "oneesama-pi", Mode: "live", Ready: true, Healthy: true}
	report.Flags = buildSlackTriageAuditFlags(report)
	if hasAuditFlagLevel(report.Flags, "persona_foreground_failures", "red") || hasAuditFlag(report.Flags, "persona_foreground_shadow_only") {
		t.Fatalf("flags = %#v, retry-scheduled timeout should not produce foreground red flags", report.Flags)
	}
	if !hasAuditFlagLevel(report.Flags, "persona_foreground_failures_retry_scheduled", "yellow") {
		t.Fatalf("flags = %#v, want retry-scheduled yellow flag", report.Flags)
	}
}

func TestRecoverPersonaForegroundTimeoutFailureMarksRetryScheduled(t *testing.T) {
	previousClock := timeNow
	now := time.Date(2026, 5, 21, 1, 8, 0, 0, time.UTC)
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	recorded, err := service.triage.RecordRun(context.Background(), SlackTriageContext{
		ID:        789,
		SessionID: "triage:C789:1779289224943",
		Timestamp: now.Add(-time.Hour).Format(time.RFC3339Nano),
		Status:    "failed",
		Channels:  []string{"C789"},
		Summary:   "Pi-first foreground triage pending for 3 Slack message(s) in C789",
		Error:     `call persona runtime: Post "http://127.0.0.1:8799/persona/decide": context deadline exceeded`,
		Metadata: map[string]any{
			"workspace_id": "T789",
			"persona_foreground": map[string]any{
				"request_id":  "triage:C789:1779289224943",
				"source":      "triage",
				"channel_id":  "C789",
				"thread_ts":   "1779289191.004699",
				"success":     false,
				"shadow_only": true,
				"error":       `call persona runtime: Post "http://127.0.0.1:8799/persona/decide": context deadline exceeded`,
				"latency_ms":  90001,
			},
		},
	})
	if err != nil {
		t.Fatalf("RecordRun: %v", err)
	}
	if recorded == nil {
		t.Fatal("RecordRun returned nil")
	}
	if !service.recoverOnePersonaForegroundTimeoutFailure(context.Background(), *recorded) {
		t.Fatal("recoverOnePersonaForegroundTimeoutFailure returned false")
	}
	updated, err := service.triage.GetRun(context.Background(), recorded.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if updated == nil || !boolFromAny(updated.Metadata["triage_timeout_needs_retry"], false) || !boolFromAny(updated.Metadata["persona_foreground_timeout_needs_retry"], false) {
		t.Fatalf("updated = %#v, want timeout retry markers", updated)
	}
	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 || followups[0].Kind != slackTriageTimeoutFollowupKind || followups[0].ChannelID != "C789" || followups[0].ThreadTS != "1779289191.004699" {
		t.Fatalf("followups = %#v, want one persona timeout retry followup", followups)
	}
	if service.recoverOnePersonaForegroundTimeoutFailure(context.Background(), *updated) {
		t.Fatal("second recovery should be idempotent")
	}
}
