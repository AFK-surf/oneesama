package slackagent

import "testing"

func TestNormalizeSlackExternalLinkURLDropsSlackLabel(t *testing.T) {
	t.Parallel()

	raw := "<https://deno.com/blog/clawpatrol|https://deno.com/blog/clawpatrol>"
	got := normalizeSlackExternalLinkURL(raw)
	want := "https://deno.com/blog/clawpatrol"
	if got != want {
		t.Fatalf("normalizeSlackExternalLinkURL(%q) = %q, want %q", raw, got, want)
	}
}
