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

func TestSharedLinkSynthesisRejectsLowSignalSocialStatus(t *testing.T) {
	t.Parallel()

	_, ok := firstSynthesisEligibleExternalLink([]SlackExternalLinkContext{{
		URL:     "https://x.com/FiachraRM/status/2056172311620075824?s=20",
		Title:   `Fiachra on X: "the era of discomorphism has arrived"`,
		Excerpt: "Log in Sign up Post Conversation the era of discomorphism has arrived Trending now Terms of Service Privacy Policy Cookie Policy",
		Source:  "jina_reader",
	}})
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
	}})
	if ok {
		t.Fatal("GitHub chrome/marketing boilerplate should not be treated as linked article content")
	}
}
