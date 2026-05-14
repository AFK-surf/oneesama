//go:build cueboardparity

package slackagent

import "testing"

func TestCueboardParityHTMLToMarkdownConvertsLinks(t *testing.T) {
	got := htmlToMarkdown(`<p>Hello <a href="https://example.com">world</a></p>`)
	want := "Hello [world](https://example.com)"
	if got != want {
		t.Fatalf("htmlToMarkdown() = %q, want %q", got, want)
	}
}
