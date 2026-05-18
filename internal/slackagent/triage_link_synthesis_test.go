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
