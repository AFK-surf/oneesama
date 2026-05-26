package slackagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
)

func (s *Service) handleAgentRunnerProgress(ctx context.Context, job agentrunner.Job) {
	if isSlackTriageJob(job) {
		return
	}
	if isPersonaDelegatedWorkerJob(job) {
		return
	}
	if job.Status != agentrunner.StatusRunning {
		return
	}
	ref, ok := slackRefForWorkerJob(job)
	if !ok {
		return
	}
	s.scheduleAssistantThreadStatus(ctx, ref, assistantStatusTextForJob(job), false)
}

func (s *Service) handleAgentRunnerUpdate(ctx context.Context, job agentrunner.Job) {
	if isSlackTriageJob(job) {
		if isTerminalJobStatus(job.Status) {
			if _, err := s.finalizeSlackTriageJob(ctx, job); err != nil {
				s.logger.Warn("slack triage finalization failed", "job_id", job.ID, "error", err)
			}
		}
		return
	}
	if !isTerminalJobStatus(job.Status) || !s.claimFinalizedWorkerJob(job.ID) {
		return
	}
	if s.handleMeetingCopilotToolRequest(ctx, job) {
		return
	}
	if s.handleSlackWorkerToolRequest(ctx, job) {
		return
	}
	if isPersonaDelegatedWorkerJob(job) {
		s.reportWorkerJobToMeetingAgent(ctx, job)
		handled := s.handlePersonaDelegatedWorkerResult(ctx, job)
		if ref, ok := slackRefForWorkerJob(job); ok {
			s.scheduleAssistantThreadStatus(ctx, ref, "", true)
			if job.Status == agentrunner.StatusCompleted && handled {
				s.removeSlackReaction(ctx, ref.ChannelID, ref.ReactionTS, slackReactionEyes)
			} else if job.Status == agentrunner.StatusCompleted && slackWorkerResultText(job) == "" {
				s.removeSlackReaction(ctx, ref.ChannelID, ref.ReactionTS, slackReactionEyes)
			} else {
				s.finishMentionReaction(ctx, ref, slackReactionWarn)
			}
		}
		return
	}
	s.reportWorkerJobToMeetingAgent(ctx, job)
	delivered := s.postSlackWorkerResult(ctx, job)
	if ref, ok := slackRefForWorkerJob(job); ok {
		s.scheduleAssistantThreadStatus(ctx, ref, "", true)
		if job.Status == agentrunner.StatusCompleted && delivered {
			s.finishMentionReaction(ctx, ref, slackReactionOK)
		} else if job.Status == agentrunner.StatusCompleted && isPersonaDelegatedWorkerJob(job) && slackWorkerResultText(job) == "" {
			s.removeSlackReaction(ctx, ref.ChannelID, ref.ReactionTS, slackReactionEyes)
		} else {
			s.finishMentionReaction(ctx, ref, slackReactionWarn)
		}
	}
}

func (s *Service) handlePersonaDelegatedWorkerResult(ctx context.Context, job agentrunner.Job) bool {
	if job.Status != agentrunner.StatusCompleted {
		return false
	}
	ref, ok := slackRefForWorkerJob(job)
	if !ok {
		return false
	}
	request, messages, ok := buildPersonaDelegatedWorkerReturnRequest(job)
	if !ok {
		return false
	}
	if !s.foregroundPersonaRuntimeEnabled() {
		s.logger.Warn("persona delegated worker result skipped because foreground runtime is not ready", "job_id", job.ID)
		return false
	}
	workspaceID := firstNonEmpty(stringFromContext(job.Context, "workspaceId", "workspace_id"), "workspace")
	runID := int64FromContext(job.Context, "triageRunId", "triage_run_id")
	callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
	defer cancel()
	result := callPersonaShadow(callCtx, s.personaRuntime, "worker_return", request)
	disposition := s.applySlackPersonaForegroundDispositions(result, request, messages)
	result = disposition.Result
	actions := slackTriageVisibleReplyActionsAfterGate(slackPersonaForegroundActions(ref.ChannelID, ref.ThreadTS, result, request))
	toolCalls := []SlackTriageToolCall{personaDelegatedWorkerReturnToolCall(job, result)}
	toolCalls = append(toolCalls, disposition.ToolCalls...)
	directToolCalls, failures, mutations := s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, ref.ChannelID, ref.ThreadTS, runID, actions, slackTriageDirectActionOptions{
		SnapshotMessages: messages,
	})
	toolCalls = append(toolCalls, directToolCalls...)
	pending := s.insertSlackTriagePendingActions(ctx, workspaceID, ref.ChannelID, ref.ThreadTS, job.ID, &SlackTriageContext{ID: runID}, actions)
	toolCalls = append(toolCalls, personaTriageApprovalToolCalls(pending)...)
	if err := s.recordSlackTriagePersonaForegroundResult(ctx, workspaceID, runID, result, actions, toolCalls, failures, mutations); err != nil {
		s.logger.Warn("persona delegated worker second-pass record failed", "job_id", job.ID, "triage_run_id", runID, "error", err)
	}
	return result.Success && failures == 0
}

