package slackagent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackTriageLivePersonaStaySilentDoesNotPostOldBridgeMentionCandidate(t *testing.T) {
	ctx := context.Background()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_live_persona_old_bridge_mention",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"codex suggested answering old Bridge mention","actions":[{"type":"post_thread_reply","title":"old bridge reply","message":"我来补一个回答。","channelId":"C_TRIAGE","threadTs":"200.000","confidence":0.8,"requiresConfirmation":false}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			BotUserID: "U_ONEE",
			Triage:    appconfig.SlackTriageConfig{ForegroundChain: slackTriageForegroundChainCodexThenPi},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.personaRuntime = &capturePersonaRuntime{response: persona.Response{
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionStaySilent,
		Reason:     "the user addressed another bot identity",
		ShadowOnly: false,
	}}
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "<@U09SF0MQZ5M> 我们讨论过这个 repo 嘛？",
		TS:             "200.000",
	}}, "#meeting-avatar: <@U09SF0MQZ5M> 我们讨论过这个 repo 嘛？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Finalization.Run.ID)
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want no fallback when user addressed old Bridge", got)
	}
	if updated.Mutations != 0 || len(updated.Actions) != 0 {
		t.Fatalf("updated mutations/actions = %d/%#v, want no action", updated.Mutations, updated.Actions)
	}
	foreground, ok := mapFromAny(updated.Metadata["persona_foreground"])
	if !ok {
		t.Fatalf("persona_foreground = %#v, want metadata object", updated.Metadata["persona_foreground"])
	}
	if boolFromAny(foreground["codex_fallback"], false) {
		t.Fatalf("persona_foreground = %#v, want no Codex visible fallback marker", foreground)
	}
	if intFromAny(updated.Metadata["codex_suggested_actions"]) != 0 {
		t.Fatalf("metadata = %#v, want Codex action filtered before persona fallback", updated.Metadata)
	}
}

