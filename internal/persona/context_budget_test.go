package persona

import "testing"

func TestRequestHarnessContextBudgetSplitsStableDynamicWorkerAndMemory(t *testing.T) {
	t.Parallel()

	req := Request{
		Event: Event{Kind: "slack_triage", Text: "please check this"},
		Context: []ContextItem{
			{Kind: "slack_thread_context", Text: "thread context"},
			{Kind: "worker_result_summary", Text: "bounded worker output"},
		},
		DynamicContext: []DynamicContextEnvelope{
			NewDynamicContextEnvelope("workspace_triage_policy", "config", "engage product-adjacent links"),
			NewDynamicContextEnvelope("worker_result_envelope", "agentrunner", "worker evidence"),
		},
		Evidence: EvidenceBundle{
			Summary: "source evidence",
			Citations: []Citation{{
				Kind:      "memory",
				SourceRef: "memory/product.md",
				Snippet:   "related memory",
			}},
		},
		Memory: MemoryContext{
			Summary: "1 related memory",
			Items:   []MemoryRecord{{Kind: "fact", Text: "Oneesama is workspace-specific"}},
		},
	}

	budget := RequestHarnessContextBudget(req)
	if budget.StableChars <= 0 || budget.StableTokens <= 0 {
		t.Fatalf("budget = %#v, want stable prompt budget", budget)
	}
	if budget.DynamicChars <= 0 || budget.DynamicTokens <= 0 {
		t.Fatalf("budget = %#v, want dynamic envelope budget", budget)
	}
	if budget.WorkerResultChars <= 0 || budget.WorkerResultTokens <= 0 {
		t.Fatalf("budget = %#v, want worker result budget", budget)
	}
	if budget.MemoryEvidenceChars <= 0 || budget.MemoryEvidenceTokens <= 0 {
		t.Fatalf("budget = %#v, want memory/evidence budget", budget)
	}
	if budget.EventContextChars <= 0 || budget.EventContextTokens <= 0 {
		t.Fatalf("budget = %#v, want event/context budget", budget)
	}
	wantTotal := budget.StableChars + budget.DynamicChars + budget.WorkerResultChars + budget.MemoryEvidenceChars + budget.EventContextChars
	if budget.TotalChars != wantTotal {
		t.Fatalf("totalChars = %d, want %d (%#v)", budget.TotalChars, wantTotal, budget)
	}
}

func TestEstimateHarnessTokensFromCharsRoundsUp(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		chars int
		want  int
	}{
		{0, 0},
		{1, 1},
		{4, 1},
		{5, 2},
		{8, 2},
	} {
		if got := EstimateHarnessTokensFromChars(tc.chars); got != tc.want {
			t.Fatalf("EstimateHarnessTokensFromChars(%d) = %d, want %d", tc.chars, got, tc.want)
		}
	}
}
