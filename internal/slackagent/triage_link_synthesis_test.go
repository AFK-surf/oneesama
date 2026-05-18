package slackagent

import "testing"

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
