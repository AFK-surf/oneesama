# Migration Lessons — Audit-method drift (companion to migration-lessons.md)

This is a companion to `migration-lessons.md` (the canonical incident table
+ gates + Definition of Done). Read that first.

This file adds the v1 audit author's perspective: I wrote
`notes/oneesama-go-parity-audit.md` (5/13), the cross-check
(`oneesama-go-parity-cross-check.md`), and the R0–R7 specs
(`go-rewrite-r0-spec.md` ... `r7-meet-runner-spec.md`). When Peng asked us
to migrate by function and by test, those documents were the artefact I
produced. They did not prevent the drift. This file reflects on **why my
own audit method failed**, with specific commit SHAs and audit-row
citations that the canonical doc abstracts away.

## What the canonical doc covers

`migration-lessons.md` covers the 9 failure modes ("What Actually Went
Wrong"), historical signal timeline, broader drift inventory, gates
0–9, function-by-function Definition of Done, and test migration
requirements. Everything here is meant to add evidence and the
audit-author's-own-eye perspective, not duplicate those sections.

## How the v1 audit drifted from acceptance gate to backlog

`oneesama-go-parity-audit.md` produced a table of 43 TS routes vs Go ~17
and a "🚨 必须有才能算 1:1 production parity" list. It looks like an
acceptance gate. It became a backlog.

Concrete trail of how that happened:

- `POST /slack/post-message` was marked ✓ done in v1 audit because the
  Go route existed and accepted the same input shape. The actual
  product behavior — digest `message_ref` IDs resolve to
  channel/timestamp at post time, `add_reaction` falls back to the
  latest digest entry per channel — was not part of my ✓ test.
  Symptom: `a3913d5 fix(slack): resolve add reaction digest targets`
  shipped weeks later when the gap surfaced in real use. The original
  ✓ was lying.

- `/slack/tools/parity` was marked ✓ done in v1 audit. The endpoint
  returned a list. The 4-class `active / validation_only /
  registered_unavailable / product_excluded` semantic that the report
  was supposed to advertise had to be retrofitted later (see commit
  trail `slack_tool_parity_status_test.go`). ✓ meant "endpoint
  returns JSON", not "endpoint tells runtime truth".

- `POST /slack/interactions` was marked ✓ done. The full
  `suggest_action` confirmation flow (pending-action persistence,
  card update on confirm/dismiss, executor goroutine, ledger,
  freshness re-check) was nowhere near complete. We then shipped that
  full flow over many slices.

The pattern: shape ✓ ≠ contract ✓. The v1 audit checked shape only.
Canonical fix: see `migration-lessons.md` Gate 0 + Gate 6.

## Files marked ❌ MISSING that never got a direct port

Cross-check Section 8 enumerated ~5000 LOC of Slack intelligence as
❌ MISSING by file:

| TS file | LOC | What got ported |
| --- | --- | --- |
| `app-mention-context.ts` | 572 | partial — rich context shipped in Phase 2 via new Go helpers, not as a 1:1 port |
| `legacy-slack-domain-store.ts` | 1720 | not ported as a file; subsumed into typed collections + cognition |
| `legacy-slack-tool-registry.ts` | 489 | not ported as a file; tool gating handled by parity matrix |
| `local-memory.ts` | 363 | partial via persistence layer; workspace memory shape differs |
| `meeting-copilot-runner.ts` | 501 | deferred / not ported |
| `mrkdwn-renderer.ts` | 384 | partial; Slack-side rendering uses different shape |
| `scanner-compaction.ts` | 104 | partial via service_scanner_poll |
| `slack-context.ts` | 261 | partial |
| `triage-context.ts` | 306 | partial via service_triage |
| `triage-flow.ts` | 446 | rebuilt as multiple Go files; not a per-function port |

Few of those got a "port file X → Go file Y, prove byte-equivalent
output on a TS fixture" sequence. Most got new Go code solving similar
problems differently. We then ticked the row as "covered" without a
test that would fail if the original TS behavior was no longer met.

Canonical fix: see `migration-lessons.md` Gate 0 + Function-By-Function
Definition of Done.

## Decision trees enumerated, but no per-step pin test

Cross-check Section 1 enumerated 11 steps of TS `events_api` handling
(message buffering, mention dedup, command build, empty-text skip,
assistant status, command execute, response post, status keep/clear,
return). Each step had a Go ✓/⚠/❌ status.

There is still no single Go test that walks through all 11 steps in
order, verifies each step against a TS fixture, and fails if any step's
branch shifts. We have scattered tests for individual behaviors but no
canonical 11-step pin.

Symptom: when step 3's `claimSlackMentionEvent` dedup was missed in
the early Go port, the bug only surfaced when a Slack retry produced
a duplicate event. The 11-step audit row was there; the test wasn't.

Canonical fix: see `migration-lessons.md` Test Migration Requirements.

## R-specs locked types, not product contracts

`notes/go-rewrite-r0-spec.md` through `r7-meet-runner-spec.md` were
TS-to-Go interface mappings: function signatures, type definitions,
route shapes. They did NOT specify the product contracts:

- "scanner waits 5 minutes by default before posting" (task #187 root
  cause, surfaced today 2026-05-18)
- "mention queue rejects duplicate event_id within an N-second window"
- "assistant.threads.setStatus dedupes by lastStatus per
  (channel, thread)"
- "delegate response text is suppressed for events_api path when
  `job.status === running`" (the
  `slackImmediateWorkerAckText` 3-branch)

