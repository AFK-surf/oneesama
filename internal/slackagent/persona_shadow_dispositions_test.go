package slackagent

import (
	"context"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persona"
)

func TestPersonaDelegatedWorkerDefaultsToReadOnlyUnlessExplicitlyAuthorized(t *testing.T) {
	lookup := personaDelegatedWorkerSessionKind(persona.WorkerRequest{
		Prompt:  "Please inspect this PR review thread and summarize the facts.",
		Context: map[string]any{"delegation_scope": "review_followup"},
	})
	if lookup != agentrunner.SessionKindSecretaryLookup {
		t.Fatalf("session kind = %q, want secretary_lookup for untrusted delegated worker", lookup)
	}

	code := personaDelegatedWorkerSessionKind(persona.WorkerRequest{
		Prompt:  "Peng explicitly asked: fix this Oneesama bug in code.",
		Context: map[string]any{"delegation_scope": "implementation"},
	})
	if code != agentrunner.SessionKindSlack {
		t.Fatalf("session kind = %q, want slack_case for explicitly authorized code work", code)
	}
}

func TestProductLinkReactionGuardFollowsWorkspacePolicy(t *testing.T) {
	request := persona.Request{
		Event: persona.Event{Text: "转业了 https://tana.inc/"},
		Context: []persona.ContextItem{{
			Kind: "external_link_context",
			Text: "1. https://tana.inc/\n   title: Tana\n   excerpt: Tana is adding meeting workflows and collaboration features.",
		}},
		DynamicContext: []persona.DynamicContextEnvelope{{
			Kind:    "workspace_triage_policy",
			Content: "For this workspace, lightweight source-backed comments are welcome for product-adjacent articles.",
		}},
	}
	if !slackPersonaRequestNeedsProductLinkCommentary(request) {
		t.Fatal("workspace policy should enable source-backed link commentary")
	}

	noPolicy := request
	noPolicy.DynamicContext = nil
	if slackPersonaRequestNeedsProductLinkCommentary(noPolicy) {
		t.Fatal("reaction guard should not hard-code product topics without workspace policy")
	}

	explicitAsk := noPolicy
	explicitAsk.Event.Text = "看看这个 https://tana.inc/"
	if !slackPersonaRequestNeedsProductLinkCommentary(explicitAsk) {
		t.Fatal("explicit link synthesis request should still trigger lookup without workspace policy")
	}
}

func TestProductLinkSynthesisDispositionConvertsDelegateToVisibleReply(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_PAPERS",
		UserID:    "U_PENG",
		Text:      "<https://arxiv.org/html/2510.04607v2>",
		TS:        "1779434704.255149",
	}, {
		TeamID:    "T123",
		ChannelID: "C_PAPERS",
		UserID:    "U_TEAMMATE",
		Text:      "写成论文可还行",
		TS:        "1779434750.000000",
	}}
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_PAPERS",
		ThreadTS:  "1779434704.255149",
		Messages:  messages,
		Digest:    "#papers: https://arxiv.org/html/2510.04607v2\n写成论文可还行",
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://arxiv.org/html/2510.04607v2",
			Title:   "A Benchmark for Evaluating Agentic Systems",
			Excerpt: "The paper evaluates AI agent systems, tool use, planning, reliability, and benchmark methodology across multiple tasks.",
			Source:  "reader",
		}},
		WorkspaceTriagePolicy: "For this workspace, lightweight source-backed comments are welcome for product-adjacent AI agent papers and coding-agent ecosystem links.",
	})
	result, calls := applyPersonaProductLinkSynthesisDisposition(SlackPersonaShadowResult{
		Success:       true,
		Decision:      persona.DecisionDelegateWorker,
		Reason:        "Paper link matches workspace policy but Memory evidence is missing.",
		Confidence:    0.72,
		workerRecords: []persona.WorkerRequest{{ID: "lookup", Kind: "codex"}},
		WorkerRequests: []string{
			"codex: lookup",
		},
	}, request, messages)

	if result.Decision != persona.DecisionReply || strings.TrimSpace(result.VisibleText) == "" {
		t.Fatalf("result=%#v, want visible reply", result)
	}
	if len(result.workerRecords) != 0 || len(result.WorkerRequests) != 0 {
		t.Fatalf("worker records = %#v summaries=%#v, want cleared", result.workerRecords, result.WorkerRequests)
	}
	if !strings.Contains(result.VisibleText, "A Benchmark for Evaluating Agentic Systems") {
		t.Fatalf("VisibleText = %q, want synthesized paper title", result.VisibleText)
	}
	if len(result.EvidenceAnchors) < 2 || result.EvidenceAnchors[1].Kind != slackVisibleEvidenceKindFetchedLink {
		t.Fatalf("evidence anchors = %#v, want fetched-link evidence", result.EvidenceAnchors)
	}
	if len(calls) != 1 || calls[0].Action != "product_link_synthesized_visible_reply" {
		t.Fatalf("tool calls = %#v, want synthesis marker", calls)
	}
}

