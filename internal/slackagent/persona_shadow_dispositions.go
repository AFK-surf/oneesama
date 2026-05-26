package slackagent

import (
	"strings"

	"github.com/AFK-surf/oneesama/internal/persona"
)

func applyPersonaSecretaryLookupDisposition(result SlackPersonaShadowResult, request persona.Request) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionStaySilent || len(result.workerRecords) > 0 {
		return result, nil
	}
	if personaRequestIsWorkerReturn(request) {
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

func applyPersonaMediaLookupDisposition(result SlackPersonaShadowResult, request persona.Request, messages []SlackInboundMessage) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionStaySilent || len(result.workerRecords) > 0 {
		return result, nil
	}
	if personaRequestIsWorkerReturn(request) || !slackPersonaRequestNeedsMediaLookup(request, messages) {
		return result, nil
	}
	context := map[string]any{
		"delegation_scope":          "secretary_lookup",
		"secretary_lookup_type":     "media_identification_lookup",
		"triage_digest":             personaRequestContextText(request.Context, "triage_digest"),
		"slack_thread_context":      personaRequestContextText(request.Context, "slack_thread_context"),
		"workspace_memory_evidence": personaRequestMemoryEvidence(request, 5),
	}
	for key, value := range personaDelegatedWorkerSlackContext(request.Anchor.ChannelID, request.Anchor.ThreadTS, messages) {
		context[key] = value
	}
	worker := persona.WorkerRequest{
		ID:      "secretary-media-lookup",
		Kind:    "codex",
		Prompt:  buildMediaLookupWorkerPrompt(request),
		Context: context,
	}
	result.Decision = persona.DecisionDelegateWorker
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "media identification question requires bounded secretary lookup before silence"))
	result.workerRecords = []persona.WorkerRequest{worker}
	result.WorkerRequests = personaWorkerRequestSummaries(result.workerRecords)
	if result.Confidence < 0.55 {
		result.Confidence = 0.55
	}
	return result, []SlackTriageToolCall{{
		Tool:    "persona_runtime",
		Action:  "secretary_media_lookup_auto_delegate",
		Args:    marshalTriageArgs("persona", worker.ID, true),
		Success: true,
		Brief:   "Stay-silent media identification question auto-delegated to secretary lookup",
		Result:  "file/image context",
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

func applyPersonaExplicitSmokeCommandDisposition(result SlackPersonaShadowResult, request persona.Request, messages []SlackInboundMessage) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || personaRequestIsWorkerReturn(request) || strings.TrimSpace(result.Decision) != persona.DecisionStaySilent || len(result.workerRecords) > 0 {
		return result, nil
	}
	command := explicitOneesamaSmokeCommandText(request, messages)
	if command == "" {
		return result, nil
	}
	channelID := firstNonEmpty(strings.TrimSpace(request.Anchor.ChannelID), firstMessageChannelID(messages))
	threadTS := firstNonEmpty(strings.TrimSpace(request.Anchor.ThreadTS), lastMessageThreadTS(messages))
	result.Decision = persona.DecisionReply
	result.VisibleText = "看到了。"
	result.Confidence = maxFloat64(result.Confidence, 0.9)
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "explicit oneesama smoke command requires a short visible acknowledgement"))
	result.EvidenceAnchors = normalizeSlackVisibleEvidenceAnchors([]SlackVisibleEvidenceAnchor{{
		Kind:      slackVisibleEvidenceKindExplicitUserCommand,
		SourceRef: "slack:" + channelID + ":" + threadTS,
		Quote:     command,
	}})
	return result, []SlackTriageToolCall{{
		Tool:    "persona_runtime",
		Action:  "explicit_smoke_command_visible_reply",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Explicit Oneesama smoke command converted to short visible reply",
		Result:  "explicit_user_command",
	}}
}

func explicitOneesamaSmokeCommandText(request persona.Request, messages []SlackInboundMessage) string {
	text := strings.TrimSpace(joinSlackMessageTexts(messages))
	if text == "" {
		text = strings.TrimSpace(request.Event.Text)
	}
	lower := strings.ToLower(text)
	if !strings.Contains(lower, "smoke") {
		return ""
	}
	if !strings.Contains(lower, "@oneesama") && !strings.Contains(lower, "@onee-sama") && !strings.Contains(lower, "oneesama") && !strings.Contains(lower, "onee-sama") {
		return ""
	}
	for _, marker := range []string{"确认你看到了", "看到了", "一句话", "不要展开", "confirm", "ack", "acknowledge"} {
		if strings.Contains(lower, strings.ToLower(marker)) {
			return text
		}
	}
	return ""
}

