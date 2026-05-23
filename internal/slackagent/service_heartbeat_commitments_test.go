package slackagent

import (
	"context"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestAssistantCommitmentFollowupCreatesCanonicalThreadRecord(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	ref := AssistantThreadRef{ChannelID: "C123", ThreadTS: "123.456"}

	service.maybeRecordAssistantCommitmentFollowup(context.Background(), ref, "我会跟进这个 PR，回头补一条验证结果。")
	service.maybeRecordAssistantCommitmentFollowup(context.Background(), ref, "稍后我会补上截图。")

	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one deduped thread commitment", followups)
	}
	followup := followups[0]
	if followup.Kind != "commitment" || followup.SourceRef != "thread_commitment:C123:123.456" || followup.Priority != heartbeatFollowupPriorityHigh {
		t.Fatalf("followup = %#v, want canonical high-priority commitment", followup)
	}
	if !strings.Contains(followup.Title, "稍后我会补上截图") {
		t.Fatalf("title = %q, want latest commitment text", followup.Title)
	}
}

func TestAssistantCommitmentFollowupIgnoresPlainReplies(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	service.maybeRecordAssistantCommitmentFollowup(context.Background(), AssistantThreadRef{ChannelID: "C123", ThreadTS: "123.456"}, "收到，这个结论是：不需要继续处理。")

	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 0 {
		t.Fatalf("followups = %#v, want no commitment for plain reply", followups)
	}
}

func TestPendingActionConfirmCreatesCompletionFollowupAndClosesDecisionFollowup(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	action, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeCreateIssue,
		Params: map[string]any{
			"title": "Create follow-up task",
		},
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}
	if _, err := service.upsertPendingActionHeartbeatFollowup(context.Background(), *action, pendingActionHeartbeatDefaultDelay); err != nil {
		t.Fatalf("upsertPendingActionHeartbeatFollowup: %v", err)
	}

	result := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:     action.ID,
		Status: "confirmed",
		UserID: "U123",
	})
	if !result.OK {
		t.Fatalf("HandlePendingActionInteraction = %#v", result)
	}
	open, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups(open): %v", err)
	}
	if !hasFollowupSourceRef(open, confirmedActionHeartbeatSourceRef(action.ID)) {
		t.Fatalf("open followups = %#v, want action-confirmed followup", open)
	}
	if hasFollowupSourceRef(open, pendingActionHeartbeatSourceRef(action.ID)) {
		t.Fatalf("open followups = %#v, pending-action decision followup should be closed", open)
	}
	done, err := service.followups.ListFollowups(context.Background(), "done", 10)
	if err != nil {
		t.Fatalf("ListFollowups(done): %v", err)
	}
	if len(done) != 1 || done[0].SourceRef != pendingActionHeartbeatSourceRef(action.ID) {
		t.Fatalf("done followups = %#v, want resolved pending-action decision", done)
	}
}

func hasFollowupSourceRef(records []SlackHeartbeatFollowup, sourceRef string) bool {
	for _, record := range records {
		if record.SourceRef == sourceRef {
			return true
		}
	}
	return false
}

func TestMeetingActionFollowupsUseDistinctSourceRefs(t *testing.T) {
	t.Parallel()

	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	service.enqueueMeetingActionFollowups(context.Background(), NormalizedMeetingWebhookPayload{
		MeetingID: 42,
		Title:     "Launch review",
		Summary: &MeetingSummaryData{
			ActionItems: []MeetingActionItem{
				{Title: "Send launch checklist", Owner: "Alice", Deadline: "tomorrow"},
				{Description: "Verify recording artifacts", Owner: "Bob"},
			},
		},
	}, MeetingSlackRef{ChannelID: "C123", ThreadTS: "123.456"})

	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 2 {
		t.Fatalf("followups = %#v, want two meeting action followups", followups)
	}
	refs := map[string]bool{}
	for _, followup := range followups {
		refs[followup.SourceRef] = true
		if followup.Kind != "commitment" || followup.ChannelID != "C123" || followup.ThreadTS != "123.456" {
			t.Fatalf("followup = %#v, want thread commitment", followup)
		}
	}
	for _, want := range []string{"meeting:42:action:1", "meeting:42:action:2"} {
		if !refs[want] {
			t.Fatalf("source refs = %#v, missing %s", refs, want)
		}
	}
}

func TestMeetingActionFollowupsDoNotSurfacePublicHeartbeat(t *testing.T) {
	t.Parallel()

	poster := &recordingPoster{}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	service.enqueueMeetingActionFollowups(context.Background(), NormalizedMeetingWebhookPayload{
		MeetingID: 42,
		Title:     "Google Meet",
		Summary: &MeetingSummaryData{
			ActionItems: []MeetingActionItem{
				{Title: "Keep testing the permission flow"},
			},
		},
	}, MeetingSlackRef{ChannelID: "C123", ThreadTS: "123.456"})

	open, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups(open): %v", err)
	}
	if len(open) != 1 {
		t.Fatalf("open followups = %#v, want one meeting action followup", open)
	}

	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: open[0].ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, meeting action followup should not post public heartbeat", got)
	}
	if len(response.Skipped) != 1 || response.Skipped[0].BlockReason != "meeting_action_followup_not_user_visible" || response.Skipped[0].DeliveredSurface != "" {
		t.Fatalf("response = %#v, want blocked meeting action followup without delivered surface", response)
	}
	updated, err := service.followups.GetFollowup(context.Background(), open[0].ID)
	if err != nil {
		t.Fatalf("GetFollowup: %v", err)
	}
	if updated == nil || updated.Status != "done" || stringFromAny(updated.Metadata["resolution"]) != "meeting_action_followup_not_user_visible" {
		t.Fatalf("updated followup = %#v, want closed as non-user-visible", updated)
	}
}
