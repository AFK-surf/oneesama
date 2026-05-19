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
	memoryRecords  []persona.MemoryWrite
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

func (s *Service) queueSlackTriagePersonaForeground(ctx context.Context, workspaceID string, runID int64, channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord, ignoreExistingBotReply ...bool) bool {
	if !s.foregroundPersonaRuntimeEnabled() || runID == 0 {
		return false
	}
	ignoreBotReply := len(ignoreExistingBotReply) > 0 && ignoreExistingBotReply[0]
	request := BuildSlackTriagePersonaRequestWithOptions(channelID, threadTS, messages, decision, relatedMemory, SlackTriagePersonaRequestOptions{
		IgnoreExistingBotReply: ignoreBotReply,
	})
	request.Mode = persona.ModeLive
	go func() {
		callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
		defer cancel()
		result := callPersonaShadow(callCtx, s.personaRuntime, "triage", request)
		actions := slackPersonaForegroundActions(channelID, threadTS, result)
		toolCalls, failures, mutations := s.executeSlackTriageDirectActionsWithOptions(ctx, workspaceID, channelID, threadTS, runID, actions, slackTriageDirectActionOptions{
			SnapshotMessages:       messages,
			IgnoreExistingBotReply: ignoreBotReply,
		})
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
		"persona_memory_write_files":      memoryWritePersistence.Files,
		"persona_memory_write_errors":     memoryWritePersistence.Errors,
		"persona_memory_write_redactions": memoryWritePersistence.Redactions,
	})
	updated, err := s.triage.UpdateRun(ctx, patch)
	if err != nil {
		return err
	}
	if updated != nil {
		persistTriageContext(s.workspaceDir, *updated)
	}
	if personaEmptyFinal && updated != nil {
		s.maybeRecordTriageEmptyFinalFollowup(ctx, workspaceID, result.ChannelID, result.ThreadTS, updated, nil, map[string]any{
			"failure_source":     "persona_foreground",
			"persona_runtime":    strings.TrimSpace(result.Runtime),
			"persona_request_id": strings.TrimSpace(result.RequestID),
			"persona_decision":   strings.TrimSpace(result.Decision),
			"error":              truncateSlackContextText(result.Error, 400),
		})
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

func slackPersonaForegroundEmptyFinal(result SlackPersonaShadowResult) bool {
	if !result.Success || result.ShadowOnly {
		return false
	}
	visibleText := strings.TrimSpace(result.VisibleText)
	decision := strings.TrimSpace(result.Decision)
	if strings.EqualFold(decision, persona.DecisionReply) && visibleText == "" {
		return true
	}
	return decision == "" && visibleText == "" && len(result.WorkerRequests) == 0 && len(result.MemoryWrites) == 0
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

type SlackTriagePersonaRequestOptions struct {
	IgnoreExistingBotReply bool
}

func BuildSlackTriagePersonaRequest(channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord) persona.Request {
	return BuildSlackTriagePersonaRequestWithOptions(channelID, threadTS, messages, decision, relatedMemory, SlackTriagePersonaRequestOptions{})
}

func BuildSlackTriagePersonaRequestWithOptions(channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord, options SlackTriagePersonaRequestOptions) persona.Request {
	messages = normalizeSlackInboundMessages(messages)
	text := strings.TrimSpace(joinSlackMessageTexts(messages))
	if text == "" {
		text = strings.TrimSpace(decision.Summary)
	}
	citations := personaCitationsFromRelatedMemory(relatedMemory)
	contextItems := []persona.ContextItem{
		{Kind: "triage_summary", Text: strings.TrimSpace(decision.Summary)},
		{Kind: "triage_actions", Text: fmt.Sprintf("%d action(s)", len(decision.Actions))},
	}
	metadata := map[string]any{
		"decision_parse_ok": decision.ParseOK,
		"actions":           len(decision.Actions),
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
		Metadata: metadata,
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
	result.memoryRecords = append([]persona.MemoryWrite(nil), resp.MemoryWrites...)
	result.ShadowOnly = resp.ShadowOnly
	result.Reason = resp.Reason
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
