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

func (s *Service) shadowSlackTriagePersona(ctx context.Context, channelID string, threadTS string, messages []SlackInboundMessage, decision SlackTriageDecision, relatedMemory []SlackRelatedMemoryRecord) *SlackPersonaShadowResult {
	if !s.shadowPersonaRuntimeEnabled() {
		return nil
	}
	request := BuildSlackTriagePersonaRequest(channelID, threadTS, messages, decision, relatedMemory)
	result := callPersonaShadow(ctx, s.personaRuntime, "triage", request)
	return &result
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
	result.ShadowOnly = resp.ShadowOnly
	result.Reason = resp.Reason
	result.Citations = personaCitationRefs(resp.Citations)
	return result
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
