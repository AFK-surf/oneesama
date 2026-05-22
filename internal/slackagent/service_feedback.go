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

type SlackEmojiFeedbackEvent struct {
	Kind       string
	Emoji      string
	UserID     string
	ItemUserID string
	ChannelID  string
	ThreadTS   string
	MessageTS  string
	Summary    string
}

type SlackReactionBackedHumanConclusion struct {
	Emoji      string
	UserID     string
	ItemUserID string
	ChannelID  string
	ThreadTS   string
	MessageTS  string
	Summary    string
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

func (s *Service) handleReactionFeedbackEvent(ctx context.Context, envelope SlackEventEnvelope) SlackEventResponse {
	event := eventPayloadWithEnvelopeContext(envelope)
	feedback, reason := s.emojiFeedbackFromReactionEvent(ctx, event)
	if reason != "" {
		if reason == "non_bot_message" {
			conclusion, conclusionReason := s.reactionBackedHumanConclusionFromReactionEvent(ctx, event)
			if conclusionReason == "" {
				s.recordLearningSignal(ctx, slackLearningSignalFromReactionBackedHumanConclusion(conclusion))
				return SlackEventResponse{
					OK:        true,
					Handled:   true,
					Mode:      "reaction_backed_human_conclusion",
					EventType: event.Type,
					EventID:   strings.TrimSpace(envelope.EventID),
					Response: &AvatarCommandResponse{
						OK:           true,
						ResponseType: "ephemeral",
						Text:         "Reaction-backed human conclusion saved.",
						Metadata: map[string]any{
							"conclusion": conclusion,
						},
					},
				}
			}
		}
		return SlackEventResponse{
			OK:        true,
			Ignored:   true,
			Mode:      "emoji_feedback",
			EventType: event.Type,
			EventID:   strings.TrimSpace(envelope.EventID),
			Reason:    reason,
		}
	}
	if err := s.recordFeedbackMemory(ctx, SlackFeedbackEntry{
		Action:     feedback.Kind,
		Channel:    feedback.ChannelID,
		ThreadTS:   feedback.ThreadTS,
		ActionType: replyFeedbackActionType,
		Summary:    feedback.Summary,
		UserID:     feedback.UserID,
	}); err != nil {
		s.logger.Warn("slack emoji feedback persistence failed", "error", err)
	}
	if err := s.recordEmojiFeedbackImprovement(ctx, feedback); err != nil {
		s.logger.Warn("slack emoji feedback improvement failed", "error", err)
	}
	return SlackEventResponse{
		OK:        true,
		Handled:   true,
		Mode:      "emoji_feedback",
		EventType: event.Type,
		EventID:   strings.TrimSpace(envelope.EventID),
		Response: &AvatarCommandResponse{
			OK:           true,
			ResponseType: "ephemeral",
			Text:         "Emoji feedback saved.",
			Metadata: map[string]any{
				"feedback": feedback,
			},
		},
	}
}

func (s *Service) reactionBackedHumanConclusionFromReactionEvent(ctx context.Context, event SlackEventPayload) (SlackReactionBackedHumanConclusion, string) {
	if feedbackKindForReactionEmoji(event.Reaction) != replyFeedbackHelpful {
		return SlackReactionBackedHumanConclusion{}, "non_positive_reaction"
	}
	channelID := ""
	messageTS := ""
	itemType := ""
	if event.Item != nil {
		channelID = strings.TrimSpace(event.Item.Channel)
		messageTS = strings.TrimSpace(event.Item.TS)
		itemType = strings.TrimSpace(event.Item.Type)
	}
	if itemType != "" && itemType != "message" {
		return SlackReactionBackedHumanConclusion{}, "unsupported_reaction_item"
	}
	if channelID == "" || messageTS == "" {
		return SlackReactionBackedHumanConclusion{}, "missing_reaction_item"
	}
	userID := strings.TrimSpace(event.User)
	if userID == "" {
		return SlackReactionBackedHumanConclusion{}, "missing_reaction_user"
	}
	if s.botUserID != "" && userID == s.botUserID {
		return SlackReactionBackedHumanConclusion{}, "bot_self_reaction"
	}
	if s.botUserID != "" && strings.TrimSpace(event.ItemUser) == s.botUserID {
		return SlackReactionBackedHumanConclusion{}, "bot_message"
	}
	message := s.reactionTargetMessage(ctx, event, channelID, messageTS)
	messageUserID := firstNonEmpty(strings.TrimSpace(message.User), strings.TrimSpace(message.UserID), strings.TrimSpace(message.UserIDCamel), strings.TrimSpace(event.ItemUser))
	if messageUserID == "" {
		return SlackReactionBackedHumanConclusion{}, "missing_message_user"
	}
	if s.botUserID != "" && messageUserID == s.botUserID {
		return SlackReactionBackedHumanConclusion{}, "bot_message"
	}
	if messageUserID == userID {
		return SlackReactionBackedHumanConclusion{}, "self_reaction"
	}
	if strings.TrimSpace(message.BotID) != "" || strings.TrimSpace(message.Subtype) != "" {
		return SlackReactionBackedHumanConclusion{}, "bot_or_subtype_message"
	}
	threadTS := strings.TrimSpace(message.ThreadTS)
	if threadTS == "" || threadTS == messageTS {
		return SlackReactionBackedHumanConclusion{}, "not_thread_reply"
	}
	summary := strings.TrimSpace(sanitizeSlackVisibleText(messageSummaryForFeedback(message)))
	if summary == "" || slackDelayedNoReplyLooksLowSignal(summary) {
		return SlackReactionBackedHumanConclusion{}, "low_signal_human_reply"
	}
	return SlackReactionBackedHumanConclusion{
		Emoji:      normalizeReactionEmojiKey(event.Reaction),
		UserID:     userID,
		ItemUserID: messageUserID,
		ChannelID:  channelID,
		ThreadTS:   threadTS,
		MessageTS:  messageTS,
		Summary:    summary,
	}, ""
}

func (s *Service) emojiFeedbackFromReactionEvent(ctx context.Context, event SlackEventPayload) (SlackEmojiFeedbackEvent, string) {
	kind := feedbackKindForReactionEmoji(event.Reaction)
	if kind == "" {
		return SlackEmojiFeedbackEvent{}, "unmapped_reaction"
	}
	channelID := ""
	messageTS := ""
	itemType := ""
	if event.Item != nil {
		channelID = strings.TrimSpace(event.Item.Channel)
		messageTS = strings.TrimSpace(event.Item.TS)
		itemType = strings.TrimSpace(event.Item.Type)
	}
	if itemType != "" && itemType != "message" {
		return SlackEmojiFeedbackEvent{}, "unsupported_reaction_item"
	}
	if channelID == "" || messageTS == "" {
		return SlackEmojiFeedbackEvent{}, "missing_reaction_item"
	}
	userID := strings.TrimSpace(event.User)
	if userID == "" {
		return SlackEmojiFeedbackEvent{}, "missing_reaction_user"
	}
	if s.botUserID != "" && userID == s.botUserID {
		return SlackEmojiFeedbackEvent{}, "bot_self_reaction"
	}
	itemUserID := strings.TrimSpace(event.ItemUser)
	if s.botUserID != "" && itemUserID != s.botUserID {
		return SlackEmojiFeedbackEvent{}, "non_bot_message"
	}

	message := s.reactionTargetMessage(ctx, event, channelID, messageTS)
	threadTS := firstNonEmpty(message.ThreadTS, messageTS)
	summary := messageSummaryForFeedback(message)
	if strings.TrimSpace(summary) == "" {
		summary = fmt.Sprintf(":%s: reaction on assistant reply %s", normalizeReactionEmojiKey(event.Reaction), messageTS)
	} else {
		summary = fmt.Sprintf(":%s: reaction on assistant reply: %s", normalizeReactionEmojiKey(event.Reaction), summary)
	}
	return SlackEmojiFeedbackEvent{
		Kind:       kind,
		Emoji:      normalizeReactionEmojiKey(event.Reaction),
		UserID:     userID,
		ItemUserID: itemUserID,
		ChannelID:  channelID,
		ThreadTS:   threadTS,
		MessageTS:  messageTS,
		Summary:    summary,
	}, ""
}

func (s *Service) reactionTargetMessage(ctx context.Context, event SlackEventPayload, channelID string, messageTS string) SlackMessage {
	if event.Message != nil {
		message := *event.Message
		if strings.TrimSpace(message.Channel) == "" {
			message.Channel = channelID
		}
		if strings.TrimSpace(firstNonEmpty(message.TS, message.Timestamp, message.EventTS)) == "" {
			message.TS = messageTS
		}
		return message
	}
	if strings.TrimSpace(s.botToken) == "" {
		return SlackMessage{}
	}
	params := map[string]string{
		"channel":   strings.TrimSpace(channelID),
		"latest":    strings.TrimSpace(messageTS),
		"limit":     "1",
		"inclusive": "true",
	}
	var response slackConversationsHistoryResponse
	if err := s.callSlackScannerAPI(ctx, "conversations.history", params, &response); err != nil {
		s.logger.Warn("slack emoji feedback target fetch failed", "channel", channelID, "ts", messageTS, "error", err)
		return SlackMessage{}
	}
	if !response.OK || len(response.Messages) == 0 {
		if !response.OK {
			s.logger.Warn("slack emoji feedback target fetch failed", "channel", channelID, "ts", messageTS, "error", firstNonEmpty(response.Error, "slack_api_error"))
		}
		return SlackMessage{}
	}
	message := response.Messages[0]
	if firstNonEmpty(message.TS, message.Timestamp, message.EventTS) != strings.TrimSpace(messageTS) {
		return SlackMessage{}
	}
	return message
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

func feedbackKindForReactionEmoji(emoji string) string {
	normalized := normalizeReactionEmojiKey(emoji)
	switch normalized {
	case "+1", "thumbsup", "thumbs_up", "white_check_mark", "heavy_check_mark", "check", "checked", "done", "ok", "ok_hand", "heart", "green_heart", "tada", "clap", "lgtm", "shipit", "ship_it":
		return replyFeedbackHelpful
	case "-1", "thumbsdown", "thumbs_down", "x", "negative_squared_cross_mark", "no_entry", "warning", "confused", "face_with_raised_eyebrow", "thinking", "thinking_face", "bug", "broken", "wrong", "bad", "fail", "failed", "rollback":
		return replyFeedbackNotHelpful
	}
	for _, token := range []string{"lgtm", "good", "approve", "approved", "ship", "pass", "done"} {
		if strings.Contains(normalized, token) {
			return replyFeedbackHelpful
		}
	}
	for _, token := range []string{"fail", "bad", "wrong", "bug", "broken", "confus", "reject", "rollback", "concern"} {
		if strings.Contains(normalized, token) {
			return replyFeedbackNotHelpful
		}
	}
	return ""
}

func normalizeReactionEmojiKey(emoji string) string {
	emoji = strings.TrimSpace(strings.ToLower(emoji))
	emoji = strings.Trim(emoji, ":")
	emoji = strings.ReplaceAll(emoji, "-", "_")
	return emoji
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

func (s *Service) recordEmojiFeedbackImprovement(ctx context.Context, feedback SlackEmojiFeedbackEvent) error {
	spec, ok := selfGrowthTopicSpecByTopic(improvementTopicReplyQuality)
	if !ok {
		return nil
	}
	signalType := improvementSignalTypeDismiss
	if feedback.Kind == replyFeedbackHelpful {
		signalType = improvementSignalTypeConfirm
	}
	return s.recordImprovementSignals(ctx, []SlackImprovementSignal{
		newImprovementSignal(spec, improvementSignalOptions{
			SignalType: signalType,
			Summary:    feedback.Summary,
			ChannelID:  feedback.ChannelID,
			ThreadTS:   feedback.ThreadTS,
			MsgTS:      feedback.MessageTS,
			Metadata: map[string]any{
				"source":        "emoji_feedback",
				"feedback_kind": feedback.Kind,
				"emoji":         feedback.Emoji,
				"user_id":       feedback.UserID,
				"item_user_id":  feedback.ItemUserID,
			},
		}),
	})
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
