package agentrunner

import (
	"strings"
	"testing"
)

func TestSlackAssistantPromptUsesCueboardToolFirstDefaults(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task: "看看这个 Meet 链接 https://meet.google.com/abc-defg-hij",
		Context: map[string]any{
			"source":               "slack-agent",
			"slackAssistantPrompt": "Thread metadata:\n- channel: C123\n\nThread context:\n[ts:1.0] <@U1>: 看这个 Meet 链接",
		},
	}, SessionKindSlack))

	for _, want := range []string{
		"## Dispatcher tool bridge",
		"<oneesama_tool_request>",
		"Supported dispatcher tools",
		"Do not request chat.postMessage",
		"Do not say \"I don't have access\"",
		"Match the tone and formality level of the conversation.",
		"Reply in the SAME language as the user's message.",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("slack assistant prompt missing cueboard default %q:\n%s", want, prompt)
		}
	}
	for _, forbidden := range []string{
		"call runtime_status first",
		"slack.uploadFile",
		"linear_api directly",
	} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("slack assistant prompt contains prompt-only tool assumption %q:\n%s", forbidden, prompt)
		}
	}
	if strings.Contains(prompt, "oneesama Go rewrite") {
		t.Fatalf("slack assistant prompt leaked repo-worker identity:\n%s", prompt)
	}
}
