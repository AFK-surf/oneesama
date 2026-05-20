package slackagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func (s *Service) finalizeSlackTriageJob(ctx context.Context, job agentrunner.Job) (*SlackTriageFinalization, error) {
	if job.ID == "" {
		return nil, nil
	}
	s.triageMu.Lock()
	defer s.triageMu.Unlock()
	if result, ok := s.finalizedTriageResults[job.ID]; ok {
		return result, nil
	}
	s.finalizedTriageJobIDs[job.ID] = struct{}{}

	channelID := stringFromContext(job.Context, "channelId", "channel_id")
	workspaceID := firstNonEmpty(stringFromContext(job.Context, "workspaceId", "workspace_id"), "workspace")
	threadTS := firstNonEmpty(stringFromContext(job.Context, "threadTs", "thread_ts"), "channel-root")
	messages := messagesFromContext(job.Context["messages"])
	runID := int64FromContext(job.Context, "triageRunId", "triage_run_id")
	fallback := slackTriageFallback{Summary: fmt.Sprintf("Slack triage finished for %s.", channelID), Channel: channelID, ThreadTS: threadTS}
	if s.triageHeuristicFallback {
		fallback = suggestSlackTriageFallback(channelID, messages)
		fallback.Channel = firstNonEmpty(fallback.Channel, channelID)
		fallback.ThreadTS = firstNonEmpty(fallback.ThreadTS, threadTS)
	}

	rawOutput := firstNonEmpty(job.Result, job.Error)
	decision := parseSlackTriageDecision(rawOutput, fallback)
	ok := job.Status == agentrunner.StatusCompleted
	actions := append([]SlackTriageDecisionAction(nil), decision.Actions...)
	if ok && !decision.ParseOK && len(actions) == 0 {
		if action, ok := slackTriageSharedLinkSynthesisAction(channelID, threadTS, messages, slackExternalLinksFromContext(job.Context["externalLinks"]), stringFromContext(job.Context, "workspaceTriagePolicy", "workspace_triage_policy")); ok {
			actions = append(actions, action)
			decision.Summary = firstNonEmpty(decision.Summary, "Shared link is synthesis-eligible; posting a lightweight initial opinion.")
		}
	}
	actions = filterSlackTriageActionsForMessages(actions, messages, s.botUserID)
	decision.Actions = actions
	if !ok {
		actions = nil
		decision.Actions = nil
	}
	probe := boolFromAny(job.Context["triageProbe"], false)
	foregroundChain := stringFromContext(job.Context, "foregroundChain", "foreground_chain")
	personaAllowed := slackTriageForegroundChainAllowsPersona(foregroundChain)
	personaForegroundQueued := ok && !probe && personaAllowed && s.foregroundPersonaRuntimeEnabled()
	var directToolCalls []SlackTriageToolCall
	var directFailures int
	var directMutations int
	if !probe && !personaForegroundQueued {
		directToolCalls, directFailures, directMutations = s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, channelID, threadTS, runID, actions, slackTriageDirectActionOptions{
			SnapshotMessages:       messages,
			IgnoreExistingBotReply: boolFromAny(job.Context["ignoreExistingBotReply"], false) || boolFromAny(job.Context["ignore_existing_bot_reply"], false),
		})
	}
	mutationCandidateActions := actions
	if personaForegroundQueued {
		mutationCandidateActions = nil
	}
	mutationCandidates := len(mutationCandidateActions) - countSlackTriageDirectActions(mutationCandidateActions) + directMutations
	mutations, failures := reconcileTriageCounts(&triageCounters{mutations: mutationCandidates, failures: directFailures}, nil)
	if probe {
		mutations = 0
	}
	if ok {
		var reason string
		ok, reason = triageDidSucceed(job.ID, mutations, failures, nil, rawOutput)
		if !ok {
			job.Error = reason
		}
	}
	toolCalls := append([]SlackTriageToolCall{{
		Tool:    "agent_runner",
		Action:  "slack_triage",
		Args:    marshalTriageArgs(job.Provider, job.ID, decision.ParseOK),
		Success: ok,
		Brief:   mapBool(ok, "AgentRunner triage completed", "AgentRunner triage failed"),
		Result:  rawOutput,
	}}, directToolCalls...)
	extraMetadata := map[string]any{
		"suppressed_reason":  slackTriageSuppressedReason(decision, actions, ok),
		"skip_reason_bucket": slackTriageSkipReasonBucketForDecision(decision, actions, ok),
	}
	triageTimedOut := !ok && slackTriageJobTimedOut(job)
	if triageTimedOut {
		extraMetadata["triage_timeout_needs_retry"] = true
		extraMetadata["triage_timeout_job_status"] = string(job.Status)
	}
	triageEmptyFinal := !ok && slackTriageJobEmptyFinal(job)
	if triageEmptyFinal {
		extraMetadata["triage_empty_final_needs_retry"] = true
		extraMetadata["triage_empty_final_job_status"] = string(job.Status)
	}
	personaShadowQueued := ok && !probe && personaAllowed && !personaForegroundQueued && s.shadowPersonaRuntimeEnabled()
	if personaShadowQueued {
		extraMetadata["persona_shadow_queued"] = true
	}
	if personaForegroundQueued {
		extraMetadata["persona_foreground_queued"] = true
		extraMetadata["codex_suggested_actions"] = len(actions)
	}
	runPatch := SlackTriageContext{
		ID:        runID,
		SessionID: stringFromContext(job.Context, "sessionId", "session_id"),
		Status:    "ok",
		Summary:   decision.Summary,
		RawOutput: rawOutput,
		Digest:    stringFromContext(job.Context, "digest"),
		Channels:  firstNonEmptyStringSlice(extractChannelNames(stringFromContext(job.Context, "digest")), []string{channelID}),
		Actions:   triageActionRows(mutationCandidateActions),
		ToolCalls: toolCalls,
		Steps:     1,
		Mutations: mutations,
		Failures:  failures,
		Metadata:  mergeStringAnyMaps(mapFromAnyOrEmpty(job.Context["triageAudit"]), extraMetadata),
	}
	if !ok {
		runPatch.Status = "failed"
		runPatch.Summary = "Triage failed: " + firstNonEmpty(job.Error, job.Result, string(job.Status))
		runPatch.Error = firstNonEmpty(job.Error, job.Result, string(job.Status), "triage_failed")
		runPatch.Failures = 1
	}
	updatedRun, err := s.triage.UpdateRun(ctx, runPatch)
	if err != nil {
		return nil, err
	}
	if updatedRun != nil {
		persistTriageContext(s.workspaceDir, *updatedRun)
	}
	if triageTimedOut && !probe {
		s.maybeRecordTriageTimeoutFollowup(ctx, workspaceID, channelID, threadTS, updatedRun, job, messages)
	}
	if triageEmptyFinal && !probe {
		s.maybeRecordTriageEmptyFinalFollowup(ctx, workspaceID, channelID, threadTS, updatedRun, messages, map[string]any{
			"failure_source": "agent_runner",
			"job_id":         strings.TrimSpace(job.ID),
			"job_status":     string(job.Status),
			"error":          truncateSlackContextText(firstNonEmpty(job.Error, job.Result), 400),
		})
	}
	if personaForegroundQueued && updatedRun != nil {
		relatedMemory := slackRelatedMemoryRecordsFromAny(job.Context["relatedMemory"])
		s.queueSlackTriagePersonaForeground(context.WithoutCancel(ctx), workspaceID, updatedRun.ID, channelID, threadTS, messages, decision, relatedMemory, boolFromAny(job.Context["ignoreExistingBotReply"], false) || boolFromAny(job.Context["ignore_existing_bot_reply"], false))
	} else if personaShadowQueued && updatedRun != nil {
		relatedMemory := slackRelatedMemoryRecordsFromAny(job.Context["relatedMemory"])
		s.queueSlackTriagePersonaShadow(context.WithoutCancel(ctx), updatedRun.ID, channelID, threadTS, messages, decision, relatedMemory)
	}
	go s.maybeCompactDailyNotes(context.WithoutCancel(ctx))
	if ok && decision.Summary != "" {
		if err := s.cognition.RecordTriageSummary(ctx, workspaceID, channelID, threadTS, runPatch.SessionID, decision.Summary, slackTriageLedgerOutcome(ok, mutations, failures)); err != nil {
			s.logger.Warn("slack thread ledger triage summary record failed", "error", err)
		}
	}
	if ok && !probe {
		s.resolveTriageRetryFollowups(ctx, channelID, threadTS, "superseded_by_successful_triage")
	}
	if ok && !probe && !personaForegroundQueued && len(actions) == 0 {
		s.maybeRecordDelayedNoReplyFollowup(ctx, workspaceID, channelID, threadTS, updatedRun, decision, messages)
	}
	var pendingActions []SlackTriagePendingResult
	if !probe && !personaForegroundQueued {
		pendingActions = s.insertSlackTriagePendingActions(ctx, workspaceID, channelID, threadTS, job.ID, updatedRun, actions)
	}
	finalization := &SlackTriageFinalization{Run: updatedRun, Decision: decision, PendingActions: pendingActions}
	s.finalizedTriageResults[job.ID] = finalization
	return finalization, nil
}

