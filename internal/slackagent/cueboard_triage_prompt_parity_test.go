package slackagent

import (
	"os"
	"strings"
	"testing"
)

func TestCueboardTriageSystemPromptMatchesLegacyPrompt(t *testing.T) {
	t.Parallel()

	expected, err := os.ReadFile("testdata/cueboard_triage_system_prompt.txt")
	if err != nil {
		t.Fatalf("read legacy prompt fixture: %v", err)
	}
	if got := strings.TrimRight(cueboardTriageSystemPrompt, "\n"); got != strings.TrimRight(string(expected), "\n") {
		t.Fatalf("cueboard triage prompt drifted from legacy fixture\n--- got ---\n%s\n--- want ---\n%s", got, string(expected))
	}
}

func TestBuildSlackTriagePromptUsesCueboardTwoPassPolicy(t *testing.T) {
	t.Parallel()

	prompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID: "C123",
		Digest:    "https://meet.google.com/abc-defg-hij crash follow-up",
	})
	for _, want := range []string{
		cueboardTriageSystemPrompt,
		"## Pass 1: classify without tools",
		"ACT — explicit ask",
		"MAYBE — low-stakes thread",
		"SKIP — routine discussion",
		"## Pass 2: investigate with tools",
		`slack_api(method="conversations.replies")`,
		`use suggest_action(action_type="join_meeting") immediately`,
		"For meaningful external links, read first",
		"shared article, PDF, technical post, RFC, or long-form thread",
		"one lightweight synthesis / initial opinion",
		"Shared article/PDF links are synthesis-eligible",
		"slack.postThreadReply for verified facts",
		"followup_memory when a concrete follow-up should not evaporate",
		"Know your lane: technical implementation is not your job",
		"Match the language of the thread you act on",
		"Casual chat exception",
		"No markdown tables.",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("triage prompt missing cueboard policy %q:\n%s", want, prompt)
		}
	}
	for _, unwanted := range []string{
		"You are porting Legacy Slack Agent triage behavior.",
		"Confirmation cards are only for external mutations",
		"Use `post_thread_reply`",
	} {
		if strings.Contains(prompt, unwanted) {
			t.Fatalf("triage prompt still contains invented/paraphrased policy %q:\n%s", unwanted, prompt)
		}
	}
}

func TestCueboardDefaultPromptsCarryLegacyToolFirstRules(t *testing.T) {
	t.Parallel()

	for _, want := range []string{
		"MeetingCopilotSystemPrompt",
		"send_meeting_chat",
		"notify_meeting_slack",
		"Passive by default",
	} {
		if want == "MeetingCopilotSystemPrompt" {
			continue
		}
		if !strings.Contains(cueboardMeetingCopilotSystemPrompt, want) {
			t.Fatalf("meeting copilot prompt missing %q:\n%s", want, cueboardMeetingCopilotSystemPrompt)
		}
	}
	for _, want := range []string{
		"## Tool-first defaults",
		"heartbeat or runtime questions → call runtime_status first",
		`a Google Meet URL appears in the current thread → use suggest_action(action_type="join_meeting")`,
		`requested screenshots or local files → use slack_api(method="slack.uploadFile", params={...})`,
		"Match the tone and formality level of the conversation.",
		"Reply in the SAME language as the user's message.",
	} {
		if !strings.Contains(cueboardDefaultSystemPromptTemplate, want) {
			t.Fatalf("default prompt missing %q:\n%s", want, cueboardDefaultSystemPromptTemplate)
		}
	}
	if ActionTypeJoinMeeting != "join_meeting" || PendingActionStatusPending != "pending" || PendingActionStatusConfirmed != "confirmed" || PendingActionStatusDismissed != "dismissed" {
		t.Fatalf("cueboard action/status aliases drifted")
	}
}

func TestSlackTriageFallbackDoesNotInventPendingActionCards(t *testing.T) {
	t.Parallel()

	fallback := suggestSlackTriageFallback("C123", []SlackInboundMessage{{
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "need follow up on the blocked deploy",
		TS:        "123.456",
	}})
	if len(fallback.Actions) != 0 {
		t.Fatalf("fallback actions = %#v, want no invented pending action cards", fallback.Actions)
	}
	if fallback.Channel != "C123" || fallback.ThreadTS != "123.456" {
		t.Fatalf("fallback = %#v, want source channel/thread retained", fallback)
	}
}
