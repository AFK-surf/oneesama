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
		"## Tool-first defaults",
		"heartbeat or runtime questions → call runtime_status first",
		`a Google Meet URL appears in the current thread → use suggest_action(action_type="join_meeting")`,
		`requested screenshots or local files → use slack_api(method="slack.uploadFile", params={...})`,
		"NEVER say \"I don't have access\"",
		"Match the tone and formality level of the conversation.",
		"Reply in the SAME language as the user's message.",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("slack assistant prompt missing cueboard default %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "oneesama Go rewrite") {
		t.Fatalf("slack assistant prompt leaked repo-worker identity:\n%s", prompt)
	}
}
