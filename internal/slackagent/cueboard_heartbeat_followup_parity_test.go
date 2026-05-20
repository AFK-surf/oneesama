//go:build cueboardparity

package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityFollowupCreateCapturesThreadSource(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	created, err := service.CreateSlackFollowupSurface(context.Background(), SlackFollowupCreateRequest{
		ChannelID: "C123",
		ThreadTS:  "123.456",
		Kind:      "commitment",
		Title:     "Send heartbeat diagram",
		Summary:   "Need to come back with the heartbeat architecture diagram.",
		Priority:  "high",
	})
	if err != nil || !created.OK || created.Followup == nil {
		t.Fatalf("CreateSlackFollowupSurface = %#v err=%v", created, err)
	}
	if created.Followup.SourceKind != "thread" || created.Followup.ChannelID != "C123" || created.Followup.ThreadTS != "123.456" {
		t.Fatalf("followup source = %#v", created.Followup)
	}
	if created.Followup.SourceRef != "thread_commitment:C123:123.456" {
		t.Fatalf("source ref = %q, want canonical thread commitment", created.Followup.SourceRef)
	}
}

func TestCueboardParityFollowupStatusListsCurrentCollections(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	_, err := service.CreateSlackFollowupSurface(context.Background(), SlackFollowupCreateRequest{
		ChannelID:          "C123",
		ThreadTS:           "123.456",
		Title:              "Follow up owner",
		Summary:            "Ask owner for update",
		RecommendationType: "reply",
		OutboundActionType: "dm",
	})
	if err != nil {
		t.Fatalf("CreateSlackFollowupSurface: %v", err)
	}
	status, err := service.SlackFollowupStatus(context.Background(), "", 10)
	if err != nil {
		t.Fatalf("SlackFollowupStatus: %v", err)
	}
	if len(status.HeartbeatFollowups) != 1 || len(status.HeartbeatSurfaces) != 1 || len(status.ThreadRecommendations) != 1 || len(status.OutboundActions) != 1 {
		t.Fatalf("status = %#v, want followup/surface/recommendation/outbound", status)
	}
}

func TestCueboardParityResolveFollowupClosesRecord(t *testing.T) {
	t.Parallel()

	store := newSlackHeartbeatStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())
	record, err := store.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "Follow up with diagram"})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	updated, err := store.ResolveFollowup(context.Background(), record.ID, "done", "Posted the diagram in-thread.")
	if err != nil {
		t.Fatalf("ResolveFollowup: %v", err)
	}
	if updated == nil || updated.Status != "done" || updated.Metadata["resolution"] != "Posted the diagram in-thread." {
		t.Fatalf("resolved = %#v", updated)
	}
	open, err := store.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(open) != 0 {
		t.Fatalf("open followups = %#v, want none", open)
	}
}

func TestCueboardParityResolveFollowupMissingIDIsNoop(t *testing.T) {
	t.Parallel()

	store := newSlackHeartbeatStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())
	updated, err := store.ResolveFollowup(context.Background(), 999, "done", "missing")
	if err != nil {
		t.Fatalf("ResolveFollowup missing: %v", err)
	}
	if updated != nil {
		t.Fatalf("updated = %#v, want nil for missing followup", updated)
	}
}

func TestCueboardParityCanonicalThreadCommitmentsDedupe(t *testing.T) {
	t.Parallel()

	store := newSlackHeartbeatStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())
	first, err := store.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Kind:       "commitment",
		Title:      "监督 Codex 完成 CUE-1309",
		Summary:    "旧的 thread commitment。",
		SourceKind: "thread",
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		SourceRef:  "slack:C123:123.456",
		Priority:   "high",
	})
	if err != nil {
		t.Fatalf("first CreateFollowup: %v", err)
	}
	second, err := store.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Kind:       "commitment",
		Title:      "继续盯 CUE-1309 PR",
		Summary:    "新的 thread commitment。",
		SourceKind: "thread",
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		SourceRef:  "C123/123.456",
	})
	if err != nil {
		t.Fatalf("second CreateFollowup: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("expected canonical thread commitment dedupe, first=%d second=%d", first.ID, second.ID)
	}
	records, err := store.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(records) != 1 || records[0].SourceRef != "thread_commitment:C123:123.456" || records[0].Title != "继续盯 CUE-1309 PR" {
		t.Fatalf("records = %#v, want updated canonical record", records)
	}
}

