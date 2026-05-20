package slackagent

import (
	"context"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestShouldPublishWorkerResultAsCanvasWhenMentionRequestsCanvas(t *testing.T) {
	job := agentrunner.Job{
		Status: agentrunner.StatusCompleted,
		Task:   "看看这个，给一版本 what's new，写 canvas 里",
		Context: map[string]any{
			"slackAppMention": SlackAppMentionContext{
				MentionText: "看看这个，给一版本 what's new，写 canvas 里",
			},
		},
	}

	text := "# What's New\n\n- 新增 meeting avatar Canvas parity。\n"
	if !shouldPublishWorkerResultAsCanvas(job, text) {
		t.Fatal("expected explicit Canvas request to publish worker result as canvas")
	}
}

func TestShouldNotPublishShortWorkerResultAsCanvasWithoutIntent(t *testing.T) {
	job := agentrunner.Job{
		Status: agentrunner.StatusCompleted,
		Task:   "总结一下这个线程",
	}

	if shouldPublishWorkerResultAsCanvas(job, "我看完了，这里主要是在讨论发版节奏。") {
		t.Fatal("short worker result without Canvas intent should remain a thread reply")
	}
}

func TestWorkerResultCanvasInputReusesExistingCanvasFile(t *testing.T) {
	job := agentrunner.Job{
		ID: "job_123",
		Context: map[string]any{
			"slackAppMention": SlackAppMentionContext{
				CanvasFiles: []SlackThreadFile{{ID: "F0B4GEERALD", Title: "What's New"}},
			},
		},
	}

	input := workerResultCanvasInput(job, AssistantThreadRef{ChannelID: "C123", ThreadTS: "123.456"}, "# What's New\n\n- shipped", "job_123")
	if input.CanvasID != "F0B4GEERALD" {
		t.Fatalf("CanvasID = %q, want existing canvas file", input.CanvasID)
	}
	if input.Operation != "insert_at_end" {
		t.Fatalf("Operation = %q, want insert_at_end", input.Operation)
	}
	if input.Title != "What's New" {
		t.Fatalf("Title = %q, want existing canvas title", input.Title)
	}
}

func TestSlackWorkerResultTextSilentOnInternalGatewayLeak(t *testing.T) {
	job := agentrunner.Job{
		Status: agentrunner.StatusCompleted,
		Result: "我试着 curl http://127.0.0.1:8780/slack/tools/call，但是 connection refused，所以拿不到资料。",
	}
	if got := slackWorkerResultText(job); got != "" {
		t.Fatalf("slackWorkerResultText() = %q, want empty string (silent) when result leaks internal gateway", got)
	}
}

func TestSlackWorkerResultTextKeepsNormalWorkerAnswer(t *testing.T) {
	const answer = "我看完了，这个线程主要是在讨论 Canvas parity。"
	got := slackWorkerResultText(agentrunner.Job{Status: agentrunner.StatusCompleted, Result: answer})
	if got != answer {
		t.Fatalf("slackWorkerResultText() = %q, want unchanged answer %q", got, answer)
	}
}

func TestSlackWorkerResultTextSilentOnNonCompletedStates(t *testing.T) {
	// Every non-completed state must yield empty text so postSlackWorkerResult
	// skips the Slack post entirely. Status is conveyed via the mention
	// reaction, not via hardcoded user-facing template strings. Anchor: #299
	// retrospective on "我处理完了" fallback that was claiming completion of
	// nothing — silence is the correct state for failure / timeout / canceled.
	cases := []struct {
		name string
		job  agentrunner.Job
	}{
		{"empty_completed", agentrunner.Job{Status: agentrunner.StatusCompleted, Result: "   "}},
		{"timeout_via_status", agentrunner.Job{Status: agentrunner.StatusTimeout, Error: "job timed out", Result: "partial: started inspecting staging deploy logs..."}},
		{"timeout_via_failure_code", agentrunner.Job{Status: agentrunner.StatusFailed, FailureCode: agentrunner.FailureTimeout, Error: "job timed out"}},
		{"provider_auth_failure", agentrunner.Job{Status: agentrunner.StatusFailed, FailureCode: agentrunner.FailureProviderAuth, Error: "401 unauthorized"}},
		{"canceled_failure", agentrunner.Job{Status: agentrunner.StatusFailed, FailureCode: agentrunner.FailureCanceled, Error: "job canceled"}},
		{"generic_failed", agentrunner.Job{Status: agentrunner.StatusFailed, Error: "boom"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := slackWorkerResultText(tc.job); got != "" {
				t.Fatalf("slackWorkerResultText() = %q, want empty (silent) for %s", got, tc.name)
			}
		})
	}
}

func TestSlackWorkerToolRequestStartsContinuationWithDispatcherEvidence(t *testing.T) {
	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/bridge-tools.md", strings.Join([]string{
		"# Bridge tools",
		"Old Agent D used native tool loops instead of prompt-only localhost curl.",
	}, "\n"))
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_followup",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
		Mode:     "analysis",
	}}
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Slack:  appconfig.SlackConfig{WorkspaceDir: workspaceDir},
		Runner: runner,
		Poster: poster,
	})

	service.handleAgentRunnerUpdate(context.Background(), agentrunner.Job{
		ID:       "job_tool_request",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Mode:     "analysis",
		Task:     "Bridge tool-loop parity 是怎么回事？",
		Result: strings.Join([]string{
			"<oneesama_tool_request>",
			`{"calls":[{"tool":"memory_search","args":{"query":"Bridge native tool loop localhost curl","limit":3}}],"reason":"need old/new tool-loop evidence"}`,
			"</oneesama_tool_request>",
		}, "\n"),
		Context: map[string]any{
			"source": "slack-agent",
			"slack":  map[string]any{"channelId": "C123", "threadTs": "177.123"},
		},
	})

	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want no raw tool-request Slack post", got)
	}
	if runner.startCount != 1 {
		t.Fatalf("runner starts = %d, want continuation job", runner.startCount)
	}
	evidence, ok := runner.startInput.Context["slackToolEvidence"].(string)
	if !ok || !strings.Contains(evidence, "Worker-requested dispatcher evidence") || !strings.Contains(evidence, "memory_search (ok)") || !strings.Contains(evidence, "Bridge tools") {
		t.Fatalf("slackToolEvidence = %q, want dispatcher memory evidence", evidence)
	}
	if !strings.Contains(runner.startInput.Task, "Continue the Slack thread reply") || !strings.Contains(runner.startInput.Task, "Original task: Bridge tool-loop parity") {
		t.Fatalf("continuation task = %q", runner.startInput.Task)
	}
}

