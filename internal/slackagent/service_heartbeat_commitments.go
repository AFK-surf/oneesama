package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	assistantCommitmentFollowupDelay = time.Hour
	confirmedActionFollowupDelay     = 2 * time.Hour
	meetingActionFollowupDelay       = 24 * time.Hour
)

func (s *Service) maybeRecordAssistantCommitmentFollowup(ctx context.Context, ref AssistantThreadRef, assistantText string) {
	if s == nil || s.followups == nil {
		return
	}
	channelID := strings.TrimSpace(ref.ChannelID)
	threadTS := strings.TrimSpace(ref.ThreadTS)
	if channelID == "" || threadTS == "" || !looksLikeAssistantCommitment(assistantText) {
		return
	}
	title := assistantCommitmentTitle(assistantText)
	summary := "Assistant said it would follow up in this thread."
	if line := truncateSlackContextText(strings.TrimSpace(firstTextLine(assistantText)), 220); line != "" {
		summary += " Latest commitment: " + line
	}
	if _, err := s.followups.CreateFollowup(ctx, SlackHeartbeatFollowup{
		Kind:        "commitment",
		Title:       title,
		Summary:     summary,
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   channelID,
		ThreadTS:    threadTS,
		Priority:    heartbeatFollowupPriorityHigh,
		NextCheckAt: timeNow().UTC().Add(assistantCommitmentFollowupDelay).Format(time.RFC3339Nano),
		Metadata: map[string]any{
			"source": "assistant_commitment",
		},
	}); err != nil {
		s.logger.Warn("slack assistant commitment followup create failed", "channel", channelID, "thread_ts", threadTS, "error", err)
	}
}

func looksLikeAssistantCommitment(text string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(text)), " "))
	if normalized == "" {
		return false
	}
	for _, phrase := range []string{
		"follow up",
		"follow-up",
		"circle back",
		"check back",
		"keep an eye",
		"will update",
		"i'll update",
		"i will update",
		"i’ll update",
		"我会跟进",
		"我来跟进",
		"继续跟进",
		"我继续盯",
		"我会盯",
		"我来盯",
		"我回头",
		"回头我",
		"稍后我",
		"我稍后",
		"之后我",
		"我之后",
		"晚点我",
		"我晚点",
		"我会补",
		"我来补",
		"我会检查",
		"我会确认",
	} {
		if strings.Contains(normalized, phrase) {
			return true
		}
	}
	return false
}

func assistantCommitmentTitle(text string) string {
	line := strings.TrimSpace(firstTextLine(text))
	line = strings.TrimPrefix(line, ":heartbeat:")
	line = strings.TrimSpace(line)
	if line == "" {
		return "Follow up on assistant commitment"
	}
	return "Follow up: " + truncateSlackContextText(trimSlackResultMarkup(line), 80)
}

func (s *Service) recordConfirmedActionFollowup(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction) {
	if s == nil || s.followups == nil || action.ID == 0 || !strings.EqualFold(interaction.Status, "confirmed") {
		return
	}
	title := pendingActionTitle(action)
	summary := fmt.Sprintf("Confirmed `%s` action needs completion follow-up.", firstNonEmpty(action.ActionType, "follow_up"))
	if title != "" {
		summary += " " + title
	}
	if _, err := s.followups.CreateFollowup(ctx, SlackHeartbeatFollowup{
		Kind:        "commitment",
		Title:       "Follow up confirmed action: " + firstNonEmpty(title, action.ActionType, "pending action"),
		Summary:     summary,
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   action.ChannelID,
		ThreadTS:    action.ThreadTS,
		SourceRef:   confirmedActionHeartbeatSourceRef(action.ID),
		Priority:    heartbeatFollowupPriorityHigh,
		NextCheckAt: timeNow().UTC().Add(confirmedActionFollowupDelay).Format(time.RFC3339Nano),
		Metadata: map[string]any{
			"source":            "confirmed_action",
			"pending_action_id": action.ID,
			"action_type":       action.ActionType,
			"confirmed_by":      interaction.UserID,
		},
	}); err != nil {
		s.logger.Warn("slack confirmed action followup create failed", "pending_action_id", action.ID, "error", err)
	}
}

