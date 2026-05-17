package slackagent

import (
	"context"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestPrimeHeartbeatStateNormalizesDuplicateThreadCommitments(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	writeRawHeartbeatFollowup(t, service, SlackHeartbeatFollowup{
		ID:         101,
		Kind:       "commitment",
		Title:      "old promise",
		Summary:    "legacy commitment source ref",
		SourceKind: "thread",
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		SourceRef:  "slack:C123:123.456",
		Status:     "open",
		CreatedAt:  "2026-05-17T01:00:00Z",
		UpdatedAt:  "2026-05-17T01:00:00Z",
	})
	writeRawHeartbeatFollowup(t, service, SlackHeartbeatFollowup{
		ID:         102,
		Kind:       "commitment",
		Title:      "new promise",
		Summary:    "another legacy commitment source ref",
		SourceKind: "thread",
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		SourceRef:  "C123/123.456",
		Status:     "open",
		CreatedAt:  "2026-05-17T02:00:00Z",
		UpdatedAt:  "2026-05-17T02:00:00Z",
	})

	result, err := service.primeHeartbeatState(ctx)
	if err != nil {
		t.Fatalf("primeHeartbeatState: %v", err)
	}
	if result.FollowupsScanned != 2 || result.DuplicateFollowupsClosed != 1 {
		t.Fatalf("prime result = %#v, want 2 scanned / 1 duplicate closed", result)
	}
	open, err := service.followups.ListFollowups(ctx, "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups open: %v", err)
	}
	if len(open) != 1 {
		t.Fatalf("open followups = %#v, want one", open)
	}
	if open[0].ID != 102 || open[0].SourceRef != "thread_commitment:C123:123.456" {
		t.Fatalf("open followup = %#v, want newest canonical commitment", open[0])
	}
	closed, err := service.followups.ListFollowups(ctx, "done", 10)
	if err != nil {
		t.Fatalf("ListFollowups done: %v", err)
	}
	if len(closed) != 1 || closed[0].Metadata["superseded_by"] != float64(102) {
		t.Fatalf("closed followups = %#v, want superseded duplicate", closed)
	}
}

func TestPrimeHeartbeatStateKeepsDistinctMeetingCommitments(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	writeRawHeartbeatFollowup(t, service, SlackHeartbeatFollowup{
		ID:         201,
		Kind:       "commitment",
		Title:      "first action",
		SourceKind: "thread",
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		SourceRef:  "meeting:1:action:1",
		Status:     "open",
	})
	writeRawHeartbeatFollowup(t, service, SlackHeartbeatFollowup{
		ID:         202,
		Kind:       "commitment",
		Title:      "second action",
		SourceKind: "thread",
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		SourceRef:  "meeting:1:action:2",
		Status:     "open",
	})

	result, err := service.primeHeartbeatState(ctx)
	if err != nil {
		t.Fatalf("primeHeartbeatState: %v", err)
	}
	if result.DuplicateFollowupsClosed != 0 {
		t.Fatalf("prime result = %#v, want no duplicate closures", result)
	}
	open, err := service.followups.ListFollowups(ctx, "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(open) != 2 {
		t.Fatalf("open followups = %#v, want both meeting actions", open)
	}
}

func TestPrimeHeartbeatStateSyncsOpenImprovementClusters(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: t.TempDir()},
	})
	if _, err := service.improvements.InsertSignal(ctx, SlackImprovementSignal{
		Topic:           improvementTopicHeartbeatTasking,
		SignalType:      improvementSignalTypeComplaint,
		Summary:         "heartbeat 没有把跟进自动提上来",
		DesiredBehavior: "Surface heartbeat follow-ups automatically.",
		Severity:        improvementSignalSeverityHigh,
		Confidence:      0.9,
		ChannelID:       "C123",
		ThreadTS:        "123.456",
		MsgTS:           "123.456",
		ClusterKey:      improvementClusterBotAutonomy,
		Status:          improvementSignalStatusOpen,
	}); err != nil {
		t.Fatalf("InsertSignal: %v", err)
	}

	result, err := service.primeHeartbeatState(ctx)
	if err != nil {
		t.Fatalf("primeHeartbeatState: %v", err)
	}
	if result.ImprovementSignalsScanned != 1 || result.ImprovementClustersSynced != 1 {
		t.Fatalf("prime result = %#v, want improvement cluster synced", result)
	}
	followups, err := service.followups.ListFollowups(ctx, "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one self-growth followup", followups)
	}
	if followups[0].Kind != heartbeatFollowupKindSelfImprovement ||
		followups[0].SourceRef != "improvement_cluster:"+improvementClusterBotAutonomy ||
		!strings.Contains(anyMapString(followups[0].Metadata), improvementTopicHeartbeatTasking) {
		t.Fatalf("followup = %#v, want synced improvement cluster followup", followups[0])
	}
	signals, err := service.improvements.ListSignals(ctx, 10, []string{improvementSignalStatusAbsorbed}, time.Time{})
	if err != nil {
		t.Fatalf("ListSignals absorbed: %v", err)
	}
	if len(signals) != 1 {
		t.Fatalf("signals = %#v, want open signal absorbed after sync", signals)
	}
}

func writeRawHeartbeatFollowup(t *testing.T, service *Service, record SlackHeartbeatFollowup) {
	t.Helper()
	if service == nil || service.followups == nil || service.followups.followups == nil {
		t.Fatal("heartbeat store is not initialized")
	}
	if record.ID == 0 {
		t.Fatal("raw heartbeat followup requires an ID")
	}
	if err := service.followups.followups.Set(context.Background(), heartbeatKey(record.ID), record); err != nil {
		t.Fatalf("write raw heartbeat followup: %v", err)
	}
}
