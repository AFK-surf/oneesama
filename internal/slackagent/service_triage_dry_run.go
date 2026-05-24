package slackagent

import (
	"context"
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/persona"
)

func (s *Service) DryRunSlackTriage(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string, options slackTriageStartOptions) (SlackTriageDryRunResult, error) {
	if !s.foregroundPersonaRuntimeEnabled() {
		return SlackTriageDryRunResult{}, fmt.Errorf("persona foreground runtime is not ready for dry-run replay")
	}
	prepared := s.prepareSlackTriagePersonaRequest(ctx, channelID, messages, digest, options)
	request := prepared.Request
	callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
	defer cancel()
	result := callPersonaShadow(callCtx, s.personaRuntime, "triage_dry_run", request)
	disposition := s.applySlackPersonaForegroundDispositions(result, request, prepared.Messages)
	result = disposition.Result
	if action, ok := slackTriageSharedLinkSynthesisAction(
		prepared.ChannelID,
		prepared.ThreadTS,
		prepared.Messages,
		prepared.ExternalLinks,
		personaDynamicContextTextFromRequest(request, "workspace_triage_policy"),
	); ok && strings.TrimSpace(result.Decision) == persona.DecisionStaySilent && slackVisibleReplyAllowListVerdictForAction(action).Allowed {
		result = applySlackPersonaVisibleReplyAction(result, action)
		disposition.ToolCalls = append(disposition.ToolCalls, SlackTriageToolCall{
			Tool:    "persona_runtime",
			Action:  "dry_run_link_synthesis_fallback",
			Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
			Success: true,
			Brief:   "Dry-run link synthesis fallback converted silent result to visible reply",
			Result:  "fetched_link_context",
		})
	}

	actionsBeforeGate := slackPersonaForegroundActions(prepared.ChannelID, prepared.ThreadTS, result, request)
	actionsAfterGate := slackTriageVisibleReplyActionsAfterGate(actionsBeforeGate)
	verdicts := slackTriageDryRunVisibleReplyVerdicts(actionsBeforeGate)
	workers := slackTriageDryRunWorkers(result, request)
	toolCalls := append([]SlackTriageToolCall(nil), disposition.ToolCalls...)
	toolCalls = append(toolCalls, slackTriageDryRunVisibleReplyToolCalls(actionsBeforeGate, actionsAfterGate)...)
	toolCalls = append(toolCalls, slackTriageDryRunWorkerToolCalls(workers)...)

	return SlackTriageDryRunResult{
		DryRun:               true,
		ChannelID:            prepared.ChannelID,
		ThreadTS:             prepared.ThreadTS,
		MessageCount:         len(prepared.Messages),
		Digest:               prepared.Digest,
		RelatedMemory:        prepared.RelatedMemory,
		RequestID:            request.ID,
		Persona:              result,
		FinalDecision:        slackTriageDryRunFinalDecision(result, actionsAfterGate, workers),
		ActionsBeforeGate:    actionsBeforeGate,
		ActionsAfterGate:     actionsAfterGate,
		VisibleReplyVerdicts: verdicts,
		WouldDelegateWorkers: workers,
		WouldMemoryWrites:    append([]string(nil), result.MemoryWrites...),
		ToolCalls:            toolCalls,
		SideEffectsBlocked: []string{
			"slack_post",
			"reaction",
			"worker_start",
			"memory_write",
		},
		ContextBudget:        slackTriageDryRunContextBudget(request),
		PipelineSmellSignals: slackTriageDryRunPipelineSmells(result, actionsBeforeGate, actionsAfterGate, workers, request, prepared.ExternalLinks),
	}, nil
}

type slackTriagePersonaRequestPreparation struct {
	ChannelID       string
	ThreadTS        string
	Messages        []SlackInboundMessage
	Digest          string
	ExternalLinks   []SlackExternalLinkContext
	RelatedMemory   SlackRelatedMemorySearchResult
	AuditMetadata   map[string]any
	Request         persona.Request
	WorkspaceID     string
	ForegroundChain string
}

