//go:build cueboardparity

package slackagent

import (
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityLocalMemoryMissingDirIsSafe(t *testing.T) {
	t.Parallel()

	memory := newLocalSlackMemory(appconfig.SlackMemoryConfig{Enabled: true, Dir: filepath.Join(t.TempDir(), "missing")})
	summary := memory.Summary()
	if summary.FileCount != 0 || !summary.Enabled {
		t.Fatalf("summary = %#v, want enabled memory with no files", summary)
	}
	if got := memory.Search("anything", 5); len(got) != 0 {
		t.Fatalf("Search missing dir = %#v, want empty", got)
	}
}

func TestCueboardParityLocalMemorySearchesAllowedFilesOnly(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "workspace", "MEMORY.md"), "launch checklist lives here")
	writeTestFile(t, filepath.Join(root, "workspace", "memory", "team.md"), "launch owners are Alice and Peng")
	writeTestFile(t, filepath.Join(root, "workspace", "SOUL.md"), "launch should be ignored")
	writeTestFile(t, filepath.Join(root, "workspace", "notes.txt"), "launch should be ignored")

	results := newLocalSlackMemory(appconfig.SlackMemoryConfig{Enabled: true, Dir: root}).Search("launch", 10)
	if len(results) != 2 {
		t.Fatalf("results = %#v, want MEMORY.md and memory/*.md only", results)
	}
	sources := []string{results[0].Source, results[1].Source}
	joined := strings.Join(sources, "\n")
	for _, want := range []string{"MEMORY.md", "memory/team.md"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("sources = %#v, missing %q", sources, want)
		}
	}
	for _, unwanted := range []string{"SOUL.md", "notes.txt"} {
		if strings.Contains(joined, unwanted) {
			t.Fatalf("sources = %#v, should not include %q", sources, unwanted)
		}
	}
}

func TestCueboardParityLocalMemorySnippetTruncatesUTF8(t *testing.T) {
	t.Parallel()

	got := memorySnippet(strings.Repeat("你", slackMemorySnippetLimit+20))
	if !strings.HasSuffix(got, "...") {
		t.Fatalf("snippet suffix = %q, want ellipsis", got[len(got)-3:])
	}
	if !utf8.ValidString(got) || strings.Contains(got, "�") {
		t.Fatalf("snippet should stay valid UTF-8: %q", got)
	}
}

func TestCueboardParityBuildAgentRunnerContextCarriesLocalMemoryBehindAdapter(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "workspace", "MEMORY.md"), "launch checklist should be remembered")
	service := NewService(Config{
		Slack: appconfig.SlackConfig{Memory: appconfig.SlackMemoryConfig{Enabled: true, Dir: root}},
	})

	context := service.buildAgentRunnerContext(AvatarCommandInput{
		TeamID:      "W1",
		ChannelID:   "C1",
		ChannelName: "launch",
		ThreadTS:    "123.456",
		UserID:      "U1",
		UserName:    "Peng",
		Command:     "app_mention",
		RichThreadContext: &SlackAppMentionContext{
			MentionText: "what about the launch checklist?",
			Transcript:  "Alice asked about launch checklist owners.",
		},
	}, parsedAvatarCommand{Action: "delegate", Task: "summarize"}, nil)

	memory, ok := context["localSlackMemory"].(SlackMemoryAgentContext)
	if !ok || !memory.Enabled || memory.ResultCount == 0 {
		t.Fatalf("localSlackMemory = %#v, want enabled adapter result", context["localSlackMemory"])
	}
	if !strings.Contains(memory.Provenance, "private Slack Agent D memory seed") {
		t.Fatalf("provenance = %q, want private adapter boundary", memory.Provenance)
	}
}

func TestCueboardParityTriagePromptPolicyRails(t *testing.T) {
	t.Parallel()

	prompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID: "C1",
		Digest:    "https://meet.google.com/abc-defg-hij crash follow-up",
	})
	for _, want := range []string{
		"Pass 1: classify without tools",
		"ACT — explicit ask",
		"MAYBE — low-stakes thread",
		"SKIP — routine discussion",
		"Pass 2: investigate with tools",
		`slack_api(method="conversations.replies")`,
		"Casual chat exception",
		"one short reply",
		"it adds something new",
		"sounds natural out loud",
		"Facts for facts.",
		"slack.postThreadReply for verified facts",
		"suggest_action for mutations needing confirmation",
		"followup_memory when a concrete follow-up should not evaporate",
		"For meaningful external links, read first",
		"technical threads that have clearly stalled",
		"do not do the debugging yourself",
		"Meet links are a strong action signal",
		"join_meeting",
		"Product-risk threads are not ordinary chatter",
		"People talking to each other is not an auto-SKIP",
		"Do not let follow-ups evaporate",
		"Know your lane: technical implementation is not your job",
		"Match the language of the thread you act on",
		"shared article, PDF, technical post, RFC, or long-form thread",
		"Shared article/PDF links are synthesis-eligible",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("triage prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestCueboardParityTriagePromptStaysCompactAndAvoidsPrivateExamples(t *testing.T) {
	t.Parallel()

	prompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID: "C1",
		Messages:  []SlackInboundMessage{{UserID: "U1", Text: "hello", TS: "1.0"}},
	})
	if got := utf8.RuneCountInString(prompt); got > 5000 {
		t.Fatalf("triage prompt runes = %d, want <= 5000", got)
	}
	for _, unwanted := range []string{"Haowen", "Jiachen", "Zijian", "onee_sama", "onee-sama", "#watercooler", "#general", "CUE-42"} {
		if strings.Contains(prompt, unwanted) {
			t.Fatalf("triage prompt leaked private example %q:\n%s", unwanted, prompt)
		}
	}
}

