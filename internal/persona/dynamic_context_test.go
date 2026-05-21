package persona

import "testing"

func TestNormalizeDynamicContextEnvelopeDefaultsCachePolicyAndBoundsConfidence(t *testing.T) {
	env := NormalizeDynamicContextEnvelope(DynamicContextEnvelope{
		Kind:       " workspace_triage_policy ",
		Source:     " workspace_config ",
		Content:    " engage product-adjacent links ",
		Confidence: 2.5,
	})

	if env.Kind != "workspace_triage_policy" || env.Source != "workspace_config" || env.Content != "engage product-adjacent links" {
		t.Fatalf("normalized envelope = %#v, want trimmed fields", env)
	}
	if env.CachePolicy != DynamicContextCachePolicyNotStablePrefix {
		t.Fatalf("CachePolicy = %q, want %q", env.CachePolicy, DynamicContextCachePolicyNotStablePrefix)
	}
	if env.Confidence != 1 {
		t.Fatalf("Confidence = %v, want upper bound 1", env.Confidence)
	}
}

func TestNormalizeDynamicContextEnvelopesDropsEmptyEntries(t *testing.T) {
	envs := NormalizeDynamicContextEnvelopes([]DynamicContextEnvelope{
		{},
		NewDynamicContextEnvelope("workspace_custom_emoji", "slack_emoji_list", "oneesama"),
		{Kind: "current_time", Content: "2026-05-21T19:40:00+08:00", Confidence: -1},
	})

	if len(envs) != 2 {
		t.Fatalf("len(envs) = %d, want 2", len(envs))
	}
	if envs[0].Kind != "workspace_custom_emoji" || envs[0].CachePolicy != DynamicContextCachePolicyNotStablePrefix {
		t.Fatalf("envs[0] = %#v, want custom emoji dynamic envelope", envs[0])
	}
	if envs[1].Kind != "current_time" || envs[1].Confidence != 0 {
		t.Fatalf("envs[1] = %#v, want bounded current time envelope", envs[1])
	}
}
