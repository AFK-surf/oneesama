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
	request := BuildSlackTriagePersonaRequestWithOptions(channelID, threadTS, messages, decision, relatedMemory, SlackTriagePersonaRequestOptions{
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
	request := BuildSlackTriagePersonaRequestWithOptions(channelID, threadTS, messages, decision, relatedMemory, SlackTriagePersonaRequestOptions{
		IgnoreExistingBotReply: ignoreBotReply,
		WorkspaceTriagePolicy:  s.triageWorkspacePolicy,
		CustomEmoji:            s.workspaceCustomEmojiSnapshot(),
	})
	request.Mode = persona.ModeLive
	go func() {
		callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
		defer cancel()
		result := callPersonaShadow(callCtx, s.personaRuntime, "triage", request)
		result, policyToolCalls := s.applyPersonaSecretaryDelegationPolicy(result)
		actions := slackPersonaForegroundActions(channelID, threadTS, result)
		toolCalls, failures, mutations := s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, channelID, threadTS, runID, actions, slackTriageDirectActionOptions{
			SnapshotMessages:       messages,
			IgnoreExistingBotReply: ignoreBotReply,
		})
		if len(policyToolCalls) > 0 {
			toolCalls = append(toolCalls, policyToolCalls...)
		}
		delegation := s.startPersonaDelegatedWorkerJobs(ctx, workspaceID, runID, result)
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
	go func() {
		callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
		defer cancel()
		result := callPersonaShadow(callCtx, s.personaRuntime, "triage", request)
		result, policyToolCalls := s.applyPersonaSecretaryDelegationPolicy(result)
		actions := slackPersonaForegroundActions(channelID, threadTS, result)
		toolCalls, failures, mutations := s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, channelID, threadTS, runID, actions, slackTriageDirectActionOptions{
			SnapshotMessages:       messages,
			IgnoreExistingBotReply: ignoreExistingBotReply,
		})
		if len(policyToolCalls) > 0 {
			toolCalls = append(toolCalls, policyToolCalls...)
		}
		delegation := s.startPersonaDelegatedWorkerJobs(ctx, workspaceID, runID, result)
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
	result.workerRecords = allowed
	result.WorkerRequests = personaWorkerRequestSummaries(allowed)
	if len(allowed) == 0 && strings.TrimSpace(result.VisibleText) == "" {
		result.Decision = persona.DecisionReply
		result.VisibleText = slackPersonaSecretaryRoutingText()
		result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "delegate_worker blocked by secretary routing policy"))
		if result.Confidence < 0.7 {
			result.Confidence = 0.7
		}
	}
	return result, toolCalls
}