func TestProductLinkSynthesisDispositionKeepsIdentityLookupDelegated(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_TRIAGE",
		UserID:    "U_PENG",
		Text:      "https://news.ycombinator.com/user?id=Johnson8053 这是谁",
		TS:        "500.000",
	}}
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_TRIAGE",
		ThreadTS:  "500.000",
		Messages:  messages,
		Digest:    "#product: https://news.ycombinator.com/user?id=Johnson8053 这是谁",
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://news.ycombinator.com/user?id=Johnson8053",
			Title:   "Profile: Johnson8053 | Hacker News",
			Excerpt: "user: Johnson8053 created: September 20, 2024 karma:33 about: submissions comments favorites",
			Source:  "reader",
		}},
		WorkspaceTriagePolicy: "For this workspace, lightweight source-backed comments are welcome for product-adjacent links.",
	})
	result, calls := applyPersonaProductLinkSynthesisDisposition(SlackPersonaShadowResult{
		Success:       true,
		Decision:      persona.DecisionDelegateWorker,
		workerRecords: []persona.WorkerRequest{{ID: "lookup", Kind: "codex"}},
	}, request, messages)

	if result.Decision != persona.DecisionDelegateWorker || len(result.workerRecords) != 1 {
		t.Fatalf("result=%#v, want identity lookup to remain delegated", result)
	}
	if len(calls) != 0 {
		t.Fatalf("tool calls = %#v, want no synthesis for identity lookup", calls)
	}
}

func TestExplicitSmokeCommandDispositionConvertsSilentToAck(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_BENCH",
		UserID:    "U_PENG",
		Text:      "@oneesama smoke：用一句话确认你看到了这条，不要展开。",
		TS:        "1779450005.000005",
	}}
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_BENCH",
		ThreadTS:  "1779450005.000005",
		Messages:  messages,
		Digest:    "#bench: @oneesama smoke：用一句话确认你看到了这条，不要展开。",
	})
	result, calls := applyPersonaExplicitSmokeCommandDisposition(SlackPersonaShadowResult{
		Success:    true,
		Decision:   persona.DecisionStaySilent,
		Confidence: 0.4,
	}, request, messages)

	if result.Decision != persona.DecisionReply || result.VisibleText != "看到了。" {
		t.Fatalf("result=%#v, want short ack reply", result)
	}
	if len(result.EvidenceAnchors) != 1 || result.EvidenceAnchors[0].Kind != slackVisibleEvidenceKindExplicitUserCommand {
		t.Fatalf("anchors=%#v, want explicit command anchor", result.EvidenceAnchors)
	}
	if len(calls) != 1 || calls[0].Action != "explicit_smoke_command_visible_reply" {
		t.Fatalf("tool calls=%#v, want explicit smoke marker", calls)
	}
}

