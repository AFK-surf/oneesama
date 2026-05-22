package slackagent

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

func buildSlackTriageActionText(action SlackTriageDecisionAction, pending SlackPendingAction) string {
	if firstNonEmpty(action.Type, pending.ActionType) == slackActionTypeThreadReply {
		evidence := slackVisibleReplyEvidencePlainText(action)
		lines := []string{
			"待确认回复",
			"",
			action.Message,
		}
		if evidence != "" {
			lines = append(lines, "", evidence)
		}
		lines = append(lines, "", fmt.Sprintf("Pending action: %d", pending.ID))
		return strings.Join(lines, "\n")
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
		blocks := []map[string]any{
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
		}
		if evidenceText := slackVisibleReplyEvidenceMrkdwn(action); evidenceText != "" {
			blocks = append(blocks, map[string]any{
				"type": "context",
				"elements": []map[string]any{{
					"type": "mrkdwn",
					"text": evidenceText,
				}},
			})
		}
		blocks = append(blocks, map[string]any{
			"type":     "actions",
			"block_id": fmt.Sprintf("mab_pending_action:%d", pending.ID),
			"elements": []map[string]any{
				triageButton("通过并发送", "primary", "mab_pending_action_confirm", pending.ID, "confirmed", nil),
				triageButton("不通过", "danger", "mab_pending_action_dismiss", pending.ID, "dismissed", map[string]any{"rejectReason": slackVisibleReplyRejectReasonOther}),
			},
		})
		return blocks
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

func slackVisibleReplyEvidencePlainText(action SlackTriageDecisionAction) string {
	anchors := normalizeSlackVisibleEvidenceAnchors(action.EvidenceAnchors)
	if len(anchors) == 0 {
		return ""
	}
	lines := make([]string, 0, minInt(len(anchors), 3)+1)
	lines = append(lines, "Evidence: passed anchor gate")
	for _, anchor := range anchors {
		if len(lines) >= 4 {
			break
		}
		lines = append(lines, "- "+slackVisibleReplyEvidencePlainLine(anchor))
	}
	return strings.Join(lines, "\n")
}

func slackVisibleReplyEvidenceMrkdwn(action SlackTriageDecisionAction) string {
	anchors := normalizeSlackVisibleEvidenceAnchors(action.EvidenceAnchors)
	if len(anchors) == 0 {
		return ""
	}
	parts := make([]string, 0, minInt(len(anchors), 3)+1)
	parts = append(parts, "*Evidence:* passed anchor gate")
	for _, anchor := range anchors {
		if len(parts) >= 4 {
			break
		}
		parts = append(parts, slackVisibleReplyEvidenceMrkdwnLine(anchor))
	}
	return truncateSlackContextText(strings.Join(parts, " | "), 1800)
}

func slackVisibleReplyEvidencePlainLine(anchor SlackVisibleEvidenceAnchor) string {
	source := slackVisibleReplyEvidenceSourcePlain(anchor.SourceRef)
	quote := compactSlackVisibleEvidenceQuote(anchor.Quote, 110)
	if quote != "" {
		return fmt.Sprintf("%s: %s — %q", anchor.Kind, source, quote)
	}
	return fmt.Sprintf("%s: %s", anchor.Kind, source)
}

func slackVisibleReplyEvidenceMrkdwnLine(anchor SlackVisibleEvidenceAnchor) string {
	source := slackVisibleReplyEvidenceSourceMrkdwn(anchor.SourceRef)
	quote := compactSlackVisibleEvidenceQuote(anchor.Quote, 96)
	if quote != "" {
		return fmt.Sprintf("`%s` %s “%s”", slackMrkdwnEscape(anchor.Kind), source, slackMrkdwnEscape(quote))
	}
	return fmt.Sprintf("`%s` %s", slackMrkdwnEscape(anchor.Kind), source)
}

func slackVisibleReplyEvidenceSourcePlain(sourceRef string) string {
	source := truncateSlackContextText(strings.Join(strings.Fields(strings.TrimSpace(sourceRef)), " "), 140)
	if source == "" {
		return "-"
	}
	return source
}

func slackVisibleReplyEvidenceSourceMrkdwn(sourceRef string) string {
	sourceRef = truncateSlackContextText(strings.Join(strings.Fields(strings.TrimSpace(sourceRef)), " "), 140)
	if sourceRef == "" {
		return "`-`"
	}
	lower := strings.ToLower(sourceRef)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "slack://") {
		return "<" + slackMrkdwnURLSafe(sourceRef) + ">"
	}
	return "`" + slackMrkdwnEscape(sourceRef) + "`"
}

func compactSlackVisibleEvidenceQuote(value string, maxLength int) string {
	return truncateSlackContextText(strings.Join(strings.Fields(strings.TrimSpace(value)), " "), maxLength)
}

func slackMrkdwnURLSafe(value string) string {
	return strings.NewReplacer(">", "%3E", "|", "%7C").Replace(strings.TrimSpace(value))
}

func slackMrkdwnEscape(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "`", "'").Replace(strings.TrimSpace(value))
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
