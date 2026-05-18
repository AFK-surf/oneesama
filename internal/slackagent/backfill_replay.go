package slackagent

import (
	"fmt"
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
	thread := firstNonEmpty(strings.TrimSpace(message.ThreadTS), strings.TrimSpace(message.TS))
	return SlackBackfillCandidate{
		ChannelID:      strings.TrimSpace(message.ChannelID),
		ThreadTS:       thread,
		OriginatorTS:   strings.TrimSpace(message.TS),
		Classification: candidate.Classification,
		Title:          candidate.Title,
		Draft:          candidate.Summary,
		OriginalText:   strings.TrimSpace(message.Text),
	}, true
}

// RenderBackfillCandidatesMarkdown groups candidates by classification
// and emits a human-reviewable Markdown report. Driver's `--post`
// safety toggle (future slice) reads the SAME structured slice; this
// renderer is presentation-only.
func RenderBackfillCandidatesMarkdown(candidates []SlackBackfillCandidate) string {
	if len(candidates) == 0 {
		return "# Triage backfill replay\n\n_No candidate messages found in the scan window._\n"
	}
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
	fmt.Fprintf(&b, "channel/thread anchor, the original message excerpt, and a draft\n")
	fmt.Fprintf(&b, "reply for human review. Nothing is posted; this is dry-run output.\n\n")
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
			original := c.OriginalText
			if original == "" {
				original = "_(no fresh scan match; draft comes verbatim from the persisted followup)_"
			} else {
				original = "> " + truncateForMarkdown(original, 240)
			}
			fmt.Fprintf(&b, "- **Original**:\n  %s\n\n", original)
			fmt.Fprintf(&b, "**Draft reply**:\n\n%s\n\n", c.Draft)
			fmt.Fprintf(&b, "---\n\n")
		}
	}
	return b.String()
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
