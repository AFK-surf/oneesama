package slackagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityWorkerResultUsesMrkdwnBlocks(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
	})

	service.handleAgentRunnerUpdate(context.Background(), agentrunner.Job{
		ID:       "job_markdown_blocks",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   "## 结论\n\n**重点**：用 Canvas 承载长文。\n\n| 项 | 说明 |\n| --- | --- |\n| A | B |",
		Context: map[string]any{
			"slack": map[string]any{"channelId": "C123", "threadTs": "1778772007.043069"},
		},
	})

	poster.WaitForCalls(t, 1)
	call := poster.Calls()[0]
	if len(call.Blocks) == 0 {
		t.Fatalf("post call = %#v, want Block Kit mrkdwn blocks", call)
	}
	if strings.Contains(call.Text, "**") || strings.Contains(call.Text, "| --- |") {
		t.Fatalf("fallback text = %q, want Slack mrkdwn/plain fallback instead of raw Markdown", call.Text)
	}
	for _, block := range call.Blocks {
		if block["block_id"] == replyFeedbackBlockID {
			t.Fatalf("worker result should not add feedback footer block: %#v", call.Blocks)
		}
	}
}

func TestCueboardParityTriageDirectReplyUsesMrkdwnBlocks(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
	})

	calls, failures, mutations := service.executeSlackTriageDirectActions(context.Background(), "W1", "C123", "1778772007.043069", 42, []SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "补充说明",
		Message:              "## 说明\n\n**这条**可以直接回答。",
		ChannelID:            "C123",
		ThreadTS:             "1778772007.043069",
		RequiresConfirmation: false,
	}})
	if failures != 0 || mutations != 1 || len(calls) != 1 || !calls[0].Success {
		t.Fatalf("calls=%#v failures=%d mutations=%d, want one successful direct reply", calls, failures, mutations)
	}
	poster.WaitForCalls(t, 1)
	call := poster.Calls()[0]
	if len(call.Blocks) == 0 {
		t.Fatalf("post call = %#v, want Block Kit mrkdwn blocks", call)
	}
	if strings.Contains(call.Text, "**") || strings.Contains(call.Text, "##") {
		t.Fatalf("fallback text = %q, want Slack mrkdwn/plain fallback instead of raw Markdown", call.Text)
	}
}

func TestCueboardParityLongWorkerResultPublishesCanvas(t *testing.T) {
	canvas := &recordingCanvasPublisher{}
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence:           appconfig.PersistenceConfig{Provider: "memory"},
		Poster:                poster,
		CanvasPublisher:       canvas,
		CanvasPublisherConfig: CanvasPublisherConfig{Provider: "slack-canvas"},
	})
	longDraft := "# Slack Bot Team 架构介绍文稿\n\n" +
		strings.Repeat("这一段介绍巡游 bot、工作 bot、桌面环境分配机制，以及 harness 的三个核心能力。\n\n", 45)

	service.handleAgentRunnerUpdate(context.Background(), agentrunner.Job{
		ID:       "job_long_doc",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   longDraft,
		Context: map[string]any{
			"slack": map[string]any{"channelId": "C123", "threadTs": "1778772007.043069"},
			"slackAppMention": map[string]any{
				"mentionText": "看到我后面补充的了吗？",
				"canvasFiles": []any{map[string]any{"id": "F0B3RNQH04V", "title": "Slack Bot Team 架构介绍文稿"}},
			},
		},
	})

	inputs := canvas.Inputs()
	if len(inputs) != 1 {
		t.Fatalf("canvas inputs = %d, want one canvas publish", len(inputs))
	}
	input := inputs[0]
	if !input.ForceSlackCanvas || input.Channel != "C123" || input.ThreadTS != "1778772007.043069" {
		t.Fatalf("canvas input = %#v, want native Slack Canvas publish back to source thread", input)
	}
	if !strings.Contains(input.SummaryMarkdown, "桌面环境分配机制") {
		t.Fatalf("canvas markdown missing worker draft:\n%s", input.SummaryMarkdown)
	}
	if !strings.Contains(input.NotificationText, "{{canvas_link}}") ||
		!strings.Contains(input.NotificationText, "新版") {
		t.Fatalf("notification = %q, want short revised Canvas notification", input.NotificationText)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want long draft routed through Canvas publisher only", calls)
	}
}

func TestCueboardParityServiceBootstrapsWorkspaceTemplatesOnStartup(t *testing.T) {
	workspace := t.TempDir()

	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspace},
	})

	if service.workspaceDir != workspace {
		t.Fatalf("workspaceDir = %q, want %q", service.workspaceDir, workspace)
	}
	for _, rel := range []string{"AGENTS.md", "SOUL.md", "CODEX_GUIDANCE.md", filepath.Join("docs", "slack-tools.md")} {
		if _, err := os.Stat(filepath.Join(workspace, rel)); err != nil {
			t.Fatalf("expected startup bootstrap file %s: %v", rel, err)
		}
	}
}