func TestSlackWorkerToolBridgeFailureClearsStatusAndWarnsReaction(t *testing.T) {
	assistant := &recordingAssistant{}
	reactions := &recordingReactions{}
	service := NewService(Config{
		Assistant: assistant,
		Reactions: reactions,
	})

	service.handleAgentRunnerUpdate(context.Background(), agentrunner.Job{
		ID:       "job_tool_request_no_runner",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Mode:     "analysis",
		Task:     "Need a tool call.",
		Result: strings.Join([]string{
			"<oneesama_tool_request>",
			`{"calls":[{"tool":"memory_search","args":{"query":"Bridge native tool loop","limit":3}}],"reason":"need evidence"}`,
			"</oneesama_tool_request>",
		}, "\n"),
		Context: map[string]any{
			"source":                      "slack-agent",
			slackWorkerToolLoopContextKey: slackWorkerToolLoopMax,
			"slack": map[string]any{
				"channelId":  "C123",
				"threadTs":   "177.123",
				"reactionTs": "177.122",
			},
		},
	})

	calls := assistant.Calls()
	if len(calls) != 1 || calls[0].Status != "" {
		t.Fatalf("assistant calls = %#v, want one clear-status call", calls)
	}
	assertReactionCalls(t, reactions.Calls(), []reactionCall{
		{Method: "remove", Channel: "C123", Timestamp: "177.122", Name: slackReactionEyes},
		{Method: "add", Channel: "C123", Timestamp: "177.122", Name: slackReactionWarn},
	})
}

func TestSlackWorkerToolRequestRejectsUnsafeSlackPost(t *testing.T) {
	request, ok := parseSlackWorkerToolBridgeRequest(strings.Join([]string{
		"<oneesama_tool_request>",
		`{"calls":[{"tool":"slack_api","args":{"method":"chat.postMessage","params":{"channel":"C123","text":"hi"}}}]}`,
		"</oneesama_tool_request>",
	}, "\n"))
	if !ok {
		t.Fatal("expected tool bridge request to parse")
	}
	evidence := NewService(Config{}).executeSlackWorkerToolBridgeRequest(context.Background(), request, nil)
	if len(evidence) != 1 || evidence[0].OK || !strings.Contains(evidence[0].Error, "not available") {
		t.Fatalf("evidence = %#v, want rejected unsafe Slack post", evidence)
	}
}
