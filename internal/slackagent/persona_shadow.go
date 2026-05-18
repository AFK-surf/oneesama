package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persona"
)

type SlackPersonaShadowResult struct {
	RequestID      string   `json:"request_id"`
	Source         string   `json:"source"`
	ChannelID      string   `json:"channel_id,omitempty"`
	ThreadTS       string   `json:"thread_ts,omitempty"`
	Classification string   `json:"classification,omitempty"`
	Runtime        string   `json:"runtime,omitempty"`
	Decision       string   `json:"decision,omitempty"`
	VisibleText    string   `json:"visible_text,omitempty"`
	Confidence     float64  `json:"confidence,omitempty"`
	WorkerRequests []string `json:"worker_requests,omitempty"`
	MemoryWrites   []string `json:"memory_writes,omitempty"`
	ShadowOnly     bool     `json:"shadow_only"`
	Success        bool     `json:"success"`
	Error          string   `json:"error,omitempty"`
	Reason         string   `json:"reason,omitempty"`
	LatencyMS      int64    `json:"latency_ms,omitempty"`
	Citations      []string `json:"citations,omitempty"`
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
	request := BuildSlackTriagePersonaRequest(channelID, threadTS, messages, decision, relatedMemory)
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

func (s *Service) queueSlackTriagePersonaForeground(ctx context.Context, workspaceID string, runID int64, channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord) bool {
	if !s.foregroundPersonaRuntimeEnabled() || runID == 0 {
		return false
	}
	request := BuildSlackTriagePersonaRequest(channelID, threadTS, messages, decision, relatedMemory)
	request.Mode = persona.ModeLive
	go func() {
		callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
		defer cancel()
		result := callPersonaShadow(callCtx, s.personaRuntime, "triage", request)
		actions := slackPersonaForegroundActions(channelID, threadTS, result)
		toolCalls, failures, mutations := s.executeSlackTriageDirectActions(ctx, workspaceID, channelID, threadTS, runID, actions, messages)
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
	patch := *current
	patch.Actions = triageActionRows(actions)
	patch.ToolCalls = replacePersonaRuntimeToolCall(append(current.ToolCalls, actionToolCalls...), "foreground_triage", slackPersonaForegroundToolCall(result))
	patch.Steps = current.Steps + 1
	patch.Mutations = maxInt(current.Mutations, mutations)
	patch.Failures = maxInt(current.Failures, failures)
	if !result.Success {
		patch.Status = "failed"
		patch.Error = firstNonEmpty(result.Error, "persona_runtime_failed")
		patch.Failures = maxInt(patch.Failures, 1)
	} else if failures > 0 {
		patch.Status = "failed"
		patch.Error = firstNonEmpty(result.Error, "persona_foreground_post_failed")
	}
	patch.Metadata = mergeStringAnyMaps(current.Metadata, map[string]any{
		"persona_foreground":              result,
		"persona_foreground_queued":       false,
		"persona_foreground_done_at":      nowRFC3339(),
		"persona_foreground_action_count": len(actions),
	})
	updated, err := s.triage.UpdateRun(ctx, patch)
	if err != nil {
		return err
	}
	if updated != nil {
		persistTriageContext(s.workspaceDir, *updated)
	}
	if result.ChannelID != "" && result.ThreadTS != "" {
		summary := firstNonEmpty(result.VisibleText, result.Reason, patch.Summary)
		outcome := slackTriageLedgerOutcome(result.Success, mutations, failures)
		if err := s.cognition.RecordTriageSummary(ctx, workspaceID, result.ChannelID, result.ThreadTS, patch.SessionID, summary, outcome); err != nil {
			s.logger.Warn("slack thread ledger persona foreground summary record failed", "error", err)
		}
		if result.Success && summary != "" {
			if _, err := s.cognition.UpsertChannelBrainSummary(ctx, workspaceID, result.ChannelID, summary); err != nil {
				s.logger.Warn("slack channel brain persona foreground summary update failed", "error", err)
			}
		}
	}
	return nil
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

func slackPersonaForegroundActions(channelID string, threadTS string, result SlackPersonaShadowResult) []SlackTriageDecisionAction {
	if !result.Success || result.ShadowOnly || result.Decision != persona.DecisionReply || strings.TrimSpace(result.VisibleText) == "" {
		return nil
	}
	return []SlackTriageDecisionAction{{
		Type:       "post_thread_reply",
		Title:      "Persona reply",
		Message:    strings.TrimSpace(result.VisibleText),
		ChannelID:  strings.TrimSpace(channelID),
		ThreadTS:   strings.TrimSpace(threadTS),
		Reason:     strings.TrimSpace(result.Reason),
		Confidence: result.Confidence,
	}}
}

func BuildSlackTriagePersonaRequest(channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord) persona.Request {
	messages = normalizeSlackInboundMessages(messages)
	text := strings.TrimSpace(joinSlackMessageTexts(messages))
	if text == "" {
		text = strings.TrimSpace(decision.Summary)
	}
	citations := personaCitationsFromRelatedMemory(relatedMemory)
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
		Context: []persona.ContextItem{
			{Kind: "triage_summary", Text: strings.TrimSpace(decision.Summary)},
			{Kind: "triage_actions", Text: fmt.Sprintf("%d action(s)", len(decision.Actions))},
		},
		Evidence: persona.EvidenceBundle{
			Summary:   strings.TrimSpace(decision.Summary),
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
			MaxVisibleChars:    600,
			AllowedWorkers:     []string{"codex", "claude", "agent_read"},
		},
		Metadata: map[string]any{
			"decision_parse_ok": decision.ParseOK,
			"actions":           len(decision.Actions),
		},
	}
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
	result.VisibleText = resp.VisibleText
	result.Confidence = resp.Confidence
	result.WorkerRequests = personaWorkerRequestSummaries(resp.WorkerRequests)
	result.MemoryWrites = personaMemoryWriteSummaries(resp.MemoryWrites)
	result.ShadowOnly = resp.ShadowOnly
	result.Reason = resp.Reason
	result.Citations = personaCitationRefs(resp.Citations)
	return result
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

func personaCitationsFromRelatedMemory(records []SlackRelatedMemoryRecord) []persona.Citation {
	out := make([]persona.Citation, 0, len(records))
	for _, record := range records {
		out = append(out, persona.Citation{
			Kind:      record.Kind,
			Source:    record.Source,
			SourceRef: firstNonEmpty(record.SourceRef, record.SourcePath),
			LineStart: record.StartLine,
			LineEnd:   record.EndLine,
			Snippet:   truncateSlackContextText(record.Content, 240),
		})
	}
	return out
}

func personaMemoryRecordsFromRelatedMemory(records []SlackRelatedMemoryRecord) []persona.MemoryRecord {
	out := make([]persona.MemoryRecord, 0, len(records))
	for _, record := range records {
		out = append(out, persona.MemoryRecord{
			Kind:      record.Kind,
			Text:      record.Content,
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
