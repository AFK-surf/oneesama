package slackagent

import (
	"strings"
	"testing"
)

func TestSharedLinkSynthesisRequiresWorkspacePolicyOrExplicitAsk(t *testing.T) {
	t.Parallel()

	contexts := []SlackExternalLinkContext{{
		URL:     "https://antirez.com/news/166",
		Title:   "Alternatives for the EDIT tool of LLM agents",
		Excerpt: strings.Repeat("This article explains an LLM agent edit strategy with source-backed tradeoffs. ", 5),
		Source:  "jina_reader",
	}}
	coldShare := []SlackInboundMessage{{Text: "<https://antirez.com/news/166>", TS: "123.456"}}
	if _, ok := slackTriageSharedLinkSynthesisAction("C1", "123.456", coldShare, contexts, ""); ok {
		t.Fatal("cold shared link without workspace policy should not trigger deterministic synthesis")
	}
	if _, ok := slackTriageSharedLinkSynthesisAction("C1", "123.456", coldShare, contexts, "Reply to source-backed product-adjacent articles in this workspace."); !ok {
		t.Fatal("workspace policy should enable deterministic source-backed link synthesis")
	}
	explicitAsk := []SlackInboundMessage{{Text: "看看这个 <https://antirez.com/news/166>", TS: "123.456"}}
	if _, ok := slackTriageSharedLinkSynthesisAction("C1", "123.456", explicitAsk, contexts, ""); !ok {
		t.Fatal("explicit link-synthesis ask should trigger without workspace policy")
	}
}

func TestSharedLinkSynthesisAddsFetchedLinkEvidenceAnchor(t *testing.T) {
	t.Parallel()

	context := SlackExternalLinkContext{
		URL:     "https://antirez.com/news/166",
		Title:   "Alternatives for the EDIT tool of LLM agents",
		Excerpt: strings.Repeat("This article explains an LLM agent edit strategy with source-backed tradeoffs. ", 5),
		Source:  "jina_reader",
	}
	action, ok := slackTriageSharedLinkSynthesisAction(
		"C1",
		"123.456",
		[]SlackInboundMessage{{Text: "看看这个 <https://antirez.com/news/166>", TS: "123.456"}},
		[]SlackExternalLinkContext{context},
		"",
	)
	if !ok {
		t.Fatal("explicit link-synthesis ask should trigger")
	}
	if len(action.EvidenceAnchors) != 2 {
		t.Fatalf("EvidenceAnchors = %#v, want thread + fetched link anchors", action.EvidenceAnchors)
	}
	link := action.EvidenceAnchors[1]
	if link.Kind != slackVisibleEvidenceKindFetchedLink || link.SourceRef != context.URL || link.ConfidenceSource != "source_derived:fetched_link" || link.Freshness != "jina_reader" {
		t.Fatalf("link anchor = %#v", link)
	}
}

func TestEnrichTriageActionsWithFetchedLinkEvidence(t *testing.T) {
	t.Parallel()

	actions := enrichSlackTriageActionsWithContextEvidence(
		[]SlackTriageDecisionAction{{
			Type:      slackActionTypeThreadReply,
			Message:   "这条链接讨论 agent 编辑工具的取舍。",
			ChannelID: "C1",
			ThreadTS:  "123.456",
		}},
		"C1",
		"123.456",
		[]SlackInboundMessage{{Text: "看看 <https://antirez.com/news/166>", TS: "123.456"}},
		[]SlackExternalLinkContext{{
			URL:     "https://antirez.com/news/166",
			Title:   "Alternatives for the EDIT tool of LLM agents",
			Excerpt: "Source-backed article excerpt.",
			Source:  "jina_reader",
		}},
	)
	if len(actions) != 1 || len(actions[0].EvidenceAnchors) != 2 {
		t.Fatalf("actions = %#v, want thread + fetched-link anchors", actions)
	}
	if !slackVisibleReplyAllowListVerdictForAction(actions[0]).Allowed {
		t.Fatalf("action = %#v, want allow-list eligible after fetched-link enrichment", actions[0])
	}
}

