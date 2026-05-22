package slackagent

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

func buildSlackTriageActionText(action SlackTriageDecisionAction, pending SlackPendingAction) string {
	if firstNonEmpty(action.Type, pending.ActionType) == slackActionTypeThreadReply {
		return strings.Join([]string{
			"待确认回复",
			"",
			action.Message,
			"",
			fmt.Sprintf("Pending action: %d", pending.ID),
		}, "\n")
	}
	confidence := ""
	if !math.IsNaN(action.Confidence) {
		confidence = fmt.Sprintf(" confidence=%d%%", int(math.Round(action.Confidence*100)))
	}
	reason := ""
	if strings.TrimSpace(action.Reason) != "" {
		reason = "\nReason: " + strings.TrimSpace(action.Reason)
	}
	return strings.Join([]string{
		"Triage suggestion: " + firstNonEmpty(action.Title, "Review Slack activity"),
		"",
		action.Message,
		"",
		"Action: " + firstNonEmpty(action.Type, "follow_up") + confidence,
		fmt.Sprintf("Pending action: %d", pending.ID),
		reason,
	}, "\n")
}

func buildSlackTriageActionBlocks(action SlackTriageDecisionAction, pending SlackPendingAction) []map[string]any {
	actionType := firstNonEmpty(action.Type, pending.ActionType, "follow_up")
	threadTS := firstNonEmpty(action.ThreadTS, pending.ThreadTS)
	if actionType == slackActionTypeThreadReply {
		sourceParts := []string{fmt.Sprintf("Pending: %d", pending.ID)}
		channelID := firstNonEmpty(action.ChannelID, pending.ChannelID)
		if channelID != "" {
			sourceParts = append(sourceParts, "Channel: `"+channelID+"`")
		}
		if threadTS != "" {
			sourceParts = append(sourceParts, "Thread: `"+threadTS+"`")
		}
		return []map[string]any{
			{
				"type": "section",
				"text": map[string]any{
					"type": "mrkdwn",
					"text": "*待确认回复*\n" + action.Message,
				},
			},
			{
				"type": "context",
				"elements": []map[string]any{{
					"type": "mrkdwn",
					"text": strings.Join(sourceParts, " | "),
				}},
			},
			{
				"type":     "actions",
				"block_id": fmt.Sprintf("mab_pending_action:%d", pending.ID),
				"elements": []map[string]any{
					triageButton("通过并发送", "primary", "mab_pending_action_confirm", pending.ID, "confirmed", nil),
					triageButton("不通过", "danger", "mab_pending_action_dismiss", pending.ID, "dismissed", map[string]any{"rejectReason": slackVisibleReplyRejectReasonOther}),
				},
			},
		}
	}
	contextParts := []string{
		"Action: `" + actionType + "`",
		fmt.Sprintf("Confidence: %d%%", int(math.Round(action.Confidence*100))),
		fmt.Sprintf("Pending: %d", pending.ID),
	}
	if threadTS != "" {
		contextParts = append(contextParts, "Thread: `"+threadTS+"`")
	}
	blocks := []map[string]any{
		{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": "*Triage suggestion:* " + firstNonEmpty(action.Title, "Review Slack activity") + "\n" + action.Message,
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
	if strings.TrimSpace(action.Reason) != "" {
		blocks = append(blocks, map[string]any{
			"type": "context",
			"elements": []map[string]any{{
				"type": "mrkdwn",
				"text": "Reason: " + strings.TrimSpace(action.Reason),
			}},
		})
	}
	actionButtons := []map[string]any{
		triageButton("Confirm", "primary", "mab_pending_action_confirm", pending.ID, "confirmed", nil),
		triageButton("Dismiss", "danger", "mab_pending_action_dismiss", pending.ID, "dismissed", nil),
		triageButton("Snooze", "", "mab_pending_action_snooze", pending.ID, "snoozed", map[string]any{"snoozeMinutes": 60}),
		triageButton("Open thread", "", "mab_pending_action_open_thread", pending.ID, "opened", map[string]any{"channelId": firstNonEmpty(action.ChannelID, pending.ChannelID), "threadTs": threadTS}),
		{
			"type":        "users_select",
			"action_id":   "mab_pending_action_assign",
			"placeholder": map[string]any{"type": "plain_text", "text": "Assign"},
		},
	}
	blocks = append(blocks, map[string]any{
		"type":     "actions",
		"block_id": fmt.Sprintf("mab_pending_action:%d", pending.ID),
		"elements": actionButtons,
	})
	return blocks
}

func triageButton(text string, style string, actionID string, pendingID int64, status string, extra map[string]any) map[string]any {
	value := map[string]any{
		"kind":   "mab_pending_action",
		"id":     pendingID,
		"status": status,
	}
	for key, item := range extra {
		value[key] = item
	}
	payload, _ := json.Marshal(value)
	button := map[string]any{
		"type":      "button",
		"text":      map[string]any{"type": "plain_text", "text": text},
		"action_id": actionID,
		"value":     string(payload),
	}
	if style != "" {
		button["style"] = style
	}
	return button
}
