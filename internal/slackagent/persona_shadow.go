package slackagent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
)

type SlackPersonaShadowResult struct {
	RequestID       string   `json:"request_id"`
	Source          string   `json:"source"`
	ChannelID       string   `json:"channel_id,omitempty"`
	ThreadTS        string   `json:"thread_ts,omitempty"`
	Classification  string   `json:"classification,omitempty"`
	Runtime         string   `json:"runtime,omitempty"`
	Decision        string   `json:"decision,omitempty"`
	VisibleText     string   `json:"visible_text,omitempty"`
	Confidence      float64  `json:"confidence,omitempty"`
	WorkerRequests  []string `json:"worker_requests,omitempty"`
	MemoryWrites    []string `json:"memory_writes,omitempty"`
	Reactions       []string `json:"reactions,omitempty"`
	memoryRecords   []persona.MemoryWrite
	workerRecords   []persona.WorkerRequest
	reactionRecords []persona.ReactionIntent
	ShadowOnly      bool     `json:"shadow_only"`
	Success         bool     `json:"success"`
	Error           string   `json:"error,omitempty"`
	Reason          string   `json:"reason,omitempty"`
	LatencyMS       int64    `json:"latency_ms,omitempty"`
	Citations       []string `json:"citations,omitempty"`
}

func BuildBackfillPersonaRequest(candidate SlackBackfillCandidate) persona.Request {
	status, reason := backfillCandidateReviewStatus(candidate)
	threadTS := firstNonEmpty(strings.TrimSpace(candidate.ThreadTS), strings.TrimSpace(candidate.OriginatorTS))
	citations := personaCitationsFromRelatedMemory(candidate.RelatedMemory)
	allowVisibleReply := status == BackfillReviewReady
	return persona.Request{
		ID:   fmt.Sprintf("backfill:%s:%s:%s", candidate.ChannelID, threadTS, candidate.Classification),
		Mode: persona.ModeShadow,
		Event: persona.Event{
			Kind: "slack_backfill_candidate",
			Text: strings.TrimSpace(candidate.OriginalText),
		},
		Anchor: persona.Anchor{
			Surface:   "slack",
			ChannelID: strings.TrimSpace(candidate.ChannelID),
			ThreadTS:  threadTS,
			MessageTS: strings.TrimSpace(candidate.OriginatorTS),
		},
		Context: []persona.ContextItem{
			{Kind: "classification", Text: strings.TrimSpace(candidate.Classification)},
			{Kind: "review_status", Text: status},
			{Kind: "review_reason", Text: reason},
			{Kind: "candidate_title", Text: strings.TrimSpace(candidate.Title)},
			{Kind: "candidate_note", Text: strings.TrimSpace(candidate.Draft)},
		},
		Evidence: persona.EvidenceBundle{
			Summary:   strings.TrimSpace(candidate.Draft),
			Citations: citations,
		},
		Memory: persona.MemoryContext{
			Summary: fmt.Sprintf("%d related memory record(s)", len(candidate.RelatedMemory)),
			Items:   personaMemoryRecordsFromRelatedMemory(candidate.RelatedMemory),
		},
		Safety: persona.SafetyConstraints{
			AllowVisibleReply:  allowVisibleReply,
			AllowSpeech:        false,
			AllowWorkerRequest: true,
			MaxVisibleChars:    600,
			AllowedWorkers:     []string{"codex", "claude", "agent_read"},
		},
		Metadata: map[string]any{
			"classification":       strings.TrimSpace(candidate.Classification),
			"review_status":        status,
			"review_reason":        reason,
			"from_persisted_state": candidate.FromPersistedState,
			"followup_id":          candidate.FollowupID,
		},
	}
}

func ShadowPersonaBackfillCandidates(ctx context.Context, runtime persona.Runtime, candidates []SlackBackfillCandidate) []SlackPersonaShadowResult {
	if runtime == nil || len(candidates) == 0 {
		return nil
	}
	results := make([]SlackPersonaShadowResult, 0, len(candidates))
	for _, candidate := range candidates {
		request := BuildBackfillPersonaRequest(candidate)
		results = append(results, callPersonaShadow(ctx, runtime, "backfill", request))
	}
	return results
}

func (s *Service) shadowPersonaRuntimeEnabled() bool {
	if s == nil || s.personaRuntime == nil || s.personaRuntimeErr != nil {
		return false
	}
	provider := persona.NormalizeProvider(s.personaRuntimeConfig.Provider)
	return provider != "" && provider != persona.ProviderLegacy
}

func (s *Service) foregroundPersonaRuntimeEnabled() bool {
	if !s.shadowPersonaRuntimeEnabled() {
		return false
	}
	return persona.NormalizeMode(s.personaRuntimeConfig.Mode) == persona.ModeLive && !s.personaRuntimeConfig.ShadowOnly
}

func (s *Service) queueSlackTriagePersonaShadow(ctx context.Context, runID int64, channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord) bool {
	if !s.shadowPersonaRuntimeEnabled() || runID == 0 {
		return false
	}
	request := BuildSlackTriagePersonaShadowRequest(SlackTriagePersonaShadowRequestInput{
		ChannelID:             channelID,
		ThreadTS:              threadTS,
		Messages:              messages,
		Decision:              decision,
		RelatedMemory:         relatedMemory,
		WorkspaceTriagePolicy: s.triageWorkspacePolicy,
		CustomEmoji:           s.workspaceCustomEmojiSnapshot(),
	})
	go func() {
		callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
		defer cancel()
		result := callPersonaShadow(callCtx, s.personaRuntime, "triage", request)
		if err := s.recordSlackTriagePersonaShadowResult(ctx, runID, result); err != nil {
			s.logger.Warn("persona runtime shadow triage result record failed", "triage_run_id", runID, "error", err)
		}
	}()
	return true
}

func (s *Service) queueSlackTriagePersonaForeground(ctx context.Context, workspaceID string, runID int64, channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord, ignoreExistingBotReply ...bool) bool {
	if !s.foregroundPersonaRuntimeEnabled() || runID == 0 {
		return false
	}
	ignoreBotReply := len(ignoreExistingBotReply) > 0 && ignoreExistingBotReply[0]
	request := BuildSlackTriagePersonaForegroundRequest(SlackTriagePersonaForegroundRequestInput{
		ChannelID:              channelID,
		ThreadTS:               threadTS,
		Messages:               messages,
		Decision:               decision,
		RelatedMemory:          relatedMemory,
		IgnoreExistingBotReply: ignoreBotReply,
		WorkspaceTriagePolicy:  s.triageWorkspacePolicy,
		CustomEmoji:            s.workspaceCustomEmojiSnapshot(),
	})
	s.recordSlackTriagePersonaRequestAudit(ctx, runID, request)
	go func() {
		callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
		defer cancel()
		result := callPersonaShadow(callCtx, s.personaRuntime, "triage", request)
		result, dispositionToolCalls := applyPersonaSecretaryLookupDisposition(result, request)
		var completedToolCalls []SlackTriageToolCall
		result, completedToolCalls = applyPersonaCompletedDelegationDisposition(result)
		dispositionToolCalls = append(dispositionToolCalls, completedToolCalls...)
		var ambientToolCalls []SlackTriageToolCall
		result, ambientToolCalls = applyPersonaAmbientDelegationDisposition(result, messages, s.botUserID)
		dispositionToolCalls = append(dispositionToolCalls, ambientToolCalls...)
		var cannedToolCalls []SlackTriageToolCall
		result, cannedToolCalls = applyPersonaCannedRefusalDisposition(result)
		dispositionToolCalls = append(dispositionToolCalls, cannedToolCalls...)
		var directReplyToolCalls []SlackTriageToolCall
		result, directReplyToolCalls = applyPersonaAmbientDirectReplyDisposition(result, messages, s.botUserID)
		dispositionToolCalls = append(dispositionToolCalls, directReplyToolCalls...)
		result, policyToolCalls := s.applyPersonaSecretaryDelegationPolicy(result)
		var reactionGuardToolCalls []SlackTriageToolCall
		result, reactionGuardToolCalls = applyPersonaProductLinkReactionDisposition(result, request)
		dispositionToolCalls = append(dispositionToolCalls, reactionGuardToolCalls...)
		actions := requireSlackTriageVisibleReplyApproval(slackPersonaForegroundActions(channelID, threadTS, result))
		toolCalls, failures, mutations := s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, channelID, threadTS, runID, actions, slackTriageDirectActionOptions{
			SnapshotMessages:       messages,
			IgnoreExistingBotReply: ignoreBotReply,
		})
		if len(dispositionToolCalls) > 0 {
			toolCalls = append(toolCalls, dispositionToolCalls...)
		}
		if len(policyToolCalls) > 0 {
			toolCalls = append(toolCalls, policyToolCalls...)
		}
		pendingResults := s.insertSlackTriagePendingActions(ctx, workspaceID, channelID, threadTS, "persona:"+fmt.Sprint(runID), &SlackTriageContext{ID: runID}, actions)
		toolCalls = append(toolCalls, personaTriageApprovalToolCalls(pendingResults)...)
		delegation := s.startPersonaDelegatedWorkerJobs(ctx, workspaceID, runID, result, request, messages)
		if len(delegation.ToolCalls) > 0 {
			toolCalls = append(toolCalls, delegation.ToolCalls...)
		}
		failures = maxInt(failures, delegation.Failures)
		if err := s.recordSlackTriagePersonaForegroundResult(ctx, workspaceID, runID, result, actions, toolCalls, failures, mutations); err != nil {
			s.logger.Warn("persona runtime foreground triage result record failed", "triage_run_id", runID, "error", err)
		}
	}()
	return true
}