func TestPositiveStatusSummaryDispositionConvertsSilentToReaction(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{
			name: "status summary",
			text: "过去 24 小时概况：合并多项权限与 Willow 集成、对话/权限界面重构与若干 UX/后端修复；Linear 报告 5 条 issue 已同步。",
		},
		{
			name: "team daily report",
			text: "_2026-05-22 团队日报_ 今天主要是权限系统的集中重构日，zzj3720 推进权限审批流重构并修复若干 UI 问题。今日贡献者：zzj3720 · darksky。",
		},
		{
			name: "demo video share",
			text: "录了一个 computer use 操控 iPhone mirroring 创建 shortcut",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			messages := []SlackInboundMessage{{
				TeamID:    "T123",
				ChannelID: "C_STATUS",
				UserID:    "U_STATUS_BOT",
				Text:      tc.text,
				TS:        "1779447920.433539",
				ThreadTS:  "1779447920.433539",
			}}
			request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
				ChannelID: "C_STATUS",
				ThreadTS:  "1779447920.433539",
				Messages:  messages,
				Digest:    "#status: " + tc.text,
			})
			result, calls := applyPersonaPositiveStatusSummaryReactionDisposition(SlackPersonaShadowResult{
				Success:    true,
				Decision:   persona.DecisionStaySilent,
				Confidence: 0.41,
			}, request, messages)

			if result.Decision != persona.DecisionReact {
				t.Fatalf("decision = %q, want react", result.Decision)
			}
			if len(result.reactionRecords) != 1 || result.reactionRecords[0].Emoji != "tada" || result.reactionRecords[0].MessageTS != "1779447920.433539" {
				t.Fatalf("reactionRecords=%#v, want tada on status message", result.reactionRecords)
			}
			if len(calls) != 1 || calls[0].Action != "positive_status_summary_reaction" {
				t.Fatalf("tool calls=%#v, want status summary marker", calls)
			}
		})
	}
}

func TestPositiveStatusSummaryDispositionPreservesHandledSilence(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_STATUS",
		UserID:    "U_STATUS_BOT",
		Text:      "Bridge Staging staging-v1.2.17-beta.795 is released. PASS conclusion posted with release/build details and screenshots.",
		TS:        "1779450072.599829",
		ThreadTS:  "1779450072.599829",
	}}
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_STATUS",
		ThreadTS:  "1779450072.599829",
		Messages:  messages,
		Digest:    "#status: " + messages[0].Text,
	})
	result, calls := applyPersonaPositiveStatusSummaryReactionDisposition(SlackPersonaShadowResult{
		Success:    true,
		Decision:   persona.DecisionStaySilent,
		Confidence: 0.95,
		Reason:     "The thread is fully handled by another worker; no open human request remains.",
	}, request, messages)

	if result.Decision != persona.DecisionStaySilent {
		t.Fatalf("decision = %q, want handled silence preserved", result.Decision)
	}
	if len(calls) != 0 {
		t.Fatalf("tool calls=%#v, want no reaction on handled worker thread", calls)
	}
}

func TestProductLinkReactionDispositionPreservesFullyHandledThread(t *testing.T) {
	request := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_STATUS",
		ThreadTS:  "1779445997.412279",
		Messages: []SlackInboundMessage{{
			ChannelID: "C_STATUS",
			Text:      "Bridge Staging staging-v1.2.17-beta.794 is released. <https://github.com/AFK-surf/cueboard/releases/tag/staging-v1.2.17-beta.794>",
			TS:        "1779445997.412279",
			ThreadTS:  "1779445997.412279",
		}},
		Digest: "Bridge Staging staging-v1.2.17-beta.794 is released.",
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://github.com/AFK-surf/cueboard/releases/tag/staging-v1.2.17-beta.794",
			Title:   "Build software better, together",
			Excerpt: "GitHub navigation chrome",
		}},
		WorkspaceTriagePolicy: "Reply to source-backed product-adjacent articles in this workspace.",
	})
	result, calls := applyPersonaProductLinkReactionDisposition(SlackPersonaShadowResult{
		Success:    true,
		Decision:   persona.DecisionReact,
		Confidence: 0.95,
		Reason:     "The thread is fully handled; the worker already posted PASS and there is no open human request.",
		reactionRecords: []persona.ReactionIntent{{
			Emoji:     "tada",
			MessageTS: "1779450079.850319",
		}},
	}, request)

	if result.Decision != persona.DecisionReact {
		t.Fatalf("decision = %q, want reaction result preserved without worker upgrade", result.Decision)
	}
	if len(result.workerRecords) != 0 {
		t.Fatalf("workerRecords=%#v, want no secretary lookup upgrade", result.workerRecords)
	}
	if len(calls) != 1 || calls[0].Action != "product_link_reaction_preserved_already_handled" {
		t.Fatalf("tool calls=%#v, want handled product-link guard", calls)
	}
}

