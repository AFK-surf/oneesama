package slackagent

import (
	"context"
	"strconv"
	"strings"
)

func (s *Service) HandleSlackEvent(ctx context.Context, envelope SlackEventEnvelope, headers SlackEventHeaders) SlackEventResponse {
	if retry := retryResponse(headers); retry != nil {
		return SlackEventResponse{
			OK:      true,
			Ignored: true,
			Reason:  "retry_request",
			EventID: strings.TrimSpace(envelope.EventID),
			Retry:   retry,
		}
	}

	if envelope.Type != "event_callback" {
		return SlackEventResponse{
			OK:        true,
			Ignored:   true,
			EventType: strings.TrimSpace(envelope.Type),
			Reason:    "unsupported_envelope_type",
			EventID:   strings.TrimSpace(envelope.EventID),
		}
	}

	if !s.claimEventID(envelope.EventID) {
		return SlackEventResponse{
			OK:        true,
			Ignored:   true,
			EventType: strings.TrimSpace(envelope.Event.Type),
			Reason:    "duplicate_event_id",
			EventID:   strings.TrimSpace(envelope.EventID),
		}
	}

	event := eventPayloadWithEnvelopeContext(envelope)
	switch event.Type {
	case "assistant_thread_started":
		ref := assistantThreadRefFromEvent(event)
		var suggestedPrompts *AssistantAPIResult
		if ref != nil {
			result := s.setAssistantSuggestedPrompts(ctx, *ref)
			suggestedPrompts = &result
		}
		return SlackEventResponse{
			OK:               true,
			Handled:          true,
			Mode:             "assistant_thread_started",
			EventType:        event.Type,
			EventID:          strings.TrimSpace(envelope.EventID),
			AssistantThread:  ref,
			SuggestedPrompts: suggestedPrompts,
		}
	case "assistant_thread_context_changed":
		return SlackEventResponse{
			OK:              true,
			Handled:         true,
			Mode:            "assistant_thread_context_changed",
			EventType:       event.Type,
			EventID:         strings.TrimSpace(envelope.EventID),
			AssistantThread: assistantThreadRefFromEvent(event),
		}
	case "app_mention":
		return s.handleEventAvatarCommand(ctx, envelope, "app_mention")
	case "message":
		if mentionEvent, ok := s.messageMentionFallbackEvent(ctx, event); ok {
			envelope.Event = mentionEvent
			return s.handleEventAvatarCommand(ctx, envelope, "message_mention")
		}
		if strings.TrimSpace(event.ChannelType) != "im" {
			inbound := s.BufferSlackInboundEvent(ctx, envelope, event)
			if inbound.Buffered {
				return SlackEventResponse{
					OK:        true,
					Handled:   true,
					Mode:      "event_buffer",
					EventType: event.Type,
					Reason:    "buffered_message",
					EventID:   strings.TrimSpace(envelope.EventID),
					Inbound:   &inbound,
				}
			}
			if inbound.Reason != "event_buffer_disabled" {
				return SlackEventResponse{
					OK:        true,
					Ignored:   true,
					Mode:      "event_buffer",
					EventType: event.Type,
					Reason:    inbound.Reason,
					EventID:   strings.TrimSpace(envelope.EventID),
					Inbound:   &inbound,
				}
			}
			return SlackEventResponse{
				OK:        true,
				Ignored:   true,
				EventType: event.Type,
				Reason:    "unsupported_message_channel_type",
				EventID:   strings.TrimSpace(envelope.EventID),
			}
		}
		return s.handleEventAvatarCommand(ctx, envelope, "dm_command")
	default:
		return SlackEventResponse{
			OK:        true,
			Ignored:   true,
			EventType: strings.TrimSpace(event.Type),
			Reason:    "unsupported_event_type",
			EventID:   strings.TrimSpace(envelope.EventID),
		}
	}
}

func eventPayloadWithEnvelopeContext(envelope SlackEventEnvelope) SlackEventPayload {
	event := envelope.Event
	event.ChannelType = normalizeObservedChannelType(event.ChannelType)
	if len(event.ThreadMessages) == 0 {
		event.ThreadMessages = envelope.ThreadMessages
	}
	if len(event.ThreadMessagesCamel) == 0 {
		event.ThreadMessagesCamel = envelope.ThreadMessagesCamel
	}
	if len(event.Replies) == 0 {
		event.Replies = envelope.Replies
	}
	if event.MeetingContext == "" {
		event.MeetingContext = envelope.MeetingContext
	}
	if event.MeetingContextCamel == "" {
		event.MeetingContextCamel = envelope.MeetingContextCamel
	}
	if event.ThreadPermalink == "" {
		event.ThreadPermalink = envelope.ThreadPermalink
	}
	if event.ThreadPermalinkCamel == "" {
		event.ThreadPermalinkCamel = envelope.ThreadPermalinkCamel
	}
	return event
}