func (s *Service) queueSlackTriagePersonaForegroundRequest(ctx context.Context, workspaceID string, runID int64, channelID string, threadTS string, messages []SlackInboundMessage, request persona.Request, ignoreExistingBotReply bool) bool {
	if !s.foregroundPersonaRuntimeEnabled() || runID == 0 {
		return false
	}
	request.Mode = persona.ModeLive
	s.recordSlackTriagePersonaRequestAudit(ctx, runID, request)
	go func() {
		callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
		defer cancel()
		result := callPersonaShadow(callCtx, s.personaRuntime, "triage", request)
		result, dispositionToolCalls := applyPersonaSecretaryLookupDisposition(result, request)
		var completedToolCalls []SlackTriageToolCall
		result, completedToolCalls = applyPersonaCompletedDelegationDisposition(result)
		dispositionToolCalls = append(dispositionToolCalls, completedToolCalls...)
		var ambientToolCalls []SlackTriageToolCall
		result, ambientToolCalls = applyPersonaAmbientDelegationDisposition(result, messages, s.botUserID)
		dispositionToolCalls = append(dispositionToolCalls, ambientToolCalls...)
		var cannedToolCalls []SlackTriageToolCall
		result, cannedToolCalls = applyPersonaCannedRefusalDisposition(result)
		dispositionToolCalls = append(dispositionToolCalls, cannedToolCalls...)
		var directReplyToolCalls []SlackTriageToolCall
		result, directReplyToolCalls = applyPersonaAmbientDirectReplyDisposition(result, messages, s.botUserID)
		dispositionToolCalls = append(dispositionToolCalls, directReplyToolCalls...)
		result, policyToolCalls := s.applyPersonaSecretaryDelegationPolicy(result)
		var reactionGuardToolCalls []SlackTriageToolCall
		result, reactionGuardToolCalls = applyPersonaProductLinkReactionDisposition(result, request)
		dispositionToolCalls = append(dispositionToolCalls, reactionGuardToolCalls...)
		actions := requireSlackTriageVisibleReplyApproval(slackPersonaForegroundActions(channelID, threadTS, result))
		toolCalls, failures, mutations := s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, channelID, threadTS, runID, actions, slackTriageDirectActionOptions{
			SnapshotMessages:       messages,
			IgnoreExistingBotReply: ignoreExistingBotReply,
		})
		if len(dispositionToolCalls) > 0 {
			toolCalls = append(toolCalls, dispositionToolCalls...)
		}
		if len(policyToolCalls) > 0 {
			toolCalls = append(toolCalls, policyToolCalls...)
		}
		pendingResults := s.insertSlackTriagePendingActions(ctx, workspaceID, channelID, threadTS, "persona:"+fmt.Sprint(runID), &SlackTriageContext{ID: runID}, actions)
		toolCalls = append(toolCalls, personaTriageApprovalToolCalls(pendingResults)...)
		delegation := s.startPersonaDelegatedWorkerJobs(ctx, workspaceID, runID, result, request, messages)
		if len(delegation.ToolCalls) > 0 {
			toolCalls = append(toolCalls, delegation.ToolCalls...)
		}
		failures = maxInt(failures, delegation.Failures)
		if err := s.recordSlackTriagePersonaForegroundResult(ctx, workspaceID, runID, result, actions, toolCalls, failures, mutations); err != nil {
			s.logger.Warn("persona runtime foreground triage result record failed", "triage_run_id", runID, "error", err)
		}
	}()
	return true
}

func (s *Service) personaRuntimeShadowTimeout() time.Duration {
	if s != nil && s.personaRuntimeConfig.Timeout > 0 {
		return s.personaRuntimeConfig.Timeout
	}
	return 90 * time.Second
}

type personaDelegatedWorkerStartResult struct {
	JobIDs    []string
	Errors    []string
	ToolCalls []SlackTriageToolCall
	Failures  int
}

func (s *Service) applyPersonaSecretaryDelegationPolicy(result SlackPersonaShadowResult) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionDelegateWorker || len(result.workerRecords) == 0 {
		return result, nil
	}
	allowed := make([]persona.WorkerRequest, 0, len(result.workerRecords))
	toolCalls := make([]SlackTriageToolCall, 0)
	for _, request := range result.workerRecords {
		ok, reason := personaDelegatedWorkerAllowedBySecretaryPolicy(request)
		if ok {
			allowed = append(allowed, request)
			continue
		}
		toolCalls = append(toolCalls, SlackTriageToolCall{
			Tool:    "agent_runner",
			Action:  "delegate_worker_blocked_scope",
			Args:    marshalTriageArgs(firstNonEmpty(strings.TrimSpace(request.Kind), "worker"), strings.TrimSpace(request.ID), false),
			Success: true,
			Brief:   "Persona delegate_worker blocked by secretary routing policy",
			Result:  reason,
		})
	}
	if len(toolCalls) == 0 {
		return result, nil
	}
	blockedShouldStaySilent := len(allowed) == 0 && personaDelegateBlockShouldStaySilent(result)
	result.workerRecords = allowed
	result.WorkerRequests = personaWorkerRequestSummaries(allowed)
	if len(allowed) == 0 && strings.TrimSpace(result.VisibleText) == "" {
		if blockedShouldStaySilent {
			result.Decision = persona.DecisionStaySilent
			result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "delegate_worker blocked; no safe visible reply"))
			toolCalls = append(toolCalls, SlackTriageToolCall{
				Tool:    "agent_runner",
				Action:  "delegate_worker_blocked_silent",
				Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
				Success: true,
				Brief:   "Persona delegate_worker block downgraded to silence",
				Result:  "blocked secretary lookup produced no safe visible reply",
			})
			return result, toolCalls
		}
		result.Decision = persona.DecisionReply
		result.VisibleText = slackPersonaSecretaryRoutingText()
		result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "delegate_worker blocked by secretary routing policy"))
		if result.Confidence < 0.7 {
			result.Confidence = 0.7
		}
	}
	return result, toolCalls
}

func applyPersonaCompletedDelegationDisposition(result SlackPersonaShadowResult) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionDelegateWorker || len(result.workerRecords) == 0 {
		return result, nil
	}
	marker := personaCompletedDelegationMarker(result)
	if marker == "" {
		return result, nil
	}
	result.Decision = persona.DecisionStaySilent
	result.VisibleText = ""
	result.workerRecords = nil
	result.WorkerRequests = nil
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "delegate_worker suppressed because the thread is already handled"))
	return result, []SlackTriageToolCall{{
		Tool:    "agent_runner",
		Action:  "delegate_worker_already_handled_silent",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Persona delegate_worker suppressed because reason says no further action",
		Result:  marker,
	}}
}

func personaCompletedDelegationMarker(result SlackPersonaShadowResult) string {
	text := strings.Join([]string{
		strings.TrimSpace(result.Reason),
		strings.TrimSpace(result.VisibleText),
	}, "\n")
	if strings.TrimSpace(text) == "" {
		return ""
	}
	if marker := triageQualityRunIsHandledByOther(text); marker != "" {
		return marker
	}
	lower := strings.ToLower(text)
	for _, marker := range []string{
		"no further triage action needed",
		"no further action needed",
		"no further action is needed",
		"no additional action needed",
		"no action needed",
		"nothing for me to add",
		"nothing to add",
		"already determined this thread is handled",
		"无需进一步处理",
		"无需进一步动作",
		"不需要进一步处理",
		"不需要再处理",
		"无需再处理",
		"无需介入",
		"不用介入",
		"这轮 review 已完成",
	} {
		if strings.Contains(lower, strings.ToLower(marker)) {
			return marker
		}
	}
	return ""
}

func applyPersonaAmbientDelegationDisposition(result SlackPersonaShadowResult, messages []SlackInboundMessage, botUserID string) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionDelegateWorker || len(result.workerRecords) == 0 {
		return result, nil
	}
	reason := personaAmbientDelegationSilentReason(result, messages, botUserID)
	if reason == "" {
		return result, nil
	}
	result.Decision = persona.DecisionStaySilent
	result.VisibleText = ""
	result.workerRecords = nil
	result.WorkerRequests = nil
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "delegate_worker suppressed because the Slack item was not addressed to Oneesama"))
	return result, []SlackTriageToolCall{{
		Tool:    "agent_runner",
		Action:  "delegate_worker_ambient_silent",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Persona delegate_worker suppressed for ambient/non-addressed triage",
		Result:  reason,
	}}
}

func applyPersonaAmbientDirectReplyDisposition(result SlackPersonaShadowResult, messages []SlackInboundMessage, botUserID string) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionReply || strings.TrimSpace(result.VisibleText) == "" {
		return result, nil
	}
	reason := personaAmbientDirectReplySilentReason(result, messages, botUserID)
	if reason == "" {
		return result, nil
	}
	result.Decision = persona.DecisionStaySilent
	result.VisibleText = ""
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "direct reply suppressed because the Slack item was not addressed to Oneesama"))
	return result, []SlackTriageToolCall{{
		Tool:    "slack_api",
		Action:  "persona_reply_ambient_silent",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Persona direct reply suppressed for ambient/non-addressed triage",
		Result:  reason,
	}}
}

func personaAmbientDirectReplySilentReason(result SlackPersonaShadowResult, messages []SlackInboundMessage, botUserID string) string {
	if slackMessagesMentionOtherUsersWithoutBot(messages, botUserID) {
		return "mentioned_other_user_without_bot"
	}
	if personaMessagesAddressBot(messages, botUserID) {
		return ""
	}
	if slackMessagesHaveFetchableExternalLinks(messages) {
		return ""
	}
	text := strings.Join([]string{
		strings.TrimSpace(result.VisibleText),
		strings.TrimSpace(result.Reason),
	}, "\n")
	if personaDirectReplyLooksSpeculative(text) {
		return "ambient_speculative_direct_reply"
	}
	if slackTriageDirectRepliesShouldStaySilent(messages, botUserID) {
		return "ambient_direct_reply_without_bot_mention"
	}
	return ""
}

func personaMessagesAddressBot(messages []SlackInboundMessage, botUserID string) bool {
	if strings.TrimSpace(botUserID) == "" {
		return false
	}
	for _, message := range messages {
		if slackTextMentionsUser(message.Text, botUserID) {
			return true
		}
	}
	return false
}

func personaDirectReplyLooksSpeculative(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	return slackVisibleTextContainsAny(lower, []string{
		"可能",
		"很可能",
		"大概率",
		"像是",
		"应该是",
		"要不要看看",
		"看看最近",
		"推断",
		"猜测",
		"speculate",
		"guess",
		"likely",
		"probably",
		"maybe",
		"might be",
		"could be",
	})
}

func personaAmbientDelegationSilentReason(result SlackPersonaShadowResult, messages []SlackInboundMessage, botUserID string) string {
	if slackMessagesMentionOtherUsersWithoutBot(messages, botUserID) {
		return "mentioned_other_user_without_bot"
	}
	reason := strings.ToLower(strings.TrimSpace(result.Reason))
	if reason == "" {
		return ""
	}
	noExplicitAskMarkers := []string{
		"no explicit question",
		"no explicit ask",
		"no explicit request",
		"no @oneesama",
		"no @mention",
		"没有明确问题",
		"没有明确请求",
		"没有 @oneesama",
		"未 @oneesama",
	}
	var sawMarker bool
	for _, marker := range noExplicitAskMarkers {
		if strings.Contains(reason, strings.ToLower(marker)) {
			sawMarker = true
			break
		}
	}
	if !sawMarker {
		return ""
	}
	if slackMessagesHaveFetchableExternalLinks(messages) || personaMessagesContainExplicitQuestion(messages, botUserID) {
		return ""
	}
	return "no_explicit_question_or_bot_mention"
}