func TestCueboardParityMeetingCommitmentsStayDistinct(t *testing.T) {
	t.Parallel()

	store := newSlackHeartbeatStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())
	first, err := store.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Kind: "commitment", Title: "Meeting follow-up: first", SourceKind: "thread", ChannelID: "C123", ThreadTS: "123.456", SourceRef: "meeting:1:action:1"})
	if err != nil {
		t.Fatalf("first CreateFollowup: %v", err)
	}
	second, err := store.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Kind: "commitment", Title: "Meeting follow-up: second", SourceKind: "thread", ChannelID: "C123", ThreadTS: "123.456", SourceRef: "meeting:1:action:2"})
	if err != nil {
		t.Fatalf("second CreateFollowup: %v", err)
	}
	if second.ID == first.ID {
		t.Fatalf("expected distinct meeting commitments, got same id %d", second.ID)
	}
}

func TestCueboardParityFollowupSourceRefFallbackUsesThread(t *testing.T) {
	t.Parallel()

	record := normalizeHeartbeatFollowup(SlackHeartbeatFollowup{Title: "Review PR", ChannelID: "C123", ThreadTS: "123.456"})
	if record.SourceRef != "C123:123.456" {
		t.Fatalf("source ref = %q, want channel/thread fallback", record.SourceRef)
	}
}

func TestCueboardParityBuildHeartbeatContextIncludesOpenFollowups(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	_, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Kind:      "commitment",
		Title:     "Heartbeat diagram",
		Summary:   "Need to send the diagram back in-thread.",
		ChannelID: "C123",
		ThreadTS:  "123.456",
	})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	body, err := service.BuildHeartbeatContext(context.Background())
	if err != nil {
		t.Fatalf("BuildHeartbeatContext: %v", err)
	}
	for _, want := range []string{"Server-selected candidate tasks", "Open follow-ups:", "Heartbeat diagram", "Recent heartbeat surfaces"} {
		if !strings.Contains(body, want) {
			t.Fatalf("heartbeat context missing %q:\n%s", want, body)
		}
	}
}

func TestCueboardParityBuildHeartbeatContextExcludesDoneFollowups(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "Old resolved item"})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	if _, err := service.followups.ResolveFollowup(context.Background(), record.ID, "done", "done"); err != nil {
		t.Fatalf("ResolveFollowup: %v", err)
	}
	body, err := service.BuildHeartbeatContext(context.Background())
	if err != nil {
		t.Fatalf("BuildHeartbeatContext: %v", err)
	}
	if strings.Contains(body, "Old resolved item") {
		t.Fatalf("resolved followup should not appear:\n%s", body)
	}
}

func TestCueboardParityBuildHeartbeatContextIncludesRecentSurfaces(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	if _, err := service.followups.RecordSurface(context.Background(), SlackHeartbeatSurface{Title: "Heartbeat diagram", Summary: "Already nudged once.", DeliveredSurface: "slack_thread", Status: "sent"}); err != nil {
		t.Fatalf("RecordSurface: %v", err)
	}
	body, err := service.BuildHeartbeatContext(context.Background())
	if err != nil {
		t.Fatalf("BuildHeartbeatContext: %v", err)
	}
	if !strings.Contains(body, "Heartbeat diagram via slack_thread") {
		t.Fatalf("recent surface missing:\n%s", body)
	}
}

func TestCueboardParityFollowupCreateSideEffectsReserveRecommendationAndOutbound(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	result, err := service.CreateSlackFollowupSurface(context.Background(), SlackFollowupCreateRequest{
		ChannelID:          "C123",
		ThreadTS:           "123.456",
		Title:              "Review PR request",
		Summary:            "Ping this thread later if nobody reviews the PR.",
		RecommendationType: "reply",
		OutboundActionType: "dm",
		OutboundStatus:     "pending",
	})
	if err != nil || result.Recommendation == nil || result.Outbound == nil {
		t.Fatalf("result = %#v err=%v, want recommendation and outbound action", result, err)
	}
	if result.Recommendation.ChannelID != "C123" || result.Outbound.Reference == "" {
		t.Fatalf("side effects = rec %#v outbound %#v", result.Recommendation, result.Outbound)
	}
}

