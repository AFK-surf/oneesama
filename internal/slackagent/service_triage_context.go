package slackagent

import (
	"context"
	"strings"
)

func (s *Service) fetchSlackTriageThreadContexts(ctx context.Context, channelID string, messages []SlackInboundMessage) []SlackTriageThreadContext {
	if s == nil || strings.TrimSpace(s.botToken) == "" {
		return nil
	}
	seen := map[string]struct{}{}
	var contexts []SlackTriageThreadContext
	for _, message := range messages {
		message = normalizeSlackInboundMessage(message)
		threadTS := slackTriageThreadLookupTS(message)
		if threadTS == "" {
			continue
		}
		channel := firstNonEmpty(message.ChannelID, channelID)
		key := channel + "\x00" + threadTS
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		response, err := s.callSlackConversationsReplies(ctx, channel, threadTS)
		if err != nil {
			contexts = append(contexts, SlackTriageThreadContext{
				ChannelID:  channel,
				ThreadTS:   threadTS,
				FetchOK:    false,
				FetchError: err.Error(),
			})
			continue
		}
		if !response.OK {
			contexts = append(contexts, SlackTriageThreadContext{
				ChannelID:  channel,
				ThreadTS:   threadTS,
				FetchOK:    false,
				FetchError: firstNonEmpty(response.Error, "slack_api_error"),
			})
			continue
		}
		inbound := slackInboundMessagesFromThreadMessages(channel, response.Messages)
		contexts = append(contexts, SlackTriageThreadContext{
			ChannelID:    channel,
			ThreadTS:     threadTS,
			FetchOK:      true,
			MessageCount: len(inbound),
			Messages:     inbound,
			Transcript:   renderSlackTriageThreadTranscript(inbound),
		})
	}
	return contexts
}

func filterSlackTriageThreadContextBotReplies(contexts []SlackTriageThreadContext, botUserIDs []string) ([]SlackTriageThreadContext, int) {
	if len(contexts) == 0 {
		return nil, 0
	}
	filtered := make([]SlackTriageThreadContext, 0, len(contexts))
	var removed int
	for _, context := range contexts {
		if len(context.Messages) == 0 {
			filtered = append(filtered, context)
			continue
		}
		messages := make([]SlackInboundMessage, 0, len(context.Messages))
		for _, message := range context.Messages {
			message = normalizeSlackInboundMessage(message)
			if isAuthoredByBot(message, botUserIDs) {
				removed++
				continue
			}
			messages = append(messages, message)
		}
		context.Messages = messages
		context.MessageCount = len(messages)
		context.Transcript = renderSlackTriageThreadTranscript(messages)
		filtered = append(filtered, context)
	}
	return filtered, removed
}

func filterSlackTriageBotInboundMessages(messages []SlackInboundMessage, botUserIDs []string) ([]SlackInboundMessage, int) {
	if len(messages) == 0 {
		return nil, 0
	}
	filtered := make([]SlackInboundMessage, 0, len(messages))
	var removed int
	for _, message := range messages {
		message = normalizeSlackInboundMessage(message)
		if isAuthoredByBot(message, botUserIDs) {
			removed++
			continue
		}
		filtered = append(filtered, message)
	}
	return filtered, removed
}

func (s *Service) fetchSlackTriageChannelContexts(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string, threadContexts []SlackTriageThreadContext) []SlackInboundMessage {
	if s == nil || strings.TrimSpace(s.botToken) == "" {
		return nil
	}
	if !slackTriageNeedsChannelContext(digest, messages, threadContexts) {
		return nil
	}
	latestTS := ""
	for _, message := range messages {
		message = normalizeSlackInboundMessage(message)
		if ts := firstNonEmpty(message.TS, message.EventTS); slackTSGreater(ts, latestTS) {
			latestTS = ts
		}
	}
	if latestTS == "" {
		return nil
	}
	channel := firstNonEmpty(firstMessageChannelID(messages), channelID)
	contextMessages := s.fetchSlackHistoryContext(ctx, channel, latestTS)
	if len(contextMessages) == 0 {
		return nil
	}
	return slackScannerInboundMessages(slackScannerConversation{ID: channel, IsChannel: true}, contextMessages)
}