func buildPersonaDelegatedWorkerReturnRequest(job agentrunner.Job) (persona.Request, []SlackInboundMessage, bool) {
	ref, ok := slackRefForWorkerJob(job)
	if !ok {
		return persona.Request{}, nil, false
	}
	envelope := agentrunner.NewWorkerResultEnvelope(job)
	workerText := agentrunner.WorkerResultEnvelopeCompletedText(envelope)
	if strings.TrimSpace(workerText) == "" {
		return persona.Request{}, nil, false
	}
	visibleText, anchors, reason := workerText, []SlackVisibleEvidenceAnchor{{
		Kind:      slackVisibleEvidenceKindWorkerResult,
		SourceRef: firstNonEmpty(strings.TrimSpace(job.ID), "persona_delegate_worker"),
		Quote:     workerText,
	}}, ""
	if isPersonaSecretaryLookupWorkerJob(job) {
		if parsedText, parsedAnchors, parsedReason, ok := slackSecretaryLookupWorkerVisibleResult(workerText); ok {
			visibleText, anchors, reason = parsedText, parsedAnchors, parsedReason
		}
	}
	anchors = normalizeSlackVisibleEvidenceAnchors(anchors)
	messages := personaDelegatedWorkerReturnMessages(job, ref)
	contextItems := []persona.ContextItem{
		{
			Kind: "worker_return_instruction",
			Text: "The delegated worker result is evidence only, not a message to post. Re-read the original Slack request and the worker evidence, then decide the next Oneesama action. If replying, rewrite in Oneesama's own concise human-facing voice with typed evidence_anchors. If the thread is already handled or the worker adds no value, choose stay_silent or react.",
		},
		{
			Kind:      "worker_result_context",
			SourceRef: strings.TrimSpace(job.ID),
			Text:      formatPersonaDelegatedWorkerReturnContext(job, visibleText, reason, anchors),
		},
	}
	if transcript := personaDelegatedWorkerReturnTranscript(job.Context); transcript != "" {
		contextItems = append(contextItems, persona.ContextItem{Kind: "slack_thread_context", Text: transcript})
	}
	if external := firstNonEmpty(stringFromContext(job.Context, "external_link_context"), stringFromContext(job.Context, "externalLinkContext")); external != "" {
		contextItems = append(contextItems, persona.ContextItem{Kind: "external_link_context", Text: truncateSlackContextText(external, slackExternalLinkContextBudgetChars)})
	}
	if memory := stringFromContext(job.Context, "workspace_memory_evidence", "workspaceMemoryEvidence"); memory != "" {
		contextItems = append(contextItems, persona.ContextItem{Kind: "workspace_memory_evidence", Text: truncateSlackContextText(memory, slackPreviousTriageContextBudgetChars)})
	}
	originalText := firstNonEmpty(slackWorkerTurnUserContent(job), latestSlackInboundMessageText(messages), strings.TrimSpace(job.Task))
	citations := personaDelegatedWorkerReturnCitations(anchors)
	return persona.Request{
		ID:   fmt.Sprintf("worker-return:%s", firstNonEmpty(strings.TrimSpace(job.ID), "unknown")),
		Mode: persona.ModeLive,
		Event: persona.Event{
			Kind: "slack_worker_result_return",
			Text: originalText,
		},
		Anchor: persona.Anchor{
			Surface:   "slack",
			ChannelID: ref.ChannelID,
			ThreadTS:  ref.ThreadTS,
			MessageTS: ref.ReactionTS,
		},
		Context: contextItems,
		Evidence: persona.EvidenceBundle{
			Summary:   truncateSlackContextText(visibleText, 800),
			Citations: citations,
		},
		Safety: persona.SafetyConstraints{
			AllowVisibleReply:  true,
			AllowSpeech:        false,
			AllowWorkerRequest: false,
			AllowReactions:     true,
			MaxVisibleChars:    600,
		},
		Metadata: map[string]any{
			"worker_return_second_pass": true,
			"worker_job_id":             strings.TrimSpace(job.ID),
			"worker_session_kind":       stringFromContext(job.Context, "session_kind", "sessionKind"),
			"triage_run_id":             int64FromContext(job.Context, "triageRunId", "triage_run_id"),
		},
	}, messages, true
}

