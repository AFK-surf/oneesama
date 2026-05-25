package slackagent

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
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
	case "reaction_added":
		return s.handleReactionFeedbackEvent(ctx, envelope)
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

	mentionWorkspaceID := firstNonEmpty(envelope.TeamID, "workspace")
	mentionThreadTS := firstNonEmpty(event.ThreadTS, event.TS, event.EventTS)
	mentionChannel := strings.TrimSpace(event.Channel)
	var richContext *SlackAppMentionContext
	if mentionMode {
		richContext = s.buildSlackAppMentionContext(ctx, firstNonEmpty(envelope.TeamID, "workspace"), event)
	}

	commandText := eventTextToAvatarCommandForBot(event, s.botUserID)
	if commandText == "" && mentionMode && richContext != nil && richContext.ContainsMeetURL {
		if meetURL := slackMeetURLPattern.FindString(richContext.Transcript); meetURL != "" {
			commandText = "join " + meetURL
		}
	}
	mentionThreadOwned := false
	if mentionMode && shouldUseMentionWorkerQueue(commandText) && s.mentionQueue != nil && mentionChannel != "" && mentionThreadTS != "" {
		startWorker, postAck := s.mentionQueue.enqueue(mentionWorkspaceID, mentionChannel, mentionThreadTS, event)
		if !startWorker {
			if postAck {
				ackInput := PostMessageInput{
					Channel:  mentionChannel,
					ThreadTS: mentionThreadTS,
					Text:     "Got it — finishing the earlier mention in this thread, will reply once that lands.",
					DedupKey: slackEventDedupKey(envelope.EventID, event) + ":queued_ack",
				}
				go s.dispatchEventQueuedAck(context.WithoutCancel(ctx), mentionWorkspaceID, ackInput, firstNonEmpty(event.TS, event.EventTS))
			}
			s.logger.Info(
				"slack mention coalesced into running worker",
				"mode", mode,
				"event_id", strings.TrimSpace(envelope.EventID),
				"channel", mentionChannel,
				"thread_ts", mentionThreadTS,
				"posted_ack", postAck,
			)
			return SlackEventResponse{
				OK:        true,
				Ignored:   true,
				Mode:      mode,
				EventType: event.Type,
				EventID:   strings.TrimSpace(envelope.EventID),
				Reason:    "mention_thread_busy",
			}
		}
		mentionThreadOwned = true
		s.beginMentionThreadCase(ctx, mentionChannel, mentionThreadTS, envelope.EventID)
		defer s.endMentionThreadCase(context.WithoutCancel(ctx), mentionWorkspaceID, mentionChannel, mentionThreadTS, envelope.EventID)
	}
	_ = mentionThreadOwned

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
		if shouldRewriteMentionWorkerTask(commandText, richContext) {
			commandText = "work " + strconv.Quote(mentionWorkerTaskText(richContext))
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
	if mentionMode {
		userText := commandText
		transcript := ""
		if richContext != nil {
			userText = firstNonEmpty(richContext.MentionText, commandText)
			transcript = richContext.Transcript
		}
		sessionID := ""
		if job, ok := command.Metadata["job"].(agentrunner.Job); ok {
			sessionID = job.ID
		} else if jobMap, ok := mapFromAny(command.Metadata["job"]); ok {
			sessionID = stringFromAny(jobMap["id"])
		}
		s.maybeRecordThreadImprovementSignals(ctx, ref.ChannelID, ref.ThreadTS, firstNonEmpty(event.TS, event.EventTS), sessionID, userText, transcript, command.Text)
	}
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
	if mentionMode && command.OK {
		s.maybeRecordAssistantCommitmentFollowup(ctx, ref, postText)
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
	workspaceID := firstNonEmpty(envelope.TeamID, "workspace")
	ledgerSummary := slackEventReplyLedgerSummary(mode, postText)
	go s.dispatchEventReplyWithLedger(context.WithoutCancel(ctx), workspaceID, postInput, ledgerSummary, firstNonEmpty(event.TS, event.EventTS))
	return response
}

// slackEventReplyLedgerSummary builds the short ledger summary recorded
// for a durable event reply. The mode prefix lets future audit views
// distinguish app_mention answers from DM responses without re-deriving
// the source from raw text.
func slackEventReplyLedgerSummary(mode, postText string) string {
	prefix := mode
	if strings.TrimSpace(prefix) == "" {
		prefix = "event_reply"
	}
	body := strings.TrimSpace(firstTextLine(postText))
	if body == "" {
		return prefix
	}
	return prefix + ": " + body
}

func shouldRewriteMentionWorkerTask(commandText string, richContext *SlackAppMentionContext) bool {
	if richContext == nil {
		return false
	}
	rawFirst := ""
	if fields := strings.Fields(strings.TrimSpace(richContext.RawMentionText)); len(fields) > 0 {
		rawFirst = strings.ToLower(fields[0])
	}
	switch rawFirst {
	case "join", "status", "stop", "help":
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(commandText), "work ") && strings.TrimSpace(richContext.MentionText) != ""
}

func shouldUseMentionWorkerQueue(commandText string) bool {
	parsed := parseAvatarCommand(commandText)
	return parsed.Action == "work" || parsed.Action == "delegate"
}

func mentionWorkerTaskText(richContext *SlackAppMentionContext) string {
	if richContext == nil {
		return ""
	}
	mentionText := strings.TrimSpace(richContext.MentionText)
	if mentionText == "" {
		return ""
	}
	if !mentionTextNeedsThreadContext(mentionText) {
		return mentionText
	}
	return strings.Join([]string{
		"Use the Slack thread context to infer and complete the concrete request.",
		"Latest mention: " + mentionText,
		"If another bot is already active in the thread, add only missing evidence, a concise synthesis, or the next useful step; do not return an empty result just because the mention is short.",
	}, "\n")
}

func mentionTextNeedsThreadContext(text string) bool {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return false
	}
	normalized = strings.Trim(normalized, " \t\r\n.,;:!?，。！？、")
	if len([]rune(normalized)) > 16 {
		return false
	}
	for _, marker := range []string{
		"你来试试",
		"来试试",
		"试试",
		"看看",
		"看下",
		"看一下",
		"看这个",
		"这个呢",
		"你看下",
		"你看看",
		"帮看下",
		"帮看看",
		"try this",
		"take a look",
		"look at this",
	} {
		if normalized == marker {
			return true
		}
	}
	return false
}

