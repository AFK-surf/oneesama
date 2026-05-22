package slackagent

import (
	"fmt"
	"strings"
)

const (
	slackVisibleEvidenceKindSlackThread         = "slack_thread"
	slackVisibleEvidenceKindFetchedLink         = "fetched_link"
	slackVisibleEvidenceKindWorkspaceMemory     = "workspace_memory"
	slackVisibleEvidenceKindPersonMemory        = "person_memory"
	slackVisibleEvidenceKindFile                = "file"
	slackVisibleEvidenceKindImage               = "image"
	slackVisibleEvidenceKindWorkerResult        = "worker_result"
	slackVisibleEvidenceKindExplicitUserCommand = "explicit_user_command"
)

func normalizeSlackVisibleEvidenceAnchors(anchors []SlackVisibleEvidenceAnchor) []SlackVisibleEvidenceAnchor {
	out := make([]SlackVisibleEvidenceAnchor, 0, len(anchors))
	seen := make(map[string]struct{}, len(anchors))
	for _, anchor := range anchors {
		normalized, ok := normalizeSlackVisibleEvidenceAnchor(anchor)
		if !ok {
			continue
		}
		key := normalized.Kind + "\x00" + normalized.SourceRef + "\x00" + normalized.Quote
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, normalized)
		if len(out) >= 8 {
			break
		}
	}
	return out
}

func normalizeSlackVisibleEvidenceAnchor(anchor SlackVisibleEvidenceAnchor) (SlackVisibleEvidenceAnchor, bool) {
	kind := normalizeSlackVisibleEvidenceKind(anchor.Kind)
	sourceRef := strings.TrimSpace(anchor.SourceRef)
	if kind == "" || sourceRef == "" {
		return SlackVisibleEvidenceAnchor{}, false
	}
	confidence, confidenceSource := slackVisibleEvidenceAnchorConfidence(kind, anchor.ConfidenceSource)
	return SlackVisibleEvidenceAnchor{
		Kind:             kind,
		SourceRef:        truncateSlackContextText(sourceRef, 300),
		Quote:            truncateSlackContextText(strings.TrimSpace(anchor.Quote), 420),
		Confidence:       confidence,
		ConfidenceSource: confidenceSource,
		Freshness:        truncateSlackContextText(strings.TrimSpace(anchor.Freshness), 80),
	}, true
}

func normalizeSlackVisibleEvidenceKind(kind string) string {
	normalized := strings.ToLower(strings.TrimSpace(kind))
	normalized = strings.ReplaceAll(normalized, "-", "_")
	normalized = strings.ReplaceAll(normalized, " ", "_")
	switch normalized {
	case slackVisibleEvidenceKindSlackThread, "thread", "slack", "slack_message", "slack_context":
		return slackVisibleEvidenceKindSlackThread
	case slackVisibleEvidenceKindFetchedLink, "external_link", "link", "url", "web", "web_page", "article":
		return slackVisibleEvidenceKindFetchedLink
	case slackVisibleEvidenceKindWorkspaceMemory, "memory", "workspace", "workspace_record":
		return slackVisibleEvidenceKindWorkspaceMemory
	case slackVisibleEvidenceKindPersonMemory, "person", "person_record", "profile_memory":
		return slackVisibleEvidenceKindPersonMemory
	case slackVisibleEvidenceKindFile, "slack_file", "attachment":
		return slackVisibleEvidenceKindFile
	case slackVisibleEvidenceKindImage, "slack_image", "image_file":
		return slackVisibleEvidenceKindImage
	case slackVisibleEvidenceKindWorkerResult, "worker", "worker_output", "delegated_worker":
		return slackVisibleEvidenceKindWorkerResult
	case slackVisibleEvidenceKindExplicitUserCommand, "explicit_command", "user_command", "direct_user_command":
		return slackVisibleEvidenceKindExplicitUserCommand
	default:
		return ""
	}
}

func slackVisibleEvidenceAnchorConfidence(kind string, _ string) (float64, string) {
	source := "source_derived:" + kind
	switch kind {
	case slackVisibleEvidenceKindExplicitUserCommand:
		return 1.0, source
	case slackVisibleEvidenceKindSlackThread:
		return 0.9, source
	case slackVisibleEvidenceKindFetchedLink:
		return 0.86, source
	case slackVisibleEvidenceKindPersonMemory:
		return 0.84, source
	case slackVisibleEvidenceKindWorkspaceMemory:
		return 0.8, source
	case slackVisibleEvidenceKindImage, slackVisibleEvidenceKindFile:
		return 0.76, source
	case slackVisibleEvidenceKindWorkerResult:
		return 0.72, source
	default:
		return 0.5, source
	}
}

func slackVisibleEvidenceAnchorsFromAny(value any) []SlackVisibleEvidenceAnchor {
	switch typed := value.(type) {
	case nil:
		return nil
	case SlackVisibleEvidenceAnchor:
		return normalizeSlackVisibleEvidenceAnchors([]SlackVisibleEvidenceAnchor{typed})
	case []SlackVisibleEvidenceAnchor:
		return normalizeSlackVisibleEvidenceAnchors(typed)
	case map[string]any:
		return normalizeSlackVisibleEvidenceAnchors([]SlackVisibleEvidenceAnchor{slackVisibleEvidenceAnchorFromMap(typed)})
	case []map[string]any:
		anchors := make([]SlackVisibleEvidenceAnchor, 0, len(typed))
		for _, item := range typed {
			anchors = append(anchors, slackVisibleEvidenceAnchorFromMap(item))
		}
		return normalizeSlackVisibleEvidenceAnchors(anchors)
	case []any:
		anchors := make([]SlackVisibleEvidenceAnchor, 0, len(typed))
		for _, item := range typed {
			if anchor, ok := item.(SlackVisibleEvidenceAnchor); ok {
				anchors = append(anchors, anchor)
				continue
			}
			if mapped, ok := mapFromAny(item); ok {
				anchors = append(anchors, slackVisibleEvidenceAnchorFromMap(mapped))
			}
		}
		return normalizeSlackVisibleEvidenceAnchors(anchors)
	default:
		return nil
	}
}

