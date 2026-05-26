package slackagent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestStartPersonaDelegatedWorkerCarriesSwarmStyleHandoff(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_TRIAGE",
		UserID:    "U_PENG",
		Text:      "帮我查一下这个 HN 用户是谁",
		TS:        "600.000",
		ThreadTS:  "600.000",
	}}
	req := persona.Request{
		ID:    "pi-req-handoff",
		Event: persona.Event{Text: "帮我查一下这个 HN 用户是谁"},
		Anchor: persona.Anchor{
			Surface:   "slack",
			ChannelID: "C_TRIAGE",
			ThreadTS:  "600.000",
		},
		Context: []persona.ContextItem{{
			Kind:      "external_link_context",
			SourceRef: "https://news.ycombinator.com/user?id=Johnson8053",
			Text:      "HN profile: Johnson8053, created September 20, 2024, karma 33.",
		}},
		Memory: persona.MemoryContext{Items: []persona.MemoryRecord{{
			Kind:      "person_memory",
			SourceRef: "memory/people/zanwei.md",
			Text:      "Johnson8053 has prior workspace evidence linking affine and bridge submissions.",
			Score:     0.91,
		}}},
	}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_handoff",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{Runner: runner})
	result := SlackPersonaShadowResult{
		Success:   true,
		RequestID: req.ID,
		ChannelID: "C_TRIAGE",
		ThreadTS:  "600.000",
		Decision:  persona.DecisionDelegateWorker,
		Reason:    "needs a source-backed identity lookup",
		workerRecords: []persona.WorkerRequest{{
			ID:     "identity-lookup",
			Kind:   "codex",
			Prompt: "Identify the HN user from the supplied thread, fetched link, and memory evidence.",
			Context: map[string]any{
				"delegation_scope": "secretary_lookup",
			},
			Handoff: &persona.WorkerHandoff{
				Boundaries: []string{"custom read-only boundary"},
			},
		}},
	}

	started := service.startPersonaDelegatedWorkerJobs(context.Background(), "T123", 101, result, req, messages)
	if len(started.JobIDs) != 1 || runner.startCount != 1 {
		t.Fatalf("started=%#v runner.startCount=%d, want one worker", started, runner.startCount)
	}
	handoff, ok := runner.startInput.Context["handoff"].(persona.WorkerHandoff)
	if !ok {
		t.Fatalf("handoff = %#v, want persona.WorkerHandoff", runner.startInput.Context["handoff"])
	}
	if handoff.SourceAgent != "oneesama_pi_foreground" || handoff.TargetAgent != "secretary_lookup_worker" {
		t.Fatalf("handoff agents = %#v, want Pi foreground -> secretary lookup worker", handoff)
	}
	if handoff.Reason != result.Reason || !strings.Contains(handoff.UserRequest, "HN 用户") || !strings.Contains(handoff.Task, "Identify the HN user") {
		t.Fatalf("handoff = %#v, want reason/user request/task", handoff)
	}
	for _, want := range []string{
		"custom read-only boundary",
		"Return results to Oneesama",
		"subagent handoff from Oneesama",
		"Only produce Slack-visible text when concrete evidence anchors support it.",
	} {
		if !stringSliceContainsSubstring(handoff.Boundaries, want) {
			t.Fatalf("handoff boundaries = %#v, missing %q", handoff.Boundaries, want)
		}
	}
	if !handoffSourceRefsContain(handoff.SourceRefs, "slack_thread", "C_TRIAGE/600.000") ||
		!handoffSourceRefsContain(handoff.SourceRefs, "external_link_context", "https://news.ycombinator.com/user?id=Johnson8053") ||
		!handoffSourceRefsContain(handoff.SourceRefs, "person_memory", "memory/people/zanwei.md") {
		t.Fatalf("handoff source refs = %#v, want Slack thread, fetched link, and memory refs", handoff.SourceRefs)
	}
}

