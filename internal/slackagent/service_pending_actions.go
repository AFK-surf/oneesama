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
		RejectReason:   normalizeSlackVisibleReplyRejectReason(firstNonEmpty(stringFromAny(parsed["rejectReason"]), stringFromAny(parsed["reject_reason"]))),
		AssigneeUserID: firstNonEmpty(action.SelectedUser, stringFromAny(parsed["assigneeUserId"]), stringFromAny(parsed["assignee_user_id"])),
		SnoozeMinutes:  int(numberFromAny(firstNonEmpty(stringFromAny(parsed["snoozeMinutes"]), stringFromAny(parsed["snooze_minutes"])), 0)),
		ChannelID:      firstNonEmpty(stringFromAny(parsed["channelId"]), stringFromAny(parsed["channel_id"])),
		ThreadTS:       firstNonEmpty(stringFromAny(parsed["threadTs"]), stringFromAny(parsed["thread_ts"])),
		ResponseURL:    strings.TrimSpace(payload.ResponseURL),
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
		if action.ActionType == slackActionTypeThreadReply {
			action.Params["approvalDecision"] = slackTriagePendingApprovalDecision(interaction.Status)
			if interaction.Status == "dismissed" {
				action.Params["rejectReason"] = normalizeSlackVisibleReplyRejectReason(interaction.RejectReason)
			}
			if interaction.Status != "confirmed" {
				action.Params["finalOutcome"] = interaction.Status
			}
		}
		action.Result = fmt.Sprintf("interaction:%s", interaction.Status)
		recordSlackVisibleReplyQualitySampleParams(action)
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
	s.syncPendingActionInteractionFollowup(ctx, *updated, interaction)
	s.recordPendingActionFeedback(ctx, *updated, interaction)
	if interaction.Status == "confirmed" && updated.ActionType != slackActionTypeThreadReply {
		s.recordConfirmedActionFollowup(ctx, *updated, interaction)
	}
	if interaction.Status == "confirmed" {
		switch updated.ActionType {
		case slackActionTypeJoinMeeting:
			go s.executeJoinMeetingPendingAction(context.WithoutCancel(ctx), *updated, interaction)
			return AvatarCommandResponse{
				OK:              true,
				ResponseType:    "ephemeral",
				Text:            fmt.Sprintf("Pending action %d marked confirmed; executing join_meeting.", updated.ID),
				Blocks:          buildPendingActionResolvedBlocks(*updated, interaction, "executing join_meeting"),
				ReplaceOriginal: true,
				Metadata: map[string]any{
					"pending_action": updated,
					"interaction":    interaction,
					"execution":      "started",
				},
			}
		case slackActionTypeCreateCanvas:
			go s.executeCreateCanvasPendingAction(context.WithoutCancel(ctx), *updated, interaction)
			return AvatarCommandResponse{
				OK:              true,
				ResponseType:    "ephemeral",
				Text:            fmt.Sprintf("Pending action %d marked confirmed; executing create_canvas.", updated.ID),
				Blocks:          buildPendingActionResolvedBlocks(*updated, interaction, "executing create_canvas"),
				ReplaceOriginal: true,
				Metadata: map[string]any{
					"pending_action": updated,
					"interaction":    interaction,
					"execution":      "started",
				},
			}
		case slackActionTypeEditCanvas:
			go s.executeEditCanvasPendingAction(context.WithoutCancel(ctx), *updated, interaction)
			return AvatarCommandResponse{
				OK:              true,
				ResponseType:    "ephemeral",
				Text:            fmt.Sprintf("Pending action %d marked confirmed; executing edit_canvas.", updated.ID),
				Blocks:          buildPendingActionResolvedBlocks(*updated, interaction, "executing edit_canvas"),
				ReplaceOriginal: true,
				Metadata: map[string]any{
					"pending_action": updated,
					"interaction":    interaction,
					"execution":      "started",
				},
			}
		case slackActionTypeThreadReply:
			return s.executePostThreadReplyPendingAction(ctx, *updated, interaction)
		}
	}
	text := fmt.Sprintf("Pending action %d marked %s.", updated.ID, interaction.Status)
	return AvatarCommandResponse{
		OK:              true,
		ResponseType:    "ephemeral",
		Text:            text,
		Blocks:          buildPendingActionResolvedBlocks(*updated, interaction, ""),
		ReplaceOriginal: pendingActionInteractionReplacesOriginal(interaction.Status),
		Metadata: map[string]any{
			"pending_action": updated,
			"interaction":    interaction,
		},
	}
}