func TestCueboardParitySurfaceFollowupPostsThreadMessage(t *testing.T) {
	withCueboardParityClock(t, time.Date(2026, 3, 24, 11, 0, 0, 0, shanghaiLocation()))
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "Diagram follow-up", Summary: "Send the architecture sketch.", ChannelID: "C123", ThreadTS: "123.456"})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	poster.WaitForCalls(t, 1)
	if len(response.Posted) != 1 || response.Posted[0].Status != "sent" {
		t.Fatalf("response = %#v, want posted surface", response)
	}
	call := poster.Calls()[0]
	if call.Channel != "C123" || call.ThreadTS != "123.456" || !strings.Contains(call.Text, "Diagram follow-up") {
		t.Fatalf("post call = %#v", call)
	}
}

func TestCueboardParitySurfaceFollowupRecordsBlockedMissingTarget(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "No target"})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if len(response.Skipped) != 1 || response.Skipped[0].BlockReason != "no_user_visible_target" || response.Skipped[0].DeliveredSurface != "" {
		t.Fatalf("response = %#v, want blocked no user-visible target without delivered surface", response)
	}
}

func TestCueboardParitySurfaceFollowupBlocksWhenRecentlySurfaced(t *testing.T) {
	now := time.Date(2026, 3, 24, 11, 0, 0, 0, shanghaiLocation())
	withCueboardParityClock(t, now)
	poster := &recordingPoster{}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Title:          "Ping again later",
		ChannelID:      "C123",
		ThreadTS:       "123.456",
		SourceKind:     "thread",
		LastSurfacedAt: now.Add(-2 * time.Hour).Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want none", got)
	}
	if len(response.Skipped) != 1 || response.Skipped[0].BlockReason != "followup_rate_limited" {
		t.Fatalf("response = %#v, want followup_rate_limited", response)
	}
}

func TestCueboardParitySurfaceFollowupBlocksDuringQuietHours(t *testing.T) {
	now := time.Date(2026, 3, 24, 22, 15, 0, 0, shanghaiLocation())
	withCueboardParityClock(t, now)
	poster := &recordingPoster{}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "Late public nudge", ChannelID: "C123", ThreadTS: "123.456", SourceKind: "thread", Priority: "normal"})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want none", got)
	}
	if len(response.Skipped) != 1 || response.Skipped[0].BlockReason != "quiet_hours" {
		t.Fatalf("response = %#v, want quiet_hours", response)
	}
}

func TestCueboardParitySurfaceFollowupUrgentBypassesQuietHours(t *testing.T) {
	now := time.Date(2026, 3, 24, 22, 15, 0, 0, shanghaiLocation())
	withCueboardParityClock(t, now)
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "Urgent public nudge", ChannelID: "C123", ThreadTS: "123.456", SourceKind: "thread", Priority: "urgent"})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	poster.WaitForCalls(t, 1)
	if len(response.Posted) != 1 || response.Posted[0].Status != "sent" {
		t.Fatalf("response = %#v, want sent urgent surface", response)
	}
}

func TestCueboardParitySurfaceFollowupBlocksWhenPublicRateLimited(t *testing.T) {
	now := time.Date(2026, 3, 24, 11, 0, 0, 0, shanghaiLocation())
	withCueboardParityClock(t, now)
	poster := &recordingPoster{}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	for i := 0; i < 3; i++ {
		if _, err := service.followups.RecordSurface(context.Background(), SlackHeartbeatSurface{Title: "prior", RequestedSurface: "thread", DeliveredSurface: "thread", Status: "sent", CreatedAt: now.Add(-time.Duration(i) * time.Hour).Format(time.RFC3339Nano)}); err != nil {
			t.Fatalf("RecordSurface #%d: %v", i, err)
		}
	}
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "Fourth public nudge", ChannelID: "C123", ThreadTS: "123.456", SourceKind: "thread", Priority: "normal"})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want none", got)
	}
	if len(response.Skipped) != 1 || response.Skipped[0].BlockReason != "public_rate_limited" {
		t.Fatalf("response = %#v, want public_rate_limited", response)
	}
}

