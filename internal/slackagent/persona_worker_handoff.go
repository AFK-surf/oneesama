package slackagent

import (
	"fmt"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
)

func personaDelegatedWorkerHandoff(worker persona.WorkerRequest, sessionKind string, workerID string, result SlackPersonaShadowResult, request persona.Request, messages []SlackInboundMessage) persona.WorkerHandoff {
	handoff := normalizePersonaWorkerHandoff(worker.Handoff)
	handoff.SourceAgent = firstNonEmpty(handoff.SourceAgent, "oneesama_pi_foreground")
	handoff.TargetAgent = firstNonEmpty(handoff.TargetAgent, personaDelegatedWorkerTargetAgent(worker, sessionKind))
	handoff.Reason = firstNonEmpty(handoff.Reason, strings.TrimSpace(result.Reason), strings.TrimSpace(stringFromAny(worker.Context["reason"])))
	handoff.UserRequest = firstNonEmpty(handoff.UserRequest, strings.TrimSpace(request.Event.Text), latestSlackInboundMessageText(messages))
	handoff.Task = firstNonEmpty(handoff.Task, strings.TrimSpace(worker.Prompt))
	handoff.ContextSummary = firstNonEmpty(handoff.ContextSummary, personaDelegatedWorkerContextSummary(result, request, messages))
	handoff.ExpectedOutput = firstNonEmpty(handoff.ExpectedOutput, personaDelegatedWorkerExpectedOutput(sessionKind))
	handoff.Boundaries = appendCompactUniqueStrings(handoff.Boundaries, personaDelegatedWorkerDefaultBoundaries(sessionKind, worker)...)
	handoff.SourceRefs = compactPersonaWorkerHandoffSourceRefs(append(handoff.SourceRefs, personaWorkerHandoffSourceRefs(request, result, messages)...))
	return handoff
}

func normalizePersonaWorkerHandoff(handoff *persona.WorkerHandoff) persona.WorkerHandoff {
	if handoff == nil {
		return persona.WorkerHandoff{}
	}
	return persona.WorkerHandoff{
		SourceAgent:    strings.TrimSpace(handoff.SourceAgent),
		TargetAgent:    strings.TrimSpace(handoff.TargetAgent),
		Reason:         strings.TrimSpace(handoff.Reason),
		UserRequest:    strings.TrimSpace(handoff.UserRequest),
		Task:           strings.TrimSpace(handoff.Task),
		ContextSummary: strings.TrimSpace(handoff.ContextSummary),
		ExpectedOutput: strings.TrimSpace(handoff.ExpectedOutput),
		Boundaries:     compactUniqueStrings(handoff.Boundaries),
		SourceRefs:     compactPersonaWorkerHandoffSourceRefs(handoff.SourceRefs),
	}
}

func personaDelegatedWorkerTargetAgent(worker persona.WorkerRequest, sessionKind string) string {
	switch sessionKind {
	case agentrunner.SessionKindSecretaryLookup:
		return "secretary_lookup_worker"
	case agentrunner.SessionKindDemoExecution:
		return "demo_execution_worker"
	}
	kind := strings.ToLower(strings.TrimSpace(worker.Kind))
	if kind == "" {
		return "codex_worker"
	}
	return strings.NewReplacer(" ", "_", "-", "_").Replace(kind) + "_worker"
}

func personaDelegatedWorkerContextSummary(result SlackPersonaShadowResult, request persona.Request, messages []SlackInboundMessage) string {
	parts := []string{}
	channelID := firstNonEmpty(strings.TrimSpace(result.ChannelID), strings.TrimSpace(request.Anchor.ChannelID))
	threadTS := firstNonEmpty(strings.TrimSpace(result.ThreadTS), strings.TrimSpace(request.Anchor.ThreadTS), strings.TrimSpace(request.Anchor.MessageTS))
	if channelID != "" || threadTS != "" {
		parts = append(parts, fmt.Sprintf("Slack thread channel=%s thread_ts=%s", firstNonEmpty(channelID, "-"), firstNonEmpty(threadTS, "-")))
	}
	if latest := latestSlackInboundMessageText(messages); latest != "" {
		parts = append(parts, "latest_message="+latest)
	}
	if strings.TrimSpace(request.Event.Text) != "" && latestSlackInboundMessageText(messages) != strings.TrimSpace(request.Event.Text) {
		parts = append(parts, "event="+strings.TrimSpace(request.Event.Text))
	}
	return strings.Join(parts, "; ")
}

func personaDelegatedWorkerExpectedOutput(sessionKind string) string {
	switch sessionKind {
	case agentrunner.SessionKindSecretaryLookup:
		return `Return only JSON with visible_text, evidence_anchors, and reason. Use empty visible_text/evidence_anchors when evidence is insufficient.`
	default:
		return "Complete the delegated subtask and return a concise result with concrete evidence for Oneesama to decide delivery."
	}
}