func (s *Service) StartPendingActionSocketInteraction(ctx context.Context, interaction SlackPendingActionInteraction) {
	s.LaunchAsyncInteraction(ctx, "pending_action_socket", func(detached context.Context) {
		response := s.HandlePendingActionInteraction(detached, interaction)
		if strings.TrimSpace(response.Text) == "" {
			response.Text = "Pending action updated."
		}
		response.ResponseType = ""
		response.Metadata = nil
		if strings.TrimSpace(interaction.ResponseURL) == "" {
			return
		}
		if err := postSlackInteractionResponse(detached, interaction.ResponseURL, response); err != nil {
			s.logger.Warn("slack pending action response update failed", "pending_action_id", interaction.ID, "status", interaction.Status, "error", err)
		}
	})
}

func slackTriagePendingApprovalDecision(status string) string {
	switch strings.TrimSpace(status) {
	case "confirmed":
		return "approved"
	case "dismissed":
		return "rejected"
	case "snoozed":
		return "snoozed"
	case "opened":
		return "opened"
	case "assigned":
		return "assigned"
	default:
		return firstNonEmpty(strings.TrimSpace(status), "updated")
	}
}

func pendingActionInteractionReplacesOriginal(status string) bool {
	return status != "opened"
}

func buildPendingActionResolvedBlocks(action SlackPendingAction, interaction SlackPendingActionInteraction, suffix string) []map[string]any {
	if action.ActionType == slackActionTypeThreadReply {
		return buildPostThreadReplyPendingResolvedBlocks(action, interaction, suffix)
	}
	status := firstNonEmpty(interaction.Status, action.Status, "updated")
	actionType := firstNonEmpty(action.ActionType, "follow_up")
	title := firstNonEmpty(stringFromAny(action.Params["title"]), stringFromAny(action.Params["summary"]), actionType)
	user := strings.TrimSpace(interaction.UserID)
	contextParts := []string{
		"Action: `" + actionType + "`",
		fmt.Sprintf("Pending: %d", action.ID),
		"Status: `" + status + "`",
	}
	if user != "" {
		contextParts = append(contextParts, "By: <@"+user+">")
	}
	if strings.TrimSpace(suffix) != "" {
		contextParts = append(contextParts, strings.TrimSpace(suffix))
	}
	return []map[string]any{
		{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": fmt.Sprintf("*Triage suggestion %s:* %s", status, title),
			},
		},
		{
			"type": "context",
			"elements": []map[string]any{{
				"type": "mrkdwn",
				"text": strings.Join(contextParts, " | "),
			}},
		},
	}
}

func buildPostThreadReplyPendingResolvedBlocks(action SlackPendingAction, interaction SlackPendingActionInteraction, suffix string) []map[string]any {
	status := firstNonEmpty(interaction.Status, action.Status, "updated")
	suffix = strings.TrimSpace(suffix)
	title := "已处理"
	detail := "这条待确认回复已处理。"
	switch status {
	case "confirmed":
		if strings.Contains(strings.ToLower(suffix), "fail") {
			title = "发送失败"
			detail = "这条回复没有发出去，原 thread 保持静默。"
		} else {
			title = "已发送"
			detail = "已把这条回复发送到原 thread。"
		}
	case "dismissed":
		title = "已拒绝"
		detail = "这条回复已保持静默。"
	case "snoozed":
		title = "已稍后再看"
		detail = "这条回复暂时不发送。"
	case "assigned":
		title = "已转交"
		detail = "这条回复暂时不发送。"
	}
	contextParts := []string{
		fmt.Sprintf("Pending: %d", action.ID),
		"Status: `" + status + "`",
	}
	if user := strings.TrimSpace(interaction.UserID); user != "" {
		contextParts = append(contextParts, "By: <@"+user+">")
	}
	if suffix != "" {
		contextParts = append(contextParts, suffix)
	}
	return []map[string]any{
		{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": "*" + title + "*\n" + detail,
			},
		},
		{
			"type": "context",
			"elements": []map[string]any{{
				"type": "mrkdwn",
				"text": strings.Join(contextParts, " | "),
			}},
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
