package slackagent

import (
	"context"
	"strings"

	"github.com/AFK-surf/oneesama/internal/persona"
)

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
		"persona_foreground":                              result,
		"persona_foreground_queued":                       false,
		"persona_foreground_done_at":                      nowRFC3339(),
		"pi_first_decision":                               strings.TrimSpace(result.Decision),
		"persona_foreground_action_count":                 len(actions),
		"delegate_worker_jobs_started":                    delegateWorkerJobsStarted,
		"delegate_worker_failures":                        delegateWorkerFailures,
		"delegate_worker_scope_blocks":                    delegateWorkerScopeBlocks,
		"delegate_worker_blocked_silent":                  delegateWorkerBlockedSilent,
		"secretary_lookup_auto_delegates":                 secretaryLookupAutoDelegates,
		"reply_canned_refusal_downgraded_silent":          replyCannedRefusalDowngradedSilent,
		"persona_memory_write_files":                      memoryWritePersistence.Files,
		"persona_memory_write_contradiction_review_files": memoryWritePersistence.ContradictionReviewFiles,
		"persona_memory_write_contradiction_reviews":      memoryWritePersistence.ContradictionReviews,
		"persona_memory_write_errors":                     memoryWritePersistence.Errors,
		"persona_memory_write_redactions":                 memoryWritePersistence.Redactions,
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