func TestSlackTriagePiFirstLiveSkipsPrePiRunnerAndPostsPersonaReply(t *testing.T) {
	ctx := context.Background()
	workspaceDir, err := os.MkdirTemp("", "oneesama-pi-first-live-*")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	defer func() { _ = os.RemoveAll(workspaceDir) }()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_should_not_start_before_pi",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"codex should not run","actions":[{"type":"post_thread_reply","message":"wrong"}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			PilotUserID:  "U_PENG",
			Triage: appconfig.SlackTriageConfig{
				ForegroundChain: "pi_first_live",
				WorkspacePolicy: "In this workspace, reply to source-backed product-adjacent articles when evidence is available.",
			},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: "Pi-first 直接评价：这篇文章和我们的产品判断很接近。",
		Reason:      "workspace policy says to engage product-adjacent evidence-backed links",
		Confidence:  0.86,
		Citations:   []persona.Citation{{Kind: "memory", SourceRef: "memory/team/product-links.md:4", Snippet: "这条产品评论文章你怎么看？"}},
		ShadowOnly:  false,
	}}
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "<@U_ONEE> 这条产品评论文章你怎么看？",
		TS:             "220.000",
	}}, "#meeting-avatar: <@U_ONEE> 这条产品评论文章你怎么看？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Job != nil || started.Finalization != nil {
		t.Fatalf("started = %#v, want no pre-Pi agent_runner job/finalization", started)
	}
	if runner.startCount != 0 {
		t.Fatalf("runner.startCount = %d, want no pre-Pi StartTask", runner.startCount)
	}
	poster.WaitForCalls(t, 1)
	if runner.startCount != 0 {
		t.Fatalf("runner.startCount after Pi reply = %d, want no StartTask", runner.startCount)
	}
	if calls := poster.Calls(); len(calls) != 1 || calls[0].Channel != "C_TRIAGE" || calls[0].ThreadTS != "220.000" || !strings.Contains(calls[0].Text, "Pi-first 直接评价") {
		t.Fatalf("poster calls = %#v, want direct Pi-first thread reply", calls)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if updated.Metadata["foreground_chain"] != slackTriageForegroundChainPiFirstLive {
		t.Fatalf("metadata = %#v, want foreground_chain=pi_first_live", updated.Metadata)
	}
	if boolFromAny(updated.Metadata["pre_pi_agent_runner_started"], true) {
		t.Fatalf("metadata = %#v, want pre_pi_agent_runner_started=false", updated.Metadata)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionReply {
		t.Fatalf("metadata = %#v, want pi_first_decision=reply", updated.Metadata)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.requests) != 1 || runtime.requests[0].Mode != persona.ModeLive {
		t.Fatalf("persona requests = %#v, want one live request", runtime.requests)
	}
	var sawDigest, sawCandidate bool
	for _, item := range runtime.requests[0].Context {
		switch item.Kind {
		case "triage_digest":
			sawDigest = strings.Contains(item.Text, "产品评论文章")
		case "triage_candidate_actions":
			sawCandidate = true
		}
	}
	if policy := personaDynamicContextText(runtime.requests[0].DynamicContext, "workspace_triage_policy"); !strings.Contains(policy, "product-adjacent") {
		t.Fatalf("persona dynamic context = %#v, want workspace policy envelope", runtime.requests[0].DynamicContext)
	}
	if !sawDigest || sawCandidate {
		t.Fatalf("persona context = %#v, want digest and no Codex candidate actions", runtime.requests[0].Context)
	}
}

func TestSlackTriagePiFirstLiveDelegatesWorkerAfterPiDecision(t *testing.T) {
	ctx := context.Background()
	workspaceDir := t.TempDir()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionDelegateWorker,
		Reason:   "needs repository/tool inspection before answering",
		WorkerRequests: []persona.WorkerRequest{{
			ID:     "inspect-repo",
			Kind:   "codex",
			Prompt: "Inspect the linked repository and summarize whether it overlaps with our product.",
			Context: map[string]any{
				"delegation_scope": "secretary_lookup",
			},
		}},
		Confidence: 0.41,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_delegate_after_pi",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Triage:       appconfig.SlackTriageConfig{ForegroundChain: "pi_first_live"},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_PENG",
		Text:           "<@U_ONEE> 这个 repo 和我们的产品方向重合吗？",
		TS:             "221.000",
	}}, "#meeting-avatar: <@U_ONEE> 这个 repo 和我们的产品方向重合吗？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if runner.startCount != 1 {
		t.Fatalf("runner.startCount = %d, want exactly one post-Pi delegate worker", runner.startCount)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionDelegateWorker || intFromAny(updated.Metadata["delegate_worker_jobs_started"]) != 1 {
		t.Fatalf("metadata = %#v, want delegate decision + one worker job", updated.Metadata)
	}
	slack, ok := mapFromAny(runner.startInput.Context["slack"])
	if !ok || stringFromAny(slack["channel_id"]) != "C_TRIAGE" || stringFromAny(slack["thread_ts"]) != "221.000" {
		t.Fatalf("runner slack context = %#v, want channel/thread context", runner.startInput.Context["slack"])
	}
	if runner.startInput.Context["session_kind"] != agentrunner.SessionKindSecretaryLookup {
		t.Fatalf("runner context session_kind = %#v, want secretary_lookup", runner.startInput.Context["session_kind"])
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want worker to answer asynchronously later", got)
	}
}

