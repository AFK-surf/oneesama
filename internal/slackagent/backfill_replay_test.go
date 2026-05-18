package slackagent

import (
	"strings"
	"testing"
)

// TestClassifyBackfillMessageRejectsBotAuthor pins the rule that
// oneesama never proposes a follow-up to its own message — that would
// be talking to itself.
func TestClassifyBackfillMessageRejectsBotAuthor(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123",
		TS:        "111.000",
		UserID:    "U_BOT",
		Text:      "Why does this happen?",
	}
	_, ok := ClassifyBackfillMessage(msg, nil, []string{"U_BOT"})
	if ok {
		t.Fatal("expected bot-authored message to be skipped")
	}
}

// TestClassifyBackfillMessageRejectsLowSignal ensures the +1/lol/ack
// kind of chatter doesn't generate candidates.
func TestClassifyBackfillMessageRejectsLowSignal(t *testing.T) {
	cases := []string{"+1", "lgtm", "lol", "thanks", "收到"}
	for _, text := range cases {
		t.Run(text, func(t *testing.T) {
			msg := SlackInboundMessage{ChannelID: "C123", TS: "111.000", UserID: "U_HUMAN", Text: text}
			if _, ok := ClassifyBackfillMessage(msg, nil, nil); ok {
				t.Fatalf("expected low-signal text %q to be skipped", text)
			}
		})
	}
}

// TestClassifyBackfillMessageRejectsMessagesWithHumanReply pins the
// "don't talk over a human who already replied" rule — the whole point
// of the scan is to catch unanswered things, not to add a third opinion.
func TestClassifyBackfillMessageRejectsMessagesWithHumanReply(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "Has anyone seen broken builds on main today?",
	}
	replies := []SlackInboundMessage{
		{ChannelID: "C123", TS: "111.500", UserID: "U_DRIVER", Text: "Looking into it now."},
	}
	if _, ok := ClassifyBackfillMessage(msg, replies, []string{"U_BOT"}); ok {
		t.Fatal("expected human-already-replied to skip candidate")
	}
}

// TestClassifyBackfillMessageAllowsBotOnlyReplies confirms that a
// previous bot reply does NOT count as "human caught it" — we still
// want oneesama to follow up if only the bot answered.
func TestClassifyBackfillMessageAllowsBotOnlyReplies(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "Has anyone seen broken builds on main today?",
	}
	replies := []SlackInboundMessage{
		{ChannelID: "C123", TS: "111.500", UserID: "U_BOT", Text: "I have not yet seen this."},
	}
	candidate, ok := ClassifyBackfillMessage(msg, replies, []string{"U_BOT"})
	if !ok {
		t.Fatal("expected bot-only reply to still produce a candidate")
	}
	if candidate.Classification == "" {
		t.Fatalf("classification empty, got %+v", candidate)
	}
}

// TestClassifyBackfillMessageMarksStuckHelp covers the canonical "卡住"
// path — driver's #186 classifier returns stuck_or_handoff, and the
// backfill output must surface that with a stuck-flavoured draft.
func TestClassifyBackfillMessageMarksStuckHelp(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "看起来 CI 卡住了，没反应。",
	}
	candidate, ok := ClassifyBackfillMessage(msg, nil, nil)
	if !ok {
		t.Fatal("expected stuck-help message to classify")
	}
	if candidate.Classification != "stuck_or_handoff" {
		t.Fatalf("classification = %q, want stuck_or_handoff", candidate.Classification)
	}
	if !strings.Contains(candidate.Draft, "卡住") {
		t.Fatalf("draft = %q, want to mention 卡住", candidate.Draft)
	}
}

// TestClassifyBackfillMessageMarksUnansweredQuestion covers the
// question-mark path → unanswered_question.
func TestClassifyBackfillMessageMarksUnansweredQuestion(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "我们今天能不能上线 canvas writes？",
	}
	candidate, ok := ClassifyBackfillMessage(msg, nil, nil)
	if !ok {
		t.Fatal("expected open question to classify")
	}
	if candidate.Classification != "unanswered_question" {
		t.Fatalf("classification = %q, want unanswered_question", candidate.Classification)
	}
}

// TestRenderBackfillCandidatesMarkdownEmpty confirms the empty-state
// rendering — when nothing is found, the operator should see an
// explicit "no candidates" note instead of a blank file.
func TestRenderBackfillCandidatesMarkdownEmpty(t *testing.T) {
	out := RenderBackfillCandidatesMarkdown(nil)
	if !strings.Contains(out, "No candidate messages found") {
		t.Fatalf("empty output = %q, want explicit no-candidates note", out)
	}
}

// TestRenderBackfillCandidatesMarkdownGroupsByClassification proves
// that the report sorts/groups so reviewers can skim by category. The
// fixture mixes two classifications and we assert each headers and
// counts render.
func TestRenderBackfillCandidatesMarkdownGroupsByClassification(t *testing.T) {
	out := RenderBackfillCandidatesMarkdown([]SlackBackfillCandidate{
		{Classification: "stuck_or_handoff", Title: "补一下这个卡住点", ChannelID: "C1", ThreadTS: "1", Draft: "draft a"},
		{Classification: "unanswered_question", Title: "补一下这个开放问题", ChannelID: "C2", ThreadTS: "2", Draft: "draft b"},
		{Classification: "stuck_or_handoff", Title: "补一下这个卡住点 2", ChannelID: "C3", ThreadTS: "3", Draft: "draft c"},
	})

	if !strings.Contains(out, "## stuck_or_handoff (2)") {
		t.Fatalf("output missing stuck_or_handoff group header, got %q", out)
	}
	if !strings.Contains(out, "## unanswered_question (1)") {
		t.Fatalf("output missing unanswered_question group header, got %q", out)
	}
	// Groups are sorted alphabetically: "stuck_or_handoff" < "unanswered_question"
	// so stuck_or_handoff should appear first in the output.
	stuckIdx := strings.Index(out, "stuck_or_handoff")
	unansweredIdx := strings.Index(out, "unanswered_question")
	if stuckIdx > unansweredIdx {
		t.Fatalf("groups not sorted alphabetically: stuck idx=%d, unanswered idx=%d", stuckIdx, unansweredIdx)
	}
}

// TestTruncateForMarkdownCollapsesWhitespace ensures the Markdown
// excerpt is compact — Slack's plain-text export has \n line breaks
// and Markdown quote blocks ("> ") render those badly without
// collapsing first.
func TestTruncateForMarkdownCollapsesWhitespace(t *testing.T) {
	got := truncateForMarkdown("line one\n  line two\n\nline three", 100)
	want := "line one line two line three"
	if got != want {
		t.Fatalf("truncateForMarkdown = %q, want %q", got, want)
	}
}

func TestTruncateForMarkdownClipsToMaxRunes(t *testing.T) {
	long := strings.Repeat("漢", 300) // 300 CJK runes
	got := truncateForMarkdown(long, 50)
	if !strings.HasSuffix(got, "...") {
		t.Fatalf("expected ellipsis suffix on truncation, got %q", got)
	}
	if got == long {
		t.Fatal("expected clipping but output was unchanged")
	}
}
