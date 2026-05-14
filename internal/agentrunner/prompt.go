package agentrunner

import (
	"encoding/json"
	"strings"
)

func buildPrompt(input StartInput) string {
	contextJSON := "{}"
	if len(input.Context) > 0 {
		if payload, err := json.MarshalIndent(input.Context, "", "  "); err == nil {
			contextJSON = string(payload)
		}
	}

	return strings.Join([]string{
		"You are a background worker for the oneesama Go rewrite.",
		"Answer in concise Chinese. If you cannot complete the task, explain the blocker clearly.",
		"Mode: " + defaultMode(input.Mode),
		"Allow code changes: " + yesNo(input.AllowCodeChanges),
		"Task: " + strings.TrimSpace(input.Task),
		"Context:\n" + contextJSON,
	}, "\n\n")
}

func defaultMode(value string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return "analysis"
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}
