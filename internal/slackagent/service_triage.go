package slackagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func (s *Service) TriageStatus(ctx context.Context, limit int) (SlackTriageStatus, error) {
	if limit <= 0 {
		limit = 10
	}
	runs, err := s.triage.ListRuns(ctx, limit)
	if err != nil {
		return SlackTriageStatus{}, err
	}
	actions, err := s.triage.ListPendingActions(ctx, limit)
	if err != nil {
		return SlackTriageStatus{}, err
	}
	brains, err := s.cognition.ListChannelBrains(ctx, limit)
	if err != nil {
		return SlackTriageStatus{}, err
	}
	return SlackTriageStatus{
		Enabled:           s.InboundStatus().EventBuffer.TriageEnabled,
		PostActions:       s.triagePostActions,
		HeuristicFallback: s.triageHeuristicFallback,
		LastTriageJobID:   s.InboundStatus().EventBuffer.LastTriageJobID,
		Runs:              runs,
		PendingActions:    actions,
		ChannelBrains:     brains,
	}, nil
}

func (s *Service) StartSlackTriage(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string) (SlackTriageStartResult, error) {
	if s.runner == nil {
		return SlackTriageStartResult{}, fmt.Errorf("agent runner is not ready: %s", runnerErrorText(s.runnerErr))
	}
	messages = normalizeSlackInboundMessages(messages)
	workspaceID := firstNonEmpty(firstMessageTeamID(messages), "workspace")
	threadTS := firstNonEmpty(lastMessageThreadTS(messages), "channel-root")
	sessionID := fmt.Sprintf("triage:%s:%d", channelID, timeNow().UnixMilli())
	threadContexts := s.fetchSlackTriageThreadContexts(ctx, channelID, messages)
	if enriched := appendSlackTriageThreadContextDigest(digest, threadContexts); enriched != "" {
		digest = enriched
	}
	externalLinks := fetchSlackExternalLinkContexts(ctx, messages)
	auditMetadata := slackTriageAuditMetadata(digest, messages, threadContexts, externalLinks)
	run, err := s.triage.RecordRun(ctx, SlackTriageContext{
		SessionID: sessionID,
		Status:    "pending",
		Summary:   fmt.Sprintf("Triage pending for %d Slack message(s) in %s", len(messages), channelID),
		Digest:    digest,
		Channels:  []string{channelID},
		Steps:     0,
		Metadata:  auditMetadata,
	})
	if err != nil {
		return SlackTriageStartResult{}, err
	}

	channelBrain, _ := s.cognition.GetChannelBrain(ctx, workspaceID, channelID)
	previousRuns := loadTriageContexts(s.triage, s.workspaceDir)
	previous := filterTriageContextsForChannel(previousRuns, channelID)
	localMemory := slackTriageMemoryFromLocal(s.SearchLocalMemory(digest, 5), digest)
	prompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID:      channelID,
		Messages:       messages,
		Digest:         digest,
		ChannelBrain:   channelBrain,
		LocalMemory:    localMemory,
		PreviousTriage: formatTriageContexts(previous),
		ExternalLinks:  externalLinks,
		ThreadContexts: threadContexts,
	})
	contextMap := map[string]any{
		"source":        "slack-triage",
		"sessionId":     sessionID,
		"session_id":    sessionID,
		"channelId":     channelID,
		"channel_id":    channelID,
		"workspaceId":   workspaceID,
		"workspace_id":  workspaceID,
		"threadTs":      threadTS,
		"thread_ts":     threadTS,
		"messageCount":  len(messages),
		"message_count": len(messages),
		"messages":      messages,
		"digest":        digest,
		"triageRunId":   run.ID,
		"triage_run_id": run.ID,
		"localSlackMemory": map[string]any{
			"results": localMemory,
			"query":   digest,
			"limit":   5,
		},
		"domainContext": map[string]any{
			"channelBrain": channelBrain,
			"recentThreads": func() []SlackThreadLedgerRecord {
				records, _ := s.cognition.ListRecentThreadLedgers(ctx, workspaceID, channelID, 8)
				return records
			}(),
		},
		"previousTriage": map[string]any{
			"workspaceId": workspaceID,
			"channelId":   channelID,
			"count":       len(previous),
			"text":        formatTriageContexts(previous),
		},
		"externalLinks":  externalLinks,
		"threadContexts": threadContexts,
		"triageAudit":    auditMetadata,
		"expectedOutput": "JSON triage decision with summary and actions[]",
	}
	job, err := s.runner.StartTask(ctx, agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             prompt,
		Context:          contextMap,
		Mode:             "analysis",
		AllowCodeChanges: false,
	}, agentrunner.SessionKindTriage))
	if err != nil {
		return SlackTriageStartResult{Run: run}, err
	}
	s.inbound.SetLastTriageJob(job.ID)
	result := SlackTriageStartResult{Run: run, Job: job}
	if isTerminalJobStatus(job.Status) {
		finalization, err := s.finalizeSlackTriageJob(ctx, job)
		if err != nil {
			return result, err
		}
		result.Finalization = finalization
	}
	return result, nil
}

