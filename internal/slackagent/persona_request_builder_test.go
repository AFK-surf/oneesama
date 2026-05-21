package slackagent

import (
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/persona"
)

func TestBuildSlackTriagePersonaForegroundRequestSetsLiveBoundary(t *testing.T) {
	t.Parallel()

	req := BuildSlackTriagePersonaForegroundRequest(SlackTriagePersonaForegroundRequestInput{
		ChannelID:              "C_FOREGROUND",
		ThreadTS:               "300.000",
		Messages:               []SlackInboundMessage{{Text: "这条要 Oneesama 回一下"}},
		Decision:               SlackTriageDecision{Summary: "Codex candidate summary.", ParseOK: true},
		IgnoreExistingBotReply: true,
		WorkspaceTriagePolicy:  "Use workspace-specific policy.",
		CustomEmoji:            []string{"eyes_bridge"},
	})

	if req.Mode != persona.ModeLive {
		t.Fatalf("Mode = %q, want live", req.Mode)
	}
	if got := req.Metadata["foreground_chain"]; got != slackTriageForegroundChainCodexThenPi {
		t.Fatalf("foreground_chain = %#v, want codex_then_pi", got)
	}
	if got := req.Metadata["ignore_existing_bot_reply"]; got != true {
		t.Fatalf("ignore_existing_bot_reply = %#v, want true", got)
	}
	if got := personaContextText(req.Context, "dev_rerun_override"); !strings.Contains(got, "ignore existing bot-authored replies") {
		t.Fatalf("dev_rerun_override = %q, want rerun guard", got)
	}
	if got := personaContextText(req.Context, "delegation_scope_policy"); !strings.Contains(got, "workspace secretary") {
		t.Fatalf("delegation_scope_policy = %q, want secretary boundary", got)
	}
	if got := personaContextText(req.Context, "workspace_custom_emoji"); got != "" {
		t.Fatalf("workspace_custom_emoji stable context = %q, want dynamic envelope only", got)
	}
	if got := personaDynamicContextText(req.DynamicContext, "workspace_custom_emoji"); !strings.Contains(got, "eyes_bridge") {
		t.Fatalf("workspace_custom_emoji dynamic context = %q, want custom emoji", got)
	}
	if got := personaDynamicContextText(req.DynamicContext, "current_time"); got == "" {
		t.Fatal("current_time dynamic context empty, want runtime freshness envelope")
	}
}

