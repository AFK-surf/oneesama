package meetingagent

import (
	"encoding/json"
	"strings"
)

func realtimeHarnessContextBudget(instructions string, tools []map[string]any, session map[string]any, dynamic map[string]any) map[string]any {
	toolSchemaChars := realtimeBudgetJSONChars(tools)
	instructionsChars := realtimeBudgetTextChars(instructions)
	sessionConfigChars := realtimeBudgetJSONChars(realtimeBudgetSessionConfigOnly(session))
	dynamicChars := realtimeBudgetJSONChars(dynamic)
	stableChars := instructionsChars + toolSchemaChars
	totalChars := stableChars + dynamicChars + sessionConfigChars
	return map[string]any{
		"estimator":              "chars_div_4_ceil",
		"cacheLocalityBreakdown": "stable_dynamic_worker_result_memory_evidence_session_config",
		"instructionsChars":      instructionsChars,
		"toolSchemaChars":        toolSchemaChars,
		"sessionConfigChars":     sessionConfigChars,
		"stableChars":            stableChars,
		"dynamicChars":           dynamicChars,
		"workerResultChars":      0,
		"memoryEvidenceChars":    0,
		"totalChars":             totalChars,
		"instructionsTokens":     realtimeBudgetTokens(instructionsChars),
		"toolSchemaTokens":       realtimeBudgetTokens(toolSchemaChars),
		"sessionConfigTokens":    realtimeBudgetTokens(sessionConfigChars),
		"stableTokens":           realtimeBudgetTokens(stableChars),
		"dynamicTokens":          realtimeBudgetTokens(dynamicChars),
		"workerResultTokens":     0,
		"memoryEvidenceTokens":   0,
		"totalTokens":            realtimeBudgetTokens(totalChars),
	}
}

func realtimeBudgetSessionConfigOnly(session map[string]any) map[string]any {
	out := make(map[string]any, len(session))
	for key, value := range session {
		if key == "instructions" || key == "tools" {
			continue
		}
		out[key] = value
	}
	return out
}

func realtimeBudgetJSONChars(value any) int {
	payload, err := json.Marshal(value)
	if err != nil {
		return 0
	}
	return realtimeBudgetTextChars(string(payload))
}

func realtimeBudgetTextChars(value string) int {
	return len([]rune(strings.TrimSpace(value)))
}

func realtimeBudgetTokens(chars int) int {
	if chars <= 0 {
		return 0
	}
	return (chars + 3) / 4
}