func TestSlackTriagePiFirstLiveDelegateWorkerCarriesImageFetchContext(t *testing.T) {
	ctx := context.Background()
	workspaceDir := t.TempDir()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionDelegateWorker,
		Reason:   "image contents are required before answering",
		WorkerRequests: []persona.WorkerRequest{{
			ID:     "inspect-slack-images",
			Kind:   "codex",
			Prompt: "Read the Slack screenshots and explain what permission is missing. If you cannot inspect the images, return no visible result.",
			Context: map[string]any{
				"delegation_scope": "secretary_lookup",
			},
		}},
		Confidence: 0.44,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_image_delegate_after_pi",
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
		Text:           "没懂",
		TS:             "300.000",
		ThreadTS:       "300.000",
		Files: []SlackFile{{
			ID:        "F0B540Q5J5Q",
			Name:      "IMG_0083.jpg",
			Filetype:  "jpg",
			Mimetype:  "image/jpeg",
			Size:      224000,
			OriginalW: 2032,
			OriginalH: 352,
			Permalink: "https://slack.example/files/F0B540Q5J5Q",
		}},
	}, {
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_OTHER",
		Text:           "look its not letting me i have done everything but it keeps showing as non authorised",
		TS:             "301.000",
		ThreadTS:       "300.000",
		Files: []SlackFile{{
			ID:        "F0B55RA382V",
			Name:      "IMG_0082.jpg",
			Filetype:  "jpg",
			Mimetype:  "image/jpeg",
			Size:      412000,
			OriginalW: 1206,
			OriginalH: 609,
			Permalink: "https://slack.example/files/F0B55RA382V",
		}},
	}}, "#triage: user is confused by Bridge authorization screenshots")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if runner.startCount != 1 {
		t.Fatalf("runner.startCount = %d, want one image-inspection delegate worker", runner.startCount)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionDelegateWorker || intFromAny(updated.Metadata["delegate_worker_jobs_started"]) != 1 {
		t.Fatalf("metadata = %#v, want delegate decision + one worker job", updated.Metadata)
	}
	prompt := stringFromAny(runner.startInput.Context["slackAssistantPrompt"])
	for _, want := range []string{"slack.fetchImage", "local_path", "do not curl", "F0B540Q5J5Q", "F0B55RA382V", "IMG_0083.jpg", "[image:"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("slackAssistantPrompt missing %q:\n%s", want, prompt)
		}
	}
	mention, ok := runner.startInput.Context["slackAppMention"].(*SlackAppMentionContext)
	if !ok || mention == nil {
		t.Fatalf("slackAppMention = %#v, want rich context pointer", runner.startInput.Context["slackAppMention"])
	}
	if len(mention.ImageParts) != 2 || mention.ImageParts[0].ID != "F0B540Q5J5Q" || mention.ImageParts[1].ID != "F0B55RA382V" {
		t.Fatalf("image parts = %#v, want both Slack image file ids", mention.ImageParts)
	}
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want worker to answer after reading images", got)
	}
}

func TestSlackTriagePiFirstLiveSilencesBlockedReadOnlySecretaryLookup(t *testing.T) {
	ctx := context.Background()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionDelegateWorker,
		Reason:   "Need workspace Memory lookup for what 明天发推 refers to, but surrounding loading/performance context is noisy.",
		WorkerRequests: []persona.WorkerRequest{{
			ID:     "lookup-launch-tweet",
			Kind:   "codex",
			Prompt: "Look up workspace Memory for 明天发推 / cue-launch context. Do not investigate loading performance or source code.",
		}},
		Confidence: 0.43,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_should_not_start",
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
		UserIDSnake:    "U_HUMAN",
		Text:           "明天发推",
		TS:             "510.000",
	}}, "#cue-launch context: 一直 loading / performance discussion\n--- new messages ---\n明天发推")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if runner.startCount != 0 {
		t.Fatalf("runner.startCount = %d, want blocked noisy read-only lookup not started", runner.startCount)
	}
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want no canned secretary-routing refusal", calls)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionStaySilent || intFromAny(updated.Metadata["delegate_worker_blocked_silent"]) != 1 {
		t.Fatalf("metadata = %#v, want blocked read-only secretary lookup downgraded to silence", updated.Metadata)
	}
}

func TestSlackTriagePiFirstLiveDowngradesCannedRefusalReplyToSilence(t *testing.T) {
	ctx := context.Background()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:     persona.ProviderPi,
		Decision:    persona.DecisionReply,
		VisibleText: slackPersonaSecretaryRoutingText(),
		Reason:      "The thread has noisy project/loading context and no safe actionable answer.",
		Confidence:  0.61,
		ShadowOnly:  false,
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
		Runner: &fakeRunner{},
	})
	service.personaRuntime = runtime
	service.personaRuntimeErr = nil
	service.personaRuntimeConfig.Provider = persona.ProviderPi
	service.personaRuntimeConfig.Mode = persona.ModeLive
	service.personaRuntimeConfig.ShadowOnly = false

	started, err := service.StartSlackTriage(ctx, "C_TRIAGE", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_HUMAN",
		Text:           "明天发推",
		TS:             "520.000",
	}}, "#cue-launch context: 一直 loading / performance discussion\n--- new messages ---\n明天发推")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if calls := poster.Calls(); len(calls) != 0 {
		t.Fatalf("poster calls = %#v, want canned refusal reply downgraded to silence", calls)
	}
	if updated.Metadata["pi_first_decision"] != persona.DecisionStaySilent || intFromAny(updated.Metadata["reply_canned_refusal_downgraded_silent"]) != 1 {
		t.Fatalf("metadata = %#v, want canned refusal downgrade", updated.Metadata)
	}
}