func TestPersonaDelegateWorkerAlreadyHandledReasonDowngradesToSilence(t *testing.T) {
	cases := []struct {
		name      string
		reason    string
		visible   string
		wantMatch string
	}{
		{
			name: "already_reviewed_pr",
			reason: strings.Join([]string{
				"Claude (U0AMN6TKVJ8) has already reviewed and approved PR #444 in msg_ts:1779442634.699649, directly addressing the request.",
				"No further triage action needed.",
			}, " "),
			wantMatch: "already reviewed",
		},
		{
			name: "nothing_to_add_reply",
			visible: strings.Join([]string{
				"This is a technical statement about the authorization flow working on web now.",
				"No external link to look up here, and the persona already determined this thread is handled.",
				"Nothing for me to add.",
			}, " "),
			wantMatch: "nothing for me to add",
		},
		{
			name: "already_approved_sibling_pr",
			reason: strings.Join([]string{
				"codex-3720 resolved the underlying bug via PR #2017, and the sibling PR at #444 was already approved.",
				"No further action is needed.",
			}, " "),
			wantMatch: "already approved",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := SlackPersonaShadowResult{
				Success:     true,
				RequestID:   "triage:C09LB7V1WGJ:1779442219.313689",
				ChannelID:   "C09LB7V1WGJ",
				ThreadTS:    "1779442219.313689",
				Decision:    persona.DecisionDelegateWorker,
				Reason:      tc.reason,
				VisibleText: tc.visible,
				workerRecords: []persona.WorkerRequest{{
					ID:     "secretary-link-fact-lookup",
					Kind:   "codex",
					Prompt: "Summarize this thread.",
					Context: map[string]any{
						"delegation_scope": "secretary_lookup",
					},
				}},
				WorkerRequests: []string{"secretary-link-fact-lookup"},
			}

			downgraded, toolCalls := applyPersonaCompletedDelegationDisposition(result)
			if downgraded.Decision != persona.DecisionStaySilent {
				t.Fatalf("Decision = %q, want stay_silent", downgraded.Decision)
			}
			if downgraded.VisibleText != "" {
				t.Fatalf("VisibleText = %q, want empty", downgraded.VisibleText)
			}
			if len(downgraded.workerRecords) != 0 || len(downgraded.WorkerRequests) != 0 {
				t.Fatalf("worker records = %#v summaries = %#v, want none", downgraded.workerRecords, downgraded.WorkerRequests)
			}
			if len(toolCalls) != 1 || toolCalls[0].Action != "delegate_worker_already_handled_silent" || !strings.Contains(toolCalls[0].Result, tc.wantMatch) {
				t.Fatalf("toolCalls = %#v, want already-handled suppression with marker %q", toolCalls, tc.wantMatch)
			}

			runner := &fakeRunner{job: agentrunner.Job{
				ID:       "job_should_not_start",
				Provider: "codex",
				Status:   agentrunner.StatusRunning,
			}}
			service := NewService(Config{Runner: runner})
			started := service.startPersonaDelegatedWorkerJobs(context.Background(), "T123", 99, downgraded, persona.Request{}, nil)
			if runner.startCount != 0 || len(started.JobIDs) != 0 {
				t.Fatalf("runner.startCount=%d started=%#v, want no worker start", runner.startCount, started)
			}
		})
	}
}

func TestPersonaAmbientDelegateWorkerDowngradesToSilence(t *testing.T) {
	cases := []struct {
		name      string
		reason    string
		messages  []SlackInboundMessage
		botUserID string
		wantMatch string
	}{
		{
			name:   "mentions_another_user_without_bot",
			reason: "用户分享了一个Cue共享链接询问压缩视频性能问题，但triage无法直接访问共享内容，需委托worker检索以提供有依据的回应。",
			messages: []SlackInboundMessage{{
				TeamID:    "T123",
				ChannelID: "C09KVPBMLJ3",
				UserID:    "U09L4CPK3BL",
				Text:      "<https://app.cue.surf/c/eaa6adb7-129d-4542-b36d-c430d311a23b> 看看这个压缩视频的为什么这么慢，是不是在找工具 <@U09L0U0SJ3F> :eyes:",
				TS:        "1779442587.111859",
				ThreadTS:  "1779438182.306539",
			}},
			botUserID: "U0AP5UFU0FR",
			wantMatch: "mentioned_other_user_without_bot",
		},
		{
			name:   "no_explicit_question_or_bot_mention",
			reason: "Two technical progress messages from team members in the same channel—one about API latency improvement/CH migration, another about redeem code UX limitation. No explicit question or @Oneesama. Workspace policy allows lightweight product-adjacent commentary, but the topic is internal engineering progress.",
			messages: []SlackInboundMessage{{
				TeamID:    "T123",
				ChannelID: "C09KVPBMLJ3",
				UserID:    "U09L0U0SJ3F",
				Text:      "现在api响应基本压到1s以内了，ch还没搬完，下周搬完后把可以把历史数据和中转逻辑去掉，直传ch后应该可以进一步加速",
				TS:        "1779438182.306539",
				ThreadTS:  "1779438182.306539",
				Files: []SlackFile{{
					ID:       "F0B5NB5T75J",
					Name:     "image.png",
					Filetype: "png",
					Mimetype: "image/png",
				}},
			}},
			botUserID: "U0AP5UFU0FR",
			wantMatch: "no_explicit_question_or_bot_mention",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := SlackPersonaShadowResult{
				Success:   true,
				RequestID: "triage:C09KVPBMLJ3:1779438182.306539",
				ChannelID: "C09KVPBMLJ3",
				ThreadTS:  "1779438182.306539",
				Decision:  persona.DecisionDelegateWorker,
				Reason:    tc.reason,
				workerRecords: []persona.WorkerRequest{{
					ID:     "ambient-secretary-lookup",
					Kind:   "codex",
					Prompt: "Synthesize a concise answer.",
					Context: map[string]any{
						"delegation_scope": "secretary_lookup",
					},
				}},
				WorkerRequests: []string{"ambient-secretary-lookup"},
			}

			downgraded, toolCalls := applyPersonaAmbientDelegationDisposition(result, tc.messages, tc.botUserID)
			if downgraded.Decision != persona.DecisionStaySilent {
				t.Fatalf("Decision = %q, want stay_silent", downgraded.Decision)
			}
			if len(downgraded.workerRecords) != 0 || len(downgraded.WorkerRequests) != 0 {
				t.Fatalf("worker records = %#v summaries = %#v, want none", downgraded.workerRecords, downgraded.WorkerRequests)
			}
			if len(toolCalls) != 1 || toolCalls[0].Action != "delegate_worker_ambient_silent" || !strings.Contains(toolCalls[0].Result, tc.wantMatch) {
				t.Fatalf("toolCalls = %#v, want ambient suppression marker %q", toolCalls, tc.wantMatch)
			}
		})
	}
}