func personaMessagesContainExplicitQuestion(messages []SlackInboundMessage, botUserID string) bool {
	text := strings.TrimSpace(joinSlackMessageTexts(messages))
	if text == "" {
		return false
	}
	if botUserID != "" && slackTextMentionsUser(text, botUserID) {
		return true
	}
	lower := strings.ToLower(text)
	if strings.ContainsAny(text, "?？") {
		return true
	}
	for _, marker := range []string{"什么", "怎么", "咋", "为啥", "为什么", "吗", "么", "啥", "看看", "查一下", "看一下", "帮我", "how", "what", "why", "can you", "could you"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func applyPersonaSecretaryLookupDisposition(result SlackPersonaShadowResult, request persona.Request) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionStaySilent || len(result.workerRecords) > 0 {
		return result, nil
	}
	if !slackPersonaRequestNeedsSecretaryLookup(request) {
		return result, nil
	}
	worker := persona.WorkerRequest{
		ID:     "secretary-link-fact-lookup",
		Kind:   "codex",
		Prompt: buildSecretaryLookupWorkerPrompt(request),
		Context: map[string]any{
			"delegation_scope":          "secretary_lookup",
			"secretary_lookup_type":     "external_link_fact_lookup",
			"external_link_context":     personaRequestContextText(request.Context, "external_link_context"),
			"triage_digest":             personaRequestContextText(request.Context, "triage_digest"),
			"workspace_memory_evidence": personaRequestMemoryEvidence(request, 5),
		},
	}
	result.Decision = persona.DecisionDelegateWorker
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "external link fact question requires bounded secretary lookup before silence"))
	result.workerRecords = []persona.WorkerRequest{worker}
	result.WorkerRequests = personaWorkerRequestSummaries(result.workerRecords)
	if result.Confidence < 0.55 {
		result.Confidence = 0.55
	}
	return result, []SlackTriageToolCall{{
		Tool:    "persona_runtime",
		Action:  "secretary_lookup_auto_delegate",
		Args:    marshalTriageArgs("persona", worker.ID, true),
		Success: true,
		Brief:   "Stay-silent external link fact question auto-delegated to secretary lookup",
		Result:  "old slackd parity: fetch link/person/memory evidence before deciding visible reply",
	}}
}

func applyPersonaCannedRefusalDisposition(result SlackPersonaShadowResult) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionReply || strings.TrimSpace(result.VisibleText) == "" {
		return result, nil
	}
	if !slackPersonaVisibleTextLooksLikeCannedSecretaryRefusal(result.VisibleText) {
		return result, nil
	}
	result.Decision = persona.DecisionStaySilent
	result.VisibleText = ""
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "canned secretary routing/refusal reply downgraded to silence"))
	return result, []SlackTriageToolCall{{
		Tool:    "persona_runtime",
		Action:  "reply_canned_refusal_downgraded_silent",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Canned secretary routing reply downgraded to silence",
		Result:  "Pi reply matched a generic project-owner/refusal template without concrete evidence",
	}}
}

func applyPersonaProductLinkReactionDisposition(result SlackPersonaShadowResult, request persona.Request) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionReact || len(result.reactionRecords) == 0 {
		return result, nil
	}
	if !slackPersonaRequestNeedsProductLinkCommentary(request) {
		return result, nil
	}
	worker := persona.WorkerRequest{
		ID:     "product-link-commentary-lookup",
		Kind:   "codex",
		Prompt: buildSecretaryLookupWorkerPrompt(request),
		Context: map[string]any{
			"delegation_scope":          "secretary_lookup",
			"secretary_lookup_type":     "product_link_commentary",
			"external_link_context":     personaRequestContextText(request.Context, "external_link_context"),
			"triage_digest":             personaRequestContextText(request.Context, "triage_digest"),
			"workspace_memory_evidence": personaRequestMemoryEvidence(request, 5),
		},
	}
	result.Decision = persona.DecisionDelegateWorker
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "product-adjacent link needs source-backed commentary, not reaction-only triage"))
	result.reactionRecords = nil
	result.Reactions = nil
	result.workerRecords = []persona.WorkerRequest{worker}
	result.WorkerRequests = personaWorkerRequestSummaries(result.workerRecords)
	if result.Confidence < 0.6 {
		result.Confidence = 0.6
	}
	return result, []SlackTriageToolCall{{
		Tool:    "persona_runtime",
		Action:  "product_link_reaction_upgraded_to_secretary_lookup",
		Args:    marshalTriageArgs("persona", worker.ID, true),
		Success: true,
		Brief:   "Product-adjacent link reaction upgraded to secretary lookup",
		Result:  "workspace policy requires source-backed commentary or lookup before visible disposition",
	}}
}

func slackPersonaVisibleTextLooksLikeCannedSecretaryRefusal(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	markers := []string{
		"不直接下场查 repo",
		"项目 owner 处理",
		"明确授权我查 oneesama",
		"整理成 brief",
		"not directly inspect the repo",
		"project owner",
		"explicitly authorize me",
	}
	matches := 0
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			matches++
		}
	}
	return matches >= 2
}

func slackPersonaRequestNeedsSecretaryLookup(request persona.Request) bool {
	text := strings.Join([]string{
		request.Event.Text,
		personaRequestContextText(request.Context, "triage_digest"),
		personaRequestContextText(request.Context, "slack_thread_context"),
	}, "\n")
	if strings.TrimSpace(personaRequestContextText(request.Context, "external_link_context")) == "" && len(extractSlackExternalLinkURLs([]SlackInboundMessage{{Text: text}})) == 0 {
		return false
	}
	return slackTextContainsSecretaryLookupQuestion(text)
}

func slackPersonaRequestNeedsProductLinkCommentary(request persona.Request) bool {
	text := strings.Join([]string{
		request.Event.Text,
		personaRequestContextText(request.Context, "triage_digest"),
		personaRequestContextText(request.Context, "slack_thread_context"),
	}, "\n")
	if strings.TrimSpace(personaRequestContextText(request.Context, "external_link_context")) == "" && len(extractSlackExternalLinkURLs([]SlackInboundMessage{{Text: text}})) == 0 {
		return false
	}
	workspacePolicy := personaDynamicContextTextFromRequest(request, "workspace_triage_policy")
	if !workspacePolicyEnablesSharedLinkSynthesis(workspacePolicy) && !slackMessageExplicitlyRequestsLinkSynthesis(text) {
		return false
	}
	return true
}

func personaDynamicContextTextFromRequest(request persona.Request, kind string) string {
	for _, item := range request.DynamicContext {
		if item.Kind == kind {
			return item.Content
		}
	}
	return ""
}

func personaRequestContextText(items []persona.ContextItem, kind string) string {
	for _, item := range items {
		if item.Kind == kind {
			return item.Text
		}
	}
	return ""
}

