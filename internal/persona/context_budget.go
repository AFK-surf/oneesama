package persona

import "strings"

// HarnessContextBudget records an approximate request budget split by cache
// locality. It is intentionally estimate-only: the goal is drift detection and
// operator visibility, not provider billing exactness.
type HarnessContextBudget struct {
	StableChars         int `json:"stableChars"`
	DynamicChars        int `json:"dynamicChars"`
	WorkerResultChars   int `json:"workerResultChars"`
	MemoryEvidenceChars int `json:"memoryEvidenceChars"`
	EventContextChars   int `json:"eventContextChars"`
	TotalChars          int `json:"totalChars"`

	StableTokens         int `json:"stableTokens"`
	DynamicTokens        int `json:"dynamicTokens"`
	WorkerResultTokens   int `json:"workerResultTokens"`
	MemoryEvidenceTokens int `json:"memoryEvidenceTokens"`
	EventContextTokens   int `json:"eventContextTokens"`
	TotalTokens          int `json:"totalTokens"`
}

func RequestHarnessContextBudget(req Request) HarnessContextBudget {
	budget := HarnessContextBudget{
		StableChars: lenRunes(OneesamaPIStablePromptText(req)),
	}
	budget.EventContextChars += lenRunes(req.Event.Kind) + lenRunes(req.Event.Text) + lenRunes(req.Event.Language) + lenRunes(req.Event.CreatedAt)
	for _, item := range req.Context {
		chars := lenRunes(item.Kind) + lenRunes(item.Text) + lenRunes(item.SourceRef)
		if contextBudgetLooksLikeWorkerResult(item.Kind) || contextBudgetLooksLikeWorkerResult(item.SourceRef) {
			budget.WorkerResultChars += chars
			continue
		}
		budget.EventContextChars += chars
	}
	for _, env := range req.DynamicContext {
		chars := lenRunes(env.Kind) + lenRunes(env.Source) + lenRunes(env.Version) + lenRunes(env.Freshness) + lenRunes(env.Content)
		if contextBudgetLooksLikeWorkerResult(env.Kind) || contextBudgetLooksLikeWorkerResult(env.Source) {
			budget.WorkerResultChars += chars
			continue
		}
		budget.DynamicChars += chars
	}
	budget.MemoryEvidenceChars += lenRunes(req.Evidence.Summary)
	for _, citation := range req.Evidence.Citations {
		budget.MemoryEvidenceChars += lenRunes(citation.Kind) + lenRunes(citation.Source) + lenRunes(citation.SourceRef) + lenRunes(citation.Snippet)
	}
	budget.MemoryEvidenceChars += lenRunes(req.Memory.Summary)
	for _, record := range req.Memory.Items {
		budget.MemoryEvidenceChars += lenRunes(record.Kind) + lenRunes(record.Text) + lenRunes(record.SourceRef)
	}
	budget.TotalChars = budget.StableChars + budget.DynamicChars + budget.WorkerResultChars + budget.MemoryEvidenceChars + budget.EventContextChars
	budget.StableTokens = EstimateHarnessTokensFromChars(budget.StableChars)
	budget.DynamicTokens = EstimateHarnessTokensFromChars(budget.DynamicChars)
	budget.WorkerResultTokens = EstimateHarnessTokensFromChars(budget.WorkerResultChars)
	budget.MemoryEvidenceTokens = EstimateHarnessTokensFromChars(budget.MemoryEvidenceChars)
	budget.EventContextTokens = EstimateHarnessTokensFromChars(budget.EventContextChars)
	budget.TotalTokens = EstimateHarnessTokensFromChars(budget.TotalChars)
	return budget
}

func EstimateHarnessTokensFromChars(chars int) int {
	if chars <= 0 {
		return 0
	}
	return (chars + 3) / 4
}

func contextBudgetLooksLikeWorkerResult(value string) bool {
	text := strings.ToLower(strings.TrimSpace(value))
	if text == "" {
		return false
	}
	return strings.Contains(text, "worker_result") ||
		(strings.Contains(text, "worker") && strings.Contains(text, "result"))
}

func lenRunes(value string) int {
	return len([]rune(strings.TrimSpace(value)))
}
