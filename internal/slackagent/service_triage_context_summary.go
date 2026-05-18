package slackagent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persona"
)

const (
	slackTriageLongContextCharThreshold = 12000
	slackTriageContextSummaryMaxChars   = 4200
)

func (s *Service) maybeSummarizeOversizedSlackTriageThreadContexts(ctx context.Context, channelID string, threadTS string, messages []SlackInboundMessage, digest string, contexts []SlackTriageThreadContext) ([]SlackTriageThreadContext, map[string]any) {
	rawContext := strings.TrimSpace(formatSlackTriageThreadContexts(contexts))
	if rawContext == "" {
		return contexts, nil
	}
	rawChars := len([]rune(strings.TrimSpace(digest + "\n" + rawContext)))
	if rawChars <= slackTriageLongContextCharThreshold {
		return contexts, nil
	}
	metadata := map[string]any{
		"triage_context_summary_attempted":           true,
		"triage_context_summary_applied":             false,
		"triage_context_summary_raw_chars":           rawChars,
		"triage_context_summary_threshold_chars":     slackTriageLongContextCharThreshold,
		"triage_context_summary_original_contexts":   len(contexts),
		"triage_context_summary_original_messages":   countSlackTriageThreadContextMessages(contexts),
		"triage_context_summary_request_kind":        "slack_context_summary",
		"triage_context_summary_target_output_chars": slackTriageContextSummaryMaxChars,
	}
	if !s.shadowPersonaRuntimeEnabled() {
		metadata["triage_context_summary_error"] = "persona_runtime_unavailable"
		return contexts, metadata
	}
	request := BuildSlackTriageContextSummaryPersonaRequest(channelID, threadTS, messages, digest, contexts, rawContext, rawChars)
	callCtx, cancel := context.WithTimeout(ctx, s.personaRuntimeShadowTimeout())
	defer cancel()
	start := time.Now()
	response, err := s.personaRuntime.Decide(callCtx, request)
	metadata["triage_context_summary_latency_ms"] = time.Since(start).Milliseconds()
	if err != nil {
		metadata["triage_context_summary_error"] = truncateSlackContextText(err.Error(), 400)
		return contexts, metadata
	}
	summary := strings.TrimSpace(firstNonEmpty(response.VisibleText, response.Reason))
	if summary == "" {
		metadata["triage_context_summary_error"] = "persona_runtime_empty_summary"
		metadata["triage_context_summary_decision"] = strings.TrimSpace(response.Decision)
		return contexts, metadata
	}
	summary = truncateSlackContextText(summary, slackTriageContextSummaryMaxChars)
	metadata["triage_context_summary_applied"] = true
	metadata["triage_context_summary_chars"] = len([]rune(summary))
	metadata["triage_context_summary_runtime"] = firstNonEmpty(response.Runtime, persona.ProviderPi)
	metadata["triage_context_summary_decision"] = strings.TrimSpace(response.Decision)
	metadata["triage_context_summary_citations"] = personaCitationRefs(response.Citations)
	channel, thread := firstSlackTriageThreadContextAnchor(channelID, threadTS, contexts)
	return []SlackTriageThreadContext{{
		ChannelID:    channel,
		ThreadTS:     thread,
		FetchOK:      true,
		MessageCount: countSlackTriageThreadContextMessages(contexts),
		Transcript:   formatSlackTriageContextSummaryTranscript(summary, rawChars, contexts),
	}}, metadata
}

func BuildSlackTriageContextSummaryPersonaRequest(channelID string, threadTS string, messages []SlackInboundMessage, digest string, contexts []SlackTriageThreadContext, rawContext string, rawChars int) persona.Request {
	channel, thread := firstSlackTriageThreadContextAnchor(channelID, threadTS, contexts)
	text := strings.TrimSpace(rawContext)
	language := "en"
	if containsCJK(text) || containsCJK(digest) {
		language = "zh"
	}
	return persona.Request{
		ID:   fmt.Sprintf("triage-context-summary:%s:%s", strings.TrimSpace(channel), strings.TrimSpace(thread)),
		Mode: persona.ModeShadow,
		Event: persona.Event{
			Kind:     "slack_context_summary",
			Text:     text,
			Language: language,
		},
		Anchor: persona.Anchor{
			Surface:   "slack",
			ChannelID: strings.TrimSpace(channel),
			ThreadTS:  strings.TrimSpace(thread),
		},
		Context: []persona.ContextItem{
			{Kind: "triage_digest", Text: strings.TrimSpace(digest)},
			{Kind: "summary_goal", Text: "Summarize this oversized fetched Slack thread context for a downstream triage runner. Preserve decisions, open questions, blockers, links, owners, and unresolved asks. Do not write a user-facing reply."},
			{Kind: "thread_context_count", Text: fmt.Sprintf("%d fetched thread context(s)", len(contexts))},
			{Kind: "thread_message_count", Text: fmt.Sprintf("%d fetched message(s)", countSlackTriageThreadContextMessages(contexts))},
		},
		Safety: persona.SafetyConstraints{
			AllowVisibleReply:  true,
			AllowSpeech:        false,
			AllowWorkerRequest: false,
			MaxVisibleChars:    slackTriageContextSummaryMaxChars,
		},
		Metadata: map[string]any{
			"purpose":             "internal_context_summary",
			"raw_context_chars":   rawChars,
			"target_output_chars": slackTriageContextSummaryMaxChars,
			"message_count":       len(messages),
		},
	}
}

func formatSlackTriageContextSummaryTranscript(summary string, rawChars int, contexts []SlackTriageThreadContext) string {
	var lines []string
	lines = append(lines, "[persona summary of oversized fetched Slack thread context]")
	lines = append(lines, fmt.Sprintf("raw_context_chars=%d; original_thread_contexts=%d; original_thread_messages=%d", rawChars, len(contexts), countSlackTriageThreadContextMessages(contexts)))
	lines = append(lines, strings.TrimSpace(summary))
	return strings.Join(lines, "\n")
}

func countSlackTriageThreadContextMessages(contexts []SlackTriageThreadContext) int {
	var count int
	for _, context := range contexts {
		count += context.MessageCount
	}
	return count
}

func firstSlackTriageThreadContextAnchor(channelID string, threadTS string, contexts []SlackTriageThreadContext) (string, string) {
	for _, context := range contexts {
		channel := strings.TrimSpace(firstNonEmpty(context.ChannelID, channelID))
		thread := strings.TrimSpace(firstNonEmpty(context.ThreadTS, threadTS))
		if channel != "" || thread != "" {
			return channel, thread
		}
	}
	return strings.TrimSpace(channelID), strings.TrimSpace(threadTS)
}