func slackTextContainsSecretaryLookupQuestion(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	markers := []string{
		"这是谁", "是谁", "这是什么", "这是啥", "什么鬼", "啥意思", "什么情况", "靠不靠谱", "靠谱吗", "真假", "谁知道", "有人知道",
		"who is", "what is this", "what's this", "what does this mean", "anyone know", "is this real", "is this legit",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func buildSecretaryLookupWorkerPrompt(request persona.Request) string {
	parts := []string{
		"Bounded Oneesama secretary lookup. Read the linked public source and the Slack thread context, then cross-check workspace Memory/person context if available.",
		"Do not stop at the first profile/article excerpt. If the source exposes submissions, comments, favorites, repository, author, or source links, follow those read-only leads before answering.",
		"Use available read-only tools such as exa_search, exa_contents, person_memory, memory_search, and slack_api fetch/read methods when the provided excerpt is not enough.",
		"Only return a Slack-visible answer when you have concrete evidence. Include 2-3 short evidence anchors such as URL ownership, profile details, repo links, previous workspace mentions, or memory/person records.",
		"If evidence is insufficient, return no visible result instead of guessing or posting a routing/refusal template.",
	}
	if digest := strings.TrimSpace(personaRequestContextText(request.Context, "triage_digest")); digest != "" {
		parts = append(parts, "\nTriage digest:\n"+digest)
	}
	if thread := strings.TrimSpace(personaRequestContextText(request.Context, "slack_thread_context")); thread != "" {
		parts = append(parts, "\nSlack thread context:\n"+thread)
	}
	if external := strings.TrimSpace(personaRequestContextText(request.Context, "external_link_context")); external != "" {
		parts = append(parts, "\nFetched external link context:\n"+external)
	}
	if memory := personaRequestMemoryEvidence(request, 5); memory != "" {
		parts = append(parts, "\nWorkspace Memory/person evidence:\n"+memory)
	}
	return strings.Join(parts, "\n")
}

func personaRequestMemoryEvidence(request persona.Request, limit int) string {
	if limit <= 0 || len(request.Memory.Items) == 0 {
		return ""
	}
	lines := make([]string, 0, limit)
	for _, record := range request.Memory.Items {
		if len(lines) >= limit {
			break
		}
		text := truncateSlackContextText(strings.TrimSpace(sanitizeSlackVisibleText(record.Text)), 420)
		if text == "" {
			continue
		}
		source := strings.TrimSpace(record.SourceRef)
		kind := strings.TrimSpace(record.Kind)
		label := firstNonEmpty(source, kind, "memory")
		if kind != "" && source != "" {
			label += " [" + kind + "]"
		}
		lines = append(lines, fmt.Sprintf("%d. %s: %s", len(lines)+1, label, text))
	}
	return strings.Join(lines, "\n")
}

func personaDelegateBlockShouldStaySilent(result SlackPersonaShadowResult) bool {
	for _, request := range result.workerRecords {
		scope := strings.ToLower(strings.TrimSpace(firstNonEmpty(
			stringFromAny(request.Context["delegation_scope"]),
			stringFromAny(request.Context["scope"]),
			stringFromAny(request.Context["worker_scope"]),
		)))
		text := strings.TrimSpace(strings.Join([]string{
			request.Kind,
			request.Prompt,
			personaWorkerRequestContextText(request.Context),
			result.Reason,
		}, "\n"))
		if scope == "secretary_lookup" || scope == "workspace_memory" || personaDelegatedWorkerLooksLikeReadOnlySecretaryLookup(text) {
			return true
		}
	}
	return false
}

func personaDelegatedWorkerLooksLikeReadOnlySecretaryLookup(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	markers := []string{
		"memory lookup", "workspace memory", "person_memory", "person memory", "fetch url", "read link", "linked source", "profile", "identify", "who is",
		"查 memory", "查一下 memory", "查记忆", "查人", "识别", "这是谁", "链接内容", "读链接", "发推",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func personaDelegatedWorkerAllowedBySecretaryPolicy(request persona.WorkerRequest) (bool, string) {
	scope := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringFromAny(request.Context["delegation_scope"]),
		stringFromAny(request.Context["scope"]),
		stringFromAny(request.Context["worker_scope"]),
	)))
	switch scope {
	case "oneesama_system", "oneesama_code", "explicit_human_authorized_code":
		return true, ""
	case "external_project_code", "project_code", "project_debugging", "secretary_route":
		return false, fmt.Sprintf("delegation_scope %q is outside Oneesama secretary worker scope", scope)
	}

	text := strings.TrimSpace(strings.Join([]string{
		request.Kind,
		request.Prompt,
		personaWorkerRequestContextText(request.Context),
	}, "\n"))
	if personaDelegatedWorkerLooksLikeProjectDebugging(text) && !personaDelegatedWorkerMentionsOneesamaSystem(text) && !personaDelegatedWorkerExplicitlyAuthorized(text) {
		return false, "external project debugging should be secretary-routed instead of delegated to Codex"
	}
	switch scope {
	case "secretary_lookup", "workspace_memory":
		return true, ""
	}
	return true, ""
}

func personaWorkerRequestContextText(contextMap map[string]any) string {
	if len(contextMap) == 0 {
		return ""
	}
	payload, err := json.Marshal(contextMap)
	if err != nil {
		return fmt.Sprint(contextMap)
	}
	return string(payload)
}

func personaDelegatedWorkerLooksLikeProjectDebugging(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	markers := []string{
		"staging", "production", "deploy", "deployment", "infra", "infrastructure",
		"database", "api latency", "latency", "performance", "perf", "slow", "timeout",
		"build failure", "test failure", "regression", "incident", "debug", "fix bug", "bug",
		"codebase", "source code", "recent deployments",
		"源码", "代码库", "仓库", "组件", "触发条件", "排查", "修复", "报错", "日志",
		"线上", "生产", "部署", "接口", "性能", "延迟", "超时",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func personaDelegatedWorkerMentionsOneesamaSystem(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false
	}
	markers := []string{
		"oneesama", "onee sama", "onee-sama", "slack agent", "slack-agent", "meeting agent",
		"meeting-agent", "meet-runner", "agentrunner", "persona foreground", "pi foreground",
		"workspace triage", "triage policy", "daily report", "custom emoji", "memory provider",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func personaDelegatedWorkerExplicitlyAuthorized(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	return strings.Contains(lower, "explicit_human_authorized_code") ||
		strings.Contains(lower, "explicitly human-authorized") ||
		strings.Contains(lower, "human explicitly asked") ||
		strings.Contains(lower, "peng explicitly asked")
}

func slackPersonaSecretaryRoutingText() string {
	return "这看起来是具体项目代码/环境问题，我先不直接下场查 repo。更适合走项目 owner 处理；我可以帮忙把现象、链接和影响面整理成 brief，或者在你明确授权我查 Oneesama 自身/指定代码时再派 worker。"
}

func (s *Service) startPersonaDelegatedWorkerJobs(ctx context.Context, workspaceID string, runID int64, result SlackPersonaShadowResult, request persona.Request, messages []SlackInboundMessage) personaDelegatedWorkerStartResult {
	out := personaDelegatedWorkerStartResult{}
	if s == nil || strings.TrimSpace(result.Decision) != persona.DecisionDelegateWorker || len(result.workerRecords) == 0 {
		return out
	}
	if s.runner == nil {
		errText := "agent runner is not ready: " + runnerErrorText(s.runnerErr)
		out.Errors = append(out.Errors, errText)
		out.Failures = 1
		out.ToolCalls = append(out.ToolCalls, SlackTriageToolCall{
			Tool:    "agent_runner",
			Action:  "delegate_worker",
			Success: false,
			Brief:   "Persona delegate_worker could not start Codex worker",
			Result:  errText,
		})
		return out
	}
	for index, workerRequest := range result.workerRecords {
		if index >= 3 {
			out.Errors = append(out.Errors, "delegate_worker_limit_exceeded")
			break
		}
		sessionKind := personaDelegatedWorkerSessionKind(workerRequest)
		if sessionKind == agentrunner.SessionKindSecretaryLookup {
			workerRequest = enrichPersonaSecretaryLookupWorkerRequest(workerRequest, request)
		}
		prompt := strings.TrimSpace(workerRequest.Prompt)
		if prompt == "" {
			prompt = "Handle the delegated Slack task from Pi foreground triage."
		}
		workerID := firstNonEmpty(strings.TrimSpace(workerRequest.ID), fmt.Sprintf("%s:worker:%d", result.RequestID, index+1))
		contextMap := mergeStringAnyMaps(workerRequest.Context, map[string]any{
			"source":        "persona_delegate_worker",
			"sessionId":     firstNonEmpty(strings.TrimSpace(result.RequestID), fmt.Sprintf("triage:%d", runID)),
			"session_id":    firstNonEmpty(strings.TrimSpace(result.RequestID), fmt.Sprintf("triage:%d", runID)),
			"workspaceId":   workspaceID,
			"workspace_id":  workspaceID,
			"triageRunId":   runID,
			"triage_run_id": runID,
			"slack": map[string]any{
				"workspaceId": workspaceID,
				"channelId":   strings.TrimSpace(result.ChannelID),
				"channel_id":  strings.TrimSpace(result.ChannelID),
				"threadTs":    strings.TrimSpace(result.ThreadTS),
				"thread_ts":   strings.TrimSpace(result.ThreadTS),
			},
			"persona": map[string]any{
				"request_id": result.RequestID,
				"decision":   result.Decision,
				"reason":     result.Reason,
				"confidence": result.Confidence,
				"worker_id":  workerID,
			},
		}, personaDelegatedWorkerSlackContext(result.ChannelID, result.ThreadTS, messages))
		job, err := s.runner.StartTask(ctx, agentrunner.WithSessionCapabilities(agentrunner.StartInput{
			Task:             prompt,
			Context:          contextMap,
			Mode:             "analysis",
			AllowCodeChanges: false,
		}, sessionKind))
		if err != nil {
			errText := err.Error()
			out.Errors = append(out.Errors, errText)
			out.Failures = 1
			out.ToolCalls = append(out.ToolCalls, SlackTriageToolCall{
				Tool:    "agent_runner",
				Action:  "delegate_worker",
				Args:    marshalTriageArgs("persona", workerID, false),
				Success: false,
				Brief:   "Persona delegate_worker start failed",
				Result:  errText,
			})
			continue
		}
		out.JobIDs = append(out.JobIDs, job.ID)
		out.ToolCalls = append(out.ToolCalls, SlackTriageToolCall{
			Tool:    "agent_runner",
			Action:  "delegate_worker",
			Args:    marshalTriageArgs(job.Provider, job.ID, true),
			Success: true,
			Brief:   "Persona delegated worker started",
			Result:  prompt,
		})
	}
	if len(out.Errors) > 0 && len(out.JobIDs) == 0 {
		out.Failures = 1
	}
	return out
}

func enrichPersonaSecretaryLookupWorkerRequest(worker persona.WorkerRequest, request persona.Request) persona.WorkerRequest {
	if worker.Context == nil {
		worker.Context = map[string]any{}
	}
	if value := personaRequestContextText(request.Context, "external_link_context"); strings.TrimSpace(value) != "" && strings.TrimSpace(stringFromAny(worker.Context["external_link_context"])) == "" {
		worker.Context["external_link_context"] = value
	}
	if value := personaRequestContextText(request.Context, "triage_digest"); strings.TrimSpace(value) != "" && strings.TrimSpace(stringFromAny(worker.Context["triage_digest"])) == "" {
		worker.Context["triage_digest"] = value
	}
	if value := personaRequestMemoryEvidence(request, 5); value != "" && strings.TrimSpace(stringFromAny(worker.Context["workspace_memory_evidence"])) == "" {
		worker.Context["workspace_memory_evidence"] = value
	}
	prompt := strings.TrimSpace(worker.Prompt)
	var additions []string
	if !strings.Contains(prompt, "Do not stop at the first profile/article excerpt") {
		additions = append(additions,
			"Secretary lookup evidence rules:",
			"- Do not stop at the first profile/article excerpt. If the source exposes submissions, comments, favorites, repository, author, or source links, follow those read-only leads before answering.",
			"- Use available read-only tools such as exa_search, exa_contents, person_memory, memory_search, and slack_api fetch/read methods when the provided excerpt is not enough.",
			"- Only return a Slack-visible answer when you have concrete evidence. If evidence is insufficient, return no visible result instead of guessing or posting a routing/refusal template.",
		)
	}
	if external := strings.TrimSpace(stringFromAny(worker.Context["external_link_context"])); external != "" && !strings.Contains(prompt, "Fetched external link context:") {
		additions = append(additions, "Fetched external link context:\n"+external)
	}
	if memory := strings.TrimSpace(stringFromAny(worker.Context["workspace_memory_evidence"])); memory != "" && !strings.Contains(prompt, "Workspace Memory/person evidence:") {
		additions = append(additions, "Workspace Memory/person evidence:\n"+memory)
	}
	if len(additions) > 0 {
		if prompt != "" {
			prompt += "\n\n"
		}
		prompt += strings.Join(additions, "\n")
		worker.Prompt = prompt
	}
	return worker
}

func personaDelegatedWorkerSessionKind(request persona.WorkerRequest) string {
	scope := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringFromAny(request.Context["delegation_scope"]),
		stringFromAny(request.Context["scope"]),
		stringFromAny(request.Context["worker_scope"]),
	)))
	if scope == "secretary_lookup" {
		return agentrunner.SessionKindSecretaryLookup
	}
	return agentrunner.SessionKindSlack
}

func personaDelegatedWorkerSlackContext(channelID string, threadTS string, messages []SlackInboundMessage) map[string]any {
	messages = normalizeSlackInboundMessages(messages)
	if len(messages) == 0 {
		return nil
	}
	slackMessages := make([]SlackMessage, 0, len(messages))
	latestUserID := ""
	latestText := ""
	for _, message := range messages {
		ts := firstNonEmpty(message.TS, message.EventTS)
		slackMessages = append(slackMessages, SlackMessage{
			TS:         ts,
			EventTS:    firstNonEmpty(message.EventTS, ts),
			User:       message.UserID,
			UserID:     message.UserID,
			BotID:      message.BotID,
			Subtype:    message.Subtype,
			Text:       message.Text,
			Channel:    firstNonEmpty(message.ChannelID, channelID),
			ThreadTS:   firstNonEmpty(message.ThreadTS, threadTS),
			ReplyCount: message.ReplyCount,
			ReplyUsers: append([]string(nil), message.ReplyUsers...),
			Files:      append([]SlackFile(nil), message.Files...),
			Reactions:  append([]SlackReaction(nil), message.Reactions...),
		})
		if message.UserID != "" {
			latestUserID = message.UserID
		}
		if text := strings.TrimSpace(message.Text); text != "" {
			latestText = text
		}
	}
	transcriptMessages, omitted := compactSlackThreadTranscriptMessages(slackMessages, true, mentionRecentThreadTail)
	transcript := formatSlackThreadTranscript(transcriptMessages)
	transcript = annotateCompactedSlackTranscript(transcript, channelID, threadTS, omitted)
	media := extractSlackThreadMedia(slackMessages)
	mentionText := strings.TrimSpace(firstNonEmpty(latestText, joinSlackMessageTexts(messages)))
	rich := &SlackAppMentionContext{
		Kind:           "slack_persona_delegate_worker_context",
		Source:         "persona_delegate_worker",
		ChannelID:      channelID,
		ThreadTS:       threadTS,
		UserID:         latestUserID,
		MessageCount:   len(messages),
		Transcript:     transcript,
		RawMentionText: mentionText,
		MentionText:    mentionText,
		ParentInfo:     slackParentInfo(firstSlackMessage(slackMessages)),
		CanvasFiles:    append([]SlackThreadFile(nil), media.CanvasFiles...),
		Files:          append([]SlackThreadFile(nil), media.Files...),
		ImageParts:     append([]SlackThreadImage(nil), media.Images...),
		FetchOK:        true,
		FetchedAt:      nowRFC3339(),
	}
	prompt := buildSlackAssistantThreadMessage(rich)
	if len(media.Images) > 0 {
		prompt += "\n\n---\nImage reading rule:\nThis delegated Slack task includes image attachment file_ids. If the answer depends on image contents, request them with slack_api(method=\"slack.fetchImage\", params={\"file_id\":\"F...\"}) before answering, then inspect the returned local_path. The Slack URL in the tool result is protected and requires a bot token; do not curl it directly. If image evidence cannot be fetched or remains insufficient, return no visible result instead of guessing."
	}
	if delegatedSlackFilesIncludeNonImageMedia(media.Files) {
		prompt += "\n\n---\nFile reading rule:\nThis delegated Slack task includes non-image media/file attachments. If the answer depends on video, audio, PDF, archive, or other file contents, request the file with slack_api(method=\"slack.fetchFile\", params={\"file_id\":\"F...\"}) before answering. The result may include a local_path for a worker-side reader. Do not answer by saying you cannot view the media. If file evidence cannot be fetched or remains insufficient, return no visible result instead of guessing."
	}
	rich.Prompt = prompt
	out := map[string]any{
		"slackAssistantPrompt": prompt,
		"slackAppMention":      rich,
	}
	if len(media.Files) > 0 {
		out["slack_files"] = append([]SlackThreadFile(nil), media.Files...)
	}
	if len(media.Images) > 0 {
		out["slack_image_files"] = append([]SlackThreadImage(nil), media.Images...)
	}
	return out
}

func delegatedSlackFilesIncludeNonImageMedia(files []SlackThreadFile) bool {
	for _, file := range files {
		if isSlackImageFile(file) || isSlackCanvasFile(file) {
			continue
		}
		if isSlackVideoFile(file) || strings.TrimSpace(file.ID) != "" || strings.TrimSpace(file.Name) != "" {
			return true
		}
	}
	return false
}

func (s *Service) recordSlackTriagePersonaShadowResult(ctx context.Context, runID int64, result SlackPersonaShadowResult) error {
	if s == nil || s.triage == nil || runID == 0 {
		return nil
	}
	current, err := s.triage.GetRun(ctx, runID)
	if err != nil || current == nil {
		return err
	}
	patch := *current
	patch.ToolCalls = replacePersonaShadowToolCall(current.ToolCalls, slackPersonaShadowToolCall(result))
	metadata := mergeStringAnyMaps(current.Metadata, map[string]any{
		"persona_shadow":         result,
		"persona_shadow_queued":  false,
		"persona_shadow_done_at": nowRFC3339(),
	})
	patch.Metadata = metadata
	updated, err := s.triage.UpdateRun(ctx, patch)
	if err != nil {
		return err
	}
	if updated != nil {
		persistTriageContext(s.workspaceDir, *updated)
	}
	return nil
}

func (s *Service) recordSlackTriagePersonaForegroundResult(ctx context.Context, workspaceID string, runID int64, result SlackPersonaShadowResult, actions []SlackTriageDecisionAction, actionToolCalls []SlackTriageToolCall, failures int, mutations int) error {
	if s == nil || s.triage == nil || runID == 0 {
		return nil
	}
	current, err := s.triage.GetRun(ctx, runID)
	if err != nil || current == nil {
		return err
	}
	personaEmptyFinal := slackPersonaForegroundEmptyFinal(result)
	if personaEmptyFinal {
		result.Success = false
		result.Error = firstNonEmpty(result.Error, "empty persona foreground response with no visible reply")
	}
	patch := *current
	patch.Actions = triageActionRows(actions)
	patch.ToolCalls = replacePersonaRuntimeToolCall(append(current.ToolCalls, actionToolCalls...), "foreground_triage", slackPersonaForegroundToolCall(result))
	patch.Steps = current.Steps + 1
	patch.Mutations = maxInt(current.Mutations, mutations)
	patch.Failures = maxInt(current.Failures, failures)
	memoryWritePersistence := s.persistPersonaForegroundMemoryWrites(ctx, result)
	delegateWorkerJobsStarted := countMatchingSuccessfulTriageToolCalls(actionToolCalls, "agent_runner", "delegate_worker")
	delegateWorkerFailures := countMatchingFailedTriageToolCalls(actionToolCalls, "agent_runner", "delegate_worker")
	delegateWorkerScopeBlocks := countMatchingSuccessfulTriageToolCalls(actionToolCalls, "agent_runner", "delegate_worker_blocked_scope")
	delegateWorkerBlockedSilent := countMatchingSuccessfulTriageToolCalls(actionToolCalls, "agent_runner", "delegate_worker_blocked_silent")
	secretaryLookupAutoDelegates := countMatchingSuccessfulTriageToolCalls(actionToolCalls, "persona_runtime", "secretary_lookup_auto_delegate")
	replyCannedRefusalDowngradedSilent := countMatchingSuccessfulTriageToolCalls(actionToolCalls, "persona_runtime", "reply_canned_refusal_downgraded_silent")
	if !result.Success {
		patch.Status = "failed"
		patch.Error = firstNonEmpty(result.Error, "persona_runtime_failed")
		patch.Failures = maxInt(patch.Failures, 1)
	} else if failures > 0 {
		patch.Status = "failed"
		patch.Error = firstNonEmpty(result.Error, "persona_foreground_post_failed")
	} else {
		patch.Status = "ok"
		patch.Summary = firstNonEmpty(result.VisibleText, result.Reason, patch.Summary)
	}
	metadata := map[string]any{
		"persona_foreground":                     result,
		"persona_foreground_queued":              false,
		"persona_foreground_done_at":             nowRFC3339(),
		"pi_first_decision":                      strings.TrimSpace(result.Decision),
		"persona_foreground_action_count":        len(actions),
		"delegate_worker_jobs_started":           delegateWorkerJobsStarted,
		"delegate_worker_failures":               delegateWorkerFailures,
		"delegate_worker_scope_blocks":           delegateWorkerScopeBlocks,
		"delegate_worker_blocked_silent":         delegateWorkerBlockedSilent,
		"secretary_lookup_auto_delegates":        secretaryLookupAutoDelegates,
		"reply_canned_refusal_downgraded_silent": replyCannedRefusalDowngradedSilent,
		"persona_memory_write_files":             memoryWritePersistence.Files,
		"persona_memory_write_errors":            memoryWritePersistence.Errors,
		"persona_memory_write_redactions":        memoryWritePersistence.Redactions,
	}
	if !result.Success && slackPersonaForegroundTimedOut(result) {
		metadata["triage_timeout_needs_retry"] = true
		metadata["persona_foreground_timeout_needs_retry"] = true
	}
	patch.Metadata = mergeStringAnyMaps(current.Metadata, metadata)
	if personaEmptyFinal {
		s.maybeRecordTriageEmptyFinalFollowup(ctx, workspaceID, result.ChannelID, result.ThreadTS, &patch, nil, map[string]any{
			"failure_source":     "persona_foreground",
			"persona_runtime":    strings.TrimSpace(result.Runtime),
			"persona_request_id": strings.TrimSpace(result.RequestID),
			"persona_decision":   strings.TrimSpace(result.Decision),
			"error":              truncateSlackContextText(result.Error, 400),
		})
	}
	updated, err := s.triage.UpdateRun(ctx, patch)
	if err != nil {
		return err
	}
	if updated != nil {
		persistTriageContext(s.workspaceDir, *updated)
		if !result.Success && slackPersonaForegroundTimedOut(result) {
			s.maybeRecordPersonaForegroundTimeoutFollowup(ctx, workspaceID, result.ChannelID, result.ThreadTS, updated, result)
		}
	}
	if result.ChannelID != "" && result.ThreadTS != "" {
		summary := firstNonEmpty(result.VisibleText, result.Reason, patch.Summary)
		outcome := slackTriageLedgerOutcome(result.Success, mutations, failures)
		if err := s.cognition.RecordTriageSummary(ctx, workspaceID, result.ChannelID, result.ThreadTS, patch.SessionID, summary, outcome); err != nil {
			s.logger.Warn("slack thread ledger persona foreground summary record failed", "error", err)
		}
		if result.Success {
			s.resolveTriageRetryFollowups(ctx, result.ChannelID, result.ThreadTS, "superseded_by_successful_persona_foreground")
		}
	}
	return nil
}

func (s *Service) recordSlackTriagePersonaRequestAudit(ctx context.Context, runID int64, request persona.Request) {
	if s == nil || s.triage == nil || runID == 0 {
		return
	}
	current, err := s.triage.GetRun(ctx, runID)
	if err != nil || current == nil {
		return
	}
	patch := *current
	patch.Metadata = mergeStringAnyMaps(
		current.Metadata,
		slackPersonaDynamicContextAuditMetadata(request.DynamicContext),
		slackPersonaContextBudgetAuditMetadata(request),
	)
	updated, err := s.triage.UpdateRun(ctx, patch)
	if err != nil {
		s.logger.Warn("persona request audit metadata record failed", "triage_run_id", runID, "error", err)
		return
	}
	if updated != nil {
		persistTriageContext(s.workspaceDir, *updated)
	}
}

func slackPersonaForegroundEmptyFinal(result SlackPersonaShadowResult) bool {
	if !result.Success || result.ShadowOnly {
		return false
	}
	visibleText := strings.TrimSpace(result.VisibleText)
	decision := strings.TrimSpace(result.Decision)
	if strings.EqualFold(decision, persona.DecisionReply) && visibleText == "" {
		return true
	}
	if strings.EqualFold(decision, persona.DecisionReact) && len(result.Reactions) == 0 {
		return true
	}
	return decision == "" && visibleText == "" && len(result.WorkerRequests) == 0 && len(result.MemoryWrites) == 0 && len(result.Reactions) == 0
}

func slackPersonaShadowToolCall(result SlackPersonaShadowResult) SlackTriageToolCall {
	return SlackTriageToolCall{
		Tool:    "persona_runtime",
		Action:  "shadow_triage",
		Success: result.Success,
		Brief:   mapBool(result.Success, "Persona runtime shadow accepted triage request", "Persona runtime shadow failed"),
		Result:  firstNonEmpty(result.Decision, result.Error),
	}
}

func replacePersonaShadowToolCall(calls []SlackTriageToolCall, call SlackTriageToolCall) []SlackTriageToolCall {
	return replacePersonaRuntimeToolCall(calls, "shadow_triage", call)
}

func slackPersonaForegroundToolCall(result SlackPersonaShadowResult) SlackTriageToolCall {
	return SlackTriageToolCall{
		Tool:    "persona_runtime",
		Action:  "foreground_triage",
		Success: result.Success,
		Brief:   mapBool(result.Success, "Persona runtime foreground completed triage request", "Persona runtime foreground failed"),
		Result:  firstNonEmpty(result.Decision, result.Error),
	}
}

func replacePersonaRuntimeToolCall(calls []SlackTriageToolCall, action string, call SlackTriageToolCall) []SlackTriageToolCall {
	out := make([]SlackTriageToolCall, 0, len(calls)+1)
	for _, existing := range calls {
		if existing.Tool == "persona_runtime" && existing.Action == action {
			continue
		}
		out = append(out, existing)
	}
	return append(out, call)
}

func countMatchingSuccessfulTriageToolCalls(calls []SlackTriageToolCall, tool string, action string) int {
	count := 0
	for _, call := range calls {
		if call.Tool == tool && call.Action == action && call.Success {
			count++
		}
	}
	return count
}

func countMatchingFailedTriageToolCalls(calls []SlackTriageToolCall, tool string, action string) int {
	count := 0
	for _, call := range calls {
		if call.Tool == tool && call.Action == action && !call.Success {
			count++
		}
	}
	return count
}

func slackPersonaForegroundActions(channelID string, threadTS string, result SlackPersonaShadowResult) []SlackTriageDecisionAction {
	if !result.Success || result.ShadowOnly {
		return nil
	}
	actions := make([]SlackTriageDecisionAction, 0, 1+len(result.reactionRecords))
	if result.Decision == persona.DecisionReply && strings.TrimSpace(result.VisibleText) != "" {
		actions = append(actions, SlackTriageDecisionAction{
			Type:       "post_thread_reply",
			Title:      "Persona reply",
			Message:    strings.TrimSpace(result.VisibleText),
			ChannelID:  strings.TrimSpace(channelID),
			ThreadTS:   strings.TrimSpace(threadTS),
			Reason:     strings.TrimSpace(result.Reason),
			Confidence: result.Confidence,
		})
	}
	if result.Decision == persona.DecisionReact || len(result.reactionRecords) > 0 {
		for _, reaction := range result.reactionRecords {
			emoji := normalizeSlackReactionName(reaction.Emoji)
			if emoji == "" {
				continue
			}
			actions = append(actions, SlackTriageDecisionAction{
				Type:       "add_reaction",
				Title:      "Persona reaction",
				Message:    emoji,
				Emoji:      emoji,
				ChannelID:  firstNonEmpty(strings.TrimSpace(reaction.ChannelID), strings.TrimSpace(channelID)),
				ThreadTS:   strings.TrimSpace(threadTS),
				MessageTS:  strings.TrimSpace(reaction.MessageTS),
				Reason:     strings.TrimSpace(reaction.Reason),
				Confidence: reaction.Confidence,
			})
		}
	}
	return actions
}

func personaTriageApprovalToolCalls(pending []SlackTriagePendingResult) []SlackTriageToolCall {
	if len(pending) == 0 {
		return nil
	}
	calls := make([]SlackTriageToolCall, 0, len(pending))
	for _, result := range pending {
		if result.Action.Type != slackActionTypeThreadReply {
			continue
		}
		post := result.Post
		ok := post.OK
		status := "pending_dm_card_posted"
		if !ok {
			status = firstNonEmpty(post.Error, post.Detail, "pending_dm_card_not_posted")
		}
		calls = append(calls, SlackTriageToolCall{
			Tool:    "slack_api",
			Action:  "persona_reply_pending_dm_approval",
			Args:    marshalTriageArgs("chat.postMessage", firstNonEmpty(post.TS, post.ThreadTS), ok),
			Success: ok,
			Brief:   "Persona reply gated behind Peng approval DM",
			Result:  status,
		})
	}
	return calls
}

type SlackTriagePersonaRequestOptions struct {
	IgnoreExistingBotReply bool
	WorkspaceTriagePolicy  string
	WorkspacePolicyStatus  SlackWorkspacePolicyStatus
	PiFirst                bool
	Digest                 string
	ExternalLinks          []SlackExternalLinkContext
	ThreadContexts         []SlackTriageThreadContext
	ChannelContexts        []SlackInboundMessage
	PreviousTriage         string
	CustomEmoji            []string
}

type SlackTriagePersonaRequestInput struct {
	ChannelID     string
	ThreadTS      string
	Messages      []SlackInboundMessage
	Decision      SlackTriageDecision
	RelatedMemory []SlackRelatedMemoryRecord
	Options       SlackTriagePersonaRequestOptions
}

type SlackTriagePersonaShadowRequestInput struct {
	ChannelID             string
	ThreadTS              string
	Messages              []SlackInboundMessage
	Decision              SlackTriageDecision
	RelatedMemory         []SlackRelatedMemoryRecord
	WorkspaceTriagePolicy string
	CustomEmoji           []string
}

type SlackTriagePersonaForegroundRequestInput struct {
	ChannelID              string
	ThreadTS               string
	Messages               []SlackInboundMessage
	Decision               SlackTriageDecision
	RelatedMemory          []SlackRelatedMemoryRecord
	IgnoreExistingBotReply bool
	WorkspaceTriagePolicy  string
	CustomEmoji            []string
}

type SlackTriagePiFirstForegroundRequestInput struct {
	ChannelID              string
	ThreadTS               string
	Messages               []SlackInboundMessage
	RelatedMemory          []SlackRelatedMemoryRecord
	Digest                 string
	ExternalLinks          []SlackExternalLinkContext
	ThreadContexts         []SlackTriageThreadContext
	ChannelContexts        []SlackInboundMessage
	PreviousTriage         string
	IgnoreExistingBotReply bool
	WorkspaceTriagePolicy  string
	WorkspacePolicyStatus  SlackWorkspacePolicyStatus
	CustomEmoji            []string
}

func BuildSlackTriagePersonaRequest(channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord) persona.Request {
	return BuildSlackTriagePersonaRequestWithOptions(channelID, threadTS, messages, decision, relatedMemory, SlackTriagePersonaRequestOptions{})
}

func BuildSlackTriagePersonaRequestWithOptions(channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord, options SlackTriagePersonaRequestOptions) persona.Request {
	return BuildSlackTriagePersonaRequestFromInput(SlackTriagePersonaRequestInput{
		ChannelID:     channelID,
		ThreadTS:      threadTS,
		Messages:      messages,
		Decision:      decision,
		RelatedMemory: relatedMemory,
		Options:       options,
	})
}

func BuildSlackTriagePersonaShadowRequest(input SlackTriagePersonaShadowRequestInput) persona.Request {
	return BuildSlackTriagePersonaRequestFromInput(SlackTriagePersonaRequestInput{
		ChannelID:     input.ChannelID,
		ThreadTS:      input.ThreadTS,
		Messages:      input.Messages,
		Decision:      input.Decision,
		RelatedMemory: input.RelatedMemory,
		Options: SlackTriagePersonaRequestOptions{
			WorkspaceTriagePolicy: input.WorkspaceTriagePolicy,
			CustomEmoji:           input.CustomEmoji,
		},
	})
}

func BuildSlackTriagePersonaForegroundRequest(input SlackTriagePersonaForegroundRequestInput) persona.Request {
	req := BuildSlackTriagePersonaRequestFromInput(SlackTriagePersonaRequestInput{
		ChannelID:     input.ChannelID,
		ThreadTS:      input.ThreadTS,
		Messages:      input.Messages,
		Decision:      input.Decision,
		RelatedMemory: input.RelatedMemory,
		Options: SlackTriagePersonaRequestOptions{
			IgnoreExistingBotReply: input.IgnoreExistingBotReply,
			WorkspaceTriagePolicy:  input.WorkspaceTriagePolicy,
			CustomEmoji:            input.CustomEmoji,
		},
	})
	req.Mode = persona.ModeLive
	return req
}

func BuildSlackTriagePiFirstForegroundRequest(input SlackTriagePiFirstForegroundRequestInput) persona.Request {
	req := BuildSlackTriagePersonaRequestFromInput(SlackTriagePersonaRequestInput{
		ChannelID:     input.ChannelID,
		ThreadTS:      input.ThreadTS,
		Messages:      input.Messages,
		RelatedMemory: input.RelatedMemory,
		Options: SlackTriagePersonaRequestOptions{
			PiFirst:                true,
			Digest:                 input.Digest,
			ExternalLinks:          input.ExternalLinks,
			ThreadContexts:         input.ThreadContexts,
			ChannelContexts:        input.ChannelContexts,
			PreviousTriage:         input.PreviousTriage,
			IgnoreExistingBotReply: input.IgnoreExistingBotReply,
			WorkspaceTriagePolicy:  input.WorkspaceTriagePolicy,
			WorkspacePolicyStatus:  input.WorkspacePolicyStatus,
			CustomEmoji:            input.CustomEmoji,
		},
	})
	req.Mode = persona.ModeLive
	return req
}

func BuildSlackTriagePersonaRequestFromInput(input SlackTriagePersonaRequestInput) persona.Request {
	channelID := input.ChannelID
	threadTS := input.ThreadTS
	messages := input.Messages
	decision := input.Decision
	relatedMemory := input.RelatedMemory
	options := input.Options
	messages = normalizeSlackInboundMessages(messages)
	text := strings.TrimSpace(joinSlackMessageTexts(messages))
	if text == "" {
		text = strings.TrimSpace(firstNonEmpty(options.Digest, decision.Summary))
	}
	citations := personaCitationsFromRelatedMemory(relatedMemory)
	contextItems := make([]persona.ContextItem, 0, 8)
	dynamicContext := buildSlackTriagePersonaDynamicContext(options)
	if options.PiFirst {
		if digest := strings.TrimSpace(options.Digest); digest != "" {
			contextItems = append(contextItems, persona.ContextItem{Kind: "triage_digest", Text: truncateSlackContextText(digest, slackTriageDigestBudgetChars)})
		}
		if threadContext := formatSlackTriageThreadContexts(options.ThreadContexts); strings.TrimSpace(threadContext) != "" {
			contextItems = append(contextItems, persona.ContextItem{Kind: "slack_thread_context", Text: truncateSlackContextText(threadContext, slackThreadContextBudgetChars)})
		}
		if len(options.ChannelContexts) > 0 {
			contextItems = append(contextItems, persona.ContextItem{
				Kind: "slack_channel_context",
				Text: truncateSlackContextText(renderSlackTriageThreadTranscript(options.ChannelContexts), slackChannelContextBudgetChars),
			})
		}
		if external := formatSlackExternalLinkContexts(options.ExternalLinks); strings.TrimSpace(external) != "" {
			contextItems = append(contextItems, persona.ContextItem{Kind: "external_link_context", Text: truncateSlackContextText(external, slackExternalLinkContextBudgetChars)})
		}
		if previous := strings.TrimSpace(options.PreviousTriage); previous != "" {
			contextItems = append(contextItems, persona.ContextItem{Kind: "previous_triage_context", Text: truncateSlackContextText(previous, slackPreviousTriageContextBudgetChars)})
		}
	} else {
		contextItems = append(contextItems,
			persona.ContextItem{Kind: "triage_summary", Text: strings.TrimSpace(decision.Summary)},
			persona.ContextItem{Kind: "triage_actions", Text: fmt.Sprintf("%d action(s)", len(decision.Actions))},
		)
		if candidateActions := formatSlackTriagePersonaCandidateActions(decision.Actions); candidateActions != "" {
			contextItems = append(contextItems, persona.ContextItem{
				Kind: "triage_candidate_actions",
				Text: candidateActions,
			})
		}
	}
	contextItems = append(contextItems, persona.ContextItem{
		Kind: "delegation_scope_policy",
		Text: "Oneesama is a workspace secretary, not the default code investigator for every project. delegate_worker is allowed for bounded secretary work (workspace Memory lookup/synthesis, file/thread retrieval, external URL identity/fact lookup, Canvas/memo preparation), Oneesama's own runtime/code, or explicit human-authorized code work. For external URL/link questions such as 这是谁/这是啥/who is this/what is this, use delegation_scope=secretary_lookup before staying silent unless the thread already has a substantive answer; 不认识/不知道/no idea is not a substantive answer. For external staging/prod/deploy/infra/database/API latency/CI/performance/debug/code investigations, reply with routing/owner handoff or stay_silent instead of delegating.",
	})
	metadata := map[string]any{
		"decision_parse_ok":       decision.ParseOK,
		"actions":                 len(decision.Actions),
		"foreground_chain":        mapBool(options.PiFirst, slackTriageForegroundChainPiFirstLive, slackTriageForegroundChainCodexThenPi),
		"delegation_scope_policy": "secretary_routing",
	}
	if options.IgnoreExistingBotReply {
		contextItems = append(contextItems, persona.ContextItem{
			Kind: "dev_rerun_override",
			Text: "Internal acceptance rerun: ignore existing bot-authored replies as a reason to stay silent. Human replies still count as blocking freshness.",
		})
		metadata["ignore_existing_bot_reply"] = true
	}
	req := persona.Request{
		ID:   fmt.Sprintf("triage:%s:%s", strings.TrimSpace(channelID), strings.TrimSpace(threadTS)),
		Mode: persona.ModeShadow,
		Event: persona.Event{
			Kind: "slack_triage",
			Text: text,
		},
		Anchor: persona.Anchor{
			Surface:   "slack",
			ChannelID: strings.TrimSpace(channelID),
			ThreadTS:  strings.TrimSpace(threadTS),
		},
		Context:        contextItems,
		DynamicContext: dynamicContext,
		Evidence: persona.EvidenceBundle{
			Summary:   strings.TrimSpace(firstNonEmpty(decision.Summary, options.Digest)),
			Citations: citations,
		},
		Memory: persona.MemoryContext{
			Summary: fmt.Sprintf("%d related memory record(s)", len(relatedMemory)),
			Items:   personaMemoryRecordsFromRelatedMemory(relatedMemory),
		},
		Safety: persona.SafetyConstraints{
			AllowVisibleReply:  true,
			AllowSpeech:        false,
			AllowWorkerRequest: true,
			AllowReactions:     true,
			MaxVisibleChars:    600,
			AllowedWorkers:     []string{"codex", "claude", "agent_read"},
		},
		Metadata: metadata,
	}
	req.Metadata = mergeStringAnyMaps(req.Metadata, slackPersonaContextBudgetAuditMetadata(req))
	return req
}

const (
	slackDynamicContextSourceRuntime     = "oneesama_runtime"
	slackDynamicContextSourceCustomEmoji = "slack.emoji.list"
)

func buildSlackTriagePersonaDynamicContext(options SlackTriagePersonaRequestOptions) []persona.DynamicContextEnvelope {
	now := nowRFC3339()
	items := make([]persona.DynamicContextEnvelope, 0, 3)
	items = append(items, persona.NormalizeDynamicContextEnvelope(persona.DynamicContextEnvelope{
		Kind:        "current_time",
		Source:      slackDynamicContextSourceRuntime,
		Version:     "runtime_clock",
		Freshness:   now,
		Confidence:  1,
		Content:     now,
		CachePolicy: persona.DynamicContextCachePolicyNotStablePrefix,
		Metadata: map[string]any{
			"format":   time.RFC3339Nano,
			"timezone": "UTC",
		},
	}))
	if workspacePolicy := strings.TrimSpace(options.WorkspaceTriagePolicy); workspacePolicy != "" {
		status := normalizeSlackWorkspacePolicyStatus(workspacePolicy, options.WorkspacePolicyStatus)
		source := firstNonEmpty(status.Source, slackWorkspacePolicySourceConfig)
		items = append(items, persona.NormalizeDynamicContextEnvelope(persona.DynamicContextEnvelope{
			Kind:        "workspace_triage_policy",
			Source:      source,
			Version:     status.Version,
			Freshness:   now,
			Confidence:  1,
			Content:     workspacePolicy,
			CachePolicy: persona.DynamicContextCachePolicyNotStablePrefix,
			Metadata:    slackWorkspacePolicyMetadataMap(status),
		}))
	}
	if customEmoji, metadata := slackCustomEmojiDynamicContextPayload(options.CustomEmoji); customEmoji != "" {
		version := shortSHA256Hex(customEmoji)
		items = append(items, persona.NormalizeDynamicContextEnvelope(persona.DynamicContextEnvelope{
			Kind:        "workspace_custom_emoji",
			Source:      slackDynamicContextSourceCustomEmoji,
			Version:     "sha256:" + version,
			Freshness:   now,
			Confidence:  1,
			Content:     customEmoji,
			CachePolicy: persona.DynamicContextCachePolicyNotStablePrefix,
			Metadata:    metadata,
		}))
	}
	return persona.NormalizeDynamicContextEnvelopes(items)
}

func slackCustomEmojiDynamicContextPayload(names []string) (string, map[string]any) {
	normalized := normalizeWorkspaceCustomEmojiNames(names)
	if len(normalized) == 0 {
		return "", nil
	}
	total := len(normalized)
	truncated := false
	if len(normalized) > slackCustomEmojiPromptLimit {
		normalized = normalized[:slackCustomEmojiPromptLimit]
		truncated = true
	}
	content := "## Workspace custom emoji\n" + strings.Join(normalized, ", ")
	return content, map[string]any{
		"emoji_count":      len(normalized),
		"emoji_total":      total,
		"emoji_limit":      slackCustomEmojiPromptLimit,
		"emoji_truncated":  truncated,
		"emoji_source_api": "emoji.list",
	}
}

func shortSHA256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:12]
}