func TestBuildSlackTriagePiFirstForegroundRequestCarriesRichContext(t *testing.T) {
	t.Parallel()

	policy := "Reply to source-backed product-adjacent articles in this workspace."
	req := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID:     "C_PI",
		ThreadTS:      "400.000",
		Messages:      []SlackInboundMessage{{Text: "这个产品文章值得评价吗？"}},
		RelatedMemory: []SlackRelatedMemoryRecord{{Kind: "workspace_memory", SourcePath: "memory/product.md", Content: "产品讨论要结合 workspace memory。", Score: 0.8}},
		Digest:        "product link digest",
		ThreadContexts: []SlackTriageThreadContext{{
			ChannelID:    "C_PI",
			ThreadTS:     "400.000",
			FetchOK:      true,
			MessageCount: 1,
			Transcript:   "thread context clue",
		}},
		ChannelContexts: []SlackInboundMessage{{Text: "channel context clue"}},
		ExternalLinks: []SlackExternalLinkContext{{
			URL:     "https://example.com/product",
			Title:   "product source title",
			Excerpt: "source excerpt beyond headline",
			Source:  "reader",
		}},
		PreviousTriage:         "previous triage clue",
		IgnoreExistingBotReply: true,
		WorkspaceTriagePolicy:  policy,
		WorkspacePolicyStatus:  buildSlackWorkspacePolicyStatus(policy),
		CustomEmoji:            []string{"ok_bridge"},
	})

	if req.Mode != persona.ModeLive {
		t.Fatalf("Mode = %q, want live", req.Mode)
	}
	if got := req.Metadata["foreground_chain"]; got != slackTriageForegroundChainPiFirstLive {
		t.Fatalf("foreground_chain = %#v, want pi_first_live", got)
	}
	if got := personaContextText(req.Context, "triage_candidate_actions"); got != "" {
		t.Fatalf("triage_candidate_actions = %q, want absent for pi-first request", got)
	}
	for kind, want := range map[string]string{
		"triage_digest":           "product link digest",
		"slack_thread_context":    "thread context clue",
		"slack_channel_context":   "channel context clue",
		"external_link_context":   "source excerpt beyond headline",
		"previous_triage_context": "previous triage clue",
	} {
		if got := personaContextText(req.Context, kind); !strings.Contains(got, want) {
			t.Fatalf("%s context = %q, want %q", kind, got, want)
		}
	}
	for kind, want := range map[string]string{
		"workspace_triage_policy": "product-adjacent articles",
		"workspace_custom_emoji":  "ok_bridge",
		"current_time":            "T",
	} {
		if got := personaDynamicContextText(req.DynamicContext, kind); !strings.Contains(got, want) {
			t.Fatalf("%s dynamic context = %q, want %q", kind, got, want)
		}
		if got := personaContextText(req.Context, kind); got != "" {
			t.Fatalf("%s stable context = %q, want dynamic envelope only", kind, got)
		}
	}
	if got := personaContextText(req.Context, "workspace_triage_policy_metadata"); got != "" {
		t.Fatalf("workspace_triage_policy_metadata stable context = %q, want metadata on dynamic envelope", got)
	}
	if len(req.Memory.Items) != 1 || req.Memory.Items[0].SourceRef != "memory/product.md" {
		t.Fatalf("memory = %#v, want related memory item", req.Memory)
	}
}

func TestBuildSlackTriagePiFirstForegroundRequestBoundsWorkerScratchContext(t *testing.T) {
	t.Parallel()

	rawWorkerTail := "RAW_WORKER_TAIL_SHOULD_NOT_ENTER_PI"
	hugeTranscript := "worker file read started\n" + strings.Repeat("file-chunk ", 800) + rawWorkerTail
	previous := formatTriageContexts([]SlackTriageContext{{
		Timestamp: "2026-05-21T12:00:00Z",
		Status:    "failed",
		Channels:  []string{"C_PI"},
		Summary:   "worker failed after reading scratch logs",
		RawOutput: "<oneesama_tool_request>" + strings.Repeat("raw-tool-log ", 100) + "</oneesama_tool_request>",
		Error:     "timeout",
	}})
	req := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_PI",
		ThreadTS:  "501.000",
		Messages:  []SlackInboundMessage{{Text: "这个线程继续看一下"}},
		ThreadContexts: []SlackTriageThreadContext{{
			ChannelID:    "C_PI",
			ThreadTS:     "501.000",
			FetchOK:      true,
			MessageCount: 1,
			Transcript:   hugeTranscript,
		}},
		PreviousTriage: previous,
	})

	threadContext := personaContextText(req.Context, "slack_thread_context")
	if len(threadContext) > slackThreadContextBudgetChars+3 {
		t.Fatalf("slack_thread_context length = %d, want bounded", len(threadContext))
	}
	if strings.Contains(threadContext, rawWorkerTail) {
		t.Fatalf("slack_thread_context leaked raw worker tail: %q", threadContext)
	}
	previousContext := personaContextText(req.Context, "previous_triage_context")
	for _, banned := range []string{"<oneesama_tool_request>", "raw-tool-log"} {
		if strings.Contains(previousContext, banned) {
			t.Fatalf("previous_triage_context leaked raw worker scratch %q: %q", banned, previousContext)
		}
	}
	if !strings.Contains(previousContext, "FAILED") {
		t.Fatalf("previous_triage_context = %q, want compact failure status", previousContext)
	}
}

