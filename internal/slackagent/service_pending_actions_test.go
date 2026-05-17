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