func TestPersonaAmbientDirectReplyDowngradesToSilence(t *testing.T) {
	cases := []struct {
		name      string
		result    SlackPersonaShadowResult
		messages  []SlackInboundMessage
		botUserID string
		wantMatch string
	}{
		{
			name: "speculative_direct_reply_without_bot_mention",
			result: SlackPersonaShadowResult{
				Success:     true,
				RequestID:   "triage:C09LB7V1WGJ:1779446155.743689",
				ChannelID:   "C09LB7V1WGJ",
				ThreadTS:    "1779446155.743689",
				Decision:    persona.DecisionReply,
				VisibleText: "从之前的讨论看，local VM 文件变更检测原本有一个确认面板，现在可能被「直接完成」取代了。要不要看看最近的 release note 或代码变更？",
				Reason:      "User is discussing a missing file change panel; memory provides relevant context to comment briefly.",
			},
			messages: []SlackInboundMessage{{
				TeamID:    "T123",
				ChannelID: "C09LB7V1WGJ",
				UserID:    "U09KY0GE28K",
				Text:      "vm 用得少了？",
				TS:        "1779446155.743689",
				ThreadTS:  "1779446155.743689",
			}},
			botUserID: "U0AP5UFU0FR",
			wantMatch: "ambient_speculative_direct_reply",
		},
		{
			name: "mentions_another_user_without_bot",
			result: SlackPersonaShadowResult{
				Success:     true,
				RequestID:   "triage:C09KVPBMLJ3:1779438182.306539",
				ChannelID:   "C09KVPBMLJ3",
				ThreadTS:    "1779438182.306539",
				Decision:    persona.DecisionReply,
				VisibleText: "这个压缩视频慢可能是因为 ffmpeg 转码。",
			},
			messages: []SlackInboundMessage{{
				TeamID:    "T123",
				ChannelID: "C09KVPBMLJ3",
				UserID:    "U09L4CPK3BL",
				Text:      "<https://app.cue.surf/c/eaa6adb7-129d-4542-b36d-c430d311a23b> 看看这个压缩视频的为什么这么慢，是不是在找工具 <@U09L0U0SJ3F> :eyes:",
				TS:        "1779442587.111859",
				ThreadTS:  "1779438182.306539",
			}},
			botUserID: "U0AP5UFU0FR",
			wantMatch: "mentioned_other_user_without_bot",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			downgraded, toolCalls := applyPersonaAmbientDirectReplyDisposition(tc.result, tc.messages, tc.botUserID)
			if downgraded.Decision != persona.DecisionStaySilent {
				t.Fatalf("Decision = %q, want stay_silent", downgraded.Decision)
			}
			if downgraded.VisibleText != "" {
				t.Fatalf("VisibleText = %q, want empty", downgraded.VisibleText)
			}
			if len(toolCalls) != 1 || toolCalls[0].Action != "persona_reply_ambient_silent" || !strings.Contains(toolCalls[0].Result, tc.wantMatch) {
				t.Fatalf("toolCalls = %#v, want ambient direct reply suppression marker %q", toolCalls, tc.wantMatch)
			}
		})
	}
}