func slackPersonaDynamicContextAuditMetadata(envelopes []persona.DynamicContextEnvelope) map[string]any {
	out := map[string]any{
		"persona_dynamic_context_expected": true,
		"persona_dynamic_context_count":    len(envelopes),
	}
	if len(envelopes) == 0 {
		out["persona_dynamic_context"] = []map[string]any{}
		out["persona_dynamic_context_kinds"] = []string{}
		return out
	}
	items := make([]map[string]any, 0, len(envelopes))
	kinds := make([]string, 0, len(envelopes))
	for _, env := range envelopes {
		kind := strings.TrimSpace(env.Kind)
		if kind == "" {
			continue
		}
		kinds = append(kinds, kind)
		items = append(items, map[string]any{
			"kind":          kind,
			"source":        strings.TrimSpace(env.Source),
			"version":       strings.TrimSpace(env.Version),
			"freshness":     strings.TrimSpace(env.Freshness),
			"cache_policy":  strings.TrimSpace(env.CachePolicy),
			"content_chars": len([]rune(strings.TrimSpace(env.Content))),
		})
	}
	out["persona_dynamic_context"] = items
	out["persona_dynamic_context_kinds"] = kinds
	return out
}

func slackPersonaContextBudgetAuditMetadata(req persona.Request) map[string]any {
	budget := persona.RequestHarnessContextBudget(req)
	return map[string]any{
		"context_budget_expected":                 true,
		"context_budget_stable_chars":             budget.StableChars,
		"context_budget_dynamic_chars":            budget.DynamicChars,
		"context_budget_worker_result_chars":      budget.WorkerResultChars,
		"context_budget_memory_evidence_chars":    budget.MemoryEvidenceChars,
		"context_budget_event_context_chars":      budget.EventContextChars,
		"context_budget_total_chars":              budget.TotalChars,
		"context_budget_stable_tokens":            budget.StableTokens,
		"context_budget_dynamic_tokens":           budget.DynamicTokens,
		"context_budget_worker_result_tokens":     budget.WorkerResultTokens,
		"context_budget_memory_evidence_tokens":   budget.MemoryEvidenceTokens,
		"context_budget_event_context_tokens":     budget.EventContextTokens,
		"context_budget_total_tokens":             budget.TotalTokens,
		"context_budget_estimator":                "chars_div_4_ceil",
		"context_budget_cache_locality_breakdown": "stable_dynamic_worker_result_memory_evidence_event_context",
		"context_budget": map[string]any{
			"stableChars":          budget.StableChars,
			"dynamicChars":         budget.DynamicChars,
			"workerResultChars":    budget.WorkerResultChars,
			"memoryEvidenceChars":  budget.MemoryEvidenceChars,
			"eventContextChars":    budget.EventContextChars,
			"totalChars":           budget.TotalChars,
			"stableTokens":         budget.StableTokens,
			"dynamicTokens":        budget.DynamicTokens,
			"workerResultTokens":   budget.WorkerResultTokens,
			"memoryEvidenceTokens": budget.MemoryEvidenceTokens,
			"eventContextTokens":   budget.EventContextTokens,
			"totalTokens":          budget.TotalTokens,
		},
	}
}

