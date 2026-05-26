//go:build cueboardparity

package slackagent

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
