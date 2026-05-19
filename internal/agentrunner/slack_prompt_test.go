package agentrunner

import (
	"strings"
	"testing"
)

func TestBuildPromptUsesWorkspaceAssistantForSlackSessions(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task: "帮我把后面补充的信息并进文稿",
		Context: map[string]any{
			"source":               "slack-agent",
			"slackAssistantPrompt": "Thread metadata:\n- channel: C123\n\nThread context:\n[ts:1.0] <@U1>: 初稿\n[ts:2.0] <@U1>: 后面补充",
		},
	}, SessionKindSlack))

	for _, want := range []string{
		"You are a workspace assistant operating inside a Slack workspace.",
		"Thread context:",
		"帮我把后面补充的信息并进文稿",
		"prefer injected related memory evidence",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "oneesama Go rewrite") {
		t.Fatalf("slack workspace prompt leaked repo-worker identity:\n%s", prompt)
	}
}

func TestBuildPromptReadsSlackAppMentionPromptFromGenericContext(t *testing.T) {
	prompt := buildPrompt(StartInput{
		Task: "看看补充的信息",
		Context: map[string]any{
			"source":       "slack-agent",
			"session_kind": SessionKindSlack,
			"slackAppMention": map[string]any{
				"prompt": "Thread metadata:\n- thread_ts: 123.456\n\nThread context:\nold canvas F123",
			},
		},
	})

	if !strings.Contains(prompt, "workspace assistant operating inside a Slack workspace") ||
		!strings.Contains(prompt, "old canvas F123") {
		t.Fatalf("prompt = %s, want workspace assistant prompt with mention context", prompt)
	}
	if strings.Contains(prompt, "background worker for the oneesama Go rewrite") {
		t.Fatalf("prompt should not use repo-worker framing for Slack assistant sessions:\n%s", prompt)
	}
}

func TestBuildPromptMentionsLocalSlackToolGateway(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task: "读一下这个 X 链接",
		Context: map[string]any{
			"source": "slack-agent",
		},
	}, SessionKindSlack))

	for _, want := range []string{
		"Local Slack tool gateway",
		"http://127.0.0.1:8780/slack/tools/call",
		`"tool":"exa_contents"`,
		`"tool":"memory_search"`,
		"do not mention localhost",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestBuildPromptSurfacesRelatedMemoryEvidence(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task: "jc说之前录制了5个Case Study的视频，这个有吗？",
		Context: map[string]any{
			"source":                "slack-agent",
			"relatedMemoryEvidence": "memory/team/meetings/jc-case-study.md:1-3 [team_meeting]: Jc discussed five use case demos, not recorded Case Study videos.",
		},
	}, SessionKindSlack))

	for _, want := range []string{
		"Related memory evidence",
		"memory/team/meetings/jc-case-study.md:1-3",
		"five use case demos",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}