type slackTriageDirectActionOptions struct {
	SnapshotMessages       []SlackInboundMessage
	IgnoreExistingBotReply bool
}

func (s *Service) executeSlackTriageDirectActions(ctx context.Context, workspaceID string, channelID string, threadTS string, runID int64, actions []SlackTriageDecisionAction, snapshotMessages ...[]SlackInboundMessage) ([]SlackTriageToolCall, int, int) {
	var messages []SlackInboundMessage
	if len(snapshotMessages) > 0 {
		messages = snapshotMessages[0]
	}
	return s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, channelID, threadTS, runID, actions, slackTriageDirectActionOptions{
		SnapshotMessages: messages,
	})
}

func (s *Service) executeSlackTriageDirectActionsWithOptions(ctx context.Context, workspaceID string, channelID string, threadTS string, runID int64, actions []SlackTriageDecisionAction, options slackTriageDirectActionOptions) ([]SlackTriageToolCall, int, int) {
	calls := make([]SlackTriageToolCall, 0)
	var failures int
	var mutations int
	messages := options.SnapshotMessages
	for _, action := range actions {
		if !slackTriageDirectReplyAction(action) && !slackTriageDirectReactionAction(action) {
			continue
		}
		effectiveChannel := firstNonEmpty(action.ChannelID, channelID)
		effectiveThread := firstNonEmpty(action.ThreadTS, threadTS)
		snapshotTS := slackTriageSnapshotLatestTS(messages, effectiveChannel, effectiveThread)
		if newer, newerTS, reason := s.slackTriageThreadHasNewerBlockingActivity(ctx, effectiveChannel, effectiveThread, snapshotTS, options.IgnoreExistingBotReply); newer {
			calls = append(calls, SlackTriageToolCall{
				Tool:    "slack_api",
				Action:  "post_thread_reply",
				Args:    marshalTriageArgs("conversations.replies", newerTS, true),
				Success: true,
				Brief:   firstNonEmpty(action.Title, "skipped stale thread reply"),
				Result:  reason,
			})
			continue
		}
		if slackTriageDirectReactionAction(action) {
			emoji := normalizeSlackReactionName(firstNonEmpty(action.Emoji, action.Message, action.Title))
			reactionTS := firstNonEmpty(strings.TrimSpace(action.MessageTS), snapshotTS, effectiveThread)
			if emoji == "" || reactionTS == "" || effectiveChannel == "" {
				failures++
				calls = append(calls, SlackTriageToolCall{
					Tool:    "slack_api",
					Action:  "add_reaction",
					Args:    marshalTriageArgs("reactions.add", reactionTS, false),
					Success: false,
					Brief:   "missing reaction target",
					Result:  "emoji, channel, and timestamp are required",
				})
				continue
			}
			if s.slackTriageShouldSkipUnknownWorkspaceCustomEmoji(emoji) {
				calls = append(calls, SlackTriageToolCall{
					Tool:    "slack_api",
					Action:  "add_reaction",
					Args:    marshalTriageArgs("reactions.add", reactionTS, true),
					Success: true,
					Brief:   "skipped unknown workspace custom emoji :" + emoji + ":",
					Result:  "unknown_workspace_custom_emoji",
				})
				continue
			}
			var result SlackReactionResult
			if s == nil || s.reactions == nil {
				result = SlackReactionResult{Method: "reactions.add", Error: "missing_reaction_client"}
			} else {
				result = s.reactions.AddReaction(ctx, SlackReactionInput{
					Channel:   effectiveChannel,
					Timestamp: reactionTS,
					Name:      emoji,
				})
			}
			ok := result.OK || reactionErrorIsIgnored(true, result.Error)
			call := SlackTriageToolCall{
				Tool:    "slack_api",
				Action:  "add_reaction",
				Args:    marshalTriageArgs("reactions.add", reactionTS, ok),
				Success: ok,
				Brief:   ":" + emoji + ":",
				Result:  firstNonEmpty(result.Error, result.Detail, slackReactionBodyError(result), result.Method),
			}
			if !ok {
				failures++
			} else if err := s.cognition.RecordOutbound(ctx, workspaceID, effectiveChannel, effectiveThread, "Triage reacted :"+emoji+":"); err != nil {
				s.logger.Warn("slack thread ledger direct reaction record failed", "error", err)
			}
			mutations++
			calls = append(calls, call)
			continue
		}
		result := s.PostMessage(ctx, PostMessageInput{
			Channel:  effectiveChannel,
			ThreadTS: effectiveThread,
			Text:     markdownToSlackFallbackText(action.Message),
			Blocks:   buildSlackThreadReplyBlocks(action.Message, "", nil),
			DedupKey: fmt.Sprintf("slack-triage-direct:%d:%s:%s", runID, effectiveChannel, firstNonEmpty(effectiveThread, "root")),
		})
		call := SlackTriageToolCall{
			Tool:    "slack_api",
			Action:  "post_thread_reply",
			Args:    marshalTriageArgs("chat.postMessage", result.TS, result.OK),
			Success: result.OK,
			Brief:   firstNonEmpty(action.Title, firstLine(action.Message), "posted a thread reply"),
			Result:  firstNonEmpty(result.Error, result.Detail, result.TS, result.ThreadTS),
		}
		if !result.OK {
			failures++
		} else if err := s.cognition.RecordOutbound(ctx, workspaceID, effectiveChannel, effectiveThread, "Triage replied: "+firstNonEmpty(action.Title, firstLine(action.Message))); err != nil {
			s.logger.Warn("slack thread ledger direct reply record failed", "error", err)
		}
		mutations++
		calls = append(calls, call)
	}
	return calls, failures, mutations
}

