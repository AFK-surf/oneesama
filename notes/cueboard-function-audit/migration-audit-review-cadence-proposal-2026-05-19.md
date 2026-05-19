# Migration Audit Review Cadence Proposal — 2026-05-19

## Goal

Today's `migration-lessons-audit-method.md` has grown to ~1200
lines, 6 first-class drift classes, and 13 worked examples. The
audit method itself has become production infrastructure: every
RFC and worked example anchors back to it.

Without a review cadence, two failure modes appear:

1. **Drift class doc rot**: new commits introduce drift the doc
   already names, but no one runs the doc as a checklist before
   shipping.
2. **Worked example bit-rot**: file:line citations age; pinned
   commits get refactored; a future reader can't reconstruct the
   anchor case.

This proposal defines a lightweight review cadence so the audit
infrastructure stays valuable without becoming a chore.

## Proposal

### Trigger-based review (preferred)

Each RFC ship + each #-tagged drift class addition + each parity
audit doc creation triggers a 15-minute audit-method review:

1. Grep the new code/doc for any of the 6 drift class symptoms (the
   "Symptoms that catch this drift" bullets per class). If a match
   is found, the new ship must either:
   - Justify why this is not actually the drift (with text in the
     PR description), or
   - Fix the drift before the ship lands.
2. Verify the new code references that audit-method's drift class
   by name in commit message or comment if it intentionally avoided
   that class. ("This change does not re-introduce
   candidate-generator-as-cognition because Pi remains the only
   decision-owner; see migration-lessons-audit-method.md §
   candidate-generator as cognition in main path.")
3. Verify any new file:line citations resolve to current head.

This trigger pattern means the doc is consulted at every
opportunity to drift, not on a schedule.

### Weekly snapshot review (fallback)

If the trigger pattern misses (e.g., quiet weeks with no ships),
add a weekly cron that:

1. Grep the active runtime for symptoms (workspace name strings;
   prompt-curl gateway URLs; candidate-action language; runner pre-Pi
   call sites). Report any matches to #meeting-avatar.
2. Run `migration-lessons-audit-method.md` worked-example citations
   through a verifier that resolves `commit:file:line` references
   to current head; report any that resolve to deleted lines.

This is the safety net for the trigger pattern.

### Quarterly review (deeper)

Once per quarter:

- Walk the 6 drift classes and ask: did any of them surface this
  quarter? If yes, the worked example list grows.
- Walk the worked examples and ask: did any of them become outdated
  (the cited code refactored, the cited pattern is no longer
  current)? If yes, update or retire.
- Check if any new drift class is forming (recurring failure
  pattern across multiple incidents that doesn't fit one of the
  existing 6). If yes, promote to first-class.

## Concrete First Cycle

For the next 30 days, the cadence is trigger-based on every
`notes/cueboard-function-audit/*-parity-audit-2026-05-19.md` style
audit doc creation. After 30 days, evaluate:

- How many trigger reviews caught real issues?
- How many worked example citations went stale?
- Is the cadence sustainable without a dedicated owner?

Then decide whether to keep trigger-only, add weekly cron, or
move to quarterly only.

## Ownership

Trigger reviews: whoever wrote the audit doc / drift class /
worked example owns the trigger review for their addition.

Weekly cron (if added): supervisor (@喵喵) owns the grep + report
post.

Quarterly review: co-authored by driver + supervisor; Peng review
at the end.

## Acceptance Criteria

- Every RFC ship in #meeting-avatar references the audit-method
  doc by name and cites at least one drift class it explicitly
  avoided.
- Every parity audit doc ends with a "drift class self-check"
  paragraph: "this audit looked for X, Y, Z drift classes; found
  none / found Z which is fixed in commit ABC."
- No worked example citation in `migration-lessons-audit-method.md`
  resolves to a deleted line in current head.

## Open Questions

- Is 30 days the right first cycle, or should we start with 7 days
  (since today's drift class count is still growing fast)?
- Should the cadence be enforced (block ships that don't reference
  drift classes), or guidance only?
- If the weekly cron flags a possible drift, who triages? The cron
  itself should not require human intervention if no drift is
  found.

## Status

- Proposal only; no implementation yet.
- The trigger pattern is already de-facto in use (today's RFC ship
  and parity audit docs both reference drift classes). Formalizing
  the cadence makes it durable across team changes / context
  compactions.