func TestCueboardParityTriageSuppressesCasualRepliesInActiveThreads(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "W1",
		ChannelID: "C123",
		UserID:    "U123",
		TS:        "1778774118.638859",
		ThreadTS:  "1778772007.043069",
		Text:      "还有一些对现有模型的妥协：比如 GPT 会异常终止，所以必须显式调用终止 tool",
	}}
	actions := filterSlackTriageActionsForMessages([]SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "GPT reliability note",
		Message:              "这个设计挺务实的，GPT 异常终止确实是个真实痛点。",
		ChannelID:            "C123",
		ThreadTS:             "1778772007.043069",
		Confidence:           0.72,
		RequiresConfirmation: false,
	}}, messages, "UBOT")

	if len(actions) != 0 {
		t.Fatalf("actions = %#v, want casual triage reply suppressed in active human/assistant thread", actions)
	}
}

func TestCueboardParityTriageSuppressesUnmentionedObservationDirectReplies(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "W1",
		ChannelID: "C123",
		UserID:    "U123",
		TS:        "1778779797.697749",
		Text:      "这个onboarding-bot-hourly刷屏了",
	}}
	actions := filterSlackTriageActionsForMessages([]SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "bot noise",
		Message:              "看到了，确实在刷屏。",
		ChannelID:            "C123",
		ThreadTS:             "1778779797.697749",
		Confidence:           0.72,
		RequiresConfirmation: false,
	}}, messages, "UBOT")

	if len(actions) != 0 {
		t.Fatalf("actions = %#v, want unmentioned observation to stay silent instead of casual triage reply", actions)
	}
}

func TestCueboardParityTriageSuppressesRepliesWhenAnotherUserIsMentioned(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "W1",
		ChannelID: "C123",
		UserID:    "U123",
		TS:        "1778808469.644499",
		ThreadTS:  "1778779797.697749",
		Text:      "prod Willow/control DB 里查到了吗 <@UOTHER> `name = 'onboarding-bot-hourly'` 查 `schedules`",
	}}
	actions := filterSlackTriageActionsForMessages([]SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "wrong target",
		Message:              "不是我设置的。",
		ChannelID:            "C123",
		ThreadTS:             "1778779797.697749",
		Confidence:           0.9,
		RequiresConfirmation: false,
	}, {
		Type:                 "create_issue",
		Title:                "track onboarding bot",
		Message:              "Track onboarding bot schedule.",
		ChannelID:            "C123",
		ThreadTS:             "1778779797.697749",
		Confidence:           0.8,
		RequiresConfirmation: true,
	}}, messages, "UBOT")

	if len(actions) != 0 {
		t.Fatalf("actions = %#v, want triage fully silent when the latest message mentions another user but not the bot", actions)
	}
}

func TestCueboardParityTriageKeepsExplicitThreadRequests(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "W1",
		ChannelID: "C123",
		UserID:    "U123",
		TS:        "1778774034.016459",
		ThreadTS:  "1778772007.043069",
		Text:      "看看补充的信息",
	}}
	actions := filterSlackTriageActionsForMessages([]SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "补充信息总结",
		Message:              "补充信息主要是 harness 三个核心能力。",
		ChannelID:            "C123",
		ThreadTS:             "1778772007.043069",
		Confidence:           0.86,
		RequiresConfirmation: false,
	}}, messages, "UBOT")

	if len(actions) != 1 {
		t.Fatalf("actions = %#v, want explicit inspect/summarize thread request kept", actions)
	}
}

func TestCueboardParityTriageKeepsExplicitBotMentionReplies(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "W1",
		ChannelID: "C123",
		UserID:    "U123",
		TS:        "1778810926.574949",
		ThreadTS:  "1778779797.697749",
		Text:      "<@UBOT> 你闭嘴",
	}}
	actions := filterSlackTriageActionsForMessages([]SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "ack",
		Message:              "好的，我闭嘴。",
		ChannelID:            "C123",
		ThreadTS:             "1778779797.697749",
		Confidence:           0.9,
		RequiresConfirmation: false,
	}}, messages, "UBOT")

	if len(actions) != 1 {
		t.Fatalf("actions = %#v, want explicit bot mention reply kept", actions)
	}
}

func TestCueboardParityTriageSuppressesUnmentionedBotDiscussionReplies(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "W1",
		ChannelID: "C123",
		UserID:    "U123",
		TS:        "1778845444.339469",
		Text:      "我一动鼠标 agent 怎么就停了？",
	}}
	actions := filterSlackTriageActionsForMessages([]SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "Explain desktop agent",
		Message:              "Agent uses keyboard and mouse control.",
		ChannelID:            "C123",
		ThreadTS:             "1778845444.339469",
		Confidence:           0.9,
		RequiresConfirmation: false,
	}}, messages, "UBOT")

	if len(actions) != 0 {
		t.Fatalf("actions = %#v, want unmentioned bot-discussion reply suppressed", actions)
	}
}

func TestCueboardParityTriageKeepsNamedOneesamaDiscussionReplies(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "W1",
		ChannelID: "C123",
		UserID:    "U123",
		TS:        "1778845444.339469",
		Text:      "oneesama 一动鼠标怎么就停了？",
	}}
	actions := filterSlackTriageActionsForMessages([]SlackTriageDecisionAction{{
		Type:                 "post_thread_reply",
		Title:                "Explain oneesama",
		Message:              "Oneesama uses keyboard and mouse control.",
		ChannelID:            "C123",
		ThreadTS:             "1778845444.339469",
		Confidence:           0.9,
		RequiresConfirmation: false,
	}}, messages, "UBOT")

	if len(actions) != 1 {
		t.Fatalf("actions = %#v, want named oneesama discussion reply kept", actions)
	}
}