func TestPersonaDelegatedWorkerSlackContextForVideoCarriesFileReader(t *testing.T) {
	context := personaDelegatedWorkerSlackContext("C_TRIAGE", "300.000", []SlackInboundMessage{{
		TeamID:         "T123",
		ChannelIDSnake: "C_TRIAGE",
		UserIDSnake:    "U_ASK",
		Text:           "",
		TS:             "301.000",
		ThreadTS:       "300.000",
		Files: []SlackFile{{
			ID:        "FVID",
			Name:      "timeout.mov",
			Filetype:  "mov",
			Mimetype:  "video/quicktime",
			Size:      412000,
			Permalink: "https://slack.example/files/FVID",
		}},
	}})
	prompt := stringFromAny(context["slackAssistantPrompt"])
	for _, want := range []string{"timeout.mov", "File reading rule", "slack.fetchFile", "FVID", "local_path", "Do not answer by saying you cannot view the media", "return no visible result"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("slackAssistantPrompt missing %q:\n%s", want, prompt)
		}
	}
	if files, ok := context["slack_files"].([]SlackThreadFile); !ok || len(files) != 1 || files[0].ID != "FVID" {
		t.Fatalf("slack_files = %#v, want video metadata", context["slack_files"])
	}
}

func TestSlackTriagePiFirstLiveBlocksExternalProjectDebugDelegation(t *testing.T) {
	ctx := context.Background()
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runtime := &capturePersonaRuntime{response: persona.Response{
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionDelegateWorker,
		Reason:   "needs staging investigation",
		WorkerRequests: []persona.WorkerRequest{{
			ID:     "investigate-staging",
			Kind:   "codex",
			Prompt: "Investigate staging environment: check recent deployments, database query performance, and API latency for conversation loading.",
		}},
		Confidence: 0.38,
		ShadowOnly: false,
	}}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_should_not_start",
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
		UserIDSnake:    "U_PENG",
		Text:           "staging conversations loading is very slow, about 30s",
		TS:             "222.000",
	}}, "#meeting-avatar: staging conversations loading is very slow, about 30s")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	poster.WaitForCalls(t, 1)
	if runner.startCount != 0 {
		t.Fatalf("runner.startCount = %d, want no project-code worker", runner.startCount)
	}
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "C_TRIAGE" || calls[0].ThreadTS != "222.000" || !strings.Contains(calls[0].Text, "项目 owner") || !strings.Contains(calls[0].Text, "不直接下场查 repo") {
		t.Fatalf("poster calls = %#v, want direct secretary routing reply", calls)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Run.ID)
	if updated.Metadata["pi_first_decision"] != persona.DecisionReply {
		t.Fatalf("metadata = %#v, want downgraded reply decision", updated.Metadata)
	}
	if intFromAny(updated.Metadata["delegate_worker_jobs_started"]) != 0 || intFromAny(updated.Metadata["delegate_worker_scope_blocks"]) != 1 {
		t.Fatalf("metadata = %#v, want no worker jobs and one scope block", updated.Metadata)
	}
	var sawBlock bool
	for _, call := range updated.ToolCalls {
		if call.Tool == "agent_runner" && call.Action == "delegate_worker_blocked_scope" && call.Success {
			sawBlock = true
		}
	}
	if !sawBlock {
		t.Fatalf("tool calls = %#v, want delegate_worker_blocked_scope", updated.ToolCalls)
	}
}