func formatSlackTriagePersonaCandidateActions(actions []SlackTriageDecisionAction) string {
	if len(actions) == 0 {
		return ""
	}
	var b strings.Builder
	for index, action := range actions {
		if index >= 5 {
			fmt.Fprintf(&b, "\n- ... %d more action(s) omitted", len(actions)-index)
			break
		}
		fmt.Fprintf(&b, "- type=%s", firstNonEmpty(strings.TrimSpace(action.Type), "unknown"))
		if title := strings.TrimSpace(action.Title); title != "" {
			fmt.Fprintf(&b, " title=%q", truncateSlackContextText(title, 80))
		}
		if slackTriageDirectReplyAction(action) {
			b.WriteString(" direct_reply=true")
		}
		if action.RequiresConfirmation {
			b.WriteString(" requires_confirmation=true")
		}
		if message := strings.TrimSpace(action.Message); message != "" {
			fmt.Fprintf(&b, "\n  message: %s", truncateSlackContextText(message, 280))
		}
		if reason := strings.TrimSpace(action.Reason); reason != "" {
			fmt.Fprintf(&b, "\n  reason: %s", truncateSlackContextText(reason, 180))
		}
		if index != len(actions)-1 {
			b.WriteString("\n")
		}
	}
	return strings.TrimSpace(b.String())
}