func applyPersonaProductLinkSynthesisDisposition(result SlackPersonaShadowResult, request persona.Request, messages []SlackInboundMessage) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || personaRequestIsWorkerReturn(request) {
		return result, nil
	}
	decision := strings.TrimSpace(result.Decision)
	if decision != persona.DecisionDelegateWorker && decision != persona.DecisionReact && decision != persona.DecisionStaySilent {
		return result, nil
	}
	if !slackPersonaRequestNeedsProductLinkCommentary(request) || slackPersonaRequestNeedsSecretaryLookup(request) {
		return result, nil
	}
	if marker := personaCompletedDelegationMarker(result); marker != "" {
		return result, nil
	}
	contexts := personaRequestExternalLinkContexts(request)
	action, ok := slackTriageSharedLinkSynthesisAction(
		firstNonEmpty(strings.TrimSpace(request.Anchor.ChannelID), firstMessageChannelID(messages)),
		firstNonEmpty(strings.TrimSpace(request.Anchor.ThreadTS), lastMessageThreadTS(messages)),
		messages,
		contexts,
		personaDynamicContextTextFromRequest(request, "workspace_triage_policy"),
	)
	if !ok {
		return result, nil
	}
	result = applySlackPersonaVisibleReplyAction(result, action)
	return result, []SlackTriageToolCall{{
		Tool:    "persona_runtime",
		Action:  "product_link_synthesized_visible_reply",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Product-adjacent link converted to source-backed visible reply",
		Result:  "fetched_link_context",
	}}
}

func applySlackPersonaVisibleReplyAction(result SlackPersonaShadowResult, action SlackTriageDecisionAction) SlackPersonaShadowResult {
	result.Decision = persona.DecisionReply
	result.VisibleText = strings.TrimSpace(action.Message)
	result.EvidenceAnchors = normalizeSlackVisibleEvidenceAnchors(action.EvidenceAnchors)
	result.workerRecords = nil
	result.WorkerRequests = nil
	result.reactionRecords = nil
	result.Reactions = nil
	result.Reason = strings.TrimSpace(firstNonEmpty(action.Reason, result.Reason, "source-backed product link synthesis"))
	if result.Confidence < action.Confidence {
		result.Confidence = action.Confidence
	}
	return result
}

func applyPersonaPositiveStatusSummaryReactionDisposition(result SlackPersonaShadowResult, request persona.Request, messages []SlackInboundMessage) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || personaRequestIsWorkerReturn(request) || strings.TrimSpace(result.Decision) != persona.DecisionStaySilent || len(result.workerRecords) > 0 {
		return result, nil
	}
	if personaCompletedDelegationMarker(result) != "" {
		return result, nil
	}
	if !slackMessagesLookLikePositiveStatusSummary(messages) {
		return result, nil
	}
	channelID := firstNonEmpty(strings.TrimSpace(request.Anchor.ChannelID), firstMessageChannelID(messages))
	threadTS := firstNonEmpty(strings.TrimSpace(request.Anchor.ThreadTS), lastMessageThreadTS(messages))
	messageTS := lastMessageTS(messages)
	result.Decision = persona.DecisionReact
	result.Reactions = []string{"tada"}
	result.reactionRecords = []persona.ReactionIntent{{
		Emoji:      "tada",
		ChannelID:  channelID,
		MessageTS:  messageTS,
		Reason:     "light congratulations for a shipped-status summary",
		Confidence: 0.82,
	}}
	result.Confidence = maxFloat64(result.Confidence, 0.82)
	result.Reason = strings.TrimSpace(firstNonEmpty(result.Reason, "positive shipped-status summary merits a lightweight congratulations reaction"))
	return result, []SlackTriageToolCall{{
		Tool:    "persona_runtime",
		Action:  "positive_status_summary_reaction",
		Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
		Success: true,
		Brief:   "Positive status summary converted to lightweight reaction",
		Result:  "status_summary:" + channelID + ":" + threadTS,
	}}
}

