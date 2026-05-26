package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"

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
	ShadowOnly      bool                         `json:"shadow_only"`
	Success         bool                         `json:"success"`
	Error           string                       `json:"error,omitempty"`
	Reason          string                       `json:"reason,omitempty"`
	LatencyMS       int64                        `json:"latency_ms,omitempty"`
	Citations       []string                     `json:"citations,omitempty"`
	EvidenceAnchors []SlackVisibleEvidenceAnchor `json:"evidence_anchors,omitempty"`
}

type slackPersonaForegroundDisposition struct {
	Result    SlackPersonaShadowResult
	ToolCalls []SlackTriageToolCall
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
		disposition := s.applySlackPersonaForegroundDispositions(result, request, messages)
		result = disposition.Result
		actions := slackTriageVisibleReplyActionsAfterGate(slackPersonaForegroundActions(channelID, threadTS, result, request))
		toolCalls, failures, mutations := s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, channelID, threadTS, runID, actions, slackTriageDirectActionOptions{
			SnapshotMessages:       messages,
			IgnoreExistingBotReply: ignoreBotReply,
		})
		if len(disposition.ToolCalls) > 0 {
			toolCalls = append(toolCalls, disposition.ToolCalls...)
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
		disposition := s.applySlackPersonaForegroundDispositions(result, request, messages)
		result = disposition.Result
		actions := slackTriageVisibleReplyActionsAfterGate(slackPersonaForegroundActions(channelID, threadTS, result, request))
		toolCalls, failures, mutations := s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, channelID, threadTS, runID, actions, slackTriageDirectActionOptions{
			SnapshotMessages:       messages,
			IgnoreExistingBotReply: ignoreExistingBotReply,
		})
		if len(disposition.ToolCalls) > 0 {
			toolCalls = append(toolCalls, disposition.ToolCalls...)
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

func (s *Service) applySlackPersonaForegroundDispositions(result SlackPersonaShadowResult, request persona.Request, messages []SlackInboundMessage) slackPersonaForegroundDisposition {
	result, toolCalls := applyPersonaWorkerReturnNoDelegateDisposition(result, request)
	var next []SlackTriageToolCall
	result, next = applyPersonaSecretaryLookupDisposition(result, request)
	toolCalls = append(toolCalls, next...)
	result, next = applyPersonaMediaLookupDisposition(result, request, messages)
	toolCalls = append(toolCalls, next...)
	result, next = applyPersonaCompletedDelegationDisposition(result)
	toolCalls = append(toolCalls, next...)
	result, next = applyPersonaAmbientDelegationDisposition(result, messages, s.botUserID)
	toolCalls = append(toolCalls, next...)
	result, next = applyPersonaCannedRefusalDisposition(result)
	toolCalls = append(toolCalls, next...)
	result, next = applyPersonaAmbientDirectReplyDisposition(result, messages, s.botUserID)
	toolCalls = append(toolCalls, next...)
	result, next = applyPersonaExplicitSmokeCommandDisposition(result, request, messages)
	toolCalls = append(toolCalls, next...)
	result, next = applyPersonaProductLinkSynthesisDisposition(result, request, messages)
	toolCalls = append(toolCalls, next...)
	result, next = applyPersonaPositiveStatusSummaryReactionDisposition(result, request, messages)
	toolCalls = append(toolCalls, next...)
	result, next = s.applyPersonaSecretaryDelegationPolicy(result)
	toolCalls = append(toolCalls, next...)
	result, next = applyPersonaProductLinkReactionDisposition(result, request)
	toolCalls = append(toolCalls, next...)
	result, next = applyPersonaVisibleReplyQualityDisposition(result)
	toolCalls = append(toolCalls, next...)
	return slackPersonaForegroundDisposition{Result: result, ToolCalls: toolCalls}
}

func (s *Service) personaRuntimeShadowTimeout() time.Duration {
	if s != nil && s.personaRuntimeConfig.Timeout > 0 {
		return s.personaRuntimeConfig.Timeout
	}
	return 90 * time.Second
}
