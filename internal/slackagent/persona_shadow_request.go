package slackagent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persona"
)

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
	if len(options.ExternalLinks) > 0 {
		metadata["external_links"] = options.ExternalLinks
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
	result.EvidenceAnchors = slackVisibleEvidenceAnchorsFromPersona(resp.EvidenceAnchors)
	return result
}
