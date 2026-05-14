package slackagent

import (
	"strings"
	"time"
)

const slackEventSeenTTL = 10 * time.Minute

func retryResponse(headers SlackEventHeaders) *SlackRetryResponse {
	retryNum := strings.TrimSpace(headers.RetryNum)
	retryReason := strings.TrimSpace(headers.RetryReason)
	if retryNum == "" && retryReason == "" {
		return nil
	}
	return &SlackRetryResponse{
		Num:    retryNum,
		Reason: retryReason,
	}
}

func assistantThreadRefFromEvent(event SlackEventPayload) *AssistantThreadRef {
	thread := event.AssistantThread
	if thread == nil && event.Context == nil && event.Channel == "" && event.ThreadTS == "" && event.User == "" {
		return nil
	}

	ref := &AssistantThreadRef{
		ChannelID: firstNonEmpty(
			valueOrEmpty(thread, func(value *SlackAssistantThread) string { return value.ChannelID }),
			event.Channel,
			contextChannelID(thread),
			valueOrEmpty(event.Context, func(value *SlackThreadContext) string { return value.ChannelID }),
		),
		ThreadTS: firstNonEmpty(
			valueOrEmpty(thread, func(value *SlackAssistantThread) string { return value.ThreadTS }),
			event.ThreadTS,
			event.TS,
		),
		UserID: firstNonEmpty(
			valueOrEmpty(thread, func(value *SlackAssistantThread) string { return value.UserID }),
			event.User,
		),
	}
	if ref.ChannelID == "" && ref.ThreadTS == "" && ref.UserID == "" {
		return nil
	}
	return ref
}

func contextChannelID(thread *SlackAssistantThread) string {
	if thread == nil || thread.Context == nil {
		return ""
	}
	return thread.Context.ChannelID
}

func valueOrEmpty[T any](value *T, extract func(*T) string) string {
	if value == nil {
		return ""
	}
	return extract(value)
}

func slackEventDedupKey(eventID string, event SlackEventPayload) string {
	parts := []string{
		"events-api",
		firstNonEmpty(strings.TrimSpace(eventID), strings.TrimSpace(event.EventTS), strings.TrimSpace(event.TS), "event"),
		firstNonEmpty(strings.TrimSpace(event.Channel), "channel"),
	}
	return strings.Join(parts, ":")
}

func slackMentionEventKey(event SlackEventPayload, envelope SlackEventEnvelope) string {
	parts := []string{
		"mention",
		firstNonEmpty(strings.TrimSpace(envelope.TeamID), "workspace"),
		firstNonEmpty(strings.TrimSpace(event.Channel), "channel"),
		firstNonEmpty(strings.TrimSpace(event.TS), strings.TrimSpace(event.EventTS), "ts"),
		firstNonEmpty(strings.TrimSpace(event.User), "user"),
		strings.TrimSpace(event.Text),
	}
	return strings.Join(parts, ":")
}

func (s *Service) claimSlackMentionEvent(event SlackEventPayload, envelope SlackEventEnvelope) (bool, string) {
	key := slackMentionEventKey(event, envelope)

	s.eventMu.Lock()
	defer s.eventMu.Unlock()

	now := time.Now()
	for seenKey, seenAt := range s.seenEvents {
		if now.Sub(seenAt) > slackEventSeenTTL {
			delete(s.seenEvents, seenKey)
		}
	}
	if _, ok := s.seenEvents[key]; ok {
		return false, key
	}
	s.seenEvents[key] = now
	return true, key
}

func (s *Service) allowMentionUser(userID string) bool {
	return strings.TrimSpace(userID) != ""
}

func (s *Service) claimEventID(eventID string) bool {
	trimmed := strings.TrimSpace(eventID)
	if trimmed == "" {
		return true
	}

	s.eventMu.Lock()
	defer s.eventMu.Unlock()

	now := time.Now()
	for key, seenAt := range s.seenEvents {
		if now.Sub(seenAt) > slackEventSeenTTL {
			delete(s.seenEvents, key)
		}
	}
	if _, ok := s.seenEvents[trimmed]; ok {
		return false
	}
	s.seenEvents[trimmed] = now
	return true
}
