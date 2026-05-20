package slackagent

// Centralised character budgets for the Slack thread / external-link context
// the persona runtime, triage, and storage layers compose. Each constant
// captures one specific surface so we do not bury the same magic literal in
// half a dozen call sites with no rationale. If a budget changes, change it
// here and grep call sites to confirm the surface is the same one being
// updated. Tested by `TestSlackContextBudgetMatrix` in context_budget_test.go.
//
// Task #287 anchor: centralise Slack thread / link context budget metadata.

const (
	// slackThreadContextBudgetChars caps the joined transcript text injected
	// into the persona request as `slack_thread_context`. The persona is
	// expected to skim, not re-read, so this is intentionally larger than the
	// per-message tail count but smaller than what would push the model
	// towards context-stuffing replies.
	slackThreadContextBudgetChars = 6000

	// slackTriageDigestBudgetChars caps the triage digest text injected as
	// `triage_digest`. The digest is already summarised upstream; this guards
	// against pathological digests (e.g. dumped raw transcripts).
	slackTriageDigestBudgetChars = 4000

	// slackChannelContextBudgetChars caps the rendered cross-channel triage
	// transcript injected as `slack_channel_context`. Same reasoning as the
	// digest budget; protects the persona request from a sprawling channel
	// sweep.
	slackChannelContextBudgetChars = 4000

	// slackPreviousTriageContextBudgetChars caps the previous-triage echo
	// injected as `previous_triage_context`. Historical context is helpful
	// for de-duplication but shouldn't dominate.
	slackPreviousTriageContextBudgetChars = 3000

	// slackContextLastCommandBudgetChars caps `LastCommandText` stored in the
	// per-channel slack context cache. Avoids unbounded growth from
	// command-line dumps in slash commands.
	slackContextLastCommandBudgetChars = 4000

	// slackMemoryProviderTurnBudgetChars caps the user/assistant content
	// segments handed to memory providers for turn ingestion. Same value for
	// both sides keeps SyncTurn budgets symmetric.
	slackMemoryProviderTurnBudgetChars = 4000

	// slackExternalLinkContextBudgetChars caps the joined external-link
	// summary injected as `external_link_context` in the persona request.
	// Each individual link is further bounded by the title/excerpt/text
	// budgets below.
	slackExternalLinkContextBudgetChars = 4000

	// slackExternalLinkTitleBudgetChars caps an individual external-link
	// summary title.
	slackExternalLinkTitleBudgetChars = 240

	// slackExternalLinkExcerptBudgetChars caps the fallback excerpt taken
	// from a non-2xx reader response. Keeps error-path previews bounded.
	slackExternalLinkExcerptBudgetChars = 500

	// slackExternalLinkTextBudgetChars caps the main external-link summary
	// text body extracted from a successful reader response.
	slackExternalLinkTextBudgetChars = 1200
)