func personaDelegatedWorkerReturnToolCall(job agentrunner.Job, result SlackPersonaShadowResult) SlackTriageToolCall {
	return SlackTriageToolCall{
		Tool:    "persona_runtime",
		Action:  "worker_result_second_pass",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(job.ID), result.Success),
		Success: result.Success,
		Brief:   "Persona chewed delegated worker result before any visible Slack action",
		Result:  firstNonEmpty(result.VisibleText, result.Reason, result.Error),
	}
}

func formatPersonaDelegatedWorkerReturnContext(job agentrunner.Job, visibleText string, reason string, anchors []SlackVisibleEvidenceAnchor) string {
	var b strings.Builder
	if task := strings.TrimSpace(job.Task); task != "" {
		fmt.Fprintf(&b, "Original delegated task:\n%s\n\n", truncateSlackContextText(task, 1000))
	}
	fmt.Fprintf(&b, "Worker visible candidate (not approved for direct posting):\n%s", truncateSlackContextText(visibleText, 1800))
	if reason = strings.TrimSpace(reason); reason != "" {
		fmt.Fprintf(&b, "\n\nWorker private reason:\n%s", truncateSlackContextText(reason, 800))
	}
	if len(anchors) > 0 {
		b.WriteString("\n\nWorker evidence anchors:")
		for _, anchor := range normalizeSlackVisibleEvidenceAnchors(anchors) {
			fmt.Fprintf(&b, "\n- %s %s", anchor.Kind, anchor.SourceRef)
			if quote := strings.TrimSpace(anchor.Quote); quote != "" {
				fmt.Fprintf(&b, ": %s", quote)
			}
		}
	}
	return strings.TrimSpace(b.String())
}

func personaDelegatedWorkerReturnCitations(anchors []SlackVisibleEvidenceAnchor) []persona.Citation {
	anchors = normalizeSlackVisibleEvidenceAnchors(anchors)
	out := make([]persona.Citation, 0, len(anchors))
	for _, anchor := range anchors {
		out = append(out, persona.Citation{
			Kind:      anchor.Kind,
			Source:    anchor.SourceRef,
			SourceRef: anchor.SourceRef,
			Snippet:   anchor.Quote,
		})
	}
	return out
}

func personaDelegatedWorkerReturnTranscript(context map[string]any) string {
	switch typed := context["slackAppMention"].(type) {
	case *SlackAppMentionContext:
		if typed == nil {
			return ""
		}
		return truncateSlackContextText(firstNonEmpty(typed.Transcript, typed.Prompt), slackThreadContextBudgetChars)
	case SlackAppMentionContext:
		return truncateSlackContextText(firstNonEmpty(typed.Transcript, typed.Prompt), slackThreadContextBudgetChars)
	case map[string]any:
		return truncateSlackContextText(firstNonEmpty(stringFromAny(typed["transcript"]), stringFromAny(typed["prompt"])), slackThreadContextBudgetChars)
	default:
		return ""
	}
}

func personaDelegatedWorkerReturnMessages(job agentrunner.Job, ref AssistantThreadRef) []SlackInboundMessage {
	if messages := messagesFromContext(job.Context["messages"]); len(messages) > 0 {
		return messages
	}
	switch typed := job.Context["slackAppMention"].(type) {
	case *SlackAppMentionContext:
		if typed == nil {
			return nil
		}
		return normalizeSlackInboundMessages([]SlackInboundMessage{{
			ChannelID: ref.ChannelID,
			ThreadTS:  ref.ThreadTS,
			UserID:    typed.UserID,
			Text:      firstNonEmpty(typed.MentionText, typed.RawMentionText),
			TS:        ref.ReactionTS,
		}})
	case SlackAppMentionContext:
		return normalizeSlackInboundMessages([]SlackInboundMessage{{
			ChannelID: ref.ChannelID,
			ThreadTS:  ref.ThreadTS,
			UserID:    typed.UserID,
			Text:      firstNonEmpty(typed.MentionText, typed.RawMentionText),
			TS:        ref.ReactionTS,
		}})
	case map[string]any:
		return normalizeSlackInboundMessages([]SlackInboundMessage{{
			ChannelID: ref.ChannelID,
			ThreadTS:  ref.ThreadTS,
			UserID:    stringFromAny(typed["userId"]),
			Text:      firstNonEmpty(stringFromAny(typed["mentionText"]), stringFromAny(typed["rawMentionText"])),
			TS:        ref.ReactionTS,
		}})
	default:
		return nil
	}
}

func (s *Service) reportWorkerJobToMeetingAgent(ctx context.Context, job agentrunner.Job) {
	envelope := agentrunner.NewWorkerResultEnvelope(job)
	var result map[string]any
	err := s.postMeetingAgentJSON(ctx, "/worker/report", map[string]any{
		"id":               job.ID,
		"status":           job.Status,
		"provider":         job.Provider,
		"mode":             job.Mode,
		"task":             job.Task,
		"context":          job.Context,
		"allowCodeChanges": job.AllowCodeChanges,
		"result":           envelope.Result,
		"error":            envelope.Error,
		"resultEnvelope":   envelope,
	}, &result)
	if err != nil {
		s.logger.Warn("meeting worker report failed", "job_id", job.ID, "error", err)
	}
}

