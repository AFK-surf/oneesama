package slackagent

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// NormalizeSlackInboundMessage canonicalises snake_case / camelCase /
// legacy field aliases on a `SlackInboundMessage` so consumers can pass
// data from any source (Slack export tools, conversations.history dumps,
// fixtures handwritten by humans) without having to care which casing
// convention the upstream used.
//
// This is a thin uppercase wrapper around `normalizeSlackInboundMessage`
// (in inbound_buffer.go) — it exists so cmd/oneesama-triage-replay can
// normalize its NDJSON inputs at read time, before grouping by
// (channel, thread root). Without this, a `{"channel_id": "C1"}`
// record would have `ChannelID == ""` and the grouping would
// incorrectly bucket it under the empty-channel key.
func NormalizeSlackInboundMessage(message SlackInboundMessage) SlackInboundMessage {
	return normalizeSlackInboundMessage(message)
}

// SlackBackfillCandidate is one suggested oneesama follow-up surfaced by
// the 24-hour replay scan. It mirrors the shape of the in-line
// `slackDelayedNoReplyCandidate` (shipped in 46459b7) so the backfill
// CLI and the live triage path classify with the same logic. The fields
// are sized for a Markdown report a human can review BEFORE any reply
// gets posted — slice 1 of task #185 is dry-run-only.
type SlackBackfillCandidate struct {
	ChannelID      string `json:"channel_id"`
	ThreadTS       string `json:"thread_ts"`
	OriginatorTS   string `json:"originator_ts"`
	Classification string `json:"classification"`
	Title          string `json:"title"`
	Draft          string `json:"draft"`
	OriginalText   string `json:"original_text"`
	ReviewStatus   string `json:"review_status,omitempty"`
	ReviewReason   string `json:"review_reason,omitempty"`
	// FromPersistedState is true when this candidate matches (or was
	// promoted from) a row in the `slack_heartbeat_followups`
	// collection populated by driver's #186 delayed_no_reply path.
	// Driver-locked semantics from the slice-3 design thread:
	//   - fresh + persisted overlap → existing fresh candidate keeps
	//     its Draft, FromPersistedState flips true.
	//   - persisted-only → synthesized candidate uses the followup's
	//     Title + Summary verbatim; we do NOT re-classify or
	//     paraphrase. The live triage already wrote those fields with
	//     full thread context; the backfill report respects that.
	FromPersistedState bool `json:"from_persisted_state,omitempty"`
	// FollowupID lets the report cite the underlying persisted record
	// so an operator can correlate a candidate with the live
	// followup entry in heartbeat surfaces / debug views.
	FollowupID int64 `json:"followup_id,omitempty"`
	// RelatedMemory contains evidence-rich memory records found for
	// this candidate. Backfill reports use this as a quality gate:
	// if a candidate would otherwise be postable but has no memory
	// evidence and no delegated-agent read result, it must remain
	// `needs_context` instead of pretending a generic draft is ready.
	RelatedMemory []SlackRelatedMemoryRecord `json:"related_memory,omitempty"`
}

// SlackBackfillReplayInput is what the backfill scanner consumes. The
// CLI builds this by reading messages from stdin (NDJSON) or by fetching
// Slack history via the runtime — slice 1 only wires the stdin path.
type SlackBackfillReplayInput struct {
	// Messages is the chronological list of top-level channel messages
	// considered for replay. The scanner does not filter by age — that's
	// the caller's responsibility (typically `--since 24h`).
	Messages []SlackInboundMessage
	// BotUserIDs are oneesama's own bot user ids; messages from these
	// users are never considered candidates (the bot is not its own
	// audience).
	BotUserIDs []string
	// ExcludeChannelIDs lets the caller skip noisy channels. Optional.
	ExcludeChannelIDs []string
}

