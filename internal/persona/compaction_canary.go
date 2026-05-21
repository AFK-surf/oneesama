package persona

import "strings"

// SourcePreservingCompactionCanary is the provider-neutral gate used before
// wiring any automatic compaction into foreground cognition paths.
type SourcePreservingCompactionCanary struct {
	Surface                string   `json:"surface,omitempty"`
	InputHash              string   `json:"inputHash,omitempty"`
	OutputHash             string   `json:"outputHash,omitempty"`
	StablePromptHashBefore string   `json:"stablePromptHashBefore,omitempty"`
	StablePromptHashAfter  string   `json:"stablePromptHashAfter,omitempty"`
	SourceRefsBefore       []string `json:"sourceRefsBefore,omitempty"`
	SourceRefsAfter        []string `json:"sourceRefsAfter,omitempty"`
}

type SourcePreservingCompactionCanaryResult struct {
	Pass                       bool     `json:"pass"`
	StablePrefixPreserved      bool     `json:"stablePrefixPreserved"`
	SourceAttributionPreserved bool     `json:"sourceAttributionPreserved"`
	MissingSourceRefs          []string `json:"missingSourceRefs,omitempty"`
	Reason                     string   `json:"reason,omitempty"`
}

func EvaluateSourcePreservingCompactionCanary(input SourcePreservingCompactionCanary) SourcePreservingCompactionCanaryResult {
	beforeHash := strings.TrimSpace(input.StablePromptHashBefore)
	afterHash := strings.TrimSpace(input.StablePromptHashAfter)
	stablePreserved := beforeHash != "" && beforeHash == afterHash
	beforeRefs := compactNormalizedSourceRefs(input.SourceRefsBefore)
	afterSet := normalizedSourceRefSet(input.SourceRefsAfter)
	missing := make([]string, 0)
	for _, ref := range beforeRefs {
		if _, ok := afterSet[ref]; !ok {
			missing = append(missing, ref)
		}
	}
	sourcePreserved := len(beforeRefs) > 0 && len(missing) == 0
	result := SourcePreservingCompactionCanaryResult{
		StablePrefixPreserved:      stablePreserved,
		SourceAttributionPreserved: sourcePreserved,
		MissingSourceRefs:          missing,
	}
	switch {
	case !stablePreserved:
		result.Reason = "stable_prefix_changed"
	case !sourcePreserved:
		result.Reason = "source_attribution_lost"
	default:
		result.Pass = true
		result.Reason = "ok"
	}
	return result
}

func SourceRefsFromMemoryContext(memory MemoryContext) []string {
	refs := make([]string, 0, len(memory.Items))
	for _, item := range memory.Items {
		refs = append(refs, item.SourceRef)
	}
	return compactNormalizedSourceRefs(refs)
}

func compactNormalizedSourceRefs(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		ref := strings.TrimSpace(value)
		if ref == "" {
			continue
		}
		if _, ok := seen[ref]; ok {
			continue
		}
		seen[ref] = struct{}{}
		out = append(out, ref)
	}
	return out
}

func normalizedSourceRefSet(values []string) map[string]struct{} {
	set := map[string]struct{}{}
	for _, ref := range compactNormalizedSourceRefs(values) {
		set[ref] = struct{}{}
	}
	return set
}
