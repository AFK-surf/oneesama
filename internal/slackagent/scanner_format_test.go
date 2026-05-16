package slackagent

import "testing"

func TestResolveTextMentionsRewritesOriginalTokensOnly(t *testing.T) {
	got := resolveTextMentions("hi <@U1> and <@U2>", func(uid string) string {
		return map[string]string{
			"U1": "peng",
			"U2": "@already",
		}[uid]
	})
	if want := "hi @peng and @already"; got != want {
		t.Fatalf("resolveTextMentions() = %q, want %q", got, want)
	}
}

func TestResolveTextMentionsKeepsSlackMentionFallbackFinite(t *testing.T) {
	got := resolveTextMentions("please ask <@U123> to check", func(uid string) string {
		return "<@" + uid + ">"
	})
	if want := "please ask <@U123> to check"; got != want {
		t.Fatalf("resolveTextMentions() = %q, want %q", got, want)
	}
}

func TestResolveTextMentionsLeavesMalformedMentionAlone(t *testing.T) {
	got := resolveTextMentions("please ask <@U123", func(uid string) string {
		return "peng"
	})
	if want := "please ask <@U123"; got != want {
		t.Fatalf("resolveTextMentions() = %q, want %q", got, want)
	}
}
