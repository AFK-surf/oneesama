package slackagent

import (
	"os"
	"path/filepath"
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

// TestClassifyBackfillMessageDraftIgnoresBotReplyText is the
// regression for driver's slice-2 non-blocking nit: bot-only replies
// must not leak into the candidate `Draft` text. The classifier hands
// `slackDelayedNoReplyCandidateFor` only the human-authored bundle so
// the draft summary reflects the root's question, not a bot's "ack".
func TestClassifyBackfillMessageDraftIgnoresBotReplyText(t *testing.T) {
	const botAckText = "bot acknowledged but did nothing"
	msg := SlackInboundMessage{
		ChannelID:  "C1",
		TS:         "100.000",
		UserID:     "U_PENG",
		Text:       "我们要不要回滚 canvas writes 的发布？",
		ReplyCount: 1,
	}
	replies := []SlackInboundMessage{
		{ChannelID: "C1", TS: "101.000", UserID: "USLACKBOT", Subtype: "bot_message", Text: botAckText},
	}
	candidate, ok := ClassifyBackfillMessage(msg, replies, nil)
	if !ok {
		t.Fatal("expected candidate when only bot replied")
	}
	if strings.Contains(candidate.Draft, botAckText) {
		t.Fatalf("draft leaked bot reply text; got Draft=%q", candidate.Draft)
	}
}

// TestClassifyBackfillMessageRejectsSubtypeBotMessageRoot is the
// regression for driver's slice-2 audit blocker (35d80d9 → fix in this
// same commit family). A message with `subtype: "bot_message"` but no
// `bot_id` (e.g. Slackbot, incoming webhooks) must be treated as
// bot-authored and excluded from candidates.
func TestClassifyBackfillMessageRejectsSubtypeBotMessageRoot(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C1",
		TS:        "100.000",
		UserID:    "USLACKBOT",
		Subtype:   "bot_message",
		Text:      "我们要不要看一下 ASR chunk？",
	}
	if _, ok := ClassifyBackfillMessage(msg, nil, nil); ok {
		t.Fatal("expected subtype=bot_message root to be skipped")
	}
}

// TestClassifyBackfillMessageBotOnlyReplyWithSubtypeStillSurfacesCandidate
// is the companion: when the bot reply uses `subtype: "bot_message"`
// (no `bot_id`), `humanReplyExists` must NOT count it as a human
// reply, and the original root should still produce a candidate.
func TestClassifyBackfillMessageBotOnlyReplyWithSubtypeStillSurfacesCandidate(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID:  "C1",
		TS:         "100.000",
		UserID:     "U_PENG",
		Text:       "我们要不要看一下 ASR chunk？",
		ReplyCount: 1,
	}
	replies := []SlackInboundMessage{
		{ChannelID: "C1", TS: "101.000", UserID: "USLACKBOT", Subtype: "bot_message", Text: "bot ack"},
	}
	candidate, ok := ClassifyBackfillMessage(msg, replies, nil)
	if !ok {
		t.Fatal("expected bot-only subtype=bot_message reply to still allow a candidate")
	}
	if candidate.Classification == "" {
		t.Fatalf("classification empty, got %+v", candidate)
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

func TestClassifyBackfillMessageMarksTechnicalWorkflowNeedsContext(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "合并的时候不是有 macOS test 吗，被跳过了？",
	}
	candidate, ok := ClassifyBackfillMessage(msg, nil, nil)
	if !ok {
		t.Fatal("expected technical workflow question to classify")
	}
	if candidate.Classification != "unanswered_question" {
		t.Fatalf("classification = %q, want unanswered_question", candidate.Classification)
	}
	if candidate.ReviewStatus != BackfillReviewNeedsContext {
		t.Fatalf("ReviewStatus = %q, want %s", candidate.ReviewStatus, BackfillReviewNeedsContext)
	}
	if !strings.Contains(candidate.ReviewReason, "technical workflow") {
		t.Fatalf("ReviewReason = %q, want technical workflow reason", candidate.ReviewReason)
	}
}

