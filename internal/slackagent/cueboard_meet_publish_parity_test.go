//go:build cueboardparity

package slackagent

import (
	"strings"
	"testing"
)

func TestCueboardParityNormalizeCanvasListLine(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "asterisk bullet", in: "* item", want: "item"},
		{name: "numbered bullet", in: "12. item", want: "item"},
		{name: "plain text", in: "plain text", want: "plain text"},
		{name: "not numeric prefix", in: "v1. release", want: "v1. release"},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := normalizeCanvasListLine(tt.in); got != tt.want {
				t.Fatalf("normalizeCanvasListLine(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestCueboardParityCanvasNumberedListPrefix(t *testing.T) {
	t.Parallel()

	if idx, ok := canvasNumberedListPrefix("1234. too long"); ok || idx != 0 {
		t.Fatalf("canvasNumberedListPrefix should reject long prefixes, got idx=%d ok=%v", idx, ok)
	}
	if idx, ok := canvasNumberedListPrefix("3. item"); !ok || idx != 1 {
		t.Fatalf("canvasNumberedListPrefix = (%d, %v), want (1, true)", idx, ok)
	}
}

func TestCueboardParityCanvasMarkdownDoesNotDuplicateDocumentTitle(t *testing.T) {
	t.Parallel()

	md, err := renderCanvasMarkdown(CanvasPublishInput{
		Title: "Fallback Title",
		Artifact: CanvasArtifact{
			Title:   "Structured Title",
			MeetURL: "https://meet.google.com/example",
			Summary: &CanvasArtifactSummary{
				DurationMinutes: 30,
				Attendees:       []string{"Alice", "Bob"},
				Highlights:      []string{"One"},
			},
		},
	})
	if err != nil {
		t.Fatalf("renderCanvasMarkdown() error = %v", err)
	}
	if strings.HasPrefix(md, "# ") {
		t.Fatalf("renderCanvasMarkdown should not emit top-level title heading, got %q", md)
	}
	if !strings.Contains(md, "**Duration:** 30 minutes") {
		t.Fatalf("expected duration metadata in markdown, got %q", md)
	}
}
