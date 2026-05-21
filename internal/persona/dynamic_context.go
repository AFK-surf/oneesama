package persona

import "strings"

func NewDynamicContextEnvelope(kind, source, content string) DynamicContextEnvelope {
	return NormalizeDynamicContextEnvelope(DynamicContextEnvelope{
		Kind:        kind,
		Source:      source,
		Content:     content,
		Confidence:  1,
		CachePolicy: DynamicContextCachePolicyNotStablePrefix,
	})
}

func NormalizeDynamicContextEnvelope(input DynamicContextEnvelope) DynamicContextEnvelope {
	input.Kind = strings.TrimSpace(input.Kind)
	input.Source = strings.TrimSpace(input.Source)
	input.Version = strings.TrimSpace(input.Version)
	input.Freshness = strings.TrimSpace(input.Freshness)
	input.Content = strings.TrimSpace(input.Content)
	input.CachePolicy = strings.TrimSpace(input.CachePolicy)
	if input.CachePolicy == "" {
		input.CachePolicy = DynamicContextCachePolicyNotStablePrefix
	}
	if input.Confidence < 0 {
		input.Confidence = 0
	}
	if input.Confidence > 1 {
		input.Confidence = 1
	}
	return input
}

func NormalizeDynamicContextEnvelopes(inputs []DynamicContextEnvelope) []DynamicContextEnvelope {
	if len(inputs) == 0 {
		return nil
	}
	out := make([]DynamicContextEnvelope, 0, len(inputs))
	for _, input := range inputs {
		normalized := NormalizeDynamicContextEnvelope(input)
		if normalized.Kind == "" && normalized.Content == "" {
			continue
		}
		out = append(out, normalized)
	}
	return out
}