func (s *Service) recordSlackTriageOnly(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string) (*SlackTriageContext, error) {
	run, err := s.triage.RecordRun(ctx, SlackTriageContext{
		SessionID: fmt.Sprintf("buffer:%s:%d", channelID, s.InboundStatus().EventBuffer.Flushes),
		Status:    "recorded",
		Summary:   fmt.Sprintf("Buffered %d Slack message(s) for %s", len(messages), channelID),
		Digest:    digest,
		Channels:  []string{channelID},
		Steps:     0,
	})
	if run != nil {
		persistTriageContext(s.workspaceDir, *run)
	}
	return run, err
}

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
	actions := filterSlackTriageActionsForMessages(decision.Actions, messages, s.botUserID)
	decision.Actions = actions
	if !ok {
		actions = nil
		decision.Actions = nil
	}
	directToolCalls, directFailures := s.executeSlackTriageDirectActions(ctx, workspaceID, channelID, threadTS, runID, actions)
	mutations, failures := reconcileTriageCounts(&triageCounters{mutations: len(actions), failures: directFailures}, nil)
	if ok {
		var reason string
		ok, reason = triageDidSucceed(job.ID, mutations, failures, nil, rawOutput)
		if !ok {
			job.Error = reason
		}
	}
	runPatch := SlackTriageContext{
		ID:        runID,
		SessionID: stringFromContext(job.Context, "sessionId", "session_id"),
		Status:    "ok",
		Summary:   decision.Summary,
		RawOutput: rawOutput,
		Digest:    stringFromContext(job.Context, "digest"),
		Channels:  firstNonEmptyStringSlice(extractChannelNames(stringFromContext(job.Context, "digest")), []string{channelID}),
		Actions:   triageActionRows(actions),
		ToolCalls: append([]SlackTriageToolCall{{
			Tool:    "agent_runner",
			Action:  "slack_triage",
			Args:    marshalTriageArgs(job.Provider, job.ID, decision.ParseOK),
			Success: ok,
			Brief:   mapBool(ok, "AgentRunner triage completed", "AgentRunner triage failed"),
			Result:  rawOutput,
		}}, directToolCalls...),
		Steps:     1,
		Mutations: mutations,
		Failures:  failures,
		Metadata:  mergeStringAnyMaps(mapFromAnyOrEmpty(job.Context["triageAudit"]), map[string]any{"suppressed_reason": slackTriageSuppressedReason(decision, actions, ok)}),
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
	go s.maybeCompactDailyNotes(context.WithoutCancel(ctx))
	if ok && decision.Summary != "" {
		if _, err := s.cognition.UpsertChannelBrainSummary(ctx, workspaceID, channelID, decision.Summary); err != nil {
			s.logger.Warn("slack channel brain summary update failed", "error", err)
		}
	}
	pendingActions := s.insertSlackTriagePendingActions(ctx, workspaceID, channelID, threadTS, job.ID, updatedRun, actions)
	finalization := &SlackTriageFinalization{Run: updatedRun, Decision: decision, PendingActions: pendingActions}
	s.finalizedTriageResults[job.ID] = finalization
	return finalization, nil
}

func (s *Service) executeSlackTriageDirectActions(ctx context.Context, workspaceID string, channelID string, threadTS string, runID int64, actions []SlackTriageDecisionAction) ([]SlackTriageToolCall, int) {
	calls := make([]SlackTriageToolCall, 0)
	var failures int
	for _, action := range actions {
		if !slackTriageDirectReplyAction(action) {
			continue
		}
		effectiveChannel := firstNonEmpty(action.ChannelID, channelID)
		effectiveThread := firstNonEmpty(action.ThreadTS, threadTS)
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
		calls = append(calls, call)
	}
	return calls, failures
}

func firstNonEmptyStringSlice(values []string, fallback []string) []string {
	if len(values) > 0 {
		return values
	}
	return fallback
}

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

func slackTriageAuditMetadata(digest string, messages []SlackInboundMessage, threadContexts []SlackTriageThreadContext, externalLinks []SlackExternalLinkContext) map[string]any {
	threadFetched := false
	threadMessages := 0
	for _, context := range threadContexts {
		if context.FetchOK {
			threadFetched = true
			threadMessages += context.MessageCount
		}
	}
	return map[string]any{
		"input_context_chars":     len([]rune(digest)),
		"message_count":           len(messages),
		"thread_context_fetched":  threadFetched,
		"thread_context_count":    len(threadContexts),
		"thread_context_messages": threadMessages,
		"external_links_fetched":  len(externalLinks),
	}
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