func (s *Service) prepareSlackTriagePersonaRequest(ctx context.Context, channelID string, messages []SlackInboundMessage, digest string, options slackTriageStartOptions) slackTriagePersonaRequestPreparation {
	messages = normalizeSlackInboundMessages(messages)
	channelID = firstNonEmpty(strings.TrimSpace(channelID), firstMessageChannelID(messages), "C_TRIAGE")
	workspaceID := firstNonEmpty(firstMessageTeamID(messages), "workspace")
	threadTS := firstNonEmpty(lastMessageThreadTS(messages), "channel-root")
	foregroundChain := s.slackTriageForegroundChain()
	var ignoredMessageBotReplyCount int
	if options.IgnoreExistingBotReply {
		messages, ignoredMessageBotReplyCount = filterSlackTriageBotInboundMessages(messages, []string{s.botUserID})
	}
	if strings.TrimSpace(digest) == "" {
		digest = renderSlackActivityDigest(channelID, messages)
	}
	threadContexts := s.fetchSlackTriageThreadContexts(ctx, channelID, messages)
	var ignoredBotReplyCount int
	if options.IgnoreExistingBotReply {
		threadContexts, ignoredBotReplyCount = filterSlackTriageThreadContextBotReplies(threadContexts, []string{s.botUserID})
	}
	channelContexts := s.fetchSlackTriageChannelContexts(ctx, channelID, messages, digest, threadContexts)
	threadContexts, summaryMetadata := s.maybeSummarizeOversizedSlackTriageThreadContexts(ctx, channelID, threadTS, messages, digest, threadContexts)
	if len(channelContexts) > 0 {
		digest = renderSlackActivityDigestWithContext(channelID, channelContexts, messages)
	}
	if enriched := appendSlackTriageThreadContextDigest(digest, threadContexts); enriched != "" {
		digest = enriched
	}
	externalLinks := fetchSlackExternalLinkContexts(ctx, messages)
	workspacePolicyStatus := s.slackWorkspacePolicyStatus()
	auditMetadata := slackTriageAuditMetadata(digest, messages, threadContexts, channelContexts, externalLinks)
	auditMetadata = mergeStringAnyMaps(auditMetadata, summaryMetadata)
	auditMetadata = mergeStringAnyMaps(auditMetadata, slackWorkspacePolicyMetadataMap(workspacePolicyStatus))
	if options.IgnoreExistingBotReply {
		auditMetadata = mergeStringAnyMaps(auditMetadata, map[string]any{
			"ignore_existing_bot_reply":          true,
			"ignored_existing_bot_reply_count":   ignoredBotReplyCount + ignoredMessageBotReplyCount,
			"ignored_existing_bot_message_count": ignoredMessageBotReplyCount,
		})
	}
	auditMetadata = mergeStringAnyMaps(auditMetadata, map[string]any{
		"foreground_chain":            foregroundChain,
		"workspace_id":                workspaceID,
		"channel_id":                  channelID,
		"thread_ts":                   threadTS,
		"session_id":                  fmt.Sprintf("triage-dry-run:%s:%d", channelID, timeNow().UnixMilli()),
		"pre_pi_agent_runner_started": false,
		"persona_foreground_pi_first": true,
		"dry_run":                     true,
	}, options.ExtraMetadata)
	previousRuns := loadTriageContexts(s.triage, s.workspaceDir)
	previous := filterTriageContextsForChannel(previousRuns, channelID)
	memoryQuery := slackTriageRelatedMemoryQuery(messages, digest, externalLinks)
	relatedMemory := s.searchSlackTriageRelatedMemoryContext(ctx, memoryQuery, 5)
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID:              channelID,
		ThreadTS:               threadTS,
		Messages:               messages,
		RelatedMemory:          relatedMemory.Results,
		Digest:                 digest,
		ExternalLinks:          externalLinks,
		ThreadContexts:         threadContexts,
		ChannelContexts:        channelContexts,
		PreviousTriage:         formatTriageContexts(previous),
		IgnoreExistingBotReply: options.IgnoreExistingBotReply,
		WorkspaceTriagePolicy:  s.triageWorkspacePolicy,
		WorkspacePolicyStatus:  workspacePolicyStatus,
		CustomEmoji:            s.workspaceCustomEmojiSnapshot(),
	})
	request.Mode = persona.ModeLive
	return slackTriagePersonaRequestPreparation{
		ChannelID:       channelID,
		ThreadTS:        threadTS,
		Messages:        messages,
		Digest:          digest,
		ExternalLinks:   externalLinks,
		RelatedMemory:   relatedMemory,
		AuditMetadata:   auditMetadata,
		Request:         request,
		WorkspaceID:     workspaceID,
		ForegroundChain: foregroundChain,
	}
}