func hasTriageToolCall(calls []SlackTriageToolCall, tool string, action string) bool {
	for _, call := range calls {
		if call.Tool == tool && call.Action == action && call.Success {
			return true
		}
	}
	return false
}

func handoffSourceRefsContain(refs []persona.HandoffSourceRef, kind string, sourceRef string) bool {
	for _, ref := range refs {
		if ref.Kind == kind && ref.SourceRef == sourceRef {
			return true
		}
	}
	return false
}

func stringSliceContainsSubstring(values []string, needle string) bool {
	for _, value := range values {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func TestSecretaryLookupWorkerPromptCarriesMemoryEvidenceAndFollowupInstruction(t *testing.T) {
	req := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_TRIAGE",
		ThreadTS:  "500.000",
		Messages: []SlackInboundMessage{{
			TeamID:    "T123",
			ChannelID: "C_TRIAGE",
			UserID:    "U_HEYANG",
			Text:      "https://news.ycombinator.com/user?id=Johnson8053 这是谁",
			TS:        "500.000",
		}, {
			TeamID:    "T123",
			ChannelID: "C_TRIAGE",
			UserID:    "U_VINCENT",
			Text:      "不认识 他咋了？",
			TS:        "501.000",
		}},
		Digest: "#product: https://news.ycombinator.com/user?id=Johnson8053 这是谁\n不认识 他咋了？",
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://news.ycombinator.com/user?id=Johnson8053",
			Title:   "Profile: Johnson8053 | Hacker News",
			Excerpt: "user: Johnson8053 created: September 20, 2024 karma:33 about: submissions comments favorites",
			Source:  "reader",
		}},
		RelatedMemory: []SlackRelatedMemoryRecord{{
			Kind:       "person_memory",
			SourcePath: "memory/people/zanwei.md",
			StartLine:  4,
			Content:    "Johnson8053 previously matched zanwei evidence: HN submissions mention affine, bridge, fireclaw, and github.com/zanwei/design-dna.",
			Score:      0.92,
		}},
	})
	result, calls := applyPersonaSecretaryLookupDisposition(SlackPersonaShadowResult{
		Success:    true,
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionStaySilent,
		Reason:     "uncertain identity",
		Confidence: 0.4,
	}, req)

	if len(calls) != 1 || result.Decision != persona.DecisionDelegateWorker || len(result.workerRecords) != 1 {
		t.Fatalf("result=%#v calls=%#v, want one secretary lookup worker", result, calls)
	}
	worker := result.workerRecords[0]
	prompt := worker.Prompt
	for _, want := range []string{
		"Do not stop at the first profile/article excerpt",
		"submissions, comments, favorites, repository",
		"Workspace Memory/person evidence",
		"memory/people/zanwei.md",
		"github.com/zanwei/design-dna",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("secretary lookup worker prompt missing %q:\n%s", want, prompt)
		}
	}
	if evidence := stringFromAny(worker.Context["workspace_memory_evidence"]); !strings.Contains(evidence, "memory/people/zanwei.md") || !strings.Contains(evidence, "Johnson8053") {
		t.Fatalf("workspace_memory_evidence = %q, want source-backed memory", evidence)
	}
}

