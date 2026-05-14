package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

var slackPendingActionInteractions = map[string]struct{}{
	"confirmed": {},
	"dismissed": {},
	"snoozed":   {},
	"assigned":  {},
	"opened":    {},
}

func parsePendingActionInteraction(payload SlackInteractionPayload) *SlackPendingActionInteraction {
	action := SlackInteractionAction{}
	if len(payload.Actions) > 0 {
		action = payload.Actions[0]
	}
	fallbackID := pendingActionIDFromBlockID(action.BlockID)
	var parsed map[string]any
	if strings.TrimSpace(action.Value) != "" {
		if err := json.Unmarshal([]byte(action.Value), &parsed); err != nil {
			return nil
		}
	} else if action.ActionID == "mab_pending_action_assign" && fallbackID > 0 {
		parsed = map[string]any{"kind": "mab_pending_action", "id": fallbackID, "status": "assigned"}
	} else {
		return nil
	}
	if stringFromAny(parsed["kind"]) != "mab_pending_action" {
		return nil
	}
	status := firstNonEmpty(stringFromAny(parsed["status"]), "dismissed")
	if action.ActionID == "mab_pending_action_assign" {
		status = "assigned"
	}
	if _, ok := slackPendingActionInteractions[status]; !ok {
		status = "dismissed"
	}
	return &SlackPendingActionInteraction{
		ID:             int64FromAny(parsed["id"]),
		Status:         status,
		UserID:         firstNonEmpty(userID(payload.User), payload.UserID),
		ActionID:       action.ActionID,
		AssigneeUserID: firstNonEmpty(action.SelectedUser, stringFromAny(parsed["assigneeUserId"]), stringFromAny(parsed["assignee_user_id"])),
		SnoozeMinutes:  int(numberFromAny(firstNonEmpty(stringFromAny(parsed["snoozeMinutes"]), stringFromAny(parsed["snooze_minutes"])), 0)),
		ChannelID:      firstNonEmpty(stringFromAny(parsed["channelId"]), stringFromAny(parsed["channel_id"])),
		ThreadTS:       firstNonEmpty(stringFromAny(parsed["threadTs"]), stringFromAny(parsed["thread_ts"])),
	}
}

func (s *Service) HandlePendingActionInteraction(ctx context.Context, interaction SlackPendingActionInteraction) AvatarCommandResponse {
	if interaction.ID == 0 {
		return AvatarCommandResponse{OK: false, ResponseType: "ephemeral", Text: "Invalid pending action."}
	}
	updated, err := s.triage.UpdatePendingAction(ctx, interaction.ID, func(action *SlackPendingAction) {
		action.Status = interaction.Status
		action.ConfirmedBy = interaction.UserID
		if action.Params == nil {
			action.Params = make(map[string]any)
		}
		if interaction.AssigneeUserID != "" {
			action.Params["assigneeUserId"] = interaction.AssigneeUserID
		}
		if interaction.SnoozeMinutes > 0 {
			action.Params["snoozeMinutes"] = interaction.SnoozeMinutes
		}
		action.Result = fmt.Sprintf("interaction:%s", interaction.Status)
	})
	if err != nil {
		return AvatarCommandResponse{OK: false, ResponseType: "ephemeral", Text: "Pending action update failed: " + err.Error()}
	}
	if updated == nil {
		return AvatarCommandResponse{OK: false, ResponseType: "ephemeral", Text: "Pending action not found."}
	}
	workspaceID := "workspace"
	if err := s.cognition.RecordAction(ctx, workspaceID, updated.ChannelID, updated.ThreadTS, updated.ActionType, interaction.Status); err != nil {
		s.logger.Warn("slack pending action cognition update failed", "error", err)
	}
	return AvatarCommandResponse{
		OK:           true,
		ResponseType: "ephemeral",
		Text:         fmt.Sprintf("Pending action %d marked %s.", updated.ID, interaction.Status),
		Metadata: map[string]any{
			"pending_action": updated,
			"interaction":    interaction,
		},
	}
}

func pendingActionIDFromBlockID(blockID string) int64 {
	const prefix = "mab_pending_action:"
	if !strings.HasPrefix(blockID, prefix) {
		return 0
	}
	id, _ := strconv.ParseInt(strings.TrimPrefix(blockID, prefix), 10, 64)
	return id
}