func slackTriageDryRunVisibleReplyVerdicts(actions []SlackTriageDecisionAction) []SlackTriageDryRunVisibleReplyVerdict {
	verdicts := make([]SlackTriageDryRunVisibleReplyVerdict, 0, len(actions))
	for _, action := range actions {
		if strings.TrimSpace(action.Type) != slackActionTypeThreadReply {
			continue
		}
		verdict := slackVisibleReplyAllowListVerdictForAction(action)
		verdicts = append(verdicts, SlackTriageDryRunVisibleReplyVerdict{
			Message:         strings.TrimSpace(action.Message),
			Allowed:         verdict.Allowed,
			Reason:          verdict.Reason,
			EvidenceAnchors: verdict.EvidenceAnchors,
		})
	}
	return verdicts
}

func slackTriageDryRunWorkers(result SlackPersonaShadowResult, request persona.Request) []SlackTriageDryRunWorker {
	if strings.TrimSpace(result.Decision) != persona.DecisionDelegateWorker || len(result.workerRecords) == 0 {
		return nil
	}
	workers := make([]SlackTriageDryRunWorker, 0, len(result.workerRecords))
	for _, worker := range result.workerRecords {
		if personaDelegatedWorkerSessionKind(worker) == "secretary_lookup" {
			worker = enrichPersonaSecretaryLookupWorkerRequest(worker, request)
		}
		scope := firstNonEmpty(
			stringFromAny(worker.Context["delegation_scope"]),
			stringFromAny(worker.Context["scope"]),
			stringFromAny(worker.Context["worker_scope"]),
		)
		workers = append(workers, SlackTriageDryRunWorker{
			ID:              strings.TrimSpace(worker.ID),
			Kind:            strings.TrimSpace(worker.Kind),
			SessionKind:     personaDelegatedWorkerSessionKind(worker),
			DelegationScope: strings.TrimSpace(scope),
			PromptPreview:   truncateSlackContextText(strings.TrimSpace(worker.Prompt), 280),
			WouldStart:      true,
		})
	}
	return workers
}

func slackTriageDryRunVisibleReplyToolCalls(before []SlackTriageDecisionAction, after []SlackTriageDecisionAction) []SlackTriageToolCall {
	afterReplyCount := 0
	for _, action := range after {
		if strings.TrimSpace(action.Type) == slackActionTypeThreadReply {
			afterReplyCount++
		}
	}
	var calls []SlackTriageToolCall
	for _, action := range before {
		if strings.TrimSpace(action.Type) != slackActionTypeThreadReply {
			continue
		}
		verdict := slackVisibleReplyAllowListVerdictForAction(action)
		calls = append(calls, SlackTriageToolCall{
			Tool:    "slack_api",
			Action:  "dry_run_visible_reply_gate",
			Args:    marshalTriageArgs("slack_visible_reply_allow_list", verdict.Reason, verdict.Allowed),
			Success: true,
			Brief:   "Dry-run visible reply allow-list verdict",
			Result:  verdict.Reason,
		})
		if verdict.Allowed && afterReplyCount > 0 {
			calls = append(calls, SlackTriageToolCall{
				Tool:    "slack_api",
				Action:  "dry_run_thread_reply_blocked",
				Args:    marshalTriageArgs("chat.postMessage", "", true),
				Success: true,
				Brief:   "Dry-run would post Slack thread reply in live mode",
				Result:  "side_effect_blocked",
			})
		}
	}
	return calls
}