func TestMediaLookupDispositionDelegatesVagueImageQuestion(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_TRIAGE",
		UserID:    "U_PENG",
		Text:      "这货是干啥的，",
		TS:        "700.000",
		Files: []SlackFile{{
			ID:       "F_IMG",
			Name:     "screenshot.png",
			Mimetype: "image/png",
		}},
	}}
	req := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_TRIAGE",
		ThreadTS:  "700.000",
		Messages:  messages,
		Digest:    "#meeting-avatar: 这货是干啥的， [image screenshot.png]",
		RelatedMemory: []SlackRelatedMemoryRecord{{
			Kind:       "team_fact",
			SourcePath: "memory/team/facts/media.md",
			Content:    "Image identification questions should be delegated to secretary_lookup with Slack file evidence.",
			Score:      0.8,
		}},
	})
	result, calls := applyPersonaMediaLookupDisposition(SlackPersonaShadowResult{
		Success:    true,
		Runtime:    persona.ProviderPi,
		Decision:   persona.DecisionStaySilent,
		Reason:     "needs image inspection",
		Confidence: 0.4,
	}, req, messages)

	if len(calls) != 1 || result.Decision != persona.DecisionDelegateWorker || len(result.workerRecords) != 1 {
		t.Fatalf("result=%#v calls=%#v, want one media lookup worker", result, calls)
	}
	worker := result.workerRecords[0]
	if got := stringFromAny(worker.Context["session_kind"]); got != "" {
		t.Fatalf("session_kind should be assigned when starting worker, got %q", got)
	}
	if got := stringFromAny(worker.Context["delegation_scope"]); got != "secretary_lookup" {
		t.Fatalf("delegation_scope = %q, want secretary_lookup", got)
	}
	if !strings.Contains(worker.Prompt, "slack.fetchImage") || !strings.Contains(worker.Prompt, "Workspace Memory/person evidence") {
		t.Fatalf("media worker prompt missing fetch/memory guidance:\n%s", worker.Prompt)
	}
	if _, ok := worker.Context["slack_image_files"]; !ok {
		t.Fatalf("worker context = %#v, want slack_image_files from attached image", worker.Context)
	}
}

func TestStartPersonaDelegatedSecretaryLookupWorkerEnrichesPiWorkerRequest(t *testing.T) {
	messages := []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C_TRIAGE",
		UserID:    "U_HEYANG",
		Text:      "https://news.ycombinator.com/user?id=Johnson8053 这是谁",
		TS:        "500.000",
	}}
	req := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_TRIAGE",
		ThreadTS:  "500.000",
		Messages:  messages,
		Digest:    "#product: https://news.ycombinator.com/user?id=Johnson8053 这是谁",
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://news.ycombinator.com/user?id=Johnson8053",
			Title:   "Profile: Johnson8053 | Hacker News",
			Excerpt: "user: Johnson8053 created: September 20, 2024 karma:33 about: submissions comments favorites",
			Source:  "reader",
		}},
		RelatedMemory: []SlackRelatedMemoryRecord{{
			Kind:       "person_memory",
			SourcePath: "memory/people/zanwei.md",
			Content:    "Johnson8053 evidence points at zanwei via github.com/zanwei/design-dna and workspace discussions.",
			Score:      0.91,
		}},
	})
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_direct_pi_secretary",
		Provider: "codex",
		Status:   agentrunner.StatusRunning,
	}}
	service := NewService(Config{Runner: runner})
	result := SlackPersonaShadowResult{
		Success:   true,
		RequestID: req.ID,
		ChannelID: "C_TRIAGE",
		ThreadTS:  "500.000",
		Decision:  persona.DecisionDelegateWorker,
		workerRecords: []persona.WorkerRequest{{
			ID:     "pi-secretary-lookup",
			Kind:   "codex",
			Prompt: "Look up the HN user profile and answer who this is.",
			Context: map[string]any{
				"delegation_scope": "secretary_lookup",
			},
		}},
	}

	started := service.startPersonaDelegatedWorkerJobs(context.Background(), "T123", 99, result, req, messages)
	if len(started.JobIDs) != 1 || runner.startCount != 1 {
		t.Fatalf("started=%#v runner.startCount=%d, want one worker", started, runner.startCount)
	}
	if got := runner.startInput.Context["session_kind"]; got != agentrunner.SessionKindSecretaryLookup {
		t.Fatalf("session_kind = %#v, want secretary_lookup", got)
	}
	for _, want := range []string{
		"Do not stop at the first profile/article excerpt",
		`"evidence_anchors"`,
		"Workspace Memory/person evidence",
		"memory/people/zanwei.md",
		"github.com/zanwei/design-dna",
	} {
		if !strings.Contains(runner.startInput.Task, want) {
			t.Fatalf("direct Pi secretary worker task missing %q:\n%s", want, runner.startInput.Task)
		}
	}
	if evidence := stringFromAny(runner.startInput.Context["workspace_memory_evidence"]); !strings.Contains(evidence, "memory/people/zanwei.md") || !strings.Contains(evidence, "Johnson8053") {
		t.Fatalf("workspace_memory_evidence = %q, want request memory passed through", evidence)
	}
}