func TestPersonaAmbientDirectReplyKeepsAddressedBotAnswer(t *testing.T) {
	result := SlackPersonaShadowResult{
		Success:     true,
		RequestID:   "triage:C123:177.123",
		ChannelID:   "C123",
		ThreadTS:    "177.123",
		Decision:    persona.DecisionReply,
		VisibleText: "看起来根因是重复 Socket Mode listener 抢走了 Slack interaction。",
	}
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "<@U0AP5UFU0FR> 为什么 Join with realtime 点完会回到默认卡片？",
		TS:        "177.123",
		ThreadTS:  "177.123",
	}}
	got, toolCalls := applyPersonaAmbientDirectReplyDisposition(result, messages, "U0AP5UFU0FR")
	if got.Decision != persona.DecisionReply || got.VisibleText != result.VisibleText || len(toolCalls) != 0 {
		t.Fatalf("result=%#v toolCalls=%#v, want addressed bot reply preserved", got, toolCalls)
	}
}

func TestPersonaVisibleReplyQualityGateSuppressesInternalMeta(t *testing.T) {
	result := SlackPersonaShadowResult{
		Success:     true,
		RequestID:   "triage:C09LB7V1WGJ:1779385051.079739",
		ChannelID:   "C09LB7V1WGJ",
		ThreadTS:    "1779371525.004829",
		Decision:    persona.DecisionReply,
		VisibleText: "根据 persona 分析，当前线程已被分类；persona 已判定 Oneesama 不应在此线程插话，我无可见输出。",
		Reason:      "The persona already classified this thread as no visible output.",
	}

	got, toolCalls := applyPersonaVisibleReplyQualityDisposition(result)
	if got.Decision != persona.DecisionStaySilent || got.VisibleText != "" {
		t.Fatalf("result = %#v, want stay_silent with empty visible text", got)
	}
	if len(toolCalls) != 1 || toolCalls[0].Action != "persona_reply_quality_gate_silent" || toolCalls[0].Result != "internal_control_plane_leak" {
		t.Fatalf("toolCalls = %#v, want quality gate block", toolCalls)
	}
	if actions := slackPersonaForegroundActions("C123", "123.456", got, persona.Request{}); len(actions) != 0 {
		t.Fatalf("actions = %#v, want no pending reply for internal meta", actions)
	}
}

func TestPersonaVisibleReplyQualityGateAllowsSourceBackedLinkSynthesis(t *testing.T) {
	result := SlackPersonaShadowResult{
		Success:     true,
		RequestID:   "triage:C09L0TAN31T:1779425315.544949",
		ChannelID:   "C09L0TAN31T",
		ThreadTS:    "1779425315.544949",
		Decision:    persona.DecisionReply,
		VisibleText: "《Claw Patrol: an open-source security firewall for agents | Deno》这条值得看的一点是：At Deno, agents help with production operations, but an agent cannot be trusted to police itself.",
		Reason:      "A substantive shared link is synthesis-eligible under the workspace policy or explicit thread request.",
		EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
			Kind:      slackVisibleEvidenceKindFetchedLink,
			SourceRef: "https://deno.com/blog/clawpatrol",
			Quote:     "Claw Patrol: an open-source security firewall for agents | Deno",
		}},
	}

	got, toolCalls := applyPersonaVisibleReplyQualityDisposition(result)
	if got.Decision != persona.DecisionReply || got.VisibleText == "" {
		t.Fatalf("result = %#v, want source-backed reply preserved", got)
	}
	if len(toolCalls) != 0 {
		t.Fatalf("toolCalls = %#v, want no quality gate block", toolCalls)
	}
}

