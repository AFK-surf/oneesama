# Post-Memory / Backfill Code Quality Pass

Task: #199

Date: 2026-05-18

## Scope

This pass reviews the code added around tasks #193-#198 and #200 after Peng's
direction change:

- Meeting Avatar foreground persona should move to a Pi/OpenClaw-style runtime.
- Codex remains a delegated worker, not the memory-native "lobster".
- Go should orchestrate Slack/Meet IO, persistence, audit, evidence bundles, and
  safety gates. It should not grow foreground avatar cognition.

## Fixed In This Pass

### Backfill delegated-read prompts moved out of Go literals

`BuildBackfillAgentReadPrompt` and the visible backfill "needs agent read"
context note were still hardcoded in Go. They are now workspace-overridable
templates:

- `templates/triage/backfill_agent_read_prompt.en.tmpl`
- `templates/triage/backfill_agent_read_note.zh.tmpl`
- `templates/triage/backfill_agent_read_note.en.tmpl`

This keeps the product voice and delegation instructions in the same
workspace-template system as the other triage replies.

### Persona-opinion fallback strings removed

`buildDelayedNoReplySummary` and `buildSharedLinkSynthesisReply` previously had
hardcoded fallback prose that generated social opinions when templates failed.
Those fallbacks now fail closed instead of inventing a Go-authored persona
reply. Embedded/default templates still provide normal behavior; the change only
affects missing/broken templates.

### Runtime canaries now include memory-backed quality gates

The triage audit canary set now includes memory-backed behavior checks:

- Aha/unanswered questions must carry source-cited related memory into prompt
  context.
- Delayed no-reply surfacing must cite related memory when present.
- Backfill cannot mark candidates `review_ready` without related memory evidence
  or delegated-reader evidence.
- Weak lexical memory hits stay `needs_context`.
- Person/project memory must include source path and line citations.

These are behavior gates, not "tool exists" gates.

## Remaining Drift To Keep Flagging

### Keyword routing still lives in Go

The following helpers still use Go-side lexical routing:

- `slackMessagesLookLikeUnansweredQuestion`
- `slackMessagesLookLikeStuckHelp`
- `backfillCandidateNeedsTechnicalContext`
- related-memory query intent boosts in `related_memory.go`

This is acceptable only as temporary routing/evidence plumbing. These helpers
must not become the final foreground persona decision layer. Once the Pi-style
runtime is live, these should either become prompt/template-configurable hints
or move behind persona-runtime decision outputs.

### Go still owns legacy foreground fallback mode

Legacy mode still has deterministic triage/backfill behavior so production can
run while Pi runtime is being introduced. That is intentional for rollback, but
task #200 should treat it as legacy foreground mode, not the target behavior.

### Related memory search is lexical, not a Pi memory brain

`SearchRelatedMemory` is evidence retrieval. It returns records with
source/path/line/score/reasons. It does not decide whether Oneesama should speak,
nor does it update episode/world memory. The Pi persona runtime must own those
decisions.

## #199 Review Checklist For Future Commits

- Does the code generate a visible social/persona reply from Go literals?
- Does Codex receive long-term identity/persona responsibility instead of a
  bounded worker task?
- Can the same evidence bundle be consumed by a JS Pi sidecar, a Go fake, and a
  future Go port?
- Does every confident memory-backed reply cite source path/line evidence?
- Does a weak memory hit keep the candidate in `needs_context`?
- Does linked-material reading happen through delegated agent requests, not Go
  parsers?