func slackRelatedMemoryRecordsFromAny(value any) []SlackRelatedMemoryRecord {
	switch typed := value.(type) {
	case SlackRelatedMemorySearchResult:
		return typed.Results
	case *SlackRelatedMemorySearchResult:
		if typed == nil {
			return nil
		}
		return typed.Results
	case []SlackRelatedMemoryRecord:
		return typed
	case []any:
		return slackRelatedMemoryRecordsFromAny(map[string]any{"results": typed})
	case map[string]any:
		raw, ok := typed["results"]
		if !ok {
			return nil
		}
		payload, err := json.Marshal(raw)
		if err != nil {
			return nil
		}
		var out []SlackRelatedMemoryRecord
		if err := json.Unmarshal(payload, &out); err != nil {
			return nil
		}
		return out
	default:
		return nil
	}
}

func callPersonaShadow(ctx context.Context, runtime persona.Runtime, source string, request persona.Request) SlackPersonaShadowResult {
	start := time.Now()
	result := SlackPersonaShadowResult{
		RequestID:  request.ID,
		Source:     source,
		ChannelID:  request.Anchor.ChannelID,
		ThreadTS:   request.Anchor.ThreadTS,
		ShadowOnly: true,
	}
	if classification, ok := request.Metadata["classification"].(string); ok {
		result.Classification = classification
	}
	resp, err := runtime.Decide(ctx, request)
	result.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Success = true
	result.Runtime = resp.Runtime
	result.Decision = resp.Decision
	result.VisibleText = sanitizeSlackVisibleText(resp.VisibleText)
	result.Confidence = resp.Confidence
	result.WorkerRequests = personaWorkerRequestSummaries(resp.WorkerRequests)
	result.MemoryWrites = personaMemoryWriteSummaries(resp.MemoryWrites)
	result.Reactions = personaReactionSummaries(resp.Reactions)
	result.workerRecords = append([]persona.WorkerRequest(nil), resp.WorkerRequests...)
	result.memoryRecords = append([]persona.MemoryWrite(nil), resp.MemoryWrites...)
	result.reactionRecords = append([]persona.ReactionIntent(nil), resp.Reactions...)
	result.ShadowOnly = resp.ShadowOnly
	result.Reason = sanitizeSlackVisibleText(resp.Reason)
	result.Citations = personaCitationRefs(resp.Citations)
	return result
}