func TestSharedLinkSynthesisRejectsLowSignalSocialStatus(t *testing.T) {
	t.Parallel()

	_, ok := firstSynthesisEligibleExternalLink([]SlackExternalLinkContext{{
		URL:     "https://x.com/FiachraRM/status/2056172311620075824?s=20",
		Title:   `Fiachra on X: "the era of discomorphism has arrived"`,
		Excerpt: "Log in Sign up Post Conversation the era of discomorphism has arrived Trending now Terms of Service Privacy Policy Cookie Policy",
		Source:  "jina_reader",
	}}, false)
	if ok {
		t.Fatal("low-signal X status should not trigger deterministic link synthesis")
	}
}

func TestSharedLinkSynthesisRejectsGitHubChromeBoilerplate(t *testing.T) {
	t.Parallel()

	_, ok := firstSynthesisEligibleExternalLink([]SlackExternalLinkContext{{
		URL:     "https://github.com/hangli-hl/AI-Articles/blob/main/llm-thinking.pdf",
		Title:   "AI-Articles/llm-thinking.pdf at main · hangli-hl/AI-Articles",
		Excerpt: "AI CODE CREATION GitHub Copilot Write better code with AI GitHub Spark Build and deploy intelligent apps GitHub Models Manage and compare prompts MCP Registry New Integrate external tools Developer workflow",
		Source:  "jina_reader",
	}}, false)
	if ok {
		t.Fatal("GitHub chrome/marketing boilerplate should not be treated as linked article content")
	}
}

func TestSharedLinkSynthesisRejectsReaderFailureChrome(t *testing.T) {
	t.Parallel()

	cases := []SlackExternalLinkContext{
		{
			URL:     "https://deno.com/blog/claw-patrol",
			Title:   "Not Found | Deno",
			Excerpt: "⌘K Up or down to navigate Enter to select Escape to close Search powered by Orama New! Introducing Deno Sandbox",
			Source:  "reader",
		},
		{
			URL:     "https://linear.app/example",
			Title:   "Log in to Linear",
			Excerpt: "Don't have an account? Sign up or learn more about Linear.",
			Source:  "reader",
		},
	}
	for _, context := range cases {
		if _, ok := firstSynthesisEligibleExternalLink([]SlackExternalLinkContext{context}, true); ok {
			t.Fatalf("context=%#v should not trigger deterministic link synthesis", context)
		}
	}
}

func TestSharedLinkSynthesisReplyAvoidsReadingProcessNarration(t *testing.T) {
	t.Parallel()

	action, ok := slackTriageSharedLinkSynthesisAction("C123", "100.000", []SlackInboundMessage{{
		ChannelID: "C123",
		Text:      "看看这个产品链接，给我一句有证据的评论：https://example.com/product",
		TS:        "100.000",
	}}, []SlackExternalLinkContext{{
		URL:     "https://example.com/product",
		Title:   "Example Product",
		Excerpt: "A concrete product page excerpt about the feature and launch timing.",
		Source:  "reader",
	}}, "")
	if !ok || strings.TrimSpace(action.Message) == "" {
		t.Fatalf("action=%#v ok=%v, want explicit short-context link synthesis", action, ok)
	}
	for _, marker := range []string{"我粗读了一下", "核心信息是", "我的初步判断", "讨论引子", "如果继续聊"} {
		if strings.Contains(action.Message, marker) {
			t.Fatalf("message %q contains narration marker %q", action.Message, marker)
		}
	}
}

func TestSharedLinkSynthesisAllowsShortContextForExplicitAsk(t *testing.T) {
	t.Parallel()

	action, ok := slackTriageSharedLinkSynthesisAction("C123", "100.000", []SlackInboundMessage{{
		ChannelID: "C123",
		Text:      "看看这个产品链接，给我一句有证据的评论：https://example.com/product",
		TS:        "100.000",
	}}, []SlackExternalLinkContext{{
		URL:     "https://example.com/product",
		Title:   "Example Product",
		Excerpt: "A short but concrete product page excerpt.",
		Source:  "reader",
	}}, "")
	if !ok || strings.TrimSpace(action.Message) == "" {
		t.Fatalf("action=%#v ok=%v, want explicit short-context link synthesis", action, ok)
	}
}