func confirmedActionHeartbeatSourceRef(id int64) string {
	if id == 0 {
		return ""
	}
	return fmt.Sprintf("action_confirmed:%d", id)
}

func pendingActionTitle(action SlackPendingAction) string {
	return firstNonEmpty(
		truncateSlackContextText(strings.TrimSpace(stringFromAny(action.Params["title"])), 100),
		truncateSlackContextText(strings.TrimSpace(stringFromAny(action.Params["summary"])), 100),
		truncateSlackContextText(strings.TrimSpace(stringFromAny(action.Params["message"])), 100),
	)
}

func (s *Service) enqueueMeetingActionFollowups(ctx context.Context, payload NormalizedMeetingWebhookPayload, ref MeetingSlackRef) {
	if s == nil || s.followups == nil || payload.Summary == nil {
		return
	}
	channelID := strings.TrimSpace(ref.ChannelID)
	threadTS := strings.TrimSpace(ref.ThreadTS)
	if channelID == "" || threadTS == "" {
		return
	}
	actions := meetingSummaryActionItems(payload.Summary)
	for index, item := range actions {
		title := meetingActionItemTitle(item)
		if title == "" {
			continue
		}
		if _, err := s.followups.CreateFollowup(ctx, SlackHeartbeatFollowup{
			Kind:        "commitment",
			Title:       "Meeting follow-up: " + title,
			Summary:     meetingActionItemSummary(item, payload.Title),
			SourceKind:  heartbeatSourceKindThread,
			ChannelID:   channelID,
			ThreadTS:    threadTS,
			SourceRef:   meetingActionHeartbeatSourceRef(payload.MeetingID, index),
			Priority:    heartbeatFollowupPriorityHigh,
			NextCheckAt: timeNow().UTC().Add(meetingActionFollowupDelay).Format(time.RFC3339Nano),
			Metadata: map[string]any{
				"source":        "meeting_action_item",
				"meeting_id":    payload.MeetingID,
				"meeting_title": payload.Title,
				"action_index":  index,
				"owner":         strings.TrimSpace(item.Owner),
				"deadline":      firstNonEmpty(item.Deadline, item.Due),
			},
		}); err != nil {
			s.logger.Warn("slack meeting action followup create failed", "meeting_id", payload.MeetingID, "action_index", index, "error", err)
		}
	}
}

func meetingSummaryActionItems(summary *MeetingSummaryData) []MeetingActionItem {
	if summary == nil {
		return nil
	}
	actions := make([]MeetingActionItem, 0, len(summary.ActionItems)+len(summary.ActionItemsAlt))
	actions = append(actions, summary.ActionItems...)
	actions = append(actions, summary.ActionItemsAlt...)
	return actions
}

func meetingActionHeartbeatSourceRef(meetingID int64, index int) string {
	return fmt.Sprintf("meeting:%d:action:%d", meetingID, index+1)
}

func meetingActionItemTitle(item MeetingActionItem) string {
	return truncateSlackContextText(firstNonEmpty(
		strings.TrimSpace(item.Title),
		strings.TrimSpace(item.Description),
		strings.TrimSpace(item.Text),
	), 100)
}

func meetingActionItemSummary(item MeetingActionItem, meetingTitle string) string {
	parts := []string{"Meeting action item should be followed up."}
	if meetingTitle = strings.TrimSpace(meetingTitle); meetingTitle != "" {
		parts = append(parts, "Meeting: "+meetingTitle+".")
	}
	if title := meetingActionItemTitle(item); title != "" {
		parts = append(parts, "Action: "+title+".")
	}
	if owner := strings.TrimSpace(item.Owner); owner != "" {
		parts = append(parts, "Owner: "+owner+".")
	}
	if due := firstNonEmpty(strings.TrimSpace(item.Deadline), strings.TrimSpace(item.Due)); due != "" {
		parts = append(parts, "Due: "+due+".")
	}
	return strings.Join(parts, " ")
}