type personaMemoryWritePersistence struct {
	Files      []string
	Errors     []string
	Redactions int
}

func (s *Service) persistPersonaForegroundMemoryWrites(ctx context.Context, result SlackPersonaShadowResult) personaMemoryWritePersistence {
	out := personaMemoryWritePersistence{}
	if !result.Success || len(result.memoryRecords) == 0 {
		return out
	}
	root := s.memoryWriteRoot()
	if strings.TrimSpace(root) == "" {
		out.Errors = append(out.Errors, "memory_disabled")
		return out
	}
	for _, record := range result.memoryRecords {
		if err := ctx.Err(); err != nil {
			out.Errors = append(out.Errors, err.Error())
			return out
		}
		text := strings.TrimSpace(record.Text)
		if text == "" {
			continue
		}
		body, redactions := renderPersonaMemoryWrite(result, record)
		out.Redactions += redactions
		rel := personaMemoryWritePath(result, record)
		if err := legacySlackWriteGeneratedFile(root, rel, []byte(body), true); err != nil {
			out.Errors = append(out.Errors, fmt.Sprintf("%s: %v", rel, err))
			continue
		}
		s.notifyMemoryProvidersWrite(ctx, SlackMemoryProviderWriteEvent{
			Action:  "write",
			Target:  "persona",
			Path:    filepath.ToSlash(rel),
			Content: body,
			Source:  "persona_memory_write",
			Metadata: map[string]any{
				"request_id": result.RequestID,
				"channel_id": result.ChannelID,
				"thread_ts":  result.ThreadTS,
				"kind":       record.Kind,
				"source_ref": record.SourceRef,
			},
		})
		out.Files = append(out.Files, rel)
	}
	return out
}

func personaMemoryWritePath(result SlackPersonaShadowResult, record persona.MemoryWrite) string {
	kind := sanitizePersonaMemoryPathComponent(firstNonEmpty(record.Kind, "memory"))
	day := timeNow().UTC().Format("2006-01-02")
	h := sha256.Sum256([]byte(strings.Join([]string{
		result.RequestID,
		result.ChannelID,
		result.ThreadTS,
		record.Kind,
		record.SourceRef,
		record.Text,
	}, "\n")))
	return filepath.ToSlash(filepath.Join("memory", "persona", "writes", day, kind+"-"+hex.EncodeToString(h[:])[:12]+".md"))
}

func renderPersonaMemoryWrite(result SlackPersonaShadowResult, record persona.MemoryWrite) (string, int) {
	text, redactions := redactSlockWorkspaceSecrets(strings.TrimSpace(record.Text))
	metadata, err := json.MarshalIndent(record.Metadata, "", "  ")
	if err != nil || string(metadata) == "null" {
		metadata = nil
	}
	metadataText := ""
	if len(metadata) > 0 {
		var metadataRedactions int
		metadataText, metadataRedactions = redactSlockWorkspaceSecrets(string(metadata))
		redactions += metadataRedactions
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# Persona memory write: %s\n\n", firstNonEmpty(record.Kind, "memory"))
	legacySlackWriteBullet(&b, "Request", result.RequestID)
	legacySlackWriteBullet(&b, "Runtime", result.Runtime)
	legacySlackWriteBullet(&b, "Decision", result.Decision)
	legacySlackWriteBullet(&b, "Channel", result.ChannelID)
	legacySlackWriteBullet(&b, "Thread", result.ThreadTS)
	legacySlackWriteBullet(&b, "Source", record.SourceRef)
	legacySlackWriteBullet(&b, "Imported at", timeNow().UTC().Format(time.RFC3339Nano))
	b.WriteString("\n## Memory\n\n")
	b.WriteString(text)
	b.WriteString("\n")
	if strings.TrimSpace(metadataText) != "" {
		b.WriteString("\n## Metadata\n\n```json\n")
		b.WriteString(metadataText)
		b.WriteString("\n```\n")
	}
	return b.String(), redactions
}

func sanitizePersonaMemoryPathComponent(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return "memory"
	}
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "memory"
	}
	return out
}

func personaWorkerRequestSummaries(requests []persona.WorkerRequest) []string {
	out := make([]string, 0, len(requests))
	for _, request := range requests {
		summary := strings.TrimSpace(firstNonEmpty(request.Kind, request.Prompt))
		if summary == "" {
			continue
		}
		prompt := strings.TrimSpace(request.Prompt)
		if prompt != "" && prompt != summary {
			summary = summary + ": " + truncateSlackContextText(prompt, 160)
		}
		out = append(out, summary)
	}
	return out
}

func personaMemoryWriteSummaries(writes []persona.MemoryWrite) []string {
	out := make([]string, 0, len(writes))
	for _, write := range writes {
		text := strings.TrimSpace(write.Text)
		if text == "" {
			continue
		}
		kind := strings.TrimSpace(write.Kind)
		if kind != "" {
			text = kind + ": " + text
		}
		if source := strings.TrimSpace(write.SourceRef); source != "" {
			text = text + " [" + source + "]"
		}
		out = append(out, truncateSlackContextText(text, 220))
	}
	return out
}

func personaReactionSummaries(reactions []persona.ReactionIntent) []string {
	out := make([]string, 0, len(reactions))
	for _, reaction := range reactions {
		emoji := normalizeSlackReactionName(reaction.Emoji)
		if emoji == "" {
			continue
		}
		text := ":" + emoji + ":"
		if ts := strings.TrimSpace(reaction.MessageTS); ts != "" {
			text += " @" + ts
		}
		if reason := strings.TrimSpace(reaction.Reason); reason != "" {
			text += " — " + truncateSlackContextText(reason, 160)
		}
		out = append(out, text)
	}
	return out
}

func personaCitationsFromRelatedMemory(records []SlackRelatedMemoryRecord) []persona.Citation {
	out := make([]persona.Citation, 0, len(records))
	for _, record := range records {
		out = append(out, persona.Citation{
			Kind:      record.Kind,
			Source:    record.Source,
			SourceRef: firstNonEmpty(record.SourceRef, record.SourcePath),
			LineStart: record.StartLine,
			LineEnd:   record.EndLine,
			Snippet:   truncateSlackContextText(sanitizeSlackVisibleText(record.Content), 240),
		})
	}
	return out
}

func personaMemoryRecordsFromRelatedMemory(records []SlackRelatedMemoryRecord) []persona.MemoryRecord {
	out := make([]persona.MemoryRecord, 0, len(records))
	for _, record := range records {
		out = append(out, persona.MemoryRecord{
			Kind:      record.Kind,
			Text:      sanitizeSlackVisibleText(record.Content),
			SourceRef: firstNonEmpty(record.SourceRef, record.SourcePath),
			Score:     record.Score,
		})
	}
	return out
}

func personaCitationRefs(citations []persona.Citation) []string {
	out := make([]string, 0, len(citations))
	for _, citation := range citations {
		ref := firstNonEmpty(citation.SourceRef, citation.Source)
		if ref == "" {
			continue
		}
		if citation.LineStart > 0 {
			ref = fmt.Sprintf("%s:%d", ref, citation.LineStart)
			if citation.LineEnd > citation.LineStart {
				ref = fmt.Sprintf("%s-%d", ref, citation.LineEnd)
			}
		}
		out = append(out, ref)
	}
	return out
}
