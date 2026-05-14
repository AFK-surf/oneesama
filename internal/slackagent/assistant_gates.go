package slackagent

import (
	"fmt"
	"strings"
)

func assistantMutationBlockedMessage(toolName, action string, allowedActions ...string) string {
	if toolName == "" {
		toolName = "this tool"
	}
	subject := toolName
	if action == "" {
		if len(allowedActions) == 0 {
			return fmt.Sprintf("%s is not available in assistant sessions.", toolName)
		}
		return fmt.Sprintf("%s is not available in assistant sessions. Allowed actions here: %s.", toolName, formatAssistantAllowedActions(allowedActions))
	}
	subject = fmt.Sprintf("%s action %q", toolName, action)
	if len(allowedActions) == 0 {
		return fmt.Sprintf("%s is not available in assistant sessions.", subject)
	}
	return fmt.Sprintf("%s is not available in assistant sessions. Allowed actions here: %s.", subject, formatAssistantAllowedActions(allowedActions))
}

func formatAssistantAllowedActions(actions []string) string {
	if len(actions) == 0 {
		return ""
	}
	if len(actions) == 1 {
		return fmt.Sprintf("%q", actions[0])
	}
	quoted := make([]string, 0, len(actions))
	for _, action := range actions {
		quoted = append(quoted, fmt.Sprintf("%q", action))
	}
	if len(quoted) == 2 {
		return quoted[0] + " and " + quoted[1]
	}
	return strings.Join(quoted[:len(quoted)-1], ", ") + ", and " + quoted[len(quoted)-1]
}

func assistantActionParameters(description string, actions []string) map[string]any {
	enum := append([]string(nil), actions...)
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": map[string]any{
				"type":        "string",
				"description": description,
				"enum":        enum,
			},
		},
		"required": []string{"action"},
	}
}
