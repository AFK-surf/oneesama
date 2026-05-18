package slackagent

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackTriageRecordsDelayedNoReplyFollowupForDeferredQuestion(t *testing.T) {
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_delayed_no_reply",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"这个问题先等其他人回复，暂时不用回。","actions":[]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			Triage: appconfig.SlackTriageConfig{HeuristicFallback: true},
		},
		Runner: runner,
	})

	started, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "这个方案是不是应该继续做？没人有想法吗？",
		TS:        "1779076415.945449",
	}}, "#meeting-avatar: 这个方案是不是应该继续做？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Finalization == nil || started.Finalization.Run == nil {
		t.Fatalf("started = %#v, want finalized triage run", started)
	}

	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one delayed no-reply candidate", followups)
	}
	got := followups[0]
	if got.Kind != slackDelayedNoReplyFollowupKind || got.ChannelID != "C123" || got.ThreadTS != "1779076415.945449" {
		t.Fatalf("followup = %#v, want delayed thread followup", got)
	}
	if got.Metadata["classification"] != "stale_wait_for_human" || got.Metadata["one_shot"] != true {
		t.Fatalf("metadata = %#v, want stale_wait_for_human one-shot", got.Metadata)
	}
	if got.NextCheckAt == "" || !strings.Contains(got.Summary, "补一下") {
		t.Fatalf("followup = %#v, want delayed public summary", got)
	}
}

func TestSlackTriageDoesNotRecordDelayedNoReplyForLowSignalChatter(t *testing.T) {
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_low_signal_no_delay",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"low signal acknowledgement; no action needed.","actions":[]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{Triage: appconfig.SlackTriageConfig{HeuristicFallback: true}},
		Runner:      runner,
	})

	if _, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "ok",
		TS:        "1779076415.945449",
	}}, "#meeting-avatar: ok"); err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 0 {
		t.Fatalf("followups = %#v, want none for low-signal chatter", followups)
	}
}

func TestDelayedNoReplyFollowupSurfacesOnceAndCloses(t *testing.T) {
	now := time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC)
	previousClock := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Kind:        slackDelayedNoReplyFollowupKind,
		Title:       "补一下这个开放问题",
		Summary:     "补一下这条：我的初步判断是先列选项。",
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   "C123",
		ThreadTS:    "123.456",
		SourceRef:   "delayed_no_reply:C123:123.456",
		Priority:    heartbeatFollowupPriorityUrgent,
		NextCheckAt: now.Add(-time.Minute).Format(time.RFC3339Nano),
		Metadata:    map[string]any{"one_shot": true},
	})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}

	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if len(response.Posted) != 1 || len(poster.Calls()) != 1 {
		t.Fatalf("response=%#v calls=%#v, want one post", response, poster.Calls())
	}
	updated, err := service.followups.GetFollowup(context.Background(), record.ID)
	if err != nil {
		t.Fatalf("GetFollowup: %v", err)
	}
	if updated == nil || updated.Status != "done" || updated.LastSurfacedAt == "" || updated.Metadata["resolution"] != "surfaced_once" {
		t.Fatalf("updated = %#v, want one-shot done followup", updated)
	}
}

func TestDelayedNoReplyFollowupSkipsWhenThreadHasNewerActivity(t *testing.T) {
	createdAt := time.Date(2026, 5, 18, 10, 0, 0, 0, time.UTC)
	current := createdAt
	previousClock := timeNow
	timeNow = func() time.Time { return current }
	t.Cleanup(func() { timeNow = previousClock })

	poster := &recordingPoster{}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Kind:        slackDelayedNoReplyFollowupKind,
		Title:       "补一下这个开放问题",
		Summary:     "补一下这条：我的初步判断是先列选项。",
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   "C123",
		ThreadTS:    "123.456",
		SourceRef:   "delayed_no_reply:C123:123.456",
		Priority:    heartbeatFollowupPriorityUrgent,
		NextCheckAt: createdAt.Add(-time.Minute).Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}

	current = createdAt.Add(2 * time.Hour)
	if err := service.cognition.RecordInbound(context.Background(), "workspace", SlackInboundMessage{
		ChannelID: "C123",
		ThreadTS:  "123.456",
		UserID:    "U456",
		TS:        current.Add(-5 * time.Minute).Format(time.RFC3339Nano),
		Text:      "我来接一下这个问题。",
	}); err != nil {
		t.Fatalf("RecordInbound: %v", err)
	}
	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if len(poster.Calls()) != 0 {
		t.Fatalf("poster calls = %#v, want none after newer activity", poster.Calls())
	}
	if len(response.Skipped) != 1 || response.Skipped[0].BlockReason != "thread_has_newer_activity" {
		t.Fatalf("response = %#v, want thread_has_newer_activity skip", response)
	}
	updated, err := service.followups.GetFollowup(context.Background(), record.ID)
	if err != nil {
		t.Fatalf("GetFollowup: %v", err)
	}
	if updated == nil || updated.Status != "done" || updated.Metadata["resolution"] != "thread_has_newer_activity" {
		t.Fatalf("updated = %#v, want obsolete delayed followup closed", updated)
	}
}