func TestCueboardParitySlackInboundMessageFromEvent(t *testing.T) {
	t.Parallel()

	message := slackInboundMessageFromEvent(SlackEventEnvelope{TeamID: "W1"}, SlackEventPayload{
		User:    "U-outer",
		Text:    "outer",
		Channel: "C1",
		TS:      "2.0",
		EventTS: "2.1",
		Message: &SlackMessage{
			User:     "U123",
			Text:     "hello world",
			TS:       "123.456",
			EventTS:  "123.457",
			ThreadTS: "100.000",
			Subtype:  "file_share",
			Files:    []SlackFile{{ID: "F123", Name: "image.png"}},
		},
	})
	if message.TeamID != "W1" || message.UserID != "U123" || message.Text != "hello world" {
		t.Fatalf("message = %#v, want nested user/text/team", message)
	}
	if message.TS != "123.456" || message.EventTS != "123.457" || message.ThreadTS != "100.000" || message.Subtype != "file_share" {
		t.Fatalf("message timestamps/subtype = %#v", message)
	}
	if len(message.Files) != 1 || message.Files[0].Name != "image.png" {
		t.Fatalf("files = %#v, want nested file copied", message.Files)
	}
}

func TestCueboardParityShouldIgnoreScannerInboundMessage(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		message SlackInboundMessage
		want    bool
	}{
		{name: "normal user message", message: SlackInboundMessage{ChannelID: "C1", UserID: "U123", Text: "hello"}, want: false},
		{name: "empty user ignored", message: SlackInboundMessage{ChannelID: "C1", Text: "hello"}, want: true},
		{name: "bot mention ignored", message: SlackInboundMessage{ChannelID: "C1", UserID: "U123", Text: "<@UBOT> summarize"}, want: true},
		{name: "bot message ignored", message: SlackInboundMessage{ChannelID: "C1", UserID: "U123", BotID: "B123", Text: "hello"}, want: true},
		{name: "unsupported subtype ignored", message: SlackInboundMessage{ChannelID: "C1", UserID: "U123", Subtype: "channel_join", Text: "joined"}, want: true},
		{name: "file share with no text still kept", message: SlackInboundMessage{ChannelID: "C1", UserID: "U123", Subtype: "file_share", Files: []SlackFile{{ID: "F123", Name: "image.png"}}}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldIgnoreScannerInboundMessage(tt.message, "UBOT"); got != tt.want {
				t.Fatalf("shouldIgnoreScannerInboundMessage() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCueboardParityRenderSlackActivityDigestIncludesFileShare(t *testing.T) {
	t.Parallel()

	digest := renderSlackActivityDigest("C1", []SlackInboundMessage{{
		ChannelID: "C1",
		UserID:    "U123",
		TS:        "123.456",
		Subtype:   "file_share",
		Files:     []SlackFile{{Name: "diagram.png", Filetype: "png"}},
	}})
	if !strings.Contains(digest, "name: diagram.png") {
		t.Fatalf("digest = %s, want cueboard file metadata", digest)
	}
}

func TestCueboardParityRenderSlackActivityDigestUsesScannerContextAndRefs(t *testing.T) {
	t.Parallel()

	digest := renderSlackActivityDigestWithContext("C1", []SlackInboundMessage{{
		ChannelID: "C1",
		UserID:    "U0",
		TS:        "1709812330.000000",
		Text:      "previous context",
	}}, []SlackInboundMessage{{
		ChannelID:  "C1",
		UserID:     "U1",
		TS:         "1709812345.123456",
		Text:       "Let's discuss",
		ReplyCount: 2,
		ReplyUsers: []string{"U2", "U3"},
	}, {
		ChannelID: "C1",
		UserID:    "U2",
		TS:        "1709812346.123456",
		ThreadTS:  "1709812345.123456",
		Text:      "reply detail",
	}})
	for _, want := range []string{
		`(context) <@U0>: "previous context"`,
		"--- new messages ---",
		"--- conversation ---",
		`• [ref:m1 msg_ts:1709812345.123456] <@U1>: "Let's discuss" [thread_ts:1709812345.123456, 2 replies, 2 participants]`,
		`• [ref:m2 msg_ts:1709812346.123456] <@U2>: "reply detail" [reply in thread_ts:1709812345.123456]`,
	} {
		if !strings.Contains(digest, want) {
			t.Fatalf("digest missing %q:\n%s", want, digest)
		}
	}
}