func TestSlackTriagePiFirstLiveAutoDelegatesExternalLinkIdentityLookupAfterStaySilent(t *testing.T) {
	ctx := context.Background()
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`Title: User: Johnson8053 | Hacker News

Markdown Content:
HN profile for Johnson8053. Submissions include SQLite is the best home for AI agents and a link to github.com/zanwei/design-dna.`))
	}))
	defer reader.Close()
	oldClient := slackExternalLinkHTTPClient
	oldReaderURL := slackExternalLinkReaderURL
	slackExternalLinkHTTPClient = reader.Client()
	slackExternalLinkReaderURL = func(string) string { return reader.URL + "/reader" }
	t.Cleanup(func() {
		slackExternalLinkHTTPClient = oldClient
		slackExternalLinkReaderURL = oldReaderURL
	})

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionStaySilent,
		Reason:     "uncertain identity and teammate said no idea",
		Confidence: 0.37,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_hn_secretary_lookup",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			PilotUserID: "U_PENG",
			Triage:      appconfig.SlackTriageConfig{ForegroundChain: "pi_first_live"},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster: poster,
		Runner: runner,
	})
	service.operatorFallback.DM.CacheDM("U_PENG", "D_PENG")
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_HEYANG",
		Text:           "https://news.ycombinator.com/user?id=Johnson8053 这是谁",
		TS:             "500.000",
	}, {
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_VINCENT",
		Text:           "不认识 他咋了？",
		TS:             "501.000",
	}}, "#product: https://news.ycombinator.com/user?id=Johnson8053 这是谁\n不认识 他咋了？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if runner.startCount != 1 {
		t.Fatalf("runner.startCount = %d, want secretary lookup worker after Pi stay_silent", runner.startCount)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want no pre-evidence visible reply", got)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionDelegateWorker || intFromAny(updated.Metadata["secretary_lookup_auto_delegates"]) != 1 {
		t.Fatalf("metadata = %#v, want auto-delegated secretary lookup", updated.Metadata)
	}
	if got := stringFromAny(runner.startInput.Context["session_kind"]); got != agentrunner.SessionKindSecretaryLookup {
		t.Fatalf("runner session_kind = %q, want secretary lookup case", got)
	}
	if prompt := runner.startInput.Task + "\n" + stringFromAny(runner.startInput.Context["slackAssistantPrompt"]); !strings.Contains(prompt, "Johnson8053") || !strings.Contains(prompt, "github.com/zanwei/design-dna") || !strings.Contains(prompt, "concrete evidence") || !strings.Contains(prompt, `"evidence_anchors"`) {
		t.Fatalf("secretary lookup prompt missing old-slackd evidence shape:\n%s", prompt)
	}
}