func TestClassifyBackfillMessageUsesTechnicalContextKeywordOverride(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "backfill_technical_context_keywords.en.tmpl"), []byte("flaky-special\n"), 0o600); err != nil {
		t.Fatalf("write keyword override: %v", err)
	}
	t.Setenv("ONEESAMA_TRIAGE_TEMPLATE_DIR", dir)

	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "能不能看一下 flaky-special 这条？",
	}
	candidate, ok := ClassifyBackfillMessage(msg, nil, nil)
	if !ok {
		t.Fatal("expected overridden technical workflow keyword to classify")
	}
	if candidate.ReviewStatus != BackfillReviewNeedsContext {
		t.Fatalf("ReviewStatus = %q, want %s", candidate.ReviewStatus, BackfillReviewNeedsContext)
	}
}

func TestClassifyBackfillMessageRejectsOperationalGitHubPRReview(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "https://github.com/AFK-surf/cueboard/pull/1917 @U123 来 review，没问题就 approve",
	}
	if _, ok := ClassifyBackfillMessage(msg, nil, nil); ok {
		t.Fatal("expected owner-directed GitHub PR review link to be skipped")
	}
}

func TestClassifyBackfillMessageRejectsOperationalGitHubCherryPick(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "cherry-pick https://github.com/AFK-surf/willow/commit/abcdef123456 to preprod",
	}
	if _, ok := ClassifyBackfillMessage(msg, nil, nil); ok {
		t.Fatal("expected cherry-pick/deploy GitHub link to be skipped")
	}
}

func TestClassifyBackfillMessageRejectsOperationalGitHubIssueAndPR(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "看一下 issue https://github.com/AFK-surf/oneesama/issues/29 再看看 PR https://github.com/AFK-surf/oneesama/pull/30",
	}
	if _, ok := ClassifyBackfillMessage(msg, nil, nil); ok {
		t.Fatal("expected owner-directed GitHub issue/PR work instruction to be skipped")
	}
}

func TestClassifyBackfillMessageUsesOperationalGitHubKeywordOverride(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "backfill_operational_github_keywords.en.tmpl"), []byte("shipit-owner\n"), 0o600); err != nil {
		t.Fatalf("write keyword override: %v", err)
	}
	t.Setenv("ONEESAMA_TRIAGE_TEMPLATE_DIR", dir)

	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "https://github.com/AFK-surf/cueboard/pull/1917 shipit-owner",
	}
	if _, ok := ClassifyBackfillMessage(msg, nil, nil); ok {
		t.Fatal("expected overridden owner-directed GitHub marker to be skipped")
	}
}

func TestClassifyBackfillMessageRejectsLowSignalSocialStatusLink(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "https://x.com/FiachraRM/status/2056172311620075824?s=20 今天都在发这个 蹭一下？",
	}
	if _, ok := ClassifyBackfillMessage(msg, nil, nil); ok {
		t.Fatal("expected low-signal X/Twitter status to be skipped")
	}
}