func personaDelegatedWorkerAllowedBySecretaryPolicy(request persona.WorkerRequest) (bool, string) {
	scope := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringFromAny(request.Context["delegation_scope"]),
		stringFromAny(request.Context["scope"]),
		stringFromAny(request.Context["worker_scope"]),
	)))
	switch scope {
	case "oneesama_system", "oneesama_code", "secretary_lookup", "workspace_memory", "explicit_human_authorized_code":
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
		"repository", "repo", "codebase", "source code", "recent deployments",
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

func (s *Service) startPersonaDelegatedWorkerJobs(ctx context.Context, workspaceID string, runID int64, result SlackPersonaShadowResult) personaDelegatedWorkerStartResult {
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
	for index, request := range result.workerRecords {
		if index >= 3 {
			out.Errors = append(out.Errors, "delegate_worker_limit_exceeded")
			break
		}
		prompt := strings.TrimSpace(request.Prompt)
		if prompt == "" {
			prompt = "Handle the delegated Slack task from Pi foreground triage."
		}
		workerID := firstNonEmpty(strings.TrimSpace(request.ID), fmt.Sprintf("%s:worker:%d", result.RequestID, index+1))
		contextMap := mergeStringAnyMaps(request.Context, map[string]any{
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
		})
		job, err := s.runner.StartTask(ctx, agentrunner.WithSessionCapabilities(agentrunner.StartInput{
			Task:             prompt,
			Context:          contextMap,
			Mode:             "analysis",
			AllowCodeChanges: false,
		}, agentrunner.SessionKindSlack))
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
		"persona_foreground":              result,
		"persona_foreground_queued":       false,
		"persona_foreground_done_at":      nowRFC3339(),
		"pi_first_decision":               strings.TrimSpace(result.Decision),
		"persona_foreground_action_count": len(actions),
		"delegate_worker_jobs_started":    delegateWorkerJobsStarted,
		"delegate_worker_failures":        delegateWorkerFailures,
		"delegate_worker_scope_blocks":    delegateWorkerScopeBlocks,
		"persona_memory_write_files":      memoryWritePersistence.Files,
		"persona_memory_write_errors":     memoryWritePersistence.Errors,
		"persona_memory_write_redactions": memoryWritePersistence.Redactions,
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

type SlackTriagePersonaRequestOptions struct {
	IgnoreExistingBotReply bool
	WorkspaceTriagePolicy  string
	PiFirst                bool
	Digest                 string
	ExternalLinks          []SlackExternalLinkContext
	ThreadContexts         []SlackTriageThreadContext
	ChannelContexts        []SlackInboundMessage
	PreviousTriage         string
	CustomEmoji            []string
}

func BuildSlackTriagePersonaRequest(channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord) persona.Request {
	return BuildSlackTriagePersonaRequestWithOptions(channelID, threadTS, messages, decision, relatedMemory, SlackTriagePersonaRequestOptions{})
}

func BuildSlackTriagePersonaRequestWithOptions(channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord, options SlackTriagePersonaRequestOptions) persona.Request {
	messages = normalizeSlackInboundMessages(messages)
	text := strings.TrimSpace(joinSlackMessageTexts(messages))
	if text == "" {
		text = strings.TrimSpace(firstNonEmpty(options.Digest, decision.Summary))
	}
	citations := personaCitationsFromRelatedMemory(relatedMemory)
	contextItems := make([]persona.ContextItem, 0, 8)
	if options.PiFirst {
		if digest := strings.TrimSpace(options.Digest); digest != "" {
			contextItems = append(contextItems, persona.ContextItem{Kind: "triage_digest", Text: truncateSlackContextText(digest, 4000)})
		}
		if threadContext := formatSlackTriageThreadContexts(options.ThreadContexts); strings.TrimSpace(threadContext) != "" {
			contextItems = append(contextItems, persona.ContextItem{Kind: "slack_thread_context", Text: truncateSlackContextText(threadContext, 6000)})
		}
		if len(options.ChannelContexts) > 0 {
			contextItems = append(contextItems, persona.ContextItem{
				Kind: "slack_channel_context",
				Text: truncateSlackContextText(renderSlackTriageThreadTranscript(options.ChannelContexts), 4000),
			})
		}
		if external := formatSlackExternalLinkContexts(options.ExternalLinks); strings.TrimSpace(external) != "" {
			contextItems = append(contextItems, persona.ContextItem{Kind: "external_link_context", Text: truncateSlackContextText(external, 4000)})
		}
		if previous := strings.TrimSpace(options.PreviousTriage); previous != "" {
			contextItems = append(contextItems, persona.ContextItem{Kind: "previous_triage_context", Text: truncateSlackContextText(previous, 3000)})
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
	if workspacePolicy := strings.TrimSpace(options.WorkspaceTriagePolicy); workspacePolicy != "" {
		contextItems = append(contextItems, persona.ContextItem{
			Kind: "workspace_triage_policy",
			Text: workspacePolicy,
		})
	}
	if customEmoji := formatWorkspaceCustomEmojiPrompt(options.CustomEmoji); customEmoji != "" {
		contextItems = append(contextItems, persona.ContextItem{
			Kind: "workspace_custom_emoji",
			Text: customEmoji,
		})
	}
	contextItems = append(contextItems, persona.ContextItem{
		Kind: "delegation_scope_policy",
		Text: "Oneesama is a workspace secretary, not the default code investigator for every project. delegate_worker is allowed for bounded secretary work (workspace Memory lookup/synthesis, file/thread retrieval, Canvas/memo preparation), Oneesama's own runtime/code, or explicit human-authorized code work. For external staging/prod/deploy/infra/database/API latency/CI/performance/debug/code investigations, reply with routing/owner handoff or stay_silent instead of delegating.",
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
	return persona.Request{
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
		Context: contextItems,
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
