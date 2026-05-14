package slackagent

import (
	"context"
	"strings"
)

func (s *Service) messageMentionFallbackEvent(ctx context.Context, event SlackEventPayload) (SlackEventPayload, bool) {
	if isBotMentionFallbackMessage(event) {
		return event, true
	}
	if !isThreadMentionFallbackCandidate(event) {
		return SlackEventPayload{}, false
	}

	messages, source, ok, fetchErr := s.fetchSlackMentionThreadMessages(ctx, event)
	mention, found := latestThreadBotMentionMessage(event, messages)
	if !found {
		s.logger.Warn(
			"slack thread mention fallback skipped",
			"reason", "no_latest_bot_mention",
			"event_type", event.Type,
			"subtype", event.Subtype,
			"channel", firstNonEmpty(event.Channel, nestedSlackMessageChannel(event)),
			"ts", firstNonEmpty(event.TS, event.EventTS),
			"thread_ts", slackThreadLookupTS(event),
			"source", source,
			"fetch_ok", ok,
			"fetch_error", fetchErr,
			"text_preview", truncateSlackContextText(event.Text, 120),
		)
		return SlackEventPayload{}, false
	}
	return slackEventFromThreadMention(event, mention, messages), true
}

func isBotMentionFallbackMessage(event SlackEventPayload) bool {
	if event.BotID != "" || event.Subtype != "" {
		return false
	}
	if event.Type != "message" || strings.TrimSpace(event.ChannelType) == "im" {
		return false
	}
	return slackBotMentionPattern.MatchString(event.Text)
}

func isThreadMentionFallbackCandidate(event SlackEventPayload) bool {
	if event.Type != "message" || event.BotID != "" || strings.TrimSpace(event.ChannelType) == "im" {
		return false
	}
	if strings.TrimSpace(event.Subtype) == "message_replied" {
		return true
	}
	return hasThreadFixture(event)
}

func latestThreadBotMentionMessage(event SlackEventPayload, messages []SlackMessage) (SlackMessage, bool) {
	latestReplyTS := latestThreadReplyTS(event)
	latestUserTS := ""
	for index := len(messages) - 1; index >= 0; index-- {
		message := messages[index]
		if message.BotID != "" || message.Subtype != "" {
			continue
		}
		text := strings.TrimSpace(message.Text)
		if text == "" {
			continue
		}
		messageTS := firstNonEmpty(message.TS, message.EventTS)
		if latestUserTS == "" {
			latestUserTS = messageTS
		}
		if !slackBotMentionPattern.MatchString(text) {
			continue
		}
		if latestReplyTS != "" {
			return message, messageTS == latestReplyTS
		}
		return message, latestUserTS == "" || messageTS == latestUserTS
	}
	return SlackMessage{}, false
}

func slackEventFromThreadMention(event SlackEventPayload, mention SlackMessage, messages []SlackMessage) SlackEventPayload {
	threadTS := firstNonEmpty(mention.ThreadTS, slackThreadLookupTS(event), mention.TS, mention.EventTS)
	return SlackEventPayload{
		Type:                 "message",
		User:                 firstNonEmpty(mention.User, mention.UserID, mention.UserIDCamel, event.User),
		Text:                 mention.Text,
		Channel:              firstNonEmpty(mention.Channel, event.Channel, nestedSlackMessageChannel(event)),
		ChannelType:          normalizeObservedChannelType(firstNonEmpty(mention.ChannelType, event.ChannelType, "channel")),
		ThreadTS:             threadTS,
		TS:                   firstNonEmpty(mention.TS, mention.EventTS),
		EventTS:              firstNonEmpty(mention.EventTS, mention.TS, event.EventTS),
		Replies:              messages,
		MeetingContext:       event.MeetingContext,
		MeetingContextCamel:  event.MeetingContextCamel,
		ThreadPermalink:      event.ThreadPermalink,
		ThreadPermalinkCamel: event.ThreadPermalinkCamel,
	}
}

func slackThreadLookupTS(event SlackEventPayload) string {
	if event.Message != nil {
		return firstNonEmpty(event.ThreadTS, event.Message.ThreadTS, event.Message.TS, event.TS, event.EventTS)
	}
	return firstNonEmpty(event.ThreadTS, event.TS, event.EventTS)
}

func nestedSlackThreadMessages(event SlackEventPayload) []SlackMessage {
	if event.Message == nil {
		return nil
	}
	parent := *event.Message
	parent.Channel = firstNonEmpty(parent.Channel, event.Channel)
	parent.ChannelType = normalizeObservedChannelType(firstNonEmpty(parent.ChannelType, event.ChannelType))
	parent.ThreadTS = firstNonEmpty(parent.ThreadTS, parent.TS, event.ThreadTS)
	messages := []SlackMessage{parent}
	for _, reply := range parent.Replies {
		reply.Channel = firstNonEmpty(reply.Channel, parent.Channel, event.Channel)
		reply.ChannelType = normalizeObservedChannelType(firstNonEmpty(reply.ChannelType, parent.ChannelType, event.ChannelType))
		reply.ThreadTS = firstNonEmpty(reply.ThreadTS, parent.ThreadTS, parent.TS, event.ThreadTS)
		messages = append(messages, reply)
	}
	return limitSlackMessages(messages)
}

func latestThreadReplyTS(event SlackEventPayload) string {
	if event.LatestReply != "" {
		return event.LatestReply
	}
	if event.Message != nil {
		if event.Message.LatestReply != "" {
			return event.Message.LatestReply
		}
		if len(event.Message.Replies) > 0 {
			return firstNonEmpty(event.Message.Replies[len(event.Message.Replies)-1].TS, event.Message.Replies[len(event.Message.Replies)-1].EventTS)
		}
	}
	if len(event.Replies) > 0 {
		return firstNonEmpty(event.Replies[len(event.Replies)-1].TS, event.Replies[len(event.Replies)-1].EventTS)
	}
	return ""
}

func nestedSlackMessageChannel(event SlackEventPayload) string {
	if event.Message == nil {
		return ""
	}
	return event.Message.Channel
}
