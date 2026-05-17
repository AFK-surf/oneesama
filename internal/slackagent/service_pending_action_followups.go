package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const pendingActionHeartbeatDefaultDelay = 30 * time.Minute

func (s *Service) createPendingActionSideEffects(ctx context.Context, action SlackPendingAction, cardTS string) (*SlackThreadRecommendation, *SlackHeartbeatFollowup, error) {
	if s == nil || s.followups == nil {
		return nil, nil, nil
	}
	recommendation, err := s.followups.ReserveThreadRecommendation(ctx, SlackThreadRecommendation{
		ChannelID:          action.ChannelID,
		ThreadTS:           action.ThreadTS,
		RecommendationType: firstNonEmpty(action.ActionType, "follow_up"),
		Status:             "active",
		CardTS:             cardTS,
	})
	if err != nil {
		return nil, nil, err
	}
	followup, err := s.upsertPendingActionHeartbeatFollowup(ctx, action, pendingActionHeartbeatDefaultDelay)
	if err != nil {
		return recommendation, nil, err
	}
	return recommendation, followup, nil
}

func (s *Service) upsertPendingActionHeartbeatFollowup(ctx context.Context, action SlackPendingAction, delay time.Duration) (*SlackHeartbeatFollowup, error) {
	if s == nil || s.followups == nil || action.ID == 0 {
		return nil, nil
	}
	if delay <= 0 {
		delay = pendingActionHeartbeatDefaultDelay
	}
	title := firstNonEmpty(stringFromAny(action.Params["title"]), stringFromAny(action.Params["summary"]), action.ActionType, "pending action")
	summary := pendingActionHeartbeatSummary(action, title)
	followup, err := s.followups.CreateFollowup(ctx, SlackHeartbeatFollowup{
		Kind:        "pending_action",
		Title:       "Decide pending action: " + title,
		Summary:     summary,
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   action.ChannelID,
		ThreadTS:    action.ThreadTS,
		SourceRef:   pendingActionHeartbeatSourceRef(action.ID),
		Priority:    heartbeatFollowupPriorityNormal,
		NextCheckAt: timeNow().UTC().Add(delay).Format(time.RFC3339Nano),
		Metadata: map[string]any{
			"pending_action_id": action.ID,
			"action_type":       action.ActionType,
			"card_ts":           action.CardTS,
		},
	})
	if err != nil {
		return nil, err
	}
	return followup, nil
}

func (s *Service) syncPendingActionInteractionFollowup(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction) {
	if s == nil || s.followups == nil || action.ID == 0 {
		return
	}
	switch interaction.Status {
	case "confirmed", "dismissed":
		_, err := s.followups.ResolveFollowupBySourceRef(
			ctx,
			pendingActionHeartbeatSourceRef(action.ID),
			"done",
			fmt.Sprintf("pending action %s by %s", interaction.Status, firstNonEmpty(interaction.UserID, "unknown")),
		)
		if err != nil {
			s.logger.Warn("slack pending action heartbeat resolve failed", "pending_action_id", action.ID, "error", err)
		}
	case "snoozed":
		delay := time.Duration(interaction.SnoozeMinutes) * time.Minute
		if delay <= 0 {
			delay = time.Hour
		}
		if _, err := s.upsertPendingActionHeartbeatFollowup(ctx, action, delay); err != nil {
			s.logger.Warn("slack pending action heartbeat snooze failed", "pending_action_id", action.ID, "error", err)
		}
	case "assigned":
		if _, err := s.upsertPendingActionHeartbeatFollowup(ctx, action, pendingActionHeartbeatDefaultDelay); err != nil {
			s.logger.Warn("slack pending action heartbeat assign failed", "pending_action_id", action.ID, "error", err)
		}
	}
}

func pendingActionHeartbeatSourceRef(id int64) string {
	if id == 0 {
		return ""
	}
	return fmt.Sprintf("pending_action:%d", id)
}

func pendingActionHeartbeatSummary(action SlackPendingAction, title string) string {
	parts := []string{
		fmt.Sprintf("Pending `%s` action needs a human decision.", firstNonEmpty(action.ActionType, "follow_up")),
	}
	if strings.TrimSpace(title) != "" {
		parts = append(parts, title)
	}
	if action.ChannelID != "" && action.ThreadTS != "" {
		parts = append(parts, fmt.Sprintf("Source thread: %s/%s.", action.ChannelID, action.ThreadTS))
	}
	return strings.Join(parts, " ")
}