func (s *Service) handleEventAvatarCommand(ctx context.Context, envelope SlackEventEnvelope, mode string) SlackEventResponse {
	event := eventPayloadWithEnvelopeContext(envelope)
	if event.BotID != "" || event.Subtype != "" {
		return SlackEventResponse{
			OK:        true,
			Ignored:   true,
			Mode:      mode,
			EventType: event.Type,
			EventID:   strings.TrimSpace(envelope.EventID),
			Reason:    "bot_or_subtype",
		}
	}

	mentionMode := isSlackMentionCommandMode(mode)
	if mentionMode {
		claimed, key := s.claimSlackMentionEvent(event, envelope)
		if !claimed {
			s.logger.Info(
				"slack mention event dedupe skip",
				"mode", mode,
				"event_id", strings.TrimSpace(envelope.EventID),
				"event_key", key,
				"channel", event.Channel,
				"ts", firstNonEmpty(event.TS, event.EventTS),
				"user", event.User,
			)
			return SlackEventResponse{
				OK:        true,
				Ignored:   true,
				Mode:      mode,
				EventType: event.Type,
				EventID:   strings.TrimSpace(envelope.EventID),
				EventKey:  key,
				Reason:    "duplicate_mention_event",
			}
		}
	}

	var richContext *SlackAppMentionContext
	if mentionMode {
		richContext = s.buildSlackAppMentionContext(ctx, firstNonEmpty(envelope.TeamID, "workspace"), event)
	}

	commandText := eventTextToAvatarCommand(event)
	if commandText == "" && mentionMode && richContext != nil && richContext.ContainsMeetURL {
		if meetURL := slackMeetURLPattern.FindString(richContext.Transcript); meetURL != "" {
			commandText = "join " + meetURL
		}
	}
	if commandText == "" {
		return SlackEventResponse{
			OK:        true,
			Ignored:   true,
			Mode:      mode,
			EventType: event.Type,
			EventID:   strings.TrimSpace(envelope.EventID),
			Reason:    "empty_event_text",
		}
	}
	reactionTS := ""
	if mentionMode {
		reactionTS = firstNonEmpty(event.TS, event.EventTS)
		s.addSlackReaction(ctx, event.Channel, reactionTS, slackReactionEyes)
	}
	if mentionMode {
		if shouldRewriteMentionDelegateTask(commandText, richContext) {
			commandText = "delegate " + strconv.Quote(richContext.MentionText)
		}
	}

	ref := AssistantThreadRef{
		ChannelID:  firstNonEmpty(event.Channel),
		ThreadTS:   firstNonEmpty(event.ThreadTS, event.TS, event.EventTS),
		ReactionTS: reactionTS,
		UserID:     firstNonEmpty(event.User),
	}
	thinkingStatus := s.scheduleAssistantThreadStatus(ctx, ref, "Thinking...", true)
	command := s.RunAvatarCommand(ctx, AvatarCommandInput{
		Text:              commandText,
		TeamID:            firstNonEmpty(envelope.TeamID),
		ChannelID:         ref.ChannelID,
		ThreadTS:          ref.ThreadTS,
		ReactionTS:        ref.ReactionTS,
		UserID:            ref.UserID,
		Command:           mode,
		RichThreadContext: richContext,
	})
	keepAssistantStatus := shouldKeepAssistantStatusUntilWorkerDone(command)
	if !keepAssistantStatus {
		clearResult := s.scheduleAssistantThreadStatus(ctx, ref, "", true)
		thinkingStatus = clearResult
		s.finishMentionReaction(ctx, ref, reactionEmojiForCommand(command))
	}

	response := SlackEventResponse{
		OK:              command.OK,
		Handled:         true,
		Mode:            mode,
		EventType:       event.Type,
		EventID:         strings.TrimSpace(envelope.EventID),
		Response:        &command,
		AssistantStatus: &thinkingStatus,
	}

	postText := slackImmediateCommandAckText(command)
	if strings.TrimSpace(postText) == "" || strings.TrimSpace(event.Channel) == "" {
		return response
	}

	postInput := PostMessageInput{
		Channel:  event.Channel,
		ThreadTS: firstNonEmpty(event.ThreadTS, event.TS, event.EventTS),
		Text:     postText,
		Blocks:   command.Blocks,
		DedupKey: slackEventDedupKey(envelope.EventID, event),
	}
	response.Posted = &SlackPostDispatch{
		Queued:   true,
		Channel:  postInput.Channel,
		ThreadTS: postInput.ThreadTS,
		DedupKey: postInput.DedupKey,
	}
	go s.dispatchEventPost(context.WithoutCancel(ctx), postInput)
	return response
}

func shouldRewriteMentionDelegateTask(commandText string, richContext *SlackAppMentionContext) bool {
	if richContext == nil {
		return false
	}
	rawFirst := ""
	if fields := strings.Fields(strings.TrimSpace(richContext.RawMentionText)); len(fields) > 0 {
		rawFirst = strings.ToLower(fields[0])
	}
	switch rawFirst {
	case "delegate", "join", "status", "stop", "jobs", "help":
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(commandText), "delegate ") && strings.TrimSpace(richContext.MentionText) != ""
}

func isSlackMentionCommandMode(mode string) bool {
	switch strings.TrimSpace(mode) {
	case "app_mention", "message_mention":
		return true
	default:
		return false
	}
}

func (s *Service) dispatchEventPost(ctx context.Context, input PostMessageInput) {
	result := s.PostMessage(ctx, input)
	if result.OK {
		return
	}
	s.logger.Warn(
		"slack events post dispatch failed",
		"channel", input.Channel,
		"thread_ts", input.ThreadTS,
		"dedup_key", input.DedupKey,
		"error", result.Error,
		"detail", result.Detail,
		"status", result.Status,
	)
}