// ClassifyBackfillMessage runs the same classifier as the live triage
// `slackDelayedNoReplyCandidateFor`, but on a single channel-root
// message + its known replies. It returns ok=false when the message is
// low-signal (lol/+1/ack), authored by the bot, or has no
// classification rule that matches.
//
// Exposed (capitalized) so cmd/oneesama-triage-replay can call it. The
// underlying lowercase helpers remain internal; this wrapper is the
// stable public contract.
//
// Inputs are normalized via `normalizeSlackInboundMessage` so the
// caller may pass either camelCase (`channelId`) or snake_case
// (`channel_id`) shapes — Slack exports / direct API dumps / fixtures
// all mix conventions, and a CLI consumer should not have to care.
func ClassifyBackfillMessage(message SlackInboundMessage, replies []SlackInboundMessage, botUserIDs []string) (SlackBackfillCandidate, bool) {
	message = normalizeSlackInboundMessage(message)
	normalizedReplies := make([]SlackInboundMessage, 0, len(replies))
	for _, reply := range replies {
		normalizedReplies = append(normalizedReplies, normalizeSlackInboundMessage(reply))
	}

	if isAuthoredByBot(message, botUserIDs) {
		return SlackBackfillCandidate{}, false
	}
	if strings.TrimSpace(message.Text) == "" {
		return SlackBackfillCandidate{}, false
	}
	if slackDelayedNoReplyLooksLowSignal(message.Text) {
		return SlackBackfillCandidate{}, false
	}
	if backfillMessageHasLowValueLinkOnly(message) {
		return SlackBackfillCandidate{}, false
	}
	// If any non-bot human has already replied, the backfill scan
	// should NOT add a candidate — the message has been "caught" by a
	// human and oneesama jumping in would just be noise.
	if humanReplyExists(normalizedReplies, botUserIDs) {
		return SlackBackfillCandidate{}, false
	}

	// Bot replies (Slackbot acks, app pings, our own previous replies)
	// must not leak into the draft summary. driver caught this as a
	// non-blocking quality nit on fbb6c46: `slackDelayedNoReplyCandidateFor`
	// uses `joinSlackMessageTexts` over the whole bundle, and bot
	// chatter would otherwise shape the "我理解是在问..." line. Filter
	// here so only the root's text drives the draft.
	humanReplies := make([]SlackInboundMessage, 0, len(normalizedReplies))
	for _, reply := range normalizedReplies {
		if isAuthoredByBot(reply, botUserIDs) {
			continue
		}
		humanReplies = append(humanReplies, reply)
	}
	bundle := append([]SlackInboundMessage{message}, humanReplies...)
	candidate, ok := slackDelayedNoReplyCandidateFor(SlackTriageDecision{}, bundle)
	if !ok {
		return SlackBackfillCandidate{}, false
	}
	if candidate.Classification == "link_followup_candidate" && !backfillMessagesHaveHighSignalReadableLink(bundle) {
		return SlackBackfillCandidate{}, false
	}
	thread := firstNonEmpty(strings.TrimSpace(message.ThreadTS), strings.TrimSpace(message.TS))
	return markBackfillCandidateQuality(SlackBackfillCandidate{
		ChannelID:      strings.TrimSpace(message.ChannelID),
		ThreadTS:       thread,
		OriginatorTS:   strings.TrimSpace(message.TS),
		Classification: candidate.Classification,
		Title:          candidate.Title,
		Draft:          candidate.Summary,
		OriginalText:   strings.TrimSpace(message.Text),
	}), true
}