func TestSlackPersonaStablePromptIgnoresDynamicWorkspaceInputs(t *testing.T) {
	originalNow := timeNow
	defer func() { timeNow = originalNow }()

	timeNow = func() time.Time {
		return time.Date(2026, 5, 21, 10, 0, 0, 0, time.UTC)
	}
	first := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_PI",
		ThreadTS:  "500.000",
		Messages:  []SlackInboundMessage{{Text: "first article"}},
		RelatedMemory: []SlackRelatedMemoryRecord{{
			Kind:       "workspace_memory",
			SourcePath: "memory/a.md",
			Content:    "memory anchor alpha",
			Score:      0.8,
		}},
		WorkspaceTriagePolicy: "policy alpha: engage browser harness posts",
		CustomEmoji:           []string{"alpha_bridge"},
	})

	timeNow = func() time.Time {
		return time.Date(2026, 5, 22, 11, 30, 0, 123, time.UTC)
	}
	second := BuildSlackTriagePiFirstForegroundRequest(SlackTriagePiFirstForegroundRequestInput{
		ChannelID: "C_PI",
		ThreadTS:  "500.000",
		Messages:  []SlackInboundMessage{{Text: "second article"}},
		RelatedMemory: []SlackRelatedMemoryRecord{{
			Kind:       "workspace_memory",
			SourcePath: "memory/b.md",
			Content:    "memory anchor beta",
			Score:      0.9,
		}},
		WorkspaceTriagePolicy: "policy beta: stay silent on browser harness posts",
		CustomEmoji:           []string{"beta_bridge"},
	})

	if got, want := personaDynamicContextText(first.DynamicContext, "current_time"), personaDynamicContextText(second.DynamicContext, "current_time"); got == "" || want == "" || got == want {
		t.Fatalf("current_time envelopes = %q / %q, want distinct dynamic timestamps", got, want)
	}
	if got := personaDynamicContextText(first.DynamicContext, "workspace_triage_policy"); !strings.Contains(got, "policy alpha") {
		t.Fatalf("first workspace policy dynamic context = %q, want alpha policy", got)
	}
	if got := personaDynamicContextText(second.DynamicContext, "workspace_triage_policy"); !strings.Contains(got, "policy beta") {
		t.Fatalf("second workspace policy dynamic context = %q, want beta policy", got)
	}
	if got := personaDynamicContextText(first.DynamicContext, "workspace_custom_emoji"); !strings.Contains(got, "alpha_bridge") {
		t.Fatalf("first custom emoji dynamic context = %q, want alpha emoji", got)
	}
	if got := personaDynamicContextText(second.DynamicContext, "workspace_custom_emoji"); !strings.Contains(got, "beta_bridge") {
		t.Fatalf("second custom emoji dynamic context = %q, want beta emoji", got)
	}
	if len(first.Memory.Items) != 1 || len(second.Memory.Items) != 1 || first.Memory.Items[0].Text == second.Memory.Items[0].Text {
		t.Fatalf("memory contexts = %#v / %#v, want distinct memory payloads", first.Memory, second.Memory)
	}
	if got, want := persona.OneesamaPIStablePromptHash(first), persona.OneesamaPIStablePromptHash(second); got != want {
		t.Fatalf("stable prompt hash changed under dynamic time/policy/emoji/memory inputs: got %s want %s", got, want)
	}
	stablePrompt := persona.OneesamaPIStablePromptText(first)
	for _, forbidden := range []string{
		"policy alpha",
		"alpha_bridge",
		"2026-05-21T10:00:00Z",
		"memory anchor alpha",
		persona.DynamicContextCachePolicyNotStablePrefix,
	} {
		if strings.Contains(stablePrompt, forbidden) {
			t.Fatalf("stable prompt leaked dynamic content %q:\n%s", forbidden, stablePrompt)
		}
	}
}