func personaDelegatedWorkerDefaultBoundaries(sessionKind string, worker persona.WorkerRequest) []string {
	boundaries := []string{
		"Return results to Oneesama; do not send Slack, Meet, or other user-visible messages directly.",
		"Do not answer as Codex, local CLI, or a historical bot identity; this is a subagent handoff from Oneesama.",
	}
	if sessionKind == agentrunner.SessionKindSecretaryLookup {
		boundaries = append(boundaries,
			"Read-only secretary lookup only; do not edit repositories, schedule follow-ups, or create external side effects.",
			"Only produce Slack-visible text when concrete evidence anchors support it.",
		)
	}
	if !personaDelegatedWorkerExplicitlyAuthorized(worker.Prompt + " " + personaWorkerRequestContextText(worker.Context)) {
		boundaries = append(boundaries, "No code or repository changes unless the handoff explicitly authorizes code work.")
	}
	return boundaries
}

func personaWorkerHandoffSourceRefs(request persona.Request, result SlackPersonaShadowResult, messages []SlackInboundMessage) []persona.HandoffSourceRef {
	refs := []persona.HandoffSourceRef{}
	channelID := firstNonEmpty(strings.TrimSpace(result.ChannelID), strings.TrimSpace(request.Anchor.ChannelID))
	threadTS := firstNonEmpty(strings.TrimSpace(result.ThreadTS), strings.TrimSpace(request.Anchor.ThreadTS), strings.TrimSpace(request.Anchor.MessageTS))
	if channelID != "" || threadTS != "" {
		refs = append(refs, persona.HandoffSourceRef{
			Kind:      "slack_thread",
			SourceRef: strings.Trim(channelID+"/"+threadTS, "/"),
			Summary:   "Original Slack thread for the delegated task.",
		})
	}
	if url := strings.TrimSpace(request.Anchor.URL); url != "" {
		refs = append(refs, persona.HandoffSourceRef{Kind: "url", SourceRef: url, Summary: "Anchored URL from the foreground request."})
	}
	for _, item := range request.Context {
		if strings.TrimSpace(item.SourceRef) == "" && strings.TrimSpace(item.Text) == "" {
			continue
		}
		refs = append(refs, persona.HandoffSourceRef{
			Kind:      strings.TrimSpace(item.Kind),
			SourceRef: firstNonEmpty(strings.TrimSpace(item.SourceRef), strings.TrimSpace(item.Kind)),
			Summary:   truncateHandoffSummary(item.Text),
		})
	}
	for _, item := range request.Memory.Items {
		if strings.TrimSpace(item.SourceRef) == "" && strings.TrimSpace(item.Text) == "" {
			continue
		}
		refs = append(refs, persona.HandoffSourceRef{
			Kind:      firstNonEmpty(strings.TrimSpace(item.Kind), "memory"),
			SourceRef: firstNonEmpty(strings.TrimSpace(item.SourceRef), strings.TrimSpace(item.Kind)),
			Summary:   truncateHandoffSummary(item.Text),
		})
		if len(refs) >= 10 {
			break
		}
	}
	if len(refs) == 0 && len(messages) > 0 {
		refs = append(refs, persona.HandoffSourceRef{
			Kind:      "slack_thread",
			SourceRef: strings.Trim(channelID+"/"+threadTS, "/"),
			Summary:   fmt.Sprintf("%d Slack thread messages were forwarded in context.", len(messages)),
		})
	}
	return refs
}

func compactPersonaWorkerHandoffSourceRefs(refs []persona.HandoffSourceRef) []persona.HandoffSourceRef {
	out := make([]persona.HandoffSourceRef, 0, len(refs))
	seen := map[string]bool{}
	for _, ref := range refs {
		ref.Kind = strings.TrimSpace(ref.Kind)
		ref.SourceRef = strings.TrimSpace(ref.SourceRef)
		ref.Summary = truncateHandoffSummary(ref.Summary)
		if ref.Kind == "" && ref.SourceRef == "" && ref.Summary == "" {
			continue
		}
		key := strings.ToLower(ref.Kind + "\x00" + ref.SourceRef + "\x00" + ref.Summary)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, ref)
		if len(out) >= 10 {
			break
		}
	}
	return out
}

func appendCompactUniqueStrings(values []string, additions ...string) []string {
	values = append(values, additions...)
	return compactUniqueStrings(values)
}

func truncateHandoffSummary(text string) string {
	text = strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
	if len(text) <= 240 {
		return text
	}
	return strings.TrimSpace(text[:240]) + "..."
}