These are user-visible promises. R-specs read like a port-compatibility
spec for a library, not acceptance criteria for a product. The
5-minute scanner wait was nowhere in any spec; that's why driver had
to land it as a fix today, not as a port.

Canonical fix: see `migration-lessons.md` Gate 1 (Name The Product
Contract) + Gate 5 (Re-Check Freshness).

## Wire-format duals at the call-site level

The v1 audit enumerated TS files with bot-detection logic, not the
per-call-site behavior of bot detection across the codebase. The
audit's idea of "we recognize bot messages" was correct at the file
level and wrong at the call-site level.

Today's repair trail (all from #185 slice 2/3):

- `af4e097 fix(triage-replay): normalize snake_case inputs in backfill
  scan` — backfill classifier didn't run `normalizeSlackInboundMessage`
  internally, so a snake-case `channel_id` input came out with empty
  ChannelID and grouping was wrong. Driver caught.
- `fbb6c46 fix(triage-replay): treat subtype=bot_message as
  bot-authored` — `isAuthoredByBot` only checked `bot_id`, missing
  Slackbot/incoming-webhook posts that use `subtype=bot_message`
  without `bot_id`. Driver caught.
- `c381045 refactor(triage-replay): exclude bot replies from candidate
  draft bundle` — bot reply text was leaking into the draft summary
  because the classifier saw all replies in the bundle.

All three are the same root failure: a wire-format dual (snake/camel
field names, multi-source bot identity, bot-vs-human reply roles)
that Cueboard normalized at ingress but the Go port handled
piecemeal at each call-site.

Canonical fix: see `migration-lessons.md` Broader Drift Inventory row
"Normalization and codec defaults" + Test Migration Requirements
"normalization".

## Marathon incentive structure ("port + prove" pairs)

Driver names this in their #9 ("Marathon throughput hid review depth
problems"). One concrete pattern not yet structurally fixed:

Throughout today's marathon, my slice 2 and slice 3 piece B each
shipped with a real bug that driver's audit caught. The bugs were:

- snake_case normalize gap → fixed in `af4e097`
- subtype=bot_message gap → fixed in `fbb6c46`
- bot reply leaking into draft → fixed in `c381045`

In each case the fix was small and quick. But the AUDIT ITSELF was
the safety net, not my pre-ship verification. If driver hadn't been
auditing every slice, those would have landed silently.

Suggested structural fix: marathon slices ship in **port + prove
pairs**. The same agent does not get to mark a slice in_review unless
either (a) a contract test that fails on the unported state exists,
or (b) a second agent's audit signature is attached. A marathon of
30 ships should be 15 ship+audit pairs, not 30 unaudited ships.

(This is more specific than driver's Gate 9 wording. It is a process
proposal, not a tested claim. Worth Peng's attention if a future
marathon is planned.)

## Where this file sits

`migration-lessons.md` is the canonical gates + Definition of Done.
This file is the v1 audit author's evidence-cited reflection on why
the audit method she produced failed. Future migrations should read
the canonical doc first; this file is for understanding the
historical failure modes, not for enforcing the new rules.
