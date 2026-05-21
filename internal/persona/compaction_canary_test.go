package persona

import "testing"

func TestEvaluateSourcePreservingCompactionCanaryPassesWhenSourcesAndStableHashRemain(t *testing.T) {
	t.Parallel()

	result := EvaluateSourcePreservingCompactionCanary(SourcePreservingCompactionCanary{
		StablePromptHashBefore: "stable-hash",
		StablePromptHashAfter:  "stable-hash",
		SourceRefsBefore:       []string{"slack:C:1", "memory/a.md:7"},
		SourceRefsAfter:        []string{"memory/a.md:7", "slack:C:1", "extra/ref"},
	})
	if !result.Pass || !result.StablePrefixPreserved || !result.SourceAttributionPreserved || result.Reason != "ok" {
		t.Fatalf("result = %#v, want passing canary", result)
	}
}

func TestEvaluateSourcePreservingCompactionCanaryFailsMissingSourceRef(t *testing.T) {
	t.Parallel()

	result := EvaluateSourcePreservingCompactionCanary(SourcePreservingCompactionCanary{
		StablePromptHashBefore: "stable-hash",
		StablePromptHashAfter:  "stable-hash",
		SourceRefsBefore:       []string{"slack:C:1", "memory/a.md:7"},
		SourceRefsAfter:        []string{"slack:C:1"},
	})
	if result.Pass || result.SourceAttributionPreserved || result.Reason != "source_attribution_lost" {
		t.Fatalf("result = %#v, want source attribution failure", result)
	}
	if len(result.MissingSourceRefs) != 1 || result.MissingSourceRefs[0] != "memory/a.md:7" {
		t.Fatalf("missing = %#v, want lost memory source ref", result.MissingSourceRefs)
	}
}

func TestEvaluateSourcePreservingCompactionCanaryFailsStablePromptDrift(t *testing.T) {
	t.Parallel()

	result := EvaluateSourcePreservingCompactionCanary(SourcePreservingCompactionCanary{
		StablePromptHashBefore: "before",
		StablePromptHashAfter:  "after",
		SourceRefsBefore:       []string{"slack:C:1"},
		SourceRefsAfter:        []string{"slack:C:1"},
	})
	if result.Pass || result.StablePrefixPreserved || result.Reason != "stable_prefix_changed" {
		t.Fatalf("result = %#v, want stable prefix failure", result)
	}
}

func TestSourcePreservingCompactionCanaryAllowsCompactedMemoryWithoutStablePromptDrift(t *testing.T) {
	t.Parallel()

	before := Request{
		Event: Event{Kind: "slack_triage", Text: "summarize this long thread"},
		Memory: MemoryContext{Items: []MemoryRecord{
			{Kind: "thread", Text: "long raw source detail A", SourceRef: "slack:C:100.000"},
			{Kind: "memory", Text: "long raw source detail B", SourceRef: "memory/team/oneesama.md:12"},
		}},
	}
	after := Request{
		Event: Event{Kind: "slack_triage", Text: "summarize this long thread"},
		Memory: MemoryContext{Items: []MemoryRecord{
			{Kind: "compacted_thread_activity_summary", Text: "compact summary, still attributed", SourceRef: "slack:C:100.000"},
			{Kind: "compacted_memory_evidence", Text: "compact memory, still attributed", SourceRef: "memory/team/oneesama.md:12"},
		}},
	}

	result := EvaluateSourcePreservingCompactionCanary(SourcePreservingCompactionCanary{
		StablePromptHashBefore: OneesamaPIStablePromptHash(before),
		StablePromptHashAfter:  OneesamaPIStablePromptHash(after),
		SourceRefsBefore:       SourceRefsFromMemoryContext(before.Memory),
		SourceRefsAfter:        SourceRefsFromMemoryContext(after.Memory),
	})
	if !result.Pass {
		t.Fatalf("result = %#v, want compacted memory canary to pass", result)
	}
}
