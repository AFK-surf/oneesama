package slackagent

import (
	"context"
	"fmt"
	"strings"
)

type SlackReplyFeedbackInteraction struct {
	Kind      string
	UserID    string
	ChannelID string
	ThreadTS  string
	MessageTS string
	Summary   string
}

func parseReplyFeedbackInteraction(payload SlackInteractionPayload) *SlackReplyFeedbackInteraction {
	if len(payload.Actions) == 0 {
		return nil
	}
	action := payload.Actions[0]
	if strings.TrimSpace(action.ActionID) != "reply_feedback" {
		return nil
	}
	kind := selectedReplyFeedbackKind(action)
	if kind == "" {
		return nil
	}
	message := slackMessageFromInteraction(payload.Message)
	summary := truncateSlackContextText(messageSummaryForFeedback(message), 80)
	if summary == "" {
		summary = "assistant reply"
	}
	return &SlackReplyFeedbackInteraction{
		Kind:      kind,
		UserID:    firstNonEmpty(userID(payload.User), payload.UserID),
		ChannelID: firstNonEmpty(channelID(payload.Channel), payload.ChannelID),
		ThreadTS:  interactionThreadTS(payload.Message),
		MessageTS: firstNonEmpty(message.TS, message.Timestamp),
		Summary:   summary,
	}
}

func slackMessageFromInteraction(message *SlackInteractionMessage) SlackMessage {
	if message == nil {
		return SlackMessage{}
	}
	return SlackMessage{
		TS:       message.TS,
		ThreadTS: message.ThreadTS,
		Blocks:   message.Blocks,
	}
}

func (s *Service) HandleReplyFeedbackInteraction(ctx context.Context, interaction SlackReplyFeedbackInteraction) AvatarCommandResponse {
	if interaction.Kind == "" {
		return AvatarCommandResponse{OK: false, ResponseType: "ephemeral", Text: "Invalid feedback action."}
	}
	if err := s.recordFeedbackMemory(ctx, SlackFeedbackEntry{
		Action:     interaction.Kind,
		Channel:    interaction.ChannelID,
		ThreadTS:   interaction.ThreadTS,
		ActionType: replyFeedbackActionType,
		Summary:    interaction.Summary,
		UserID:     interaction.UserID,
	}); err != nil {
		s.logger.Warn("slack reply feedback persistence failed", "error", err)
	}
	if err := s.recordReplyFeedbackImprovement(ctx, interaction); err != nil {
		s.logger.Warn("slack reply feedback improvement failed", "error", err)
	}
	return AvatarCommandResponse{
		OK:           true,
		ResponseType: "ephemeral",
		Text:         fmt.Sprintf("Feedback saved: %s.", replyFeedbackLabel(interaction.Kind)),
		Metadata: map[string]any{
			"feedback": interaction,
		},
	}
}

func (s *Service) recordFeedbackMemory(ctx context.Context, entry SlackFeedbackEntry) error {
	entry = normalizeSlackFeedbackEntry(entry)
	if s.feedback != nil {
		if _, err := s.feedback.InsertEntry(ctx, entry); err != nil {
			return err
		}
	}
	if err := writeFeedbackProjection(s.workspaceDir, entry); err != nil {
		return err
	}
	return nil
}

func (s *Service) recordReplyFeedbackImprovement(ctx context.Context, interaction SlackReplyFeedbackInteraction) error {
	spec, ok := selfGrowthTopicSpecByTopic(improvementTopicReplyQuality)
	if !ok {
		return nil
	}
	signalType := improvementSignalTypeDismiss
	if interaction.Kind == replyFeedbackHelpful {
		signalType = improvementSignalTypeConfirm
	}
	return s.recordImprovementSignals(ctx, []SlackImprovementSignal{
		newImprovementSignal(spec, improvementSignalOptions{
			SignalType: signalType,
			Summary:    interaction.Summary,
			ChannelID:  interaction.ChannelID,
			ThreadTS:   interaction.ThreadTS,
			MsgTS:      interaction.MessageTS,
			Metadata: map[string]any{
				"source":        "reply_feedback",
				"feedback_kind": interaction.Kind,
				"user_id":       interaction.UserID,
			},
		}),
	})
}

func (s *Service) recordPendingActionFeedback(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction) {
	summary := pendingActionFeedbackSummary(&action, action.Result)
	if err := s.recordFeedbackMemory(ctx, SlackFeedbackEntry{
		Action:     interaction.Status,
		Channel:    firstNonEmpty(action.ChannelID, interaction.ChannelID),
		ThreadTS:   firstNonEmpty(action.ThreadTS, interaction.ThreadTS),
		ActionType: action.ActionType,
		Summary:    summary,
		UserID:     interaction.UserID,
	}); err != nil {
		s.logger.Warn("slack pending action feedback persistence failed", "error", err)
	}
	if err := s.recordPendingActionImprovement(ctx, action, interaction, summary); err != nil {
		s.logger.Warn("slack pending action improvement failed", "error", err)
	}
}

func (s *Service) recordPendingActionImprovement(ctx context.Context, action SlackPendingAction, interaction SlackPendingActionInteraction, summary string) error {
	spec, ok := selfGrowthTopicSpecByTopic(improvementTopicActionSuggestion)
	if !ok {
		return nil
	}
	signalType := improvementSignalTypeConfirm
	switch interaction.Status {
	case "dismissed", "snoozed":
		signalType = improvementSignalTypeDismiss
	case "confirmed":
		signalType = improvementSignalTypeConfirm
	default:
		return nil
	}
	return s.recordImprovementSignals(ctx, []SlackImprovementSignal{
		newImprovementSignal(spec, improvementSignalOptions{
			SignalType: signalType,
			Summary:    summary,
			ChannelID:  firstNonEmpty(action.ChannelID, interaction.ChannelID),
			ThreadTS:   firstNonEmpty(action.ThreadTS, interaction.ThreadTS),
			Metadata: map[string]any{
				"source":      "pending_action_feedback",
				"action_type": action.ActionType,
				"user_id":     interaction.UserID,
				"status":      interaction.Status,
			},
		}),
	})
}

func replyFeedbackLabel(kind string) string {
	if kind == replyFeedbackNotHelpful {
		return "Not helpful"
	}
	return "Helpful"
}