func (s *Service) postSlackWorkerResult(ctx context.Context, job agentrunner.Job) bool {
	ref, ok := slackRefForWorkerJob(job)
	if !ok {
		return false
	}
	text := slackWorkerResultText(job)
	if strings.TrimSpace(text) == "" {
		return false
	}
	dedupKey := fmt.Sprintf("slack-worker-result:%s:%s:%s", job.ID, ref.ChannelID, firstNonEmpty(ref.ThreadTS, "root"))
	snapshotTS := slackWorkerFreshnessSnapshotTS(job, ref)
	if delivery := s.deliverSlackPublicThreadReply(ctx, slackPublicThreadReplyDelivery{
		Source:        slackPublicReplySourceWorkerFreshnessProbe,
		SurfaceKind:   slackPublicReplySurfaceThreadReply,
		ChannelID:     ref.ChannelID,
		ThreadTS:      ref.ThreadTS,
		Message:       text,
		SnapshotTS:    snapshotTS,
		FreshnessOnly: true,
	}); delivery.Blocked {
		return false
	}
	if shouldPublishWorkerResultAsCanvas(job, text) {
		manifest, err := s.PublishCanvas(ctx, workerResultCanvasInput(job, ref, text, dedupKey))
		if err == nil && manifest.OK {
			s.syncSlackWorkerMemoryTurn(ctx, job, ref, text, "canvas")
			return true
		}
		if err != nil {
			s.logger.Warn("slack worker canvas publish failed", "job_id", job.ID, "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "error", err)
		} else {
			s.logger.Warn("slack worker canvas publish failed", "job_id", job.ID, "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "surface", manifest.Surface)
		}
	}
	delivery := s.deliverSlackPublicThreadReply(ctx, slackPublicThreadReplyDelivery{
		Source:        slackPublicReplySourceWorkerResult,
		SurfaceKind:   slackPublicReplySurfaceThreadReply,
		WorkspaceID:   "workspace",
		ChannelID:     ref.ChannelID,
		ThreadTS:      ref.ThreadTS,
		Message:       text,
		Blocks:        buildSlackThreadReplyBlocks(text, "", nil),
		DedupKey:      dedupKey,
		SnapshotTS:    snapshotTS,
		LedgerSummary: "worker_result: " + firstTextLine(text),
	})
	result := delivery.Post
	if delivery.Blocked {
		return false
	}
	if !result.OK {
		s.logger.Warn("slack worker result post failed", "job_id", job.ID, "channel", ref.ChannelID, "thread_ts", ref.ThreadTS, "error", result.Error, "detail", result.Detail)
		return false
	}
	s.syncSlackWorkerMemoryTurn(ctx, job, ref, text, "thread_reply")
	return true
}

func slackWorkerFreshnessSnapshotTS(job agentrunner.Job, ref AssistantThreadRef) string {
	slack, _ := mapFromAny(job.Context["slack"])
	return firstNonEmpty(
		stringFromAny(slack["freshnessSnapshotTS"]),
		stringFromAny(slack["freshness_snapshot_ts"]),
		stringFromAny(slack["snapshotTS"]),
		stringFromAny(slack["snapshot_ts"]),
		ref.ReactionTS,
		ref.ThreadTS,
	)
}

func (s *Service) syncSlackWorkerMemoryTurn(ctx context.Context, job agentrunner.Job, ref AssistantThreadRef, assistantText string, delivery string) {
	if job.Status != agentrunner.StatusCompleted {
		return
	}
	envelope := agentrunner.NewWorkerResultEnvelope(job)
	userContent := slackWorkerTurnUserContent(job)
	if strings.TrimSpace(userContent) == "" && strings.TrimSpace(assistantText) == "" {
		return
	}
	s.syncMemoryProvidersTurn(ctx, SlackMemoryProviderTurn{
		SessionID:        firstNonEmpty(stringFromContext(job.Context, "sessionId", "session_id"), job.ID),
		UserContent:      userContent,
		AssistantContent: assistantText,
		Metadata: map[string]any{
			"source":                           "slack_worker_result",
			"job_id":                           strings.TrimSpace(job.ID),
			"channel_id":                       strings.TrimSpace(ref.ChannelID),
			"thread_ts":                        strings.TrimSpace(ref.ThreadTS),
			"delivery":                         strings.TrimSpace(delivery),
			"worker_result_envelope_schema":    envelope.Schema,
			"worker_result_envelope_truncated": envelope.Truncated,
			"worker_result_chars":              envelope.ResultChars,
		},
	})
}