func TestCueboardParitySurfaceFollowupBlocksWhenThreadHasNewerActivity(t *testing.T) {
	now := time.Date(2026, 3, 24, 11, 0, 0, 0, time.UTC)
	createdAt := now.Add(-30 * time.Minute)
	current := createdAt
	previousClock := timeNow
	timeNow = func() time.Time { return current }
	t.Cleanup(func() { timeNow = previousClock })
	poster := &recordingPoster{}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "Thread already moved", ChannelID: "C123", ThreadTS: "123.456", SourceKind: "thread", Priority: "normal", CreatedAt: createdAt.Format(time.RFC3339Nano), UpdatedAt: createdAt.Format(time.RFC3339Nano)})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	current = now
	if err := service.cognition.RecordInbound(context.Background(), "workspace", SlackInboundMessage{ChannelID: "C123", ThreadTS: "123.456", UserID: "U123", TS: now.Add(-5 * time.Minute).Format(time.RFC3339Nano), Text: "newer human update"}); err != nil {
		t.Fatalf("RecordInbound: %v", err)
	}
	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want none", got)
	}
	if len(response.Skipped) != 1 || response.Skipped[0].BlockReason != "thread_has_newer_activity" {
		t.Fatalf("response = %#v, want thread_has_newer_activity", response)
	}
}

func TestCueboardParitySurfaceFollowupBlocksWhenAnyWorkspaceLedgerUpdated(t *testing.T) {
	now := time.Date(2026, 3, 24, 11, 0, 0, 0, time.UTC)
	createdAt := now.Add(-30 * time.Minute)
	current := createdAt
	previousClock := timeNow
	timeNow = func() time.Time { return current }
	t.Cleanup(func() { timeNow = previousClock })
	poster := &recordingPoster{}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "Thread already handled", ChannelID: "C123", ThreadTS: "123.456", SourceKind: "thread", Priority: "normal", CreatedAt: createdAt.Format(time.RFC3339Nano), UpdatedAt: createdAt.Format(time.RFC3339Nano)})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	current = now
	if err := service.cognition.RecordTriageSummary(context.Background(), "T123", "C123", "123.456", "triage:done", "Decision: thread already has a useful answer.", "no_action"); err != nil {
		t.Fatalf("RecordTriageSummary: %v", err)
	}
	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want none", got)
	}
	if len(response.Skipped) != 1 || response.Skipped[0].BlockReason != "thread_has_newer_activity" {
		t.Fatalf("response = %#v, want thread_has_newer_activity", response)
	}
}

func TestCueboardParitySurfaceFollowupUpdatesLastSurfacedAt(t *testing.T) {
	withCueboardParityClock(t, time.Date(2026, 3, 24, 11, 0, 0, 0, shanghaiLocation()))
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: &recordingPoster{callCh: make(chan struct{}, 1)}})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "Ping", ChannelID: "C123", ThreadTS: "123.456"})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}
	if _, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID}); err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	updated, err := service.followups.GetFollowup(context.Background(), record.ID)
	if err != nil {
		t.Fatalf("GetFollowup: %v", err)
	}
	if updated == nil || updated.LastSurfacedAt == "" {
		t.Fatalf("updated followup = %#v, want last surfaced", updated)
	}
}

func TestCueboardParityHeartbeatDeliveryAutoRoutesThread(t *testing.T) {
	t.Parallel()

	target := heartbeatDeliveryTarget(SlackHeartbeatFollowup{SourceKind: "thread", ChannelID: "C123", ThreadTS: "123.456"}, "auto")
	if target.channelID != "C123" || target.threadTS != "123.456" || target.blockReason != "" {
		t.Fatalf("target = %#v", target)
	}
}

func TestCueboardParityHeartbeatDeliveryAutoWithoutTargetBlocks(t *testing.T) {
	t.Parallel()

	target := heartbeatDeliveryTarget(SlackHeartbeatFollowup{}, "auto")
	if target.blockReason != "no_user_visible_target" {
		t.Fatalf("target = %#v, want no_user_visible_target", target)
	}
}

func TestCueboardParityHeartbeatDeliveryAllowsDMSourcedFollowup(t *testing.T) {
	t.Parallel()

	target := heartbeatDeliveryTarget(SlackHeartbeatFollowup{SourceKind: "dm", ChannelID: "D123"}, "auto")
	if target.channelID != "D123" || target.threadTS != "" || target.blockReason != "" {
		t.Fatalf("target = %#v, want DM channel target", target)
	}
}