func firstNonEmptyAny(values ...any) any {
	for _, value := range values {
		if value == nil {
			continue
		}
		if strings.TrimSpace(stringFromAny(value)) != "" {
			return value
		}
		switch typed := value.(type) {
		case []any:
			if len(typed) > 0 {
				return value
			}
		case []SlackVisibleEvidenceAnchor:
			if len(typed) > 0 {
				return value
			}
		case map[string]any:
			if len(typed) > 0 {
				return value
			}
		}
	}
	return nil
}

func slackVisibleEvidenceAnchorFromMap(mapped map[string]any) SlackVisibleEvidenceAnchor {
	return SlackVisibleEvidenceAnchor{
		Kind: firstNonEmpty(
			stringFromAny(mapped["kind"]),
			stringFromAny(mapped["type"]),
			stringFromAny(mapped["sourceKind"]),
			stringFromAny(mapped["source_kind"]),
		),
		SourceRef: firstNonEmpty(
			stringFromAny(mapped["sourceRef"]),
			stringFromAny(mapped["source_ref"]),
			stringFromAny(mapped["ref"]),
			stringFromAny(mapped["url"]),
			stringFromAny(mapped["path"]),
			stringFromAny(mapped["fileId"]),
			stringFromAny(mapped["file_id"]),
			stringFromAny(mapped["id"]),
		),
		Quote: firstNonEmpty(
			stringFromAny(mapped["quote"]),
			stringFromAny(mapped["excerpt"]),
			stringFromAny(mapped["text"]),
			stringFromAny(mapped["message"]),
			stringFromAny(mapped["summary"]),
		),
		ConfidenceSource: firstNonEmpty(
			stringFromAny(mapped["confidenceSource"]),
			stringFromAny(mapped["confidence_source"]),
		),
		Freshness: firstNonEmpty(
			stringFromAny(mapped["freshness"]),
			stringFromAny(mapped["timestamp"]),
			stringFromAny(mapped["ts"]),
		),
	}
}

func slackVisibleEvidenceAnchorsForAction(action SlackTriageDecisionAction) []SlackVisibleEvidenceAnchor {
	anchors := normalizeSlackVisibleEvidenceAnchors(action.EvidenceAnchors)
	if len(anchors) > 0 {
		return anchors
	}
	if strings.TrimSpace(action.Type) != slackActionTypeThreadReply {
		return nil
	}
	return slackVisibleThreadEvidenceAnchors(action.ChannelID, action.ThreadTS, action.Message)
}

func slackVisibleThreadEvidenceAnchors(channelID string, threadTS string, quote string) []SlackVisibleEvidenceAnchor {
	channelID = strings.TrimSpace(channelID)
	threadTS = strings.TrimSpace(threadTS)
	if channelID == "" && threadTS == "" {
		return nil
	}
	sourceRef := "slack_thread"
	if channelID != "" || threadTS != "" {
		sourceRef = fmt.Sprintf("slack://channel/%s/thread/%s", channelID, threadTS)
	}
	return normalizeSlackVisibleEvidenceAnchors([]SlackVisibleEvidenceAnchor{{
		Kind:      slackVisibleEvidenceKindSlackThread,
		SourceRef: sourceRef,
		Quote:     quote,
	}})
}

func slackVisibleFetchedLinkEvidenceAnchor(context SlackExternalLinkContext) []SlackVisibleEvidenceAnchor {
	sourceRef := strings.TrimSpace(context.URL)
	if sourceRef == "" || strings.TrimSpace(context.Error) != "" {
		return nil
	}
	quote := firstNonEmpty(strings.TrimSpace(context.Title), strings.TrimSpace(context.Excerpt))
	confidenceSource := "source_derived:fetched_link"
	if strings.TrimSpace(context.Source) != "" {
		confidenceSource += ":" + strings.TrimSpace(context.Source)
	}
	return normalizeSlackVisibleEvidenceAnchors([]SlackVisibleEvidenceAnchor{{
		Kind:             slackVisibleEvidenceKindFetchedLink,
		SourceRef:        sourceRef,
		Quote:            quote,
		ConfidenceSource: confidenceSource,
		Freshness:        strings.TrimSpace(context.Source),
	}})
}

func slackVisibleEvidenceAnchorConfidenceSummary(anchors []SlackVisibleEvidenceAnchor) string {
	anchors = normalizeSlackVisibleEvidenceAnchors(anchors)
	if len(anchors) == 0 {
		return "not_collected_phase0"
	}
	parts := make([]string, 0, len(anchors))
	seen := make(map[string]struct{}, len(anchors))
	for _, anchor := range anchors {
		source := strings.TrimSpace(anchor.ConfidenceSource)
		if source == "" {
			continue
		}
		if _, exists := seen[source]; exists {
			continue
		}
		seen[source] = struct{}{}
		parts = append(parts, source)
	}
	if len(parts) == 0 {
		return "source_derived"
	}
	return strings.Join(parts, ",")
}