func slackTriageNeedsChannelContext(digest string, messages []SlackInboundMessage, threadContexts []SlackTriageThreadContext) bool {
	if len(threadContexts) > 0 {
		return false
	}
	if len(messages) == 0 {
		return false
	}
	if len([]rune(strings.TrimSpace(digest))) >= slackTriageLowContextCharThreshold {
		return false
	}
	for _, message := range messages {
		if slackTriageThreadLookupTS(message) != "" {
			return false
		}
	}
	return true
}

func slackTriageThreadLookupTS(message SlackInboundMessage) string {
	message = normalizeSlackInboundMessage(message)
	if ts := strings.TrimSpace(message.ThreadTS); ts != "" {
		return ts
	}
	if message.ReplyCount > 0 {
		return strings.TrimSpace(message.TS)
	}
	return ""
}

func renderSlackTriageThreadTranscript(messages []SlackInboundMessage) string {
	var lines []string
	for _, message := range messages {
		lines = append(lines, formatSlackInboundMessageLine(message, ""))
	}
	return strings.Join(lines, "\n")
}

func appendSlackTriageThreadContextDigest(digest string, contexts []SlackTriageThreadContext) string {
	threadContext := formatSlackTriageThreadContexts(contexts)
	if strings.TrimSpace(threadContext) == "" {
		return strings.TrimSpace(digest)
	}
	digest = strings.TrimSpace(digest)
	if digest == "" {
		return "Fetched Slack thread context:\n" + threadContext
	}
	return digest + "\n\nFetched Slack thread context:\n" + threadContext
}

func slackTriageAuditMetadata(digest string, messages []SlackInboundMessage, threadContexts []SlackTriageThreadContext, channelContexts []SlackInboundMessage, externalLinks []SlackExternalLinkContext) map[string]any {
	threadFetched := false
	threadMessages := 0
	for _, context := range threadContexts {
		if context.FetchOK {
			threadFetched = true
			threadMessages += context.MessageCount
		}
	}
	metadata := map[string]any{
		"input_context_chars":      len([]rune(digest)),
		"message_count":            len(messages),
		"thread_context_fetched":   threadFetched,
		"thread_context_count":     len(threadContexts),
		"thread_context_messages":  threadMessages,
		"channel_context_fetched":  len(channelContexts) > 0,
		"channel_context_messages": len(channelContexts),
		"external_links_fetched":   len(externalLinks),
	}
	metadata["context_fetch_reason"] = slackTriageContextFetchReasonFromInputs(messages, threadContexts, channelContexts)
	return metadata
}

func slackTriageContextFetchReasonFromInputs(messages []SlackInboundMessage, threadContexts []SlackTriageThreadContext, channelContexts []SlackInboundMessage) string {
	if len(threadContexts) > 0 {
		for _, context := range threadContexts {
			if context.FetchOK {
				return "thread_context_fetched"
			}
		}
		return "thread_context_attempted_failed"
	}
	if len(channelContexts) > 0 {
		return "channel_low_context_expansion"
	}
	if len(messages) == 0 {
		return "no_messages"
	}
	for _, message := range messages {
		if slackTriageThreadLookupTS(message) != "" {
			return "thread_context_not_available"
		}
	}
	return "standalone_digest"
}

func slackTriageSuppressedReason(decision SlackTriageDecision, actions []SlackTriageDecisionAction, ok bool) string {
	if !ok {
		return "triage_failed"
	}
	if len(actions) == 0 {
		if !decision.ParseOK {
			return "no_actions_parse_fallback"
		}
		return "no_actions"
	}
	return ""
}

func slackTriageSkipReasonBucketForDecision(decision SlackTriageDecision, actions []SlackTriageDecisionAction, ok bool) string {
	if !ok || len(actions) > 0 {
		return ""
	}
	return slackTriageSkipReasonBucket(SlackTriageContext{
		Summary:  decision.Summary,
		Metadata: map[string]any{"suppressed_reason": slackTriageSuppressedReason(decision, actions, ok)},
	})
}

func mergeStringAnyMaps(values ...map[string]any) map[string]any {
	out := map[string]any{}
	for _, value := range values {
		for key, item := range value {
			out[key] = item
		}
	}
	return out
}

func mapFromAnyOrEmpty(value any) map[string]any {
	if mapped, ok := mapFromAny(value); ok {
		return mapped
	}
	return map[string]any{}
}