func TestCueboardParityHeartbeatDeliveryExplicitChannelSurface(t *testing.T) {
	t.Parallel()

	target := heartbeatDeliveryTarget(SlackHeartbeatFollowup{ChannelID: "C123"}, "slack_channel")
	if target.channelID != "C123" || target.threadTS != "" || target.blockReason != "" {
		t.Fatalf("target = %#v, want channel-level target", target)
	}
}

func TestCueboardParityHeartbeatDeliveryUnsupportedSurfaceBlocks(t *testing.T) {
	t.Parallel()

	target := heartbeatDeliveryTarget(SlackHeartbeatFollowup{ChannelID: "C123", ThreadTS: "123.456"}, "unsupported_panel")
	if target.blockReason != "unsupported_surface" {
		t.Fatalf("target = %#v, want unsupported_surface", target)
	}
}

func TestCueboardParityHeartbeatSurfaceTextIncludesTitleAndSummary(t *testing.T) {
	t.Parallel()

	got := heartbeatSurfaceText(SlackHeartbeatFollowup{Title: "已继续跟进 CUE-1309", Summary: "补发具体剩余检查项"})
	if !strings.Contains(got, ":heartbeat: *已继续跟进 CUE-1309*") || !strings.Contains(got, "补发具体剩余检查项") {
		t.Fatalf("surface text = %q", got)
	}
}

func TestCueboardParitySupervisoryDoneSignalSuppressesClosure(t *testing.T) {
	t.Parallel()

	_, _, suppress := normalizeSupervisoryHeartbeatNotification("CUE-1309 监督已闭环", "Codex posted a done signal.", &SlackHeartbeatFollowup{Status: "done", Metadata: map[string]any{"issue_identifier": "CUE-1309"}})
	if !suppress {
		t.Fatal("expected done-signal closure to be suppressed")
	}
}

func TestCueboardParitySupervisoryVerifiedClosureRewritesTitle(t *testing.T) {
	t.Parallel()

	title, summary, suppress := normalizeSupervisoryHeartbeatNotification("CUE-1309 监督已闭环", "我已独立复查并确认验证缺口已补齐。", &SlackHeartbeatFollowup{Status: "done", Metadata: map[string]any{"issue_identifier": "CUE-1309"}})
	if suppress || title != "已复查 CUE-1309" || !strings.Contains(summary, "独立复查") {
		t.Fatalf("title=%q summary=%q suppress=%v", title, summary, suppress)
	}
}

func TestCueboardParityScopedRuntimeHeartbeatHidesForeignLastResult(t *testing.T) {
	t.Parallel()

	scoped := scopedRuntimeHeartbeat(&slackRuntimeStatusData{HeartbeatLastFollowupID: 2, HeartbeatTitle: "Foreign", HeartbeatNotified: true}, []SlackHeartbeatFollowup{
		{ID: 1, Title: "Current", ChannelID: "C123", ThreadTS: "123.456"},
		{ID: 2, Title: "Foreign", ChannelID: "C999", ThreadTS: "999.000"},
	}, nil, "C123", "123.456")
	if !scoped.HeartbeatLastResultHidden || scoped.HeartbeatVisiblePendingCount != 1 {
		t.Fatalf("scoped = %#v, want hidden foreign result and one visible followup", scoped)
	}
}

func TestCueboardParityCleanupStaleOutboundActionsFreesRetry(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 24, 11, 0, 0, 0, time.UTC)
	withCueboardParityClock(t, now)
	store := newSlackHeartbeatStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())
	_, err := store.ReserveOutboundAction(context.Background(), SlackOutboundAction{ActionType: "dm", Target: "U1", Reference: "old", Status: "pending", CreatedAt: now.Add(-time.Hour).Format(time.RFC3339Nano)})
	if err != nil {
		t.Fatalf("ReserveOutboundAction: %v", err)
	}
	cleaned, err := store.CleanupStalePendingActions(context.Background(), 10*time.Minute)
	if err != nil || cleaned != 1 {
		t.Fatalf("CleanupStalePendingActions cleaned=%d err=%v", cleaned, err)
	}
	retry, err := store.ReserveOutboundAction(context.Background(), SlackOutboundAction{ActionType: "dm", Target: "U1", Reference: "old", Status: "pending"})
	if err != nil || retry == nil {
		t.Fatalf("retry = %#v err=%v, want allowed", retry, err)
	}
}

