//go:build cueboardparity

package postmeeting

import (
	"strings"
	"testing"
)

func TestCueboardParityFallbackSummaryAvoidsRawJSONBlob(t *testing.T) {
	t.Parallel()

	summary := buildFallbackSummary(PostProcessInput{Title: "Meeting"}, []NormalizedSegment{{
		Speaker: "Assistant",
		Text:    `{"title":"Meeting","key_points":["x"],"action_items":[]}`,
	}}, nil)
	want := "Structured summary generation failed to parse cleanly. Please review the transcript and artifacts."
	if len(summary.Highlights) == 0 || summary.Highlights[0] != want {
		t.Fatalf("summary highlights = %#v, want %q", summary.Highlights, want)
	}
}

func TestCueboardParityFallbackSummaryTruncatesLongTextToReadableBullet(t *testing.T) {
	t.Parallel()

	summary := buildFallbackSummary(PostProcessInput{Title: "Meeting"}, []NormalizedSegment{{
		Speaker: "Alice",
		Text:    strings.Repeat("中", 2500),
	}}, nil)
	if len(summary.Highlights) != 1 {
		t.Fatalf("summary highlights = %#v, want one item", summary.Highlights)
	}
	runes := []rune(summary.Highlights[0])
	if len(runes) != 243 || !strings.HasSuffix(summary.Highlights[0], "...") {
		t.Fatalf("highlight len = %d suffix=%v, want 243 runes ending with ellipsis", len(runes), strings.HasSuffix(summary.Highlights[0], "..."))
	}
}

func TestCueboardParityTranscriptDropsExactDuplicateCaptions(t *testing.T) {
	t.Parallel()

	segments := normalizeSegments(PostProcessInput{Captions: []TranscriptSegmentInput{
		{Speaker: "Alice", Text: "ship the launch notes", Timestamp: "2026-05-13T10:00:00Z"},
		{Speaker: "Alice", Text: "ship the launch notes", Timestamp: "2026-05-13T10:00:01Z"},
	}})
	if len(segments) != 1 {
		t.Fatalf("segments = %#v, want exact duplicate caption collapsed", segments)
	}
}

func TestCueboardParityTranscriptCollapsesIncrementalCaptionUpdates(t *testing.T) {
	t.Parallel()

	segments := normalizeSegments(PostProcessInput{Captions: []TranscriptSegmentInput{
		{Speaker: "Peng", Text: "This.", StreamID: "caption-1", Timestamp: "2026-05-13T10:00:00Z"},
		{Speaker: "Peng", Text: "This caption should be captured.", StreamID: "caption-1", Timestamp: "2026-05-13T10:00:01Z"},
		{Speaker: "Peng", Text: "This caption should be captured automatically and mention rain and wind speed.", StreamID: "caption-1", Timestamp: "2026-05-13T10:00:02Z"},
		{Speaker: "Peng", Text: "This caption should be captured automatically and mention rain and wind speed.", StreamID: "caption-2", Timestamp: "2026-05-13T10:00:02Z"},
	}})
	if len(segments) != 1 {
		t.Fatalf("segments = %#v, want incremental caption updates collapsed", segments)
	}
	if segments[0].Text != "This caption should be captured automatically and mention rain and wind speed." {
		t.Fatalf("text = %q, want final caption text", segments[0].Text)
	}
}
