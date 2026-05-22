package slackagent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestPendingActionDismissedReplacesOriginalCard(t *testing.T) {
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeCreateIssue,
		Params: map[string]any{
			"title": "Create issue for flaky selection",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:        record.ID,
		Status:    "dismissed",
		UserID:    "U123",
		ChannelID: "C123",
		ThreadTS:  "123.456",
	})
	if !response.OK || !response.ReplaceOriginal {
		t.Fatalf("response = %#v, want replace_original resolved card", response)
	}
	encoded, _ := json.Marshal(response.Blocks)
	body := string(encoded)
	for _, want := range []string{"dismissed", "create_issue", "Create issue for flaky selection", "U123"} {
		if !strings.Contains(body, want) {
			t.Fatalf("blocks = %s, missing %q", body, want)
		}
	}
	if strings.Contains(body, "mab_pending_action_confirm") || strings.Contains(body, "mab_pending_action_dismiss") {
		t.Fatalf("blocks = %s, want resolved card without action buttons", body)
	}
}

func TestPendingActionOpenThreadKeepsOriginalCard(t *testing.T) {
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: "follow_up",
		Status:     PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:     record.ID,
		Status: "opened",
		UserID: "U123",
	})
	if !response.OK {
		t.Fatalf("response = %#v, want ok", response)
	}
	if response.ReplaceOriginal {
		t.Fatalf("response = %#v, open-thread helper should not replace original card", response)
	}
}

func TestPendingActionConfirmedPostThreadReplyPublishesOriginalThread(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
	})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeThreadReply,
		Params: map[string]any{
			"title":   "Review triage reply",
			"message": "这条可以发，但必须先由 Peng 确认。",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:        record.ID,
		Status:    "confirmed",
		UserID:    "U_PENG",
		ChannelID: "D_PENG",
	})
	if !response.OK || !response.ReplaceOriginal || !strings.Contains(response.Text, "posted thread reply") {
		t.Fatalf("response = %#v, want posted thread reply confirmation", response)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "C123" || calls[0].ThreadTS != "123.456" || !strings.Contains(calls[0].Text, "必须先由 Peng 确认") {
		t.Fatalf("poster calls = %#v, want confirmed reply posted to original thread", calls)
	}
	updated, err := service.triage.ListPendingActions(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListPendingActions: %v", err)
	}
	if len(updated) != 1 || !strings.HasPrefix(updated[0].Result, "posted:") {
		t.Fatalf("pending action = %#v, want posted result", updated)
	}
}

func TestPostThreadReplyApprovalCardOnlyShowsApproveReject(t *testing.T) {
	blocks := buildSlackTriageActionBlocks(SlackTriageDecisionAction{
		Type:       slackActionTypeThreadReply,
		Title:      "Review triage reply",
		Message:    "approval gate live smoke reply",
		Confidence: 0.98,
		ChannelID:  "C123",
		ThreadTS:   "123.456",
	}, SlackPendingAction{
		ID:         42,
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeThreadReply,
	})
	encoded, _ := json.Marshal(blocks)
	body := string(encoded)
	for _, want := range []string{"待确认回复", "approval gate live smoke reply", "通过并发送", "不通过", "mab_pending_action_confirm", "mab_pending_action_dismiss"} {
		if !strings.Contains(body, want) {
			t.Fatalf("blocks = %s, missing %q", body, want)
		}
	}
	for _, unwanted := range []string{"mab_pending_action_snooze", "mab_pending_action_open_thread", "mab_pending_action_assign", "Snooze", "Open thread", "Assign", "Quality gate", "Confidence", "Reason:"} {
		if strings.Contains(body, unwanted) {
			t.Fatalf("blocks = %s, unexpectedly contains %q", body, unwanted)
		}
	}
}