func TestCueboardParityListFollowupsFiltersStatusAndSortsDue(t *testing.T) {
	t.Parallel()

	store := newSlackHeartbeatStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())
	_, _ = store.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "later", NextCheckAt: "2026-03-24T12:00:00Z"})
	_, _ = store.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "earlier", NextCheckAt: "2026-03-24T10:00:00Z"})
	done, _ := store.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "done"})
	_, _ = store.ResolveFollowup(context.Background(), done.ID, "done", "")
	open, err := store.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(open) != 2 || open[0].Title != "earlier" || open[1].Title != "later" {
		t.Fatalf("open = %#v, want due-sorted open followups", open)
	}
}

func TestCueboardParityListSurfacesMostRecentFirst(t *testing.T) {
	t.Parallel()

	store := newSlackHeartbeatStore(appconfig.PersistenceConfig{Provider: "memory"}, cueboardParityDiscardLogger())
	_, _ = store.RecordSurface(context.Background(), SlackHeartbeatSurface{Title: "old", CreatedAt: "2026-03-24T10:00:00Z"})
	_, _ = store.RecordSurface(context.Background(), SlackHeartbeatSurface{Title: "new", CreatedAt: "2026-03-24T12:00:00Z"})
	surfaces, err := store.ListSurfaces(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListSurfaces: %v", err)
	}
	if len(surfaces) != 2 || surfaces[0].Title != "new" {
		t.Fatalf("surfaces = %#v, want most recent first", surfaces)
	}
}

func TestCueboardParityPendingHeartbeatFollowupsCanTargetSingleID(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	first, _ := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "first"})
	_, _ = service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{Title: "second"})
	got, err := service.pendingHeartbeatFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: first.ID})
	if err != nil {
		t.Fatalf("pendingHeartbeatFollowups: %v", err)
	}
	if len(got) != 1 || got[0].ID != first.ID {
		t.Fatalf("got = %#v, want selected followup only", got)
	}
}

func TestCueboardParityFollowupCreateEndpointReturnsFullStatus(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	response := postInternalJSON(t, router, "/slack/followups/create", `{"channel_id":"C123","thread_ts":"123.456","title":"Follow up owner","summary":"Ask owner for update","recommendation_type":"reply","outbound_action_type":"dm"}`)
	if response.Code != 200 {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, want := range []string{`"ok":true`, `"followup"`, `"surface"`, `"recommendation"`, `"outbound"`, `"heartbeatFollowups"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q:\n%s", want, body)
		}
	}
}

func TestCueboardParityFollowupSurfaceEndpointPostsSelectedFollowup(t *testing.T) {
	withCueboardParityClock(t, time.Date(2026, 3, 24, 11, 0, 0, 0, shanghaiLocation()))
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	router := newTestRouter(t, Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	create := postInternalJSON(t, router, "/slack/followups/create", `{"channel_id":"C123","thread_ts":"123.456","title":"Surface me","summary":"Thread reminder"}`)
	var created SlackFollowupCreateResponse
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if created.Followup == nil {
		t.Fatalf("create body missing followup: %s", create.Body.String())
	}
	surface := postInternalJSON(t, router, "/slack/followups/surface", `{"followup_id":`+heartbeatKey(created.Followup.ID)+`}`)
	if surface.Code != 200 {
		t.Fatalf("surface status=%d body=%s", surface.Code, surface.Body.String())
	}
	poster.WaitForCalls(t, 1)
	if !strings.Contains(surface.Body.String(), `"posted"`) {
		t.Fatalf("surface body = %s, want posted", surface.Body.String())
	}
}

func TestCueboardParityHeartbeatContextEndpointSurfacesFollowupDigest(t *testing.T) {
	t.Parallel()

	router := newTestRouter(t, Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	_ = postInternalJSON(t, router, "/slack/followups/create", `{"channel_id":"C123","thread_ts":"123.456","title":"Context item","summary":"Need to follow up"}`)
	response := httptestGetInternal(t, router, "/slack/heartbeat/context")
	if response.Code != 200 {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "Context item") {
		t.Fatalf("context body = %s", response.Body.String())
	}
}

func httptestGetInternal(t *testing.T, router http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.RemoteAddr = "127.0.0.1:4040"
	router.ServeHTTP(response, request)
	return response
}
