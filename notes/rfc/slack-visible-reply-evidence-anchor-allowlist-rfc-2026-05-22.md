# Slack Visible Reply Evidence-Anchor Allow-List RFC

Status: Proposed
Date: 2026-05-22
Owner: `@劲霸仁波切`
Reviewer / supervision lane: `@喵喵`

## Context

Peng called out that the short-term `e75aef3` fix still smells like
"打地鼠": it blocks known internal phrases such as `persona`, `triage`, and
`no visible output`, but it does not yet define what a Slack-visible reply is
allowed to be.

That critique is correct.

`e75aef3` is a stop-the-bleeding runtime gate:

- it prevents internal control-plane words from reaching Slack;
- it prevents "I have no visible output" style no-action explanations;
- it forces approval cards to resolve visibly after confirm/reject.

It is not the final quality architecture. The final architecture should be an
allow-list: Oneesama may only propose a Slack-visible reply when the reply has a
human-facing conclusion plus concrete evidence anchors.

## Problem

The current visible-reply pipeline has a negative definition:

```text
reply is blocked if it contains known bad markers
```

That negative definition fails in two ways:

1. A new internal term can leak before it is added to the list.
2. A model can produce polite but low-value text that contains no banned words
   while still adding no evidence-backed value.

The desired definition is positive:

```text
reply is allowed only if it proves why this text belongs in Slack
```

## Product Axiom

Oneesama can post a Slack-visible reply only when all of these are true:

1. **Direct conclusion:** the text says the useful thing to the humans in the
   thread, not an explanation of Oneesama's internal decision.
2. **Evidence anchor:** the reply is backed by at least one concrete source the
   system can name and audit.
3. **Thread fit:** the reply is not duplicating a handled answer and is not
   ambient commentary in a thread directed at someone else.
4. **Boundary fit:** the reply stays in Oneesama's secretary / coordination /
   source-backed lookup lane.
5. **Approval in pilot:** while the pilot is active, even allowed replies still
   go to Peng's DM approval card before public posting.

If any item fails, the system should either stay silent or delegate a bounded
evidence-gathering worker. It should never explain the no-action decision in
the target Slack thread.

## Evidence Anchor Contract

Introduce a typed evidence anchor for every proposed Slack-visible reply:

```json
{
  "kind": "slack_thread | fetched_link | workspace_memory | person_memory | file | image | worker_result | explicit_user_command",
  "source_ref": "C123/1770000000.000000 | https://... | memory/people/foo.md:2",
  "quote": "short source excerpt or fact",
  "confidence": 0.9,
  "freshness": "2026-05-22T11:30:00Z"
}
```

Rules:

- `source_ref` is mandatory.
- `quote` should be short and source-local.
- `explicit_user_command` is valid only for "reply with exactly X" / smoke /
  direct command cases; it must cite the triggering Slack message.
- `worker_result` anchors must point to bounded worker result envelopes, not raw
  scratch logs.
- Workspace/person memory anchors must preserve path or record ID.

## Target Reply Shape

Every proposed public reply should normalize to:

```json
{
  "type": "post_thread_reply",
  "message": "human-facing text",
  "evidence_anchors": [
    {"kind": "fetched_link", "source_ref": "https://news.ycombinator.com/user?id=Johnson8053", "quote": "created: 2024-09"}
  ],
  "novelty": "adds_fact | routes_owner | answers_direct_question | records_followup",
  "boundary": "secretary_lookup | issue_hygiene | meeting_coordination | source_backed_commentary",
  "requires_confirmation": true
}
```

The approval card may render the message plus a compact "why this is eligible"
line, but should not expose raw debug fields or internal module names.

## Gate Algorithm

```text
candidate action
  -> sanitize visible text
  -> reject internal/no-action/meta text
  -> require message is direct human-facing conclusion
  -> require >=1 valid evidence anchor
  -> require novelty/boundary classification
  -> require not handled_by_other / directed_to_active_agent
  -> create Peng approval card
```

The current deny-list remains as an outer safety net, but it should no longer be
the primary proof of quality.

## Data Collection

The approval pilot becomes the training/evaluation surface:

- Confirmed cards are positive examples.
- Rejected cards are negative examples.
- Silent quality-gate blocks are sampled for audit.
- Each sample stores:
  - proposed message;
  - evidence anchors;
  - boundary/novelty classification;
  - approval decision;
  - final outcome;
  - linked triage run and Slack thread.

This lets us derive stable positive features from real Peng feedback instead of
guessing a giant marker list.

## Rollout Plan

### Phase 0 — Pilot Sample Capture

- [ ] Persist approval-card decisions as structured quality samples.
- [ ] Backfill the last 24h approval cards into the sample shape when fields are
      present.
- [ ] Add audit endpoint and sweep line for sample counts:
      `reply_quality_samples_confirmed/rejected/blocked`.
- [ ] Acceptance: rejecting a card produces a searchable negative sample with
      thread/run/card IDs.

### Phase 1 — Evidence Anchor Types

- [ ] Add `SlackVisibleEvidenceAnchor` type.
- [ ] Add anchors to `SlackTriageDecisionAction`.
- [ ] Map existing sources into anchors:
      Slack thread ref, fetched external link, memory/person record, worker
      result envelope, explicit command message.
- [ ] Acceptance: existing approval-card smoke has one
      `explicit_user_command` anchor; secretary lookup replay has fetched link
      plus workspace-memory anchors.

### Phase 2 — Allow-List Gate

- [ ] Implement `slackVisibleReplyAllowListVerdict(action)` with verdict
      reason codes:
      `allowed`, `missing_evidence_anchor`, `not_human_facing`,
      `duplicate_handled`, `boundary_mismatch`, `internal_meta`.
- [ ] Keep `e75aef3` internal/meta blocker as a final safety guard.
- [ ] Wire allow-list before approval-card creation.
- [ ] Acceptance: a reply with banned words is blocked by safety; a reply with
      no anchors is blocked even if it has no banned words.

### Phase 3 — Persona / Worker Output Contract

- [ ] Extend Pi foreground output schema with `evidence_anchors`.
- [ ] Extend bounded worker result envelope with source-preserving anchors.
- [ ] Update prompts to require "if you cannot cite an anchor, stay silent or
      delegate for evidence."
- [ ] Acceptance: Pi direct reply and secretary worker reply paths both produce
      the same anchor contract; no path gets a private exemption.

### Phase 4 — Approval Card UX

- [ ] Render a compact eligibility line in Peng's DM card:
      `Evidence: fetched_link + workspace_memory`.
- [ ] Keep card actions binary: `通过并发送` / `不通过`.
- [ ] On reject, capture optional reason only if a future UX asks for it; do not
      add more buttons in the current pilot.
- [ ] Acceptance: approval card remains simple while the audit store has full
      anchor details.

### Phase 5 — Canary And Rollout

- [ ] Add canary fixtures:
      internal meta leak, no-anchor polite reply, smoke explicit command,
      HN identity lookup, source-backed product link, handled-by-other thread.
- [ ] Add 24h shadow mode comparing deny-list-only vs allow-list verdicts.
- [ ] Flip allow-list to active when false-block rate is acceptable.
- [ ] Acceptance: 24h daytime sweep shows red=0/review=0 and approval cards with
      anchors have Peng-confirmed pass rate above the chosen threshold.

## Non-Goals

- Do not remove Peng approval cards during the pilot.
- Do not attempt to infer "good taste" from a single regex list.
- Do not require citations for reactions or internal audit-only decisions.
- Do not expose raw worker logs, prompt text, or triage metadata to Slack users.
- Do not give Oneesama broader project-debugging authority; this only defines
  when visible replies are eligible.

## Open Questions

- What false-block rate is acceptable before flipping allow-list active?
- Should `explicit_user_command` anchors expire quickly so smoke commands do not
  normalize arbitrary user-provided text as evidence?
- Should rejected-card samples become Memory immediately, or first go through a
  daily reviewer summary to avoid overfitting Peng's one-off frustration?

## Acceptance Summary

- Oneesama cannot create a public reply approval card without at least one
  typed evidence anchor.
- Internal/no-action/meta text is still blocked fail-closed.
- Peng approval cards stay binary and visibly resolve after click.
- Rejections feed a structured sample store for future policy improvements.