func TestPersonaDelegatedWorkerAllowedBySecretaryPolicyFixtures(t *testing.T) {
	// Ground-truth fixtures from runtime/live-state/agent_runner_jobs.json audit.
	// 3 historical in-scope app_mention worker prompts must NOT be blocked by the
	// heuristic when Pi omits the delegation_scope field; 1 out-of-scope case
	// (the #279 staging perf incident) must be blocked.
	cases := []struct {
		name    string
		request persona.WorkerRequest
		want    bool
	}{
		{
			name: "in_scope/linear_memo",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "记一个 linear 吧，省得忘了",
			},
			want: true,
		},
		{
			name: "in_scope/github_link_discussion_recall",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "https://github.com/msitarzewski/agency-agents 我们讨论过这个嘛",
			},
			want: true,
		},
		{
			name: "in_scope/case_study_video_lookup",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "jc说之前录制了5个Case Study的视频，这个有吗？",
			},
			want: true,
		},
		{
			name: "out_of_scope/staging_perf_investigation_279",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "User reports staging loading conversations is very slow (~30s). Investigate staging environment: check recent deployments, database query performance, API latency for conversation loading.",
			},
			want: false,
		},
		{
			name: "out_of_scope/secretary_lookup_mislabel_does_not_bypass_project_debugging",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "Fetch screenshot F0B522G0NUB and analyze why the staging 卡片/notch 没弹出; inspect notification 组件 and 触发条件 in source code.",
				Context: map[string]any{
					"delegation_scope": "secretary_lookup",
				},
			},
			want: false,
		},
		{
			name: "in_scope/explicit_oneesama_code_scope_overrides_markers",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "Investigate oneesama meeting-agent recording latency regression in our own code.",
				Context: map[string]any{
					"delegation_scope": "oneesama_code",
				},
			},
			want: true,
		},
		{
			name: "in_scope/oneesama_self_reference_overrides_heuristic",
			request: persona.WorkerRequest{
				Kind:   "codex",
				Prompt: "Investigate slack-agent triage policy regression after the latest deploy.",
			},
			want: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, reason := personaDelegatedWorkerAllowedBySecretaryPolicy(tc.request)
			if got != tc.want {
				t.Fatalf("personaDelegatedWorkerAllowedBySecretaryPolicy = (%v, %q), want allowed=%v", got, reason, tc.want)
			}
		})
	}
}

func TestSlackTriageLivePersonaEmptyReplyRecordsRetryFollowup(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 19, 1, 50, 0, 0, time.UTC)
	previousClock := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_live_persona_empty",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"codex saw a candidate reply","actions":[{"type":"post_thread_reply","title":"codex reply","message":"codex visible reply","channelId":"C_TRIAGE","threadTs":"201.000"}]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{Triage: appconfig.SlackTriageConfig{ForegroundChain: slackTriageForegroundChainCodexThenPi}},
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
		Decision:   persona.DecisionReply,
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
		Text:           "这条没人接，Pi 如果要回复就必须给 visible_text。",
		TS:             "201.000",
	}}, "#meeting-avatar: 这条没人接，Pi 如果要回复就必须给 visible_text。")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	updated := waitForPersonaForegroundRun(t, service, started.Finalization.Run.ID)
	if got := len(poster.Calls()); got != 0 {
		t.Fatalf("poster calls = %d, want no empty persona or Codex fallback post", got)
	}
	if updated.Status != "failed" || !strings.Contains(updated.Error, "empty persona foreground response") {
		t.Fatalf("run status/error = %q/%q, want empty persona failure", updated.Status, updated.Error)
	}
	foreground, ok := mapFromAny(updated.Metadata["persona_foreground"])
	if !ok || boolFromAny(foreground["success"], true) || foreground["error"] == nil {
		t.Fatalf("persona_foreground = %#v, want failed empty persona metadata", updated.Metadata["persona_foreground"])
	}

	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one empty-final retry followup", followups)
	}
	got := followups[0]
	if got.Kind != slackTriageEmptyFinalFollowupKind || got.SourceRef != "triage_empty_final_retry:C_TRIAGE:201.000" {
		t.Fatalf("followup = %#v, want persona empty-final retry", got)
	}
	if got.NextCheckAt != now.Add(slackTriageEmptyFinalFollowupDelay).Format(time.RFC3339Nano) {
		t.Fatalf("NextCheckAt = %q, want 15m retry delay", got.NextCheckAt)
	}
	if got.Metadata["failure_source"] != "persona_foreground" || got.Metadata["persona_decision"] != persona.DecisionReply || got.Metadata["persona_runtime"] != persona.ProviderPi {
		t.Fatalf("metadata = %#v, want persona empty-final metadata", got.Metadata)
	}
}

