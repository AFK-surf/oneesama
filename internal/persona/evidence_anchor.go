package persona

import "strings"

const (
	EvidenceKindSlackThread         = "slack_thread"
	EvidenceKindFetchedLink         = "fetched_link"
	EvidenceKindWorkspaceMemory     = "workspace_memory"
	EvidenceKindPersonMemory        = "person_memory"
	EvidenceKindFile                = "file"
	EvidenceKindImage               = "image"
	EvidenceKindWorkerResult        = "worker_result"
	EvidenceKindExplicitUserCommand = "explicit_user_command"
)

func NormalizeEvidenceAnchors(anchors []EvidenceAnchor) []EvidenceAnchor {
	out := make([]EvidenceAnchor, 0, len(anchors))
	seen := make(map[string]struct{}, len(anchors))
	for _, anchor := range anchors {
		normalized, ok := normalizeEvidenceAnchor(anchor)
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

func EvidenceAnchorsFromCitations(citations []Citation) []EvidenceAnchor {
	anchors := make([]EvidenceAnchor, 0, len(citations))
	for _, citation := range citations {
		anchors = append(anchors, EvidenceAnchor{
			Kind:      evidenceKindFromCitation(citation),
			SourceRef: firstNonEmptyEvidence(strings.TrimSpace(citation.SourceRef), strings.TrimSpace(citation.Source)),
			Quote:     citation.Snippet,
		})
	}
	return NormalizeEvidenceAnchors(anchors)
}

func normalizeEvidenceAnchor(anchor EvidenceAnchor) (EvidenceAnchor, bool) {
	kind := normalizeEvidenceKind(anchor.Kind)
	sourceRef := strings.TrimSpace(anchor.SourceRef)
	if kind == "" || sourceRef == "" {
		return EvidenceAnchor{}, false
	}
	return EvidenceAnchor{
		Kind:      kind,
		SourceRef: truncateEvidenceAnchorText(sourceRef, 300),
		Quote:     truncateEvidenceAnchorText(strings.TrimSpace(anchor.Quote), 420),
		Freshness: truncateEvidenceAnchorText(strings.TrimSpace(anchor.Freshness), 80),
	}, true
}

func normalizeEvidenceKind(kind string) string {
	normalized := strings.ToLower(strings.TrimSpace(kind))
	normalized = strings.ReplaceAll(normalized, "-", "_")
	normalized = strings.ReplaceAll(normalized, " ", "_")
	switch normalized {
	case EvidenceKindSlackThread, "thread", "slack", "slack_message", "slack_context":
		return EvidenceKindSlackThread
	case EvidenceKindFetchedLink, "external_link", "link", "url", "web", "web_page", "article":
		return EvidenceKindFetchedLink
	case EvidenceKindWorkspaceMemory, "memory", "workspace", "workspace_record":
		return EvidenceKindWorkspaceMemory
	case EvidenceKindPersonMemory, "person", "person_record", "profile_memory":
		return EvidenceKindPersonMemory
	case EvidenceKindFile, "slack_file", "attachment":
		return EvidenceKindFile
	case EvidenceKindImage, "slack_image", "image_file":
		return EvidenceKindImage
	case EvidenceKindWorkerResult, "worker", "worker_output", "delegated_worker":
		return EvidenceKindWorkerResult
	case EvidenceKindExplicitUserCommand, "explicit_command", "user_command", "direct_user_command":
		return EvidenceKindExplicitUserCommand
	default:
		return ""
	}
}

func evidenceKindFromCitation(citation Citation) string {
	kind := strings.ToLower(strings.TrimSpace(citation.Kind))
	sourceRef := strings.ToLower(strings.TrimSpace(firstNonEmptyEvidence(citation.SourceRef, citation.Source)))
	switch {
	case strings.Contains(kind, "person") || strings.Contains(sourceRef, "/people/"):
		return EvidenceKindPersonMemory
	case strings.Contains(kind, "link") || strings.Contains(kind, "url") || strings.HasPrefix(sourceRef, "http://") || strings.HasPrefix(sourceRef, "https://"):
		return EvidenceKindFetchedLink
	case strings.Contains(kind, "thread") || strings.Contains(kind, "slack") || strings.HasPrefix(sourceRef, "slack:") || strings.HasPrefix(sourceRef, "slack://"):
		return EvidenceKindSlackThread
	case strings.Contains(kind, "file") || strings.Contains(kind, "attachment"):
		return EvidenceKindFile
	case strings.Contains(kind, "image"):
		return EvidenceKindImage
	case strings.Contains(kind, "worker"):
		return EvidenceKindWorkerResult
	default:
		return EvidenceKindWorkspaceMemory
	}
}

func truncateEvidenceAnchorText(value string, maxRunes int) string {
	trimmed := strings.TrimSpace(value)
	if maxRunes <= 0 || len([]rune(trimmed)) <= maxRunes {
		return trimmed
	}
	if maxRunes == 1 {
		return "…"
	}
	return strings.TrimSpace(string([]rune(trimmed)[:maxRunes-1])) + "…"
}

func firstNonEmptyEvidence(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