func (s *Service) slackTriageShouldSkipUnknownWorkspaceCustomEmoji(emoji string) bool {
	emoji = normalizeSlackReactionName(emoji)
	if s == nil || emoji == "" {
		return false
	}
	customEmoji := normalizeWorkspaceCustomEmojiNames(s.workspaceCustomEmojiSnapshot())
	if len(customEmoji) == 0 || stringSliceContains(customEmoji, emoji) {
		return false
	}
	return slackReactionLooksLikeWorkspaceCustomEmoji(emoji, customEmoji)
}

func slackReactionLooksLikeWorkspaceCustomEmoji(emoji string, customEmoji []string) bool {
	emoji = strings.ToLower(normalizeSlackReactionName(emoji))
	if emoji == "" {
		return false
	}
	if strings.Contains(emoji, "_bridge") || strings.HasPrefix(emoji, "bridge_") {
		return true
	}
	for _, custom := range customEmoji {
		custom = strings.ToLower(normalizeSlackReactionName(custom))
		if custom == "" {
			continue
		}
		for _, suffix := range []string{"_bridge", "_oneesama", "_slock", "_cueboard"} {
			if strings.HasSuffix(custom, suffix) && strings.HasSuffix(emoji, suffix) {
				return true
			}
		}
		for _, prefix := range []string{"oneesama_", "slock_", "cueboard_"} {
			if strings.HasPrefix(custom, prefix) && strings.HasPrefix(emoji, prefix) {
				return true
			}
		}
	}
	return false
}

