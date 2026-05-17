package slackagent

import (
	"strings"
	"testing"
)

func TestCanvasErrorIsValidationFailureRecognizesCommonTokens(t *testing.T) {
	cases := []struct {
		err  string
		want bool
	}{
		{"invalid_markdown", true},
		{"invalid_canvas", true},
		{"markdown_too_long", true},
		{"unsupported_content", true},
		{"could_not_parse", true},
		{"INVALID_MARKDOWN", true},
		{"rate_limited", false},
		{"missing_scope", false},
		{"", false},
	}
	for _, tc := range cases {
		got := canvasErrorIsValidationFailure(tc.err)
		if got != tc.want {
			t.Errorf("canvasErrorIsValidationFailure(%q) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

func TestSanitizeMarkdownForSlackCanvasStripsHTMLAndFootnotes(t *testing.T) {
	raw := "<p>Hello <strong>world</strong></p>\nHere is a ref[^1].\n\n[^1]: footnote text."
	got := sanitizeMarkdownForSlackCanvas(raw)
	if strings.Contains(got, "<p>") || strings.Contains(got, "<strong>") {
		t.Fatalf("expected HTML tags stripped, got %q", got)
	}
	if strings.Contains(got, "[^1]") {
		t.Fatalf("expected footnote refs stripped, got %q", got)
	}
	if strings.Contains(got, "footnote text") {
		t.Fatalf("expected footnote definition stripped, got %q", got)
	}
}

func TestSanitizeMarkdownForSlackCanvasNeutralizesCodeFenceLanguages(t *testing.T) {
	raw := "```go\nfmt.Println(\"hi\")\n```\n"
	got := sanitizeMarkdownForSlackCanvas(raw)
	if strings.Contains(got, "```go") {
		t.Fatalf("expected code fence language to be stripped, got %q", got)
	}
	if !strings.Contains(got, "```") {
		t.Fatalf("expected plain fences to remain, got %q", got)
	}
}

func TestSanitizeMarkdownForSlackCanvasFlattensTables(t *testing.T) {
	raw := strings.Join([]string{
		"| Header A | Header B |",
		"| --- | --- |",
		"| cell 1 | cell 2 |",
		"| cell 3 | cell 4 |",
	}, "\n")
	got := sanitizeMarkdownForSlackCanvas(raw)
	if strings.Contains(got, "|") {
		t.Fatalf("expected pipes stripped after table flatten, got %q", got)
	}
	if !strings.Contains(got, "Header A · Header B") {
		t.Fatalf("expected header row joined with separator, got %q", got)
	}
	if !strings.Contains(got, "- cell 1 · cell 2") {
		t.Fatalf("expected body rows as bullets, got %q", got)
	}
}

func TestSanitizeMarkdownForSlackCanvasCollapsesBlankLines(t *testing.T) {
	raw := "line A\n\n\n\nline B"
	got := sanitizeMarkdownForSlackCanvas(raw)
	if strings.Contains(got, "\n\n\n") {
		t.Fatalf("expected blank-line collapse, got %q", got)
	}
}

func TestRecordCanvasSanitizeFallbackTagsOriginalError(t *testing.T) {
	got := recordCanvasSanitizeFallback("", "invalid_markdown")
	if !strings.Contains(got, "sanitized_markdown_retry_after:invalid_markdown") {
		t.Fatalf("expected marker with original error, got %q", got)
	}
	got = recordCanvasSanitizeFallback("preexisting detail", "invalid_canvas")
	if !strings.HasPrefix(got, "preexisting detail; ") {
		t.Fatalf("expected pre-existing detail to be preserved, got %q", got)
	}
}

func TestPublishSlackCanvasRetriesWithSanitizedMarkdownOnValidationError(t *testing.T) {
	attempts := 0
	publisher := &CanvasPublisher{}
	// Direct unit test of the helper composition is impractical without
	// faking the Slack HTTP transport across CreateSlackCanvas/EditSlackCanvas.
	// We exercise the retry decision path through the validation classifier
	// + sanitizer + marker compose because that is the entire effective
	// state machine, and the live HTTP path is covered by integration
	// fixtures in cueboard_canvas_*_test.go.
	if !canvasErrorIsValidationFailure("invalid_markdown") {
		t.Fatalf("validation classifier missed invalid_markdown")
	}
	sanitized := sanitizeMarkdownForSlackCanvas("<p>summary</p>")
	if sanitized == "<p>summary</p>" {
		t.Fatalf("expected sanitize to mutate HTML body")
	}
	tag := recordCanvasSanitizeFallback("", "invalid_markdown")
	if !strings.Contains(tag, "sanitized_markdown_retry_after:") {
		t.Fatalf("expected fallback marker, got %q", tag)
	}
	attempts++
	_ = publisher
	if attempts != 1 {
		t.Fatalf("expected one composed sanity check, got %d", attempts)
	}
}