func isSlackMentionCommandMode(mode string) bool {
	switch strings.TrimSpace(mode) {
	case "app_mention", "message_mention":
		return true
	default:
		return false
	}
}

// beginMentionThreadCase records an active mention claim for the given thread
// so duplicate-reply guards (scanner suppression, slack_api activeThread) can
// see the bot is currently working on it. Errors are logged and swallowed —
// thread-case durability is best-effort observability, not a hard gate for
// the worker.
func (s *Service) beginMentionThreadCase(ctx context.Context, channelID, threadTS, eventID string) {
	if s == nil || s.threadCases == nil {
		return
	}
	source := strings.TrimSpace(eventID)
	if source == "" {
		source = "app_mention"
	}
	if _, err := s.threadCases.UpsertThreadCase(ctx, SlackThreadCase{
		ChannelID: channelID,
		ThreadTS:  threadTS,
		Owner:     SlackThreadCaseOwnerMention,
		Status:    SlackThreadCaseStatusActive,
		Source:    source,
	}); err != nil && s.logger != nil {
		s.logger.Warn(
			"slack mention thread case upsert failed",
			"channel", channelID,
			"thread_ts", threadTS,
			"error", err,
		)
	}
}

// endMentionThreadCase closes the active mention thread case after a worker
// completes, freeing the thread for future mention claims. If additional
// mentions arrived during execution, the queue dequeues them and the next
// app_mention event will re-claim the thread.
func (s *Service) endMentionThreadCase(ctx context.Context, workspaceID, channelID, threadTS, eventID string) {
	if s == nil {
		return
	}
	if s.mentionQueue != nil {
		s.mentionQueue.dequeueOrStop(workspaceID, channelID, threadTS)
	}
	if s.threadCases == nil {
		return
	}
	source := strings.TrimSpace(eventID)
	if source == "" {
		source = "app_mention"
	}
	if _, err := s.threadCases.MarkClosed(ctx, channelID, threadTS, SlackThreadCaseOwnerMention, source); err != nil && s.logger != nil {
		s.logger.Warn(
			"slack mention thread case close failed",
			"channel", channelID,
			"thread_ts", threadTS,
			"error", err,
		)
	}
}

func (s *Service) dispatchEventQueuedAck(ctx context.Context, workspaceID string, input PostMessageInput, snapshotTS string) {
	delivery := s.deliverSlackPublicThreadReply(ctx, slackPublicThreadReplyDelivery{
		Source:       slackPublicReplySourceEventQueuedAck,
		SurfaceKind:  slackPublicReplySurfaceThreadReply,
		WorkspaceID:  workspaceID,
		ChannelID:    input.Channel,
		ThreadTS:     input.ThreadTS,
		FallbackText: input.Text,
		Blocks:       input.Blocks,
		DedupKey:     input.DedupKey,
		SnapshotTS:   snapshotTS,
	})
	if delivery.Blocked {
		s.logger.Info(
			"slack events queued ack suppressed",
			"channel", input.Channel,
			"thread_ts", input.ThreadTS,
			"dedup_key", input.DedupKey,
			"reason", delivery.BlockReason,
			"blocked_ts", delivery.BlockedTS,
		)
		return
	}
	if delivery.Post.OK {
		return
	}
	s.logger.Warn(
		"slack events queued ack dispatch failed",
		"channel", input.Channel,
		"thread_ts", input.ThreadTS,
		"dedup_key", input.DedupKey,
		"error", delivery.Post.Error,
		"detail", delivery.Post.Detail,
		"status", delivery.Post.Status,
	)
	s.notifyOperatorPostFailure(ctx, input, delivery.Post)
}