func waitForPersonaShadowRun(t *testing.T, service *Service, runID int64) SlackTriageContext {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		run, err := service.triage.GetRun(context.Background(), runID)
		if err != nil {
			t.Fatalf("GetRun: %v", err)
		}
		if run != nil {
			if _, ok := run.Metadata["persona_shadow"]; ok {
				return *run
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	run, _ := service.triage.GetRun(context.Background(), runID)
	if run == nil {
		t.Fatalf("persona shadow result was not recorded; run missing")
	}
	t.Fatalf("persona shadow result was not recorded; metadata=%#v toolCalls=%#v", run.Metadata, run.ToolCalls)
	return SlackTriageContext{}
}

func waitForPersonaForegroundRun(t *testing.T, service *Service, runID int64) SlackTriageContext {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		run, err := service.triage.GetRun(context.Background(), runID)
		if err != nil {
			t.Fatalf("GetRun: %v", err)
		}
		if run != nil {
			if _, ok := run.Metadata["persona_foreground"]; ok {
				waitForTriageProjection(t, service, runID)
				return *run
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	run, _ := service.triage.GetRun(context.Background(), runID)
	if run == nil {
		t.Fatalf("persona foreground result was not recorded; run missing")
	}
	t.Fatalf("persona foreground result was not recorded; metadata=%#v toolCalls=%#v", run.Metadata, run.ToolCalls)
	return SlackTriageContext{}
}

func waitForTriageProjection(t *testing.T, service *Service, runID int64) {
	t.Helper()
	if service == nil || strings.TrimSpace(service.workspaceDir) == "" {
		return
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, context := range loadTriageContextsFromProjection(service.workspaceDir) {
			if context.ID == runID {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("triage projection for run %d was not persisted before test cleanup", runID)
}

func TestShadowPersonaBackfillCandidatesRecordsErrorsWithoutDroppingResult(t *testing.T) {
	runtime := &capturePersonaRuntime{err: errors.New("sidecar unavailable")}
	results := ShadowPersonaBackfillCandidates(context.Background(), runtime, []SlackBackfillCandidate{{
		ChannelID:      "C1",
		ThreadTS:       "100.000",
		Classification: "unanswered_question",
		OriginalText:   "没人回这个架构问题。",
	}})
	if len(results) != 1 || results[0].Success || !strings.Contains(results[0].Error, "sidecar unavailable") {
		t.Fatalf("results = %#v, want recorded sidecar error", results)
	}
}

func TestBuildSlackTriagePersonaRequestIncludesDecisionAndMemory(t *testing.T) {
	req := BuildSlackTriagePersonaRequest(
		"C_TRIAGE",
		"200.000",
		[]SlackInboundMessage{
			{ChannelIDSnake: "C_TRIAGE", TS: "200.000", UserIDSnake: "U_PENG", Text: "这个链接没人读，oneesama 应该补一下吗？"},
			{ChannelIDSnake: "C_TRIAGE", TS: "201.000", ThreadTSSnake: "200.000", UserIDSnake: "U_DRIVER", Text: "补充：需要参考最近的记忆。"},
		},
		SlackTriageDecision{
			Summary: "Thread is synthesis-eligible.",
			ParseOK: true,
			Actions: []SlackTriageDecisionAction{{
				Type:    "post_thread_reply",
				Message: "我来补一个轻量意见。",
			}},
		},
		[]SlackRelatedMemoryRecord{{
			Kind:       "team_question",
			SourcePath: "memory/questions/aha.md",
			StartLine:  12,
			Content:    "Aha moments should recall related recent memory.",
			Score:      0.77,
		}},
	)
	if req.ID != "triage:C_TRIAGE:200.000" || req.Event.Kind != "slack_triage" || req.Mode != persona.ModeShadow {
		t.Fatalf("request identity = %#v, want triage shadow request", req)
	}
	if !strings.Contains(req.Event.Text, "这个链接没人读") || !strings.Contains(req.Event.Text, "补充：需要参考") {
		t.Fatalf("event text = %q, want normalized joined thread text", req.Event.Text)
	}
	if !req.Safety.AllowVisibleReply || req.Safety.AllowSpeech {
		t.Fatalf("safety = %#v, want visible reply allowed in shadow and speech disabled", req.Safety)
	}
	if req.Metadata["actions"] != 1 || req.Metadata["decision_parse_ok"] != true {
		t.Fatalf("metadata = %#v, want action count + parse flag", req.Metadata)
	}
	if req.Metadata["context_budget_expected"] != true ||
		intFromAny(req.Metadata["context_budget_stable_tokens"]) <= 0 ||
		intFromAny(req.Metadata["context_budget_memory_evidence_tokens"]) <= 0 ||
		intFromAny(req.Metadata["context_budget_total_tokens"]) <= 0 {
		t.Fatalf("metadata = %#v, want harness context budget", req.Metadata)
	}
	var sawCandidateAction bool
	for _, item := range req.Context {
		if item.Kind == "triage_candidate_actions" && strings.Contains(item.Text, "我来补一个轻量意见") {
			sawCandidateAction = true
			break
		}
	}
	if !sawCandidateAction {
		t.Fatalf("context = %#v, want candidate action detail for persona foreground", req.Context)
	}
	if len(req.Evidence.Citations) != 1 || req.Evidence.Citations[0].SourceRef != "memory/questions/aha.md" {
		t.Fatalf("citations = %#v, want related memory citation", req.Evidence.Citations)
	}
}

func TestBuildSlackTriagePersonaRequestIncludesWorkspacePolicyOnlyWhenConfigured(t *testing.T) {
	base := BuildSlackTriagePersonaRequest(
		"C_TRIAGE",
		"200.000",
		[]SlackInboundMessage{{Text: "看下这个产品文章"}},
		SlackTriageDecision{Summary: "No workspace policy configured.", ParseOK: true},
		nil,
	)
	if got := personaContextText(base.Context, "workspace_triage_policy"); got != "" {
		t.Fatalf("workspace policy context = %q, want absent by default", got)
	}
	if got := personaContextText(base.Context, "workspace_triage_policy_metadata"); got != "" {
		t.Fatalf("workspace policy metadata context = %q, want absent by default", got)
	}
	if got := personaDynamicContextText(base.DynamicContext, "workspace_triage_policy"); got != "" {
		t.Fatalf("workspace policy dynamic context = %q, want absent by default", got)
	}

	withPolicy := BuildSlackTriagePersonaRequestWithOptions(
		"C_TRIAGE",
		"200.000",
		[]SlackInboundMessage{{Text: "看下这个产品文章"}},
		SlackTriageDecision{Summary: "Workspace policy configured.", ParseOK: true},
		nil,
		SlackTriagePersonaRequestOptions{
			WorkspaceTriagePolicy: "Reply to source-backed product-adjacent articles in this workspace.",
		},
	)
	if got := personaContextText(withPolicy.Context, "workspace_triage_policy"); got != "" {
		t.Fatalf("workspace policy stable context = %q, want dynamic envelope only", got)
	}
	if got := personaContextText(withPolicy.Context, "workspace_triage_policy_metadata"); got != "" {
		t.Fatalf("workspace policy metadata stable context = %q, want metadata on dynamic envelope", got)
	}
	env, ok := personaDynamicContextEnvelope(withPolicy.DynamicContext, "workspace_triage_policy")
	if !ok {
		t.Fatalf("dynamic context = %#v, want workspace policy envelope", withPolicy.DynamicContext)
	}
	if !strings.Contains(env.Content, "product-adjacent articles") {
		t.Fatalf("workspace policy dynamic content = %q, want configured policy", env.Content)
	}
	if env.Source != slackWorkspacePolicySourceConfig || !strings.HasPrefix(env.Version, "sha256:") || env.CachePolicy != persona.DynamicContextCachePolicyNotStablePrefix {
		t.Fatalf("workspace policy envelope = %#v, want source/version/cache policy", env)
	}
	if env.Metadata["workspace_policy_source"] != slackWorkspacePolicySourceConfig || env.Metadata["workspace_policy_hash"] == "" || env.Metadata["workspace_policy_length_chars"] == 0 {
		t.Fatalf("workspace policy metadata = %#v, want source/hash/length", env.Metadata)
	}
}

func personaContextText(items []persona.ContextItem, kind string) string {
	for _, item := range items {
		if item.Kind == kind {
			return item.Text
		}
	}
	return ""
}

func personaDynamicContextText(items []persona.DynamicContextEnvelope, kind string) string {
	if env, ok := personaDynamicContextEnvelope(items, kind); ok {
		return env.Content
	}
	return ""
}

func personaDynamicContextEnvelope(items []persona.DynamicContextEnvelope, kind string) (persona.DynamicContextEnvelope, bool) {
	for _, item := range items {
		if item.Kind == kind {
			return item, true
		}
	}
	return persona.DynamicContextEnvelope{}, false
}