func TestSlackTriagePiFirstLiveUpgradesProductLinkReactionToSecretaryLookup(t *testing.T) {
	ctx := context.Background()
	reader := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`Title: Tana announces meeting workspace

Markdown Content:
Tana is adding meeting workflows, agenda notes, and collaboration features.`))
	}))
	defer reader.Close()
	oldClient := slackExternalLinkHTTPClient
	oldReaderURL := slackExternalLinkReaderURL
	slackExternalLinkHTTPClient = reader.Client()
	slackExternalLinkReaderURL = func(string) string { return reader.URL + "/reader" }
	t.Cleanup(func() {
		slackExternalLinkHTTPClient = oldClient
		slackExternalLinkReaderURL = oldReaderURL
	})

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	reactions := &recordingReactions{}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionReact,
		Reason:   "Casual banter reacting to a product pivot link share. No question or request.",
		Reactions: []persona.ReactionIntent{{
			Emoji:      "吃瓜",
			Confidence: 0.9,
			Reason:     "spectating",
		}},
		Confidence: 0.9,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_tana_product_link_lookup",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			Triage: appconfig.SlackTriageConfig{
				ForegroundChain: "pi_first_live",
				WorkspacePolicy: "For this workspace, lightweight source-backed comments are welcome for product-adjacent AI agent, coding tool, creative workflow, Memory, Bridge/Cue-like collaboration, AI lab/researcher, and coding-agent ecosystem topics, even in casual channels.",
			},
		},
		PersonaRuntime: appconfig.PersonaRuntimeConfig{
			Provider: persona.ProviderFake,
			Mode:     persona.ModeLive,
			Timeout:  time.Second,
		},
		Poster:    poster,
		Reactions: reactions,
		Runner:    runner,
	})
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C09L0TAN31T", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C09L0TAN31T",
		UserIDSnake:    "U_PENG",
		Text:           "转业了 https://tana.inc/",
		TS:             "1779421855.728099",
	}, {
		TeamID:         "T123",
		ChannelIDSnake: "C09L0TAN31T",
		UserIDSnake:    "U_TEAMMATE",
		Text:           "这尼玛 woc meeting 要和Zoom干？",
		TS:             "1779421882.604639",
	}, {
		TeamID:         "T123",
		ChannelIDSnake: "C09L0TAN31T",
		UserIDSnake:    "U_TEAMMATE",
		Text:           "这感觉怕是有点难哦",
		TS:             "1779421920.854339",
	}}, "#watercooler: 转业了 https://tana.inc/\n这尼玛 woc meeting 要和Zoom干？\n这感觉怕是有点难哦")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if runner.startCount != 1 {
		t.Fatalf("runner.startCount = %d, want secretary lookup worker after product link reaction", runner.startCount)
	}
	if got := len(reactions.Calls()); got != 0 {
		t.Fatalf("reaction calls = %d, want no reaction-only product link disposition", got)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want worker to answer asynchronously later", got)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionDelegateWorker || intFromAny(updated.Metadata["delegate_worker_jobs_started"]) != 1 {
		t.Fatalf("metadata = %#v, want delegate_worker after reaction guard", updated.Metadata)
	}
	if !hasTriageToolCall(updated.ToolCalls, "persona_runtime", "product_link_reaction_upgraded_to_secretary_lookup") {
		t.Fatalf("tool calls = %#v, want product link reaction upgrade marker", updated.ToolCalls)
	}
	if got := stringFromAny(runner.startInput.Context["session_kind"]); got != agentrunner.SessionKindSecretaryLookup {
		t.Fatalf("runner session_kind = %q, want secretary_lookup", got)
	}
	if prompt := runner.startInput.Task; !strings.Contains(prompt, "tana.inc") || !strings.Contains(prompt, "meeting") || !strings.Contains(prompt, "source") {
		t.Fatalf("secretary lookup prompt missing Tana product-link context:\n%s", prompt)
	}
}

func TestSlackTriageProductLinkReactionAlreadyHandledDoesNotDelegate(t *testing.T) {
	request := persona.Request{
		Event: persona.Event{Text: "review 一下 <https://github.com/AFK-surf/cue/pull/2033>"},
		Context: []persona.ContextItem{{
			Kind: "external_link_context",
			Text: "1. https://github.com/AFK-surf/cue/pull/2033\n   title: PR #2033",
		}},
		DynamicContext: []persona.DynamicContextEnvelope{{
			Kind:    "workspace_triage_policy",
			Content: "For this workspace, lightweight source-backed comments are welcome for product-adjacent links.",
		}},
	}
	result := SlackPersonaShadowResult{
		Success:   true,
		Decision:  persona.DecisionReact,
		Reason:    "Claude already approved PR #2033 in-thread; request is fully handled and no action needed.",
		Reactions: []string{"white_check_mark"},
		reactionRecords: []persona.ReactionIntent{{
			Emoji:      "white_check_mark",
			Confidence: 0.9,
			Reason:     "acknowledge completed review",
		}},
	}

	updated, calls := applyPersonaProductLinkReactionDisposition(result, request)
	if updated.Decision != persona.DecisionReact {
		t.Fatalf("Decision = %q, want reaction preserved", updated.Decision)
	}
	if len(updated.workerRecords) != 0 || len(updated.WorkerRequests) != 0 {
		t.Fatalf("worker records = %#v summaries=%#v, want no delegate", updated.workerRecords, updated.WorkerRequests)
	}
	if len(calls) != 1 || calls[0].Action != "product_link_reaction_preserved_already_handled" || !strings.Contains(calls[0].Result, "already approved") {
		t.Fatalf("tool calls = %#v, want already-handled product-link guard", calls)
	}
}