func TestClassifyBackfillMessageKeepsReadablePDFLink(t *testing.T) {
	msg := SlackInboundMessage{
		ChannelID: "C123", TS: "111.000", UserID: "U_PENG",
		Text: "https://github.com/hangli-hl/AI-Articles/blob/main/llm-thinking.pdf",
	}
	candidate, ok := ClassifyBackfillMessage(msg, nil, nil)
	if !ok {
		t.Fatal("expected readable PDF/article link to stay eligible")
	}
	if candidate.Classification != "link_followup_candidate" {
		t.Fatalf("classification = %q, want link_followup_candidate", candidate.Classification)
	}
	if candidate.ReviewStatus != BackfillReviewNeedsAgentRead {
		t.Fatalf("ReviewStatus = %q, want %s", candidate.ReviewStatus, BackfillReviewNeedsAgentRead)
	}
	if !strings.Contains(candidate.Draft, "connected agent") {
		t.Fatalf("Draft = %q, want delegated-agent context note", candidate.Draft)
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
	if !strings.Contains(out, "**Quality gate**: `review_ready`") {
		t.Fatalf("output missing review quality gate, got %q", out)
	}
	if !strings.Contains(out, "**Draft reply**") {
		t.Fatalf("output missing postable draft label, got %q", out)
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

func TestRenderBackfillCandidatesMarkdownLabelsNonPostableContextNotes(t *testing.T) {
	out := RenderBackfillCandidatesMarkdown([]SlackBackfillCandidate{{
		Classification: "link_followup_candidate",
		Title:          "补读这条分享",
		ChannelID:      "C1",
		ThreadTS:       "1",
		Draft:          "generic link note",
		OriginalText:   "https://example.com/article.pdf",
		ReviewStatus:   BackfillReviewNeedsAgentRead,
		ReviewReason:   "linked material needs delegated reading",
	}})
	if !strings.Contains(out, "**Quality gate**: `needs_agent_read`") {
		t.Fatalf("missing needs_agent_read gate:\n%s", out)
	}
	if !strings.Contains(out, "**Context note (not a reply)**") {
		t.Fatalf("non-ready candidate should be labelled as context, not a draft:\n%s", out)
	}
	if strings.Contains(out, "**Draft reply**") {
		t.Fatalf("non-ready candidate was labelled as postable draft:\n%s", out)
	}
}

func TestRenderBackfillCandidatesMarkdownIncludesDelegatedAgentReadRequest(t *testing.T) {
	out := RenderBackfillCandidatesMarkdown([]SlackBackfillCandidate{{
		Classification: "link_followup_candidate",
		Title:          "补读这条分享",
		ChannelID:      "C1",
		ThreadTS:       "1",
		OriginatorTS:   "1",
		OriginalText:   "看看这个 https://github.com/hangli-hl/AI-Articles/blob/main/llm-thinking.pdf",
		ReviewStatus:   BackfillReviewNeedsAgentRead,
		ReviewReason:   "linked material needs delegated reading",
	}})
	for _, want := range []string{
		"## Delegated agent read requests (1)",
		"https://github.com/hangli-hl/AI-Articles/blob/main/llm-thinking.pdf",
		"Use your own reading tools",
		"Do not post to Slack",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("output missing %q:\n%s", want, out)
		}
	}
}

func TestBuildBackfillAgentReadPromptGroundsMaterialRead(t *testing.T) {
	prompt := BuildBackfillAgentReadPrompt(SlackBackfillAgentReadRequest{
		ChannelID:    "C1",
		ThreadTS:     "1",
		URL:          "https://example.com/paper.pdf",
		OriginalText: "这篇 paper 怎么看？",
	})
	for _, want := range []string{
		"https://example.com/paper.pdf",
		"Do not ask Go/backfill code to parse",
		"Include evidence/source details",
		"Do not post to Slack",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestBackfillAgentReadPromptUsesTemplateOverride(t *testing.T) {
	dir := t.TempDir()
	templatePath := filepath.Join(dir, "backfill_agent_read_prompt.en.tmpl")
	if err := os.WriteFile(templatePath, []byte("OVERRIDE {{.URL}} {{.OriginalText}}"), 0o600); err != nil {
		t.Fatalf("write template override: %v", err)
	}
	t.Setenv("ONEESAMA_TRIAGE_TEMPLATE_DIR", dir)

	prompt := BuildBackfillAgentReadPrompt(SlackBackfillAgentReadRequest{
		URL:          "https://example.com/override.pdf",
		OriginalText: "read me",
	})
	if got, want := prompt, "OVERRIDE https://example.com/override.pdf read me"; got != want {
		t.Fatalf("prompt = %q, want %q", got, want)
	}
}

func TestEnrichBackfillCandidatesRequiresMemoryEvidenceForReadyCandidate(t *testing.T) {
	candidates := []SlackBackfillCandidate{{
		Classification: "unanswered_question",
		Title:          "补一下这个开放问题",
		ChannelID:      "C1",
		ThreadTS:       "1",
		OriginalText:   "这个 lobster avatar 的记忆应该怎么接？",
		Draft:          "可以轻量补一句。",
		ReviewStatus:   BackfillReviewReady,
	}}

	enriched := EnrichBackfillCandidatesWithRelatedMemory(candidates, func(string) SlackRelatedMemorySearchResult {
		return SlackRelatedMemorySearchResult{Status: "no_relevant_memory", NoRelevantMemory: true}
	}, 3)

	if len(enriched) != 1 {
		t.Fatalf("enriched = %#v, want one candidate", enriched)
	}
	if enriched[0].ReviewStatus != BackfillReviewNeedsContext {
		t.Fatalf("ReviewStatus = %q, want %s", enriched[0].ReviewStatus, BackfillReviewNeedsContext)
	}
	if !strings.Contains(enriched[0].ReviewReason, "related memory evidence") {
		t.Fatalf("ReviewReason = %q, want related memory evidence gate", enriched[0].ReviewReason)
	}
}

func TestEnrichBackfillCandidatesWithoutSearchDemotesReadyCandidate(t *testing.T) {
	candidates := []SlackBackfillCandidate{{
		Classification: "unanswered_question",
		Title:          "补一下这个开放问题",
		ChannelID:      "C1",
		ThreadTS:       "1",
		OriginalText:   "这个 lobster avatar 的记忆应该怎么接？",
		Draft:          "可以轻量补一句。",
		ReviewStatus:   BackfillReviewReady,
	}}

	enriched := EnrichBackfillCandidatesWithRelatedMemory(candidates, nil, 3)

	if enriched[0].ReviewStatus != BackfillReviewNeedsContext {
		t.Fatalf("ReviewStatus = %q, want %s", enriched[0].ReviewStatus, BackfillReviewNeedsContext)
	}
	if !strings.Contains(enriched[0].ReviewReason, "not configured") {
		t.Fatalf("ReviewReason = %q, want not configured reason", enriched[0].ReviewReason)
	}
}

func TestEnrichBackfillCandidatesLeavesAgentReadLeadNonPostable(t *testing.T) {
	candidates := []SlackBackfillCandidate{{
		Classification: "link_followup_candidate",
		Title:          "补读这条分享",
		ChannelID:      "C1",
		ThreadTS:       "1",
		OriginalText:   "看看这个 https://example.com/paper.pdf",
		Draft:          "needs agent read",
		ReviewStatus:   BackfillReviewNeedsAgentRead,
	}}

	enriched := EnrichBackfillCandidatesWithRelatedMemory(candidates, nil, 3)

	if enriched[0].ReviewStatus != BackfillReviewNeedsAgentRead {
		t.Fatalf("ReviewStatus = %q, want %s", enriched[0].ReviewStatus, BackfillReviewNeedsAgentRead)
	}
}

func TestEnrichBackfillCandidatesKeepsReadyWithCitedMemoryEvidence(t *testing.T) {
	candidates := []SlackBackfillCandidate{{
		Classification: "unanswered_question",
		Title:          "补一下这个开放问题",
		ChannelID:      "C1",
		ThreadTS:       "1",
		OriginalText:   "这个 lobster avatar 的记忆应该怎么接？",
		Draft:          "可以轻量补一句。",
		ReviewStatus:   BackfillReviewReady,
	}}

	enriched := EnrichBackfillCandidatesWithRelatedMemory(candidates, func(string) SlackRelatedMemorySearchResult {
		return SlackRelatedMemorySearchResult{
			Status: "ok",
			Results: []SlackRelatedMemoryRecord{{
				Kind:       "team_decision",
				SourcePath: "memory/team/decisions/avatar-memory.md",
				StartLine:  1,
				EndLine:    4,
				Content:    "Avatar memory should use a Pi-style memory agent and delegate Codex for code work.",
				Score:      0.72,
				Reasons:    []string{"lexical_match:0.72", "family_boost:team_decision"},
			}},
		}
	}, 3)

	if enriched[0].ReviewStatus != BackfillReviewReady {
		t.Fatalf("ReviewStatus = %q, want %s", enriched[0].ReviewStatus, BackfillReviewReady)
	}
	if len(enriched[0].RelatedMemory) != 1 {
		t.Fatalf("RelatedMemory = %#v, want one cited record", enriched[0].RelatedMemory)
	}
	out := RenderBackfillCandidatesMarkdown(enriched)
	if !strings.Contains(out, "**Related memory**") || !strings.Contains(out, "memory/team/decisions/avatar-memory.md:1-4") {
		t.Fatalf("rendered output missing related memory citation:\n%s", out)
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
