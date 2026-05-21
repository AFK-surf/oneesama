package slackagent

import (
	"strings"
	"testing"

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