func slackTriageDryRunWorkerToolCalls(workers []SlackTriageDryRunWorker) []SlackTriageToolCall {
	calls := make([]SlackTriageToolCall, 0, len(workers))
	for _, worker := range workers {
		calls = append(calls, SlackTriageToolCall{
			Tool:    "agent_runner",
			Action:  "dry_run_delegate_worker_blocked",
			Args:    marshalTriageArgs(firstNonEmpty(worker.Kind, worker.SessionKind), worker.ID, true),
			Success: true,
			Brief:   "Dry-run would start delegated worker in live mode",
			Result:  "side_effect_blocked",
		})
	}
	return calls
}

func slackTriageDryRunFinalDecision(result SlackPersonaShadowResult, actions []SlackTriageDecisionAction, workers []SlackTriageDryRunWorker) string {
	if !result.Success {
		return "would_fail"
	}
	for _, action := range actions {
		if strings.TrimSpace(action.Type) == slackActionTypeThreadReply {
			return "would_post_reply"
		}
		if strings.TrimSpace(action.Type) == "add_reaction" {
			return "would_react"
		}
	}
	if len(workers) > 0 {
		return "would_delegate_worker"
	}
	if len(result.memoryRecords) > 0 {
		return "would_write_memory"
	}
	return "would_stay_silent"
}

func slackTriageDryRunContextBudget(request persona.Request) map[string]int {
	budget := persona.RequestHarnessContextBudget(request)
	return map[string]int{
		"stableTokens":         budget.StableTokens,
		"dynamicTokens":        budget.DynamicTokens,
		"workerResultTokens":   budget.WorkerResultTokens,
		"memoryEvidenceTokens": budget.MemoryEvidenceTokens,
		"eventContextTokens":   budget.EventContextTokens,
		"totalTokens":          budget.TotalTokens,
	}
}

func slackTriageDryRunPipelineSmells(result SlackPersonaShadowResult, before []SlackTriageDecisionAction, after []SlackTriageDecisionAction, workers []SlackTriageDryRunWorker, request persona.Request, externalLinks []SlackExternalLinkContext) []string {
	var smells []string
	text := strings.TrimSpace(strings.Join([]string{request.Event.Text, personaRequestContextText(request.Context, "triage_digest")}, "\n"))
	if result.Success && strings.TrimSpace(result.Decision) == persona.DecisionStaySilent && personaMessagesContainExplicitQuestion([]SlackInboundMessage{{Text: text}}, "") {
		smells = append(smells, "high_silent_rate_with_questions")
	}
	if len(before) > 0 && len(after) == 0 {
		smells = append(smells, "high_gate_block_rate")
	}
	if len(workers) > 0 && !slackTriageDryRunWorkersLookSourceBacked(workers) {
		smells = append(smells, "delegate_without_worker_result_contract")
	}
	if len(extractSlackExternalLinkURLs([]SlackInboundMessage{{Text: text}})) > 0 && len(externalLinks) == 0 {
		smells = append(smells, "link_or_file_context_missing")
	}
	return uniqueNonEmptyStrings(smells)
}

func slackTriageDryRunWorkersLookSourceBacked(workers []SlackTriageDryRunWorker) bool {
	for _, worker := range workers {
		lower := strings.ToLower(strings.Join([]string{worker.PromptPreview, worker.DelegationScope, worker.SessionKind}, "\n"))
		if strings.Contains(lower, "evidence_anchors") || strings.Contains(lower, "source-backed") || strings.Contains(lower, "secretary_lookup") {
			return true
		}
	}
	return false
}

func uniqueNonEmptyStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