func slackMessagesLookLikePositiveStatusSummary(messages []SlackInboundMessage) bool {
	text := strings.TrimSpace(joinSlackMessageTexts(messages))
	if text == "" {
		return false
	}
	lower := strings.ToLower(text)
	hasSummaryMarker := slackVisibleTextContainsAny(lower, []string{
		"过去 24 小时概况",
		"过去24小时概况",
		"24 小时概况",
		"24小时概况",
		"daily wrap",
		"daily summary",
		"status summary",
		"ship summary",
		"shipping summary",
		"团队日报",
		"今日日记",
		"录了一个",
		"录了个",
		"演示",
		"demo",
	})
	if !hasSummaryMarker {
		return false
	}
	return slackVisibleTextContainsAny(lower, []string{
		"合并",
		"修复",
		"已修",
		"已同步",
		"已发布",
		"上线",
		"发布",
		"merged",
		"fixed",
		"shipped",
		"released",
		"green",
		"computer use",
		"iphone mirroring",
		"shortcut",
		"创建",
	})
}

func lastMessageTS(messages []SlackInboundMessage) string {
	if len(messages) == 0 {
		return ""
	}
	last := messages[len(messages)-1]
	return firstNonEmpty(strings.TrimSpace(last.TS), strings.TrimSpace(last.EventTS), strings.TrimSpace(last.ThreadTS))
}

func applyPersonaProductLinkReactionDisposition(result SlackPersonaShadowResult, request persona.Request) (SlackPersonaShadowResult, []SlackTriageToolCall) {
	if !result.Success || result.ShadowOnly || strings.TrimSpace(result.Decision) != persona.DecisionReact || len(result.reactionRecords) == 0 {
		return result, nil
	}
	if personaRequestIsWorkerReturn(request) {
		return result, nil
	}
	if !slackPersonaRequestNeedsProductLinkCommentary(request) {
		return result, nil
	}
	if marker := personaCompletedDelegationMarker(result); marker != "" {
		return result, []SlackTriageToolCall{{
			Tool:    "persona_runtime",
			Action:  "product_link_reaction_preserved_already_handled",
			Args:    marshalTriageArgs("persona", strings.TrimSpace(result.RequestID), true),
			Success: true,
			Brief:   "Product-link reaction was not upgraded because the thread is already handled",
			Result:  marker,
		}}
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

func personaRequestExternalLinkContexts(request persona.Request) []SlackExternalLinkContext {
	if contexts := slackExternalLinksFromContext(request.Metadata["external_links"]); len(contexts) > 0 {
		return contexts
	}
	return parseFormattedSlackExternalLinkContexts(personaRequestContextText(request.Context, "external_link_context"))
}

func parseFormattedSlackExternalLinkContexts(text string) []SlackExternalLinkContext {
	lines := strings.Split(text, "\n")
	out := make([]SlackExternalLinkContext, 0)
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if index := strings.Index(trimmed, ". "); index > 0 {
			candidate := strings.TrimSpace(trimmed[index+2:])
			if strings.HasPrefix(candidate, "http://") || strings.HasPrefix(candidate, "https://") {
				out = append(out, SlackExternalLinkContext{URL: candidate})
				continue
			}
		}
		if len(out) == 0 {
			continue
		}
		current := &out[len(out)-1]
		switch {
		case strings.HasPrefix(trimmed, "title:"):
			current.Title = strings.TrimSpace(strings.TrimPrefix(trimmed, "title:"))
		case strings.HasPrefix(trimmed, "excerpt:"):
			current.Excerpt = strings.TrimSpace(strings.TrimPrefix(trimmed, "excerpt:"))
		case strings.HasPrefix(trimmed, "fetch_error:"):
			current.Error = strings.TrimSpace(strings.TrimPrefix(trimmed, "fetch_error:"))
		}
	}
	return out
}

func personaRequestIsWorkerReturn(request persona.Request) bool {
	return strings.EqualFold(strings.TrimSpace(request.Event.Kind), "slack_worker_result_return") ||
		boolFromAny(request.Metadata["worker_return_second_pass"], false)
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

func slackPersonaRequestNeedsMediaLookup(request persona.Request, messages []SlackInboundMessage) bool {
	if !slackMessagesHaveReadableMedia(messages) {
		return false
	}
	text := strings.Join([]string{
		request.Event.Text,
		personaRequestContextText(request.Context, "triage_digest"),
		personaRequestContextText(request.Context, "slack_thread_context"),
	}, "\n")
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