// RenderBackfillCandidatesMarkdown groups candidates by classification
// and emits a human-reviewable Markdown report. Driver's `--post`
// safety toggle (future slice) reads the SAME structured slice; this
// renderer is presentation-only.
func RenderBackfillCandidatesMarkdown(candidates []SlackBackfillCandidate) string {
	if len(candidates) == 0 {
		return "# Triage backfill replay\n\n_No candidate messages found in the scan window._\n"
	}
	readRequests := BackfillAgentReadRequests(candidates)
	byClass := make(map[string][]SlackBackfillCandidate)
	for _, c := range candidates {
		key := firstNonEmpty(c.Classification, "uncategorised")
		byClass[key] = append(byClass[key], c)
	}
	keys := make([]string, 0, len(byClass))
	for k := range byClass {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var b strings.Builder
	fmt.Fprintf(&b, "# Triage backfill replay\n\n")
	fmt.Fprintf(&b, "%d candidate(s) found. Each entry shows the classification, the\n", len(candidates))
	fmt.Fprintf(&b, "channel/thread anchor, the original message excerpt, and either a\n")
	fmt.Fprintf(&b, "postable draft or a non-postable context note for human review. Entries\n")
	fmt.Fprintf(&b, "marked `needs_*` are leads, not reply drafts. Nothing is posted; this is\n")
	fmt.Fprintf(&b, "dry-run output.\n\n")
	for _, key := range keys {
		group := byClass[key]
		fmt.Fprintf(&b, "## %s (%d)\n\n", key, len(group))
		for i, c := range group {
			anchor := c.ThreadTS
			if anchor == "" {
				anchor = c.OriginatorTS
			}
			fmt.Fprintf(&b, "### %d. %s\n\n", i+1, c.Title)
			fmt.Fprintf(&b, "- **Channel**: `%s`\n", c.ChannelID)
			fmt.Fprintf(&b, "- **Thread / message ts**: `%s`\n", anchor)
			// Driver-audit-required source label (slice 3 piece A).
			// `fresh` = found by this scan only.
			// `persisted+fresh` = also matches a live #186 followup.
			// `persisted` = surfaced only because of #186 state; the
			//               24h scan window did not see the root.
			source := candidateSourceLabel(c)
			fmt.Fprintf(&b, "- **Source**: %s\n", source)
			if c.FollowupID > 0 {
				fmt.Fprintf(&b, "- **Followup ID**: %d\n", c.FollowupID)
			}
			status, reason := backfillCandidateReviewStatus(c)
			fmt.Fprintf(&b, "- **Quality gate**: `%s`", status)
			if reason != "" {
				fmt.Fprintf(&b, " — %s", reason)
			}
			fmt.Fprintf(&b, "\n")
			writeBackfillRelatedMemoryMarkdown(&b, c.RelatedMemory)
			original := c.OriginalText
			if original == "" {
				original = "_(no fresh scan match; note comes verbatim from the persisted followup and needs thread refetch)_"
			} else {
				original = "> " + truncateForMarkdown(original, 240)
			}
			fmt.Fprintf(&b, "- **Original**:\n  %s\n\n", original)
			label := "Draft reply"
			if status != BackfillReviewReady {
				label = "Context note (not a reply)"
			}
			fmt.Fprintf(&b, "**%s**:\n\n%s\n\n", label, c.Draft)
			fmt.Fprintf(&b, "---\n\n")
		}
	}
	if len(readRequests) > 0 {
		fmt.Fprintf(&b, "## Delegated agent read requests (%d)\n\n", len(readRequests))
		fmt.Fprintf(&b, "These are not Slack replies. Hand one request to the connected agent/runner,\n")
		fmt.Fprintf(&b, "let it read the linked material with its own tools, and only promote the\n")
		fmt.Fprintf(&b, "candidate after it returns source-backed synthesis.\n\n")
		for i, request := range readRequests {
			fmt.Fprintf(&b, "### %d. %s\n\n", i+1, firstNonEmpty(request.Title, "Read linked material"))
			fmt.Fprintf(&b, "- **Channel**: `%s`\n", request.ChannelID)
			fmt.Fprintf(&b, "- **Thread / message ts**: `%s`\n", request.ThreadTS)
			fmt.Fprintf(&b, "- **URL**: <%s>\n\n", request.URL)
			fmt.Fprintf(&b, "```text\n%s\n```\n\n", request.Prompt)
		}
	}
	return b.String()
}

func writeBackfillRelatedMemoryMarkdown(b *strings.Builder, records []SlackRelatedMemoryRecord) {
	if len(records) == 0 {
		return
	}
	fmt.Fprintf(b, "- **Related memory**:\n")
	for _, record := range records {
		source := firstNonEmpty(record.SourcePath, record.Source, record.SourceRef)
		if record.StartLine > 0 {
			source = fmt.Sprintf("%s:%d", source, record.StartLine)
			if record.EndLine > record.StartLine {
				source = fmt.Sprintf("%s-%d", source, record.EndLine)
			}
		}
		snippet := truncateForMarkdown(record.Content, 180)
		fmt.Fprintf(b, "  - `%s` `%s` score=%.2f — %s\n", firstNonEmpty(record.Kind, "memory"), source, record.Score, snippet)
	}
}

const (
	BackfillReviewReady              = "review_ready"
	BackfillReviewNeedsContext       = "needs_context"
	BackfillReviewNeedsAgentRead     = "needs_agent_read"
	BackfillReviewNeedsLinkRead      = "needs_link_read" // legacy report value kept readable for old fixtures.
	BackfillReviewNeedsThreadRefetch = "needs_thread_refetch"
)

func markBackfillCandidateQuality(candidate SlackBackfillCandidate) SlackBackfillCandidate {
	if strings.TrimSpace(candidate.ReviewStatus) != "" {
		return candidate
	}
	switch {
	case candidate.FromPersistedState && strings.TrimSpace(candidate.OriginalText) == "":
		candidate.ReviewStatus = BackfillReviewNeedsThreadRefetch
		candidate.ReviewReason = "persisted-only lead; refetch the thread before posting"
	case strings.EqualFold(strings.TrimSpace(candidate.Classification), "link_followup_candidate"):
		candidate.ReviewStatus = BackfillReviewNeedsAgentRead
		candidate.ReviewReason = "linked material must be delegated to the connected agent for source-backed reading before posting"
		candidate.Draft = backfillAgentReadContextNote(candidate)
	case strings.Contains(candidate.OriginalText, "<@"):
		candidate.ReviewStatus = BackfillReviewNeedsContext
		candidate.ReviewReason = "message mentions specific people; verify ownership/context before posting"
	case backfillCandidateNeedsTechnicalContext(candidate.OriginalText):
		candidate.ReviewStatus = BackfillReviewNeedsContext
		candidate.ReviewReason = "technical workflow question; inspect the linked repo/CI/runtime context before posting"
	case strings.TrimSpace(candidate.Draft) == "":
		candidate.ReviewStatus = BackfillReviewNeedsContext
		candidate.ReviewReason = "missing draft text"
	default:
		candidate.ReviewStatus = BackfillReviewReady
		candidate.ReviewReason = "candidate passes local quality gates"
	}
	return candidate
}

func EnrichBackfillCandidatesWithRelatedMemory(candidates []SlackBackfillCandidate, search func(string) SlackRelatedMemorySearchResult, limit int) []SlackBackfillCandidate {
	if limit <= 0 {
		limit = 3
	}
	out := make([]SlackBackfillCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		candidate = markBackfillCandidateQuality(candidate)
		if search == nil {
			if backfillCandidateNeedsMemoryEvidence(candidate) {
				candidate.ReviewStatus = BackfillReviewNeedsContext
				candidate.ReviewReason = "backfill related-memory search is not configured"
			}
			out = append(out, candidate)
			continue
		}
		{
			query := backfillRelatedMemoryQuery(candidate)
			if strings.TrimSpace(query) != "" {
				result := search(query)
				candidate.RelatedMemory = credibleBackfillRelatedMemory(result.Results, limit)
			}
		}
		if backfillCandidateNeedsMemoryEvidence(candidate) && len(candidate.RelatedMemory) == 0 {
			candidate.ReviewStatus = BackfillReviewNeedsContext
			candidate.ReviewReason = "backfill requires related memory evidence or delegated agent read before posting"
		} else if strings.TrimSpace(candidate.ReviewStatus) == BackfillReviewReady && len(candidate.RelatedMemory) > 0 {
			candidate.ReviewReason = "candidate passes local quality gates with related memory evidence"
		}
		out = append(out, candidate)
	}
	return out
}

func backfillCandidateNeedsMemoryEvidence(candidate SlackBackfillCandidate) bool {
	status, _ := backfillCandidateReviewStatus(candidate)
	return status == BackfillReviewReady
}

func backfillRelatedMemoryQuery(candidate SlackBackfillCandidate) string {
	parts := []string{
		candidate.Classification,
		candidate.Title,
		candidate.OriginalText,
	}
	// The draft is useful only as a weak query-expansion source. It
	// must not be rendered as evidence; related memory records still
	// carry their own source/path/line citations.
	if !strings.Contains(candidate.Draft, "connected agent") {
		parts = append(parts, candidate.Draft)
	}
	return strings.Join(parts, "\n")
}

func credibleBackfillRelatedMemory(records []SlackRelatedMemoryRecord, limit int) []SlackRelatedMemoryRecord {
	if len(records) == 0 || limit <= 0 {
		return nil
	}
	out := make([]SlackRelatedMemoryRecord, 0, limit)
	for _, record := range records {
		if !backfillRelatedMemoryRecordCredible(record) {
			continue
		}
		out = append(out, record)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func backfillRelatedMemoryRecordCredible(record SlackRelatedMemoryRecord) bool {
	if strings.TrimSpace(record.Content) == "" || strings.TrimSpace(firstNonEmpty(record.SourcePath, record.Source, record.SourceRef)) == "" {
		return false
	}
	if record.Score >= 0.35 {
		return true
	}
	for _, reason := range record.Reasons {
		switch {
		case strings.HasPrefix(reason, "family_boost:"),
			reason == "project_or_repo_boost",
			reason == "recent_memory",
			reason == "feedback_match",
			reason == "triage_projection_match":
			return true
		}
	}
	return false
}

func backfillCandidateReviewStatus(candidate SlackBackfillCandidate) (string, string) {
	candidate = markBackfillCandidateQuality(candidate)
	return strings.TrimSpace(candidate.ReviewStatus), strings.TrimSpace(candidate.ReviewReason)
}

type SlackBackfillAgentReadRequest struct {
	ChannelID      string `json:"channel_id"`
	ThreadTS       string `json:"thread_ts"`
	OriginatorTS   string `json:"originator_ts,omitempty"`
	Classification string `json:"classification"`
	Title          string `json:"title"`
	URL            string `json:"url"`
	OriginalText   string `json:"original_text"`
	Prompt         string `json:"prompt"`
	FollowupID     int64  `json:"followup_id,omitempty"`
}

func BackfillAgentReadRequests(candidates []SlackBackfillCandidate) []SlackBackfillAgentReadRequest {
	requests := make([]SlackBackfillAgentReadRequest, 0)
	for _, candidate := range candidates {
		status, _ := backfillCandidateReviewStatus(candidate)
		if !backfillStatusNeedsAgentRead(status) {
			continue
		}
		urls := extractSlackExternalLinkURLs([]SlackInboundMessage{{Text: candidate.OriginalText}})
		if len(urls) == 0 {
			continue
		}
		thread := firstNonEmpty(strings.TrimSpace(candidate.ThreadTS), strings.TrimSpace(candidate.OriginatorTS))
		for _, rawURL := range urls {
			request := SlackBackfillAgentReadRequest{
				ChannelID:      strings.TrimSpace(candidate.ChannelID),
				ThreadTS:       thread,
				OriginatorTS:   strings.TrimSpace(candidate.OriginatorTS),
				Classification: strings.TrimSpace(candidate.Classification),
				Title:          strings.TrimSpace(candidate.Title),
				URL:            strings.TrimSpace(rawURL),
				OriginalText:   strings.TrimSpace(candidate.OriginalText),
				FollowupID:     candidate.FollowupID,
			}
			request.Prompt = BuildBackfillAgentReadPrompt(request)
			requests = append(requests, request)
		}
	}
	return requests
}

func backfillStatusNeedsAgentRead(status string) bool {
	switch strings.TrimSpace(status) {
	case BackfillReviewNeedsAgentRead, BackfillReviewNeedsLinkRead:
		return true
	default:
		return false
	}
}

func BuildBackfillAgentReadPrompt(request SlackBackfillAgentReadRequest) string {
	original := strings.Join(strings.Fields(strings.TrimSpace(request.OriginalText)), " ")
	if original == "" {
		original = "(original Slack message unavailable)"
	}
	rendered, err := renderTriageReplyTemplate("backfill_agent_read_prompt", "en", triageReplyTemplateData{
		ChannelID:    firstNonEmpty(strings.TrimSpace(request.ChannelID), "(unknown)"),
		ThreadTS:     firstNonEmpty(strings.TrimSpace(request.ThreadTS), "(unknown)"),
		URL:          strings.TrimSpace(request.URL),
		OriginalText: original,
		MessageText:  original,
		Title:        strings.TrimSpace(request.Title),
		Language:     "en",
	})
	if err == nil && strings.TrimSpace(rendered) != "" {
		return rendered
	}
	return strings.TrimSpace("Read URL: " + strings.TrimSpace(request.URL) + "\nDo not post to Slack. Return source-backed notes only.")
}

func backfillAgentReadContextNote(candidate SlackBackfillCandidate) string {
	urls := extractSlackExternalLinkURLs([]SlackInboundMessage{{Text: candidate.OriginalText}})
	url := ""
	if len(urls) > 0 {
		url = urls[0]
	}
	language := "en"
	if containsCJK(candidate.OriginalText) {
		language = "zh"
	}
	rendered, err := renderTriageReplyTemplate("backfill_agent_read_note", language, triageReplyTemplateData{
		Classification: strings.TrimSpace(candidate.Classification),
		MessageText:    strings.TrimSpace(candidate.OriginalText),
		Snippet:        truncateSlackContextText(strings.Join(strings.Fields(candidate.OriginalText), " "), 180),
		Title:          strings.TrimSpace(candidate.Title),
		URL:            strings.TrimSpace(url),
		Language:       language,
	})
	if err == nil && strings.TrimSpace(rendered) != "" {
		return rendered
	}
	if len(urls) == 0 {
		return "Needs delegated connected-agent reading before reply."
	}
	return fmt.Sprintf("Needs delegated connected-agent reading for <%s> before reply.", urls[0])
}

func backfillCandidateNeedsTechnicalContext(text string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(text)), " "))
	if normalized == "" {
		return false
	}
	for _, marker := range []string{
		"ci",
		"build",
		"test",
		"macos",
		"runner",
		"workflow",
		"pr ",
		"pull request",
		"merge",
		"deploy",
		"合并",
		"测试",
		"巡检",
		"生产环境",
		"被跳过",
		"接口",
		"后端",
		"前端",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

// candidateSourceLabel renders the (FromPersistedState, OriginalText)
// combination as a single short label. Used in the per-candidate
// Markdown header so a reviewer can sort by trust signal at a glance.
func candidateSourceLabel(c SlackBackfillCandidate) string {
	switch {
	case c.FromPersistedState && strings.TrimSpace(c.OriginalText) == "":
		return "`persisted` (only #186 state; backfill scan did not see root)"
	case c.FromPersistedState:
		return "`persisted+fresh` (matched live #186 followup AND backfill scan)"
	default:
		return "`fresh` (backfill scan only)"
	}
}

func backfillMessageHasLowValueLinkOnly(message SlackInboundMessage) bool {
	urls := extractSlackExternalLinkURLs([]SlackInboundMessage{message})
	if len(urls) == 0 {
		return false
	}
	allSocialStatus := true
	for _, rawURL := range urls {
		if !looksLikeLowSignalSocialStatusURL(rawURL) {
			allSocialStatus = false
			break
		}
	}
	if allSocialStatus {
		return true
	}
	return backfillMessageLooksLikeOperationalGitHubWork(message.Text, urls)
}

func backfillMessagesHaveHighSignalReadableLink(messages []SlackInboundMessage) bool {
	for _, rawURL := range extractSlackExternalLinkURLs(messages) {
		if looksLikeBackfillHighSignalReadableURL(rawURL) {
			return true
		}
	}
	return false
}

func looksLikeBackfillHighSignalReadableURL(rawURL string) bool {
	parsed, err := parseSlackExternalURL(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	path := strings.ToLower(parsed.Path)
	if looksLikeLowSignalSocialStatusURL(rawURL) {
		return false
	}
	if strings.HasSuffix(path, ".pdf") || strings.HasSuffix(path, ".md") || strings.HasSuffix(path, ".txt") {
		return true
	}
	if strings.Contains(path, "/articles/") || strings.Contains(path, "/article/") || strings.Contains(path, "/blog/") || strings.Contains(path, "/docs/") {
		return true
	}
	if strings.Contains(host, "arxiv.org") || strings.Contains(host, "medium.com") || strings.Contains(host, "substack.com") {
		return true
	}
	if strings.Contains(host, "docs.") || strings.Contains(host, "blog.") {
		return true
	}
	if (host == "github.com" || strings.HasSuffix(host, ".github.com")) && strings.Contains(path, "/blob/") {
		return strings.HasSuffix(path, ".pdf") ||
			strings.HasSuffix(path, ".md") ||
			strings.HasSuffix(path, ".markdown") ||
			strings.HasSuffix(path, ".txt") ||
			strings.HasSuffix(path, ".ipynb")
	}
	return false
}

func backfillMessageLooksLikeOperationalGitHubWork(text string, urls []string) bool {
	var hasOperationalGitHub bool
	for _, rawURL := range urls {
		if looksLikeOperationalGitHubURL(rawURL) {
			hasOperationalGitHub = true
			break
		}
	}
	if !hasOperationalGitHub {
		return false
	}
	normalized := strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(text)), " "))
	if normalized == "" {
		return true
	}
	for _, marker := range []string{
		"<@",
		"review",
		"approve",
		"cherry-pick",
		"cherry pick",
		"checkout",
		"preprod",
		"deploy",
		"merge",
		"pull request",
		"pr ",
		"issue",
		"来 review",
		"没问题就 approve",
		"看一下",
		"看看",
		"测一下",
		"发版",
		"上线",
		"合一下",
		"拉一下",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func looksLikeOperationalGitHubURL(rawURL string) bool {
	parsed, err := parseSlackExternalURL(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "github.com" && !strings.HasSuffix(host, ".github.com") {
		return false
	}
	path := strings.ToLower(parsed.Path)
	for _, marker := range []string{"/pull/", "/issues/", "/commit/", "/compare/", "/actions/runs/"} {
		if strings.Contains(path, marker) {
			return true
		}
	}
	return false
}

func parseSlackExternalURL(rawURL string) (*url.URL, error) {
	return url.Parse(strings.Trim(rawURL, "<>|.,，。)）]】"))
}

// isAuthoredByBot recognises a message as bot-authored when ANY of:
//   - `bot_id` is populated (canonical Slack signal for app/bot messages)
//   - `subtype == "bot_message"` (legacy Slack convention used by
//     Slackbot, some integrations, and incoming-webhook posts that
//     omit `bot_id`). This is the audit-blocker driver caught in
//     `35d80d9` slice 2: subtype-only bot messages were sneaking
//     through both as candidates (bot's own root) and as "human reply"
//     suppressors (bot acks compressing the candidate).
//   - the user id matches a known oneesama bot id from `--bot-user-ids`
//
// We intentionally do NOT treat other subtypes (`file_share`,
// `message_replied`, etc.) as bot-authored — those are user posts
// with extra metadata and would over-filter.
func isAuthoredByBot(message SlackInboundMessage, botUserIDs []string) bool {
	if strings.TrimSpace(message.BotID) != "" || strings.TrimSpace(message.BotIDSnake) != "" {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(message.Subtype), "bot_message") {
		return true
	}
	user := strings.TrimSpace(firstNonEmpty(message.UserID, message.UserIDSnake, message.User))
	if user == "" {
		return false
	}
	for _, botID := range botUserIDs {
		if strings.EqualFold(strings.TrimSpace(botID), user) {
			return true
		}
	}
	return false
}

func humanReplyExists(replies []SlackInboundMessage, botUserIDs []string) bool {
	for _, reply := range replies {
		if isAuthoredByBot(reply, botUserIDs) {
			continue
		}
		if strings.TrimSpace(reply.Text) == "" {
			continue
		}
		return true
	}
	return false
}

// truncateForMarkdown collapses whitespace and clips to maxRunes so the
// Markdown report stays readable on a single line. Slack's web export
// happily includes 800-char paragraphs and we don't want those bloating
// the candidate list.
func truncateForMarkdown(text string, maxRunes int) string {
	collapsed := strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
	if collapsed == "" {
		return "_(empty)_"
	}
	runes := []rune(collapsed)
	if len(runes) <= maxRunes {
		return collapsed
	}
	return string(runes[:maxRunes]) + "..."
}