// dispatchEventReplyWithLedger records successful durable event replies into
// the cognition ledger so the assistant's thread history stays consistent.
// Transient status surfaces intentionally skip ledger writes.
func (s *Service) dispatchEventReplyWithLedger(ctx context.Context, workspaceID string, input PostMessageInput, ledgerSummary string, snapshotTS string) {
	surfaceKind := slackPublicReplySurfaceChannelNotice
	if strings.TrimSpace(input.ThreadTS) != "" {
		surfaceKind = slackPublicReplySurfaceThreadReply
	}
	delivery := s.deliverSlackPublicThreadReply(ctx, slackPublicThreadReplyDelivery{
		Source:        slackPublicReplySourceEventReply,
		SurfaceKind:   surfaceKind,
		WorkspaceID:   workspaceID,
		ChannelID:     input.Channel,
		ThreadTS:      input.ThreadTS,
		FallbackText:  input.Text,
		Blocks:        input.Blocks,
		DedupKey:      input.DedupKey,
		SnapshotTS:    snapshotTS,
		LedgerSummary: ledgerSummary,
	})
	if delivery.Blocked {
		if s.logger != nil {
			s.logger.Info(
				"slack event reply dispatch blocked",
				"channel", input.Channel,
				"thread_ts", input.ThreadTS,
				"dedup_key", input.DedupKey,
				"reason", delivery.BlockReason,
				"blocked_ts", delivery.BlockedTS,
			)
		}
		return
	}
	result := delivery.Post
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
	s.notifyOperatorPostFailure(ctx, input, result)
}

// recordSlackOutboundLedger captures a successful durable Slack post into
// the cognition thread ledger. Centralizing the call here lets every
// durable-reply call site reuse the same null-safety checks (no cognition
// store / empty channel or thread / empty summary) so callers don't have
// to special-case the no-store path. The summary text is truncated to keep
// the ledger row from carrying full reply bodies.
func (s *Service) recordSlackOutboundLedger(ctx context.Context, workspaceID string, input PostMessageInput, result PostMessageResult, summary string) {
	if s == nil || s.cognition == nil {
		return
	}
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return
	}
	channelID := strings.TrimSpace(input.Channel)
	threadTS := strings.TrimSpace(input.ThreadTS)
	if threadTS == "" {
		threadTS = strings.TrimSpace(result.ThreadTS)
	}
	if threadTS == "" {
		threadTS = strings.TrimSpace(result.TS)
	}
	if channelID == "" || threadTS == "" {
		return
	}
	ws := strings.TrimSpace(workspaceID)
	if ws == "" {
		ws = "workspace"
	}
	if err := s.cognition.RecordOutbound(ctx, ws, channelID, threadTS, truncateSlackContextText(summary, 400)); err != nil {
		s.logger.Warn(
			"slack outbound ledger record failed",
			"channel", channelID,
			"thread_ts", threadTS,
			"error", err,
		)
	}
}

// notifyOperatorPostFailure routes a chat.postMessage failure to the pilot
// DM (or debug channel) when those surfaces are configured. The fallback is
// best-effort observability — failures here are logged but don't block the
// caller. Dedupe inside `SlackOperatorFallback` keeps retry storms from
// flooding the operator inbox.
func (s *Service) notifyOperatorPostFailure(ctx context.Context, input PostMessageInput, failure PostMessageResult) {
	if s == nil || s.operatorFallback == nil {
		return
	}
	if strings.TrimSpace(s.operatorFallback.PilotUserID) == "" && strings.TrimSpace(s.operatorFallback.DebugChannelID) == "" {
		return
	}
	summary := fmt.Sprintf(
		"oneesama: chat.postMessage failed in <#%s> (thread=%s, dedup_key=%s) — error=%s detail=%s status=%d",
		firstNonEmpty(input.Channel, "unknown"),
		firstNonEmpty(input.ThreadTS, "—"),
		firstNonEmpty(input.DedupKey, "—"),
		firstNonEmpty(failure.Error, "unknown"),
		firstNonEmpty(failure.Detail, "—"),
		failure.Status,
	)
	if pilotResult := s.operatorFallback.PostPilotDM(ctx, summary); !pilotResult.OK && !pilotResult.Skipped {
		s.logger.Warn(
			"slack operator pilot DM fallback failed",
			"error", pilotResult.Reason,
			"original_channel", input.Channel,
		)
	}
	if debugResult := s.operatorFallback.PostDebugChannel(ctx, summary); !debugResult.OK && !debugResult.Skipped {
		s.logger.Warn(
			"slack operator debug channel fallback failed",
			"error", debugResult.Reason,
			"original_channel", input.Channel,
		)
	}
}
