package slackagent

import (
	"context"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSuggestActionCreatesRecommendationAndHeartbeatFollowup(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
	})

	response, err := service.ExecuteSlackTool(context.Background(), SlackToolCallRequest{
		Tool: "suggest_action",
		Role: slackSuggestRoleAssistant,
		Args: map[string]any{
			"channel":     "C123",
			"thread_ts":   "123.456",
			"action_type": slackActionTypeCreateIssue,
			"title":       "Create issue for flaky selection",
			"summary":     "Selection fails in dark mode.",
			"params": map[string]any{
				"title": "Fix dark mode selection",
			},
		},
	})
	if err != nil || !response.OK {
		t.Fatalf("ExecuteSlackTool = %#v err=%v", response, err)
	}
	result, ok := response.Result.(*slackSuggestActionResult)
	if !ok || result.Recommendation == nil || result.Followup == nil {
		t.Fatalf("result = %#v, want recommendation and heartbeat followup", response.Result)
	}
	if result.PendingAction.CardTS == "" {
		t.Fatalf("pending action = %#v, want card ts", result.PendingAction)
	}
	if result.Recommendation.ChannelID != "C123" || result.Recommendation.ThreadTS != "123.456" || result.Recommendation.CardTS == "" {
		t.Fatalf("recommendation = %#v, want reserved source thread/card", result.Recommendation)
	}
	if result.Followup.SourceRef != pendingActionHeartbeatSourceRef(result.PendingAction.ID) || result.Followup.NextCheckAt == "" {
		t.Fatalf("followup = %#v, want pending-action source ref and next check", result.Followup)
	}
	status, err := service.SlackFollowupStatus(context.Background(), "", 10)
	if err != nil {
		t.Fatalf("SlackFollowupStatus: %v", err)
	}
	if len(status.ThreadRecommendations) != 1 || len(status.HeartbeatFollowups) != 1 {
		t.Fatalf("status = %#v, want one recommendation and one followup", status)
	}
}

func TestSuggestActionDedupesThreadRecommendation(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 2)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
	})
	args := map[string]any{
		"channel":     "C123",
		"thread_ts":   "123.456",
		"action_type": slackActionTypeCreateIssue,
		"title":       "Create issue for flaky selection",
		"summary":     "Selection fails in dark mode.",
		"params": map[string]any{
			"title": "Fix dark mode selection",
		},
	}
	first, err := service.ExecuteSlackTool(context.Background(), SlackToolCallRequest{Tool: "suggest_action", Role: slackSuggestRoleAssistant, Args: args})
	if err != nil || !first.OK {
		t.Fatalf("first suggest_action = %#v err=%v", first, err)
	}
	second, err := service.ExecuteSlackTool(context.Background(), SlackToolCallRequest{Tool: "suggest_action", Role: slackSuggestRoleAssistant, Args: args})
	if err != nil || !second.OK {
		t.Fatalf("second suggest_action = %#v err=%v", second, err)
	}
	status, err := service.SlackFollowupStatus(context.Background(), "", 10)
	if err != nil {
		t.Fatalf("SlackFollowupStatus: %v", err)
	}
	if len(status.ThreadRecommendations) != 1 {
		t.Fatalf("recommendations = %#v, want deduped single active recommendation", status.ThreadRecommendations)
	}
	if len(status.HeartbeatFollowups) != 2 {
		t.Fatalf("followups = %#v, want distinct pending-action followups per card", status.HeartbeatFollowups)
	}
}

func TestPendingActionDecisionResolvesHeartbeatFollowup(t *testing.T) {
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeCreateIssue,
		Params: map[string]any{
			"title": "Fix dark mode selection",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}
	if _, err := service.upsertPendingActionHeartbeatFollowup(context.Background(), *record, 0); err != nil {
		t.Fatalf("upsertPendingActionHeartbeatFollowup: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:     record.ID,
		Status: "dismissed",
		UserID: "U123",
	})
	if !response.OK {
		t.Fatalf("response = %#v, want ok", response)
	}
	status, err := service.SlackFollowupStatus(context.Background(), "", 10)
	if err != nil {
		t.Fatalf("SlackFollowupStatus: %v", err)
	}
	var pendingFollowup *SlackHeartbeatFollowup
	for i := range status.HeartbeatFollowups {
		if status.HeartbeatFollowups[i].SourceRef == pendingActionHeartbeatSourceRef(record.ID) {
			pendingFollowup = &status.HeartbeatFollowups[i]
			break
		}
	}
	if pendingFollowup == nil || pendingFollowup.Status != "done" {
		t.Fatalf("followups = %#v, want resolved pending-action followup", status.HeartbeatFollowups)
	}
	if !strings.Contains(stringFromAny(pendingFollowup.Metadata["resolution"]), "dismissed") {
		t.Fatalf("followup metadata = %#v, want dismissal resolution", pendingFollowup.Metadata)
	}
}
