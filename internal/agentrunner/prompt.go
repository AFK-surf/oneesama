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

	if isSlackAssistantStart(input) {
		return buildSlackAssistantPrompt(input, contextJSON)
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

func buildSlackAssistantPrompt(input StartInput, contextJSON string) string {
	assistantContext := firstPromptString(
		stringFromContext(input.Context, "slackAssistantPrompt", "slack_assistant_prompt"),
		stringFromNestedContext(input.Context, "slackAppMention", "prompt", "Prompt"),
	)
	sections := []string{
		"You are a workspace assistant operating inside a Slack workspace.",
		strings.Join([]string{
			"Your job:",
			"- answer questions and help with tasks when @mentioned",
			"- summarize long or complex threads so people can catch up quickly",
			"- use the provided Slack thread context and verified tool results",
			"- do not expose internal worker/job/delegate mechanics to users",
			"- do not frame normal Slack requests as internal repository work",
			"- for long-form writing or document revisions, produce clean Markdown; the delivery layer will publish it as a Slack Canvas",
			"- keep thread replies concise when the long-form content belongs in Canvas",
		}, "\n"),
		"Mode: " + defaultMode(input.Mode),
		"Allow code changes: " + yesNo(input.AllowCodeChanges),
		"Task: " + strings.TrimSpace(input.Task),
	}
	if strings.TrimSpace(assistantContext) != "" {
		sections = append(sections, "Slack thread context:\n"+strings.TrimSpace(assistantContext))
	}
	sections = append(sections, "Context:\n"+contextJSON)
	return strings.Join(sections, "\n\n")
}

func isSlackAssistantStart(input StartInput) bool {
	if NormalizeSessionKind(stringFromContext(input.Context, "session_kind", "sessionKind")) == SessionKindSlack {
		return true
	}
	switch strings.TrimSpace(stringFromContext(input.Context, "source")) {
	case "slack-agent":
		return true
	default:
		return false
	}
}

func firstPromptString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func stringFromContext(context map[string]any, keys ...string) string {
	if len(context) == 0 {
		return ""
	}
	for _, key := range keys {
		if value := stringFromAny(context[key]); value != "" {
			return value
		}
	}
	return ""
}

func stringFromNestedContext(context map[string]any, parent string, keys ...string) string {
	if len(context) == 0 {
		return ""
	}
	switch typed := context[parent].(type) {
	case map[string]any:
		for _, key := range keys {
			if value := stringFromAny(typed[key]); value != "" {
				return value
			}
		}
	case map[string]string:
		for _, key := range keys {
			if value := strings.TrimSpace(typed[key]); value != "" {
				return value
			}
		}
	}
	return ""
}

func stringFromAny(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
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
