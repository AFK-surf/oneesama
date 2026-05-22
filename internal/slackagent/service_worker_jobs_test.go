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

func TestShouldNotPublishWorkerResultAsCanvasForFetchCanvasEvidencePrompt(t *testing.T) {
	job := agentrunner.Job{
		Status: agentrunner.StatusCompleted,
		Task:   "Fetch the full thread context and any linked files/canvases. Synthesize a concise answer. Do NOT post to Slack.",
		Context: map[string]any{
			"slackAppMention": SlackAppMentionContext{
				MentionText: "是不是有问题 看看",
			},
		},
	}

	text := strings.Join([]string{
		"从 thread 和历史 memory 里能确认的信息很有限，我先把我看到的和你对齐一下——",
		"",
		"**当前 thread 全貌**",
		"- 用户提了一个 bot 爬点子的想法",
		"",
		"**我查到的**",
		"- 没有直接相关的历史讨论",
		"",
		"**需要补充**",
		"- API 返回样例或错误日志",
	}, "\n")
	if shouldPublishWorkerResultAsCanvas(job, text) {
		t.Fatal("worker prompt mentioning linked files/canvases should not imply Canvas publication")
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

func TestSlackWorkerResultTextSilentOnTransitionalAnnouncement(t *testing.T) {
	job := agentrunner.Job{
		Status: agentrunner.StatusCompleted,
		Result: `"卡片"和"notch"在这里应该是指 app 里的 UI 通知组件。让我找找相关的 notification/通知实现代码。`,
	}
	if got := slackWorkerResultText(job); got != "" {
		t.Fatalf("slackWorkerResultText() = %q, want empty string (silent) for transitional announcement", got)
	}
}

func TestSlackWorkerResultTextSilentOnUnverifiableSecretaryLookupSpeculation(t *testing.T) {
	job := agentrunner.Job{
		Status: agentrunner.StatusCompleted,
		Result: strings.Join([]string{
			"从 Cue 共享链接只拿到 `# Bridge\\nLoading shared chat…`，实际聊天内容没加载出来，所以没法直接看到那次对话的细节。",
			"但结合 repo 和 memory 证据，可以拼出概况：压缩视频慢很可能是在找工具。",
		}, "\n"),
		Context: map[string]any{
			"source":       "persona_delegate_worker",
			"session_kind": agentrunner.SessionKindSecretaryLookup,
		},
	}
	if got := slackWorkerResultText(job); got != "" {
		t.Fatalf("slackWorkerResultText() = %q, want empty string (silent) for unverifiable secretary speculation", got)
	}
}

func TestSlackWorkerResultTextKeepsVerifiedSecretaryLookupJSONAnswer(t *testing.T) {
	const answer = "Johnson8053 是队友 HN 小号。证据：HN profile 注册于 2024-09、karma 33，历史发帖集中在 affine/bridge。"
	job := agentrunner.Job{
		Status: agentrunner.StatusCompleted,
		Result: `{
			"visible_text":"Johnson8053 是队友 HN 小号。证据：HN profile 注册于 2024-09、karma 33，历史发帖集中在 affine/bridge。",
			"evidence_anchors":[{"kind":"fetched_link","source_ref":"https://news.ycombinator.com/user?id=Johnson8053","quote":"created 2024-09 / karma 33"}]
		}`,
		Context: map[string]any{
			"source":       "persona_delegate_worker",
			"session_kind": agentrunner.SessionKindSecretaryLookup,
		},
	}
	if got := slackWorkerResultText(job); got != answer {
		t.Fatalf("slackWorkerResultText() = %q, want verified answer %q", got, answer)
	}
}

func TestSlackWorkerResultTextSilentOnSecretaryLookupWithoutEvidenceAnchors(t *testing.T) {
	job := agentrunner.Job{
		Status: agentrunner.StatusCompleted,
		Result: "Johnson8053 是队友 HN 小号。证据：HN profile 注册于 2024-09、karma 33。",
		Context: map[string]any{
			"source":       "persona_delegate_worker",
			"session_kind": agentrunner.SessionKindSecretaryLookup,
		},
	}
	if got := slackWorkerResultText(job); got != "" {
		t.Fatalf("slackWorkerResultText() = %q, want silent for secretary_lookup without typed evidence anchors", got)
	}
}

func TestSlackWorkerResultTextKeepsNormalWorkerAnswer(t *testing.T) {
	const answer = "我看完了，这个线程主要是在讨论 Canvas parity。"
	got := slackWorkerResultText(agentrunner.Job{Status: agentrunner.StatusCompleted, Result: answer})
	if got != answer {
		t.Fatalf("slackWorkerResultText() = %q, want unchanged answer %q", got, answer)
	}
}

func TestSlackWorkerResultTextUsesBoundedEnvelope(t *testing.T) {
	longAnswer := "结论：可以复用 harness envelope。\n" + strings.Repeat("长段落", 6000)
	got := slackWorkerResultText(agentrunner.Job{Status: agentrunner.StatusCompleted, Result: longAnswer})
	if len([]rune(got)) > 12000 {
		t.Fatalf("slackWorkerResultText length = %d, want bounded", len([]rune(got)))
	}
	if !strings.Contains(got, "[worker result truncated]") {
		t.Fatalf("slackWorkerResultText() = %q, want truncation marker", got)
	}
}

func TestSlackWorkerPostFailsClosedWithoutVisibleFallback(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{Poster: poster})
	delivered := service.postSlackWorkerResult(context.Background(), agentrunner.Job{
		ID:          "job_timeout",
		Status:      agentrunner.StatusTimeout,
		FailureCode: agentrunner.FailureTimeout,
		Result:      "partial raw scratch: opened 200 files and started reading logs",
		Error:       "job timed out",
		Context: map[string]any{
			"source": "slack-agent",
			"slack":  map[string]any{"channelId": "C123", "threadTs": "177.123"},
		},
	})
	if delivered {
		t.Fatal("postSlackWorkerResult delivered timeout worker, want fail-closed silence")
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no user-visible fallback", calls)
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

func TestAgentRunnerProgressSkipsPersonaDelegateWorkerAssistantStatus(t *testing.T) {
	assistant := &recordingAssistant{}
	service := NewService(Config{Assistant: assistant})

	service.handleAgentRunnerProgress(context.Background(), agentrunner.Job{
		ID:       "job_persona_delegate",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
		Context: map[string]any{
			"source": "persona_delegate_worker",
			"slack": map[string]any{
				"channel_id": "C123",
				"thread_ts":  "1779442219.313689",
			},
		},
	})

	if calls := assistant.Calls(); len(calls) != 0 {
		t.Fatalf("assistant calls = %#v, want no shimmer/status for persona triage worker progress", calls)
	}
}

func TestAgentRunnerUpdateRemovesEyesForSilentPersonaDelegateResult(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	reactions := &recordingReactions{}
	service := NewService(Config{
		Poster:    poster,
		Reactions: reactions,
	})

	service.handleAgentRunnerUpdate(context.Background(), agentrunner.Job{
		ID:     "job_unverified_secretary",
		Status: agentrunner.StatusCompleted,
		Result: strings.Join([]string{
			"从 Cue 共享链接只拿到 `# Bridge\\nLoading shared chat…`，实际聊天内容没加载出来。",
			"但结合 repo 和 memory 证据，可以拼出概况。",
		}, "\n"),
		Context: map[string]any{
			"source":       "persona_delegate_worker",
			"session_kind": agentrunner.SessionKindSecretaryLookup,
			"slack": map[string]any{
				"channel_id":  "C123",
				"thread_ts":   "177.123",
				"reaction_ts": "177.111",
			},
		},
	})

	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no Slack post", calls)
	}
	assertReactionCalls(t, reactions.Calls(), []reactionCall{
		{Method: "remove", Channel: "C123", Timestamp: "177.111", Name: slackReactionEyes},
	})
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

func TestSlackWorkerMemorySyncUsesBoundedEnvelopeNotRawScratch(t *testing.T) {
	t.Parallel()

	provider := &simpleRecordingMemoryProvider{name: "turn_fake", available: true}
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Slack:           appconfig.SlackConfig{WorkspaceDir: t.TempDir()},
		MemoryProviders: []SlackMemoryProvider{provider},
		Poster:          poster,
	})
	rawTailSentinel := "RAW_WORKER_TAIL_SHOULD_NOT_ENTER_MEMORY"
	assistantText := "结论：这个 worker 有结果。\n" + strings.Repeat("scratch-log-line ", 1200) + rawTailSentinel

	service.handleAgentRunnerUpdate(context.Background(), completedWorkerJob("job_turn_bounded", "session_turn_bounded", "查一下这个长日志", assistantText))

	if len(provider.turns) != 1 {
		t.Fatalf("provider turns = %#v, want one SyncTurn", provider.turns)
	}
	got := provider.turns[0]
	if strings.Contains(got.AssistantContent, rawTailSentinel) {
		t.Fatalf("AssistantContent leaked raw tail sentinel: %q", got.AssistantContent)
	}
	if len(got.AssistantContent) > slackMemoryProviderTurnBudgetChars+3 {
		t.Fatalf("AssistantContent length = %d, want memory turn budget", len(got.AssistantContent))
	}
	if got.Metadata["worker_result_envelope_schema"] != agentrunner.WorkerResultEnvelopeSchema {
		t.Fatalf("turn metadata = %#v, want worker result envelope schema", got.Metadata)
	}
	if got.Metadata["worker_result_envelope_truncated"] != true {
		t.Fatalf("turn metadata = %#v, want truncated envelope marker", got.Metadata)
	}
}
