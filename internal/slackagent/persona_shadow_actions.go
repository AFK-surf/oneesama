package slackagent

import (
	"strings"

	"github.com/AFK-surf/oneesama/internal/persona"
)

func slackPersonaForegroundActions(channelID string, threadTS string, result SlackPersonaShadowResult, request persona.Request) []SlackTriageDecisionAction {
	if !result.Success || result.ShadowOnly {
		return nil
	}
	actions := make([]SlackTriageDecisionAction, 0, 1+len(result.reactionRecords))
	if result.Decision == persona.DecisionReply && strings.TrimSpace(result.VisibleText) != "" {
		actions = append(actions, SlackTriageDecisionAction{
			Type:            "post_thread_reply",
			Title:           "Review reply",
			Message:         strings.TrimSpace(result.VisibleText),
			ChannelID:       strings.TrimSpace(channelID),
			ThreadTS:        strings.TrimSpace(threadTS),
			Reason:          strings.TrimSpace(result.Reason),
			Confidence:      result.Confidence,
			EvidenceAnchors: slackPersonaVisibleReplyEvidenceAnchors(channelID, threadTS, result, request),
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

func slackPersonaVisibleReplyEvidenceAnchors(channelID string, threadTS string, result SlackPersonaShadowResult, request persona.Request) []SlackVisibleEvidenceAnchor {
	anchors := make([]SlackVisibleEvidenceAnchor, 0, 4)
	anchors = append(anchors, result.EvidenceAnchors...)
	for _, citation := range request.Evidence.Citations {
		anchors = append(anchors, slackVisibleEvidenceAnchorFromPersonaCitation(citation))
	}
	for _, sourceRef := range result.Citations {
		anchors = append(anchors, slackVisibleEvidenceAnchorFromSourceRef(sourceRef, result.VisibleText))
	}
	for _, item := range request.Memory.Items {
		anchors = append(anchors, slackVisibleEvidenceAnchorFromPersonaMemoryRecord(item))
	}
	if strings.TrimSpace(request.Anchor.URL) != "" {
		anchors = append(anchors, SlackVisibleEvidenceAnchor{
			Kind:      slackVisibleEvidenceKindFetchedLink,
			SourceRef: strings.TrimSpace(request.Anchor.URL),
			Quote:     result.VisibleText,
		})
	}
	for _, item := range request.Context {
		if strings.TrimSpace(item.Kind) != "external_link_context" {
			continue
		}
		sourceRef := firstSlackVisibleURL(item.Text)
		if sourceRef == "" {
			sourceRef = "external_link_context"
		}
		anchors = append(anchors, SlackVisibleEvidenceAnchor{
			Kind:      slackVisibleEvidenceKindFetchedLink,
			SourceRef: sourceRef,
			Quote:     item.Text,
		})
	}
	anchors = append(anchors, slackVisibleThreadEvidenceAnchors(channelID, threadTS, result.VisibleText)...)
	return normalizeSlackVisibleEvidenceAnchors(anchors)
}

func slackVisibleEvidenceAnchorsFromPersona(anchors []persona.EvidenceAnchor) []SlackVisibleEvidenceAnchor {
	out := make([]SlackVisibleEvidenceAnchor, 0, len(anchors))
	for _, anchor := range anchors {
		out = append(out, SlackVisibleEvidenceAnchor{
			Kind:      anchor.Kind,
			SourceRef: anchor.SourceRef,
			Quote:     anchor.Quote,
			Freshness: anchor.Freshness,
		})
	}
	return normalizeSlackVisibleEvidenceAnchors(out)
}

func slackVisibleEvidenceAnchorFromPersonaCitation(citation persona.Citation) SlackVisibleEvidenceAnchor {
	return slackVisibleEvidenceAnchorFromSourceRef(firstNonEmpty(citation.SourceRef, citation.Source), citation.Snippet)
}

func slackVisibleEvidenceAnchorFromPersonaMemoryRecord(record persona.MemoryRecord) SlackVisibleEvidenceAnchor {
	sourceRef := strings.TrimSpace(record.SourceRef)
	if sourceRef == "" {
		return SlackVisibleEvidenceAnchor{}
	}
	kind := slackVisibleEvidenceKindWorkspaceMemory
	normalizedKind := strings.ToLower(strings.TrimSpace(record.Kind))
	if strings.Contains(normalizedKind, "person") || strings.Contains(sourceRef, "/people/") {
		kind = slackVisibleEvidenceKindPersonMemory
	}
	return SlackVisibleEvidenceAnchor{
		Kind:      kind,
		SourceRef: sourceRef,
		Quote:     record.Text,
	}
}

func slackVisibleEvidenceAnchorFromSourceRef(sourceRef string, quote string) SlackVisibleEvidenceAnchor {
	sourceRef = strings.TrimSpace(sourceRef)
	if sourceRef == "" {
		return SlackVisibleEvidenceAnchor{}
	}
	kind := slackVisibleEvidenceKindWorkspaceMemory
	lower := strings.ToLower(sourceRef)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		kind = slackVisibleEvidenceKindFetchedLink
	} else if strings.HasPrefix(lower, "slack:") || strings.HasPrefix(lower, "slack://") {
		kind = slackVisibleEvidenceKindSlackThread
	} else if strings.Contains(lower, "/people/") || strings.Contains(lower, "person") {
		kind = slackVisibleEvidenceKindPersonMemory
	}
	return SlackVisibleEvidenceAnchor{
		Kind:      kind,
		SourceRef: sourceRef,
		Quote:     quote,
	}
}

func firstSlackVisibleURL(text string) string {
	match := slackTriageURLPattern.FindString(strings.TrimSpace(text))
	return strings.TrimSpace(match)
}

func personaTriageApprovalToolCalls(pending []SlackTriagePendingResult) []SlackTriageToolCall {
	if len(pending) == 0 {
		return nil
	}
	calls := make([]SlackTriageToolCall, 0, len(pending))
	for _, result := range pending {
		if result.Action.Type != slackActionTypeThreadReply {
			continue
		}
		post := result.Post
		ok := post.OK
		status := "pending_dm_card_posted"
		if !ok {
			status = firstNonEmpty(post.Error, post.Detail, "pending_dm_card_not_posted")
		}
		calls = append(calls, SlackTriageToolCall{
			Tool:    "slack_api",
			Action:  "persona_reply_pending_dm_approval",
			Args:    marshalTriageArgs("chat.postMessage", firstNonEmpty(post.TS, post.ThreadTS), ok),
			Success: ok,
			Brief:   "Persona reply gated behind Peng approval DM",
			Result:  status,
		})
	}
	return calls
}