func countSlackTriageDirectActions(actions []SlackTriageDecisionAction) int {
	count := 0
	for _, action := range actions {
		if slackTriageDirectReplyAction(action) || slackTriageDirectReactionAction(action) {
			count++
		}
	}
	return count
}

func slackTriageSnapshotLatestTS(messages []SlackInboundMessage, channelID string, threadTS string) string {
	channelID = strings.TrimSpace(channelID)
	threadTS = strings.TrimSpace(threadTS)
	var latest string
	for _, message := range messages {
		message = normalizeSlackInboundMessage(message)
		if channelID != "" && message.ChannelID != "" && message.ChannelID != channelID {
			continue
		}
		messageThread := firstNonEmpty(message.ThreadTS, message.TS)
		if threadTS != "" && messageThread != "" && messageThread != threadTS {
			continue
		}
		if ts := firstNonEmpty(message.TS, message.EventTS); slackTSGreater(ts, latest) {
			latest = ts
		}
	}
	return latest
}

func (s *Service) slackTriageThreadHasNewerBlockingActivity(ctx context.Context, channelID string, threadTS string, snapshotTS string, ignoreExistingBotReply ...bool) (bool, string, string) {
	if s == nil || strings.TrimSpace(s.botToken) == "" || strings.TrimSpace(channelID) == "" || strings.TrimSpace(threadTS) == "" || strings.TrimSpace(threadTS) == "channel-root" || strings.TrimSpace(snapshotTS) == "" {
		return false, "", ""
	}
	response, err := s.callSlackConversationsReplies(ctx, channelID, threadTS)
	if err != nil {
		s.logger.Warn("slack triage direct reply freshness check failed", "channel", channelID, "thread_ts", threadTS, "error", err)
		return false, "", ""
	}
	if !response.OK {
		s.logger.Warn("slack triage direct reply freshness check returned slack error", "channel", channelID, "thread_ts", threadTS, "error", response.Error)
		return false, "", ""
	}
	ignoreBotReply := len(ignoreExistingBotReply) > 0 && ignoreExistingBotReply[0]
	for _, message := range slackInboundMessagesFromThreadMessages(channelID, response.Messages) {
		if !slackTSGreater(firstNonEmpty(message.TS, message.EventTS), snapshotTS) {
			continue
		}
		if isAuthoredByBot(message, []string{s.botUserID}) {
			if ignoreBotReply {
				continue
			}
			return true, firstNonEmpty(message.TS, message.EventTS), "thread_has_newer_bot_activity"
		}
		return true, firstNonEmpty(message.TS, message.EventTS), "thread_has_newer_activity"
	}
	return false, "", ""
}

func slackTriageLedgerOutcome(ok bool, mutations int, failures int) string {
	switch {
	case !ok || failures > 0:
		return "failed"
	case mutations > 0:
		return "acted"
	default:
		return "no_action"
	}
}

func firstNonEmptyStringSlice(values []string, fallback []string) []string {
	if len(values) > 0 {
		return values
	}
	return fallback
}
