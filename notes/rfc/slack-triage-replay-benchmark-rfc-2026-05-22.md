# Slack Triage Replay Benchmark RFC

Status: Proposed
Date: 2026-05-22
Owner: `@劲霸仁波切`
Reviewer / fixture lane: `@喵喵`
Anchor task: #365

## Context

Peng asked for a reusable way to dry-run today's Slack triage, then clarified
that the useful path is not "inspect old triage output" or "wait for the next
24h shadow window".

The desired benchmark is:

```text
Take real Slack inputs from a bounded time range, run the current Oneesama
triage pipeline against them, and report what would happen without posting,
creating approval cards, or starting workers.
```

This benchmark should become the normal pre-ship and post-incident quality loop
for Pi foreground triage. It should let Oneesama evolve by replaying real
recent cases through the current pipeline rather than waiting for production to
produce another mistake.

Peng later clarified the bigger goal: this is not merely an audit script. It
is a self-evolution harness. The same real 24h input set should be replayed
through multiple triage variants, judged primarily by an LLM grader, calibrated
by human approval/reject samples, and then used to decide which prompt/gate/
worker configuration should ship.

## Why This Exists

The benchmark exists to make triage quality observable before production users
pay the cost.

Oneesama is no longer a simple Slack reply bot. A single Slack input can flow
through:

- context fetch;
- memory retrieval;
- external link fetch;
- Pi foreground decision;
- secretary lookup auto-delegation;
- visible-reply evidence-anchor gate;
- Peng approval-card pilot;
- worker result delivery.

When that chain is changed, a unit test can prove one local rule, but it cannot
answer whether the current system would handle the real messy traffic from
today better or worse than before. The replay benchmark fills that gap.

It gives the team four concrete abilities:

1. **Verify a fix against real incidents.** If DSML leaked, if Persona spoke in
   internal terms, if a HN identity lookup under-responded, or if Oneesama
   over-responded in a thread that should stay silent, the fix should be
   replayable against the original inputs immediately.
2. **Prevent regressions.** Once a real mistake is fixed, the benchmark can keep
   replaying it so future prompt/gate/worker changes do not re-open the same
   class of failure.
3. **Measure quality drift.** "Old slackd felt better" needs to become
   comparable signals: which cases would now reply, delegate, block, or stay
   silent, and how that differs from labeled outcomes or prior baselines.
4. **Turn Peng feedback into data.** Confirm/reject decisions from approval
   cards should become benchmark labels, so Oneesama learns from actual product
   judgment instead of accumulating marker patches.

Important: the benchmark must not assume the current triage flow is correct.
It must be allowed to prove that the flow itself is wrong.

For example, a replay can show:

- Pi stays silent too often even when evidence-gathering should happen;
- reply quality only passes because a late gate blocks bad output, meaning the
  upstream decision contract is weak;
- worker delegation is selected but the worker contract cannot produce a
  source-backed result;
- context fetch or memory evidence is missing, so Pi is deciding from a thin
  view;
- approval cards are dominated by rejects, which means the system is creating
  review burden rather than helping.

Those are not "tune one marker" failures. They are pipeline-design failures,
and the benchmark should surface them plainly.

## No-Oracle Axiom

The benchmark must not pretend that any single signal is ground truth.

Old `slackd` may be better than current Oneesama on some cases, but it can also
be wrong. Peng's approval/reject decisions are the most important product
feedback, but they are still contextual judgments, not a permanent mathematical
oracle. Canary fixtures encode known expectations, but they can become stale or
overfit. Current Pi output is obviously not truth either.

Therefore the benchmark should not emit a single "correct / wrong" verdict for
fresh rolling traffic. It should emit a multi-signal report:

```text
what current replay would do
what production actually did
what old slackd did when available
what Peng approved/rejected/deleted
what later human replies or reactions suggested
which gates fired
which pipeline-smell signals appeared
what an independent LLM judge scored and flagged
```

The reviewer decides whether a drift is a regression, an improvement, or a
case where the benchmark uncovered a wrong assumption in the pipeline.

In short:

```text
The benchmark is the triage harness loop: replay real inputs, run the real
current pipeline, block side effects, compare outcomes, then feed the deltas
back into prompts, gates, workers, and fixtures.
```

The LLM judge is also not truth. It is the main scoring column for large replay
sets because human review cannot grade every case, but human samples and known
fixtures calibrate the judge and catch judge drift.

## Problem

The current quality surfaces are useful but incomplete:

- `oneesama-triage-quality-sweep.sh` audits already-recorded triage runs.
- Visible-reply allow-list canaries test hand-written gate fixtures.
- The 24h shadow summary compares new gates against existing samples.

Those surfaces answer "what happened?" or "does this small gate fixture pass?"
They do not answer Peng's key question:

```text
If the current Oneesama saw the last 24h of Slack messages again, what would it
do now?
```

Without that replay loop, every runtime prompt/gate/worker change requires live
waiting or manual spot checks.

## Product Axiom

Triage quality should be benchmarkable from real history.

A benchmark run must:

1. **Use real inputs** from a bounded Slack time range, defaulting to the last
   24h.
2. **Use the current real triage pipeline**: context fetch, external link
   context, memory evidence, Pi foreground request, dispositions, visible reply
   allow-list, and worker delegation policy.
3. **Block all side effects**: no public Slack post, no Peng approval card, no
   pending action insert, no reaction, no worker start, no memory write.
4. **Expose decisions**: what would reply, what would delegate, what would stay
   silent, and why gates blocked.
5. **Compare against signals** when signals exist, while still producing useful
   unlabeled diagnostics for fresh rolling windows.
6. **Challenge the pipeline**, not only individual gates. A run can conclude
   that the current Pi/context/worker/gate flow is the wrong abstraction for a
   class of cases.
7. **Be repeatable enough for CI/dev loop**, while accepting that rolling 24h
   live inputs are noisy and should not be a hard gate by themselves.

## Benchmark Modes

### Mode A — Rolling 24h Live Replay

Default operator mode:

```bash
cmd/oneesama-triage-benchmark --live --since 24h --channel auto --max-threads 24
```

Input source:

- Slack conversations history / replies for configured channels;
- existing fetch limits and bot-user filters;
- a bounded dry-run cap by default (`--max-threads`, set to `0` only for an
  intentionally long full sweep);
- optional channel allow-list for a focused incident.

Use:

- daily quality check;
- after a prompt/gate/worker fix;
- Peng asks "今天这些重新 dry run 一遍".

Expected outcome:

- Mostly unlabeled.
- Reports distributions and samples for human review.

### Mode B — Labeled Fixture Replay

CI/dev mode:

```bash
cmd/oneesama-triage-benchmark --fixture internal/slackagent/testdata/triage_benchmark/*.json
```

Input source:

- archived Slack message bundles;
- labels derived from Peng approve/reject decisions, known incidents, and
  hand-curated canaries.

Use:

- PR gate / focused test;
- stable regression suite;
- prevent reintroducing known leaks and under-response cases.

Expected outcome:

- Hard assertions for must-block and must-allow cases.
- Soft assertions for should-delegate / freely-silent cases.

### Mode C — Approval Sample Replay

Data-driven evolution mode:

```bash
cmd/oneesama-triage-benchmark --approval-samples --since 7d
```

Input source:

- `SlackVisibleReplyQualitySample` records from Peng approval cards.

Use:

- derive future positive features;
- monitor false allow / false block drift;
- feed the fixture suite without guessing marker lists.

Expected outcome:

- Confirmed samples become positive examples.
- Rejected/blocked samples become negative examples after reviewer sanity check.

### Mode D — Multi-Config A/B Replay

Self-evolution mode:

```bash
cmd/oneesama-triage-benchmark --live --since 24h --channel auto --config-set notes/triage-benchmark/configs
```

Input source:

- the same Slack thread/message bundle for every variant;
- a set of triage variant specs that can adjust prompt snippets, gate strictness,
  evidence-anchor requirements, memory/context budgets, and worker contract
  toggles.

Use:

- compare current shipped config against candidate variants;
- test whether a prompt/gate/worker change improves the same real cases rather
  than merely shifting failure modes;
- pick the best-scoring variant for rollout.

Expected outcome:

- one row per `(case, variant_id)`;
- aggregate score per variant;
- drift/conflict samples where variants disagree;
- explicit "winner is not automatic" note when judge/human/canary signals
  disagree.

## LLM Judge Signal

The benchmark should include an independent LLM judge signal:

```json
{
  "score": 0.82,
  "verdict": "good | bad | uncertain",
  "flags": ["over_respond", "missing_evidence", "self_identity_overreach"],
  "reasoning": "short private audit note"
}
```

Judge principles:

- use a different prompt from production Pi;
- prefer a different model/provider from the production foreground runtime when
  available, to reduce self-confirmation bias;
- judge the final human-visible behavior, not internal style preferences;
- score factual correctness, usefulness, thread fit, over-response, internal
  leak risk, evidence quality, and reviewer burden;
- never treat the judge as the only oracle.

Human review role:

- Peng approval/reject samples calibrate the judge;
- `@喵喵` reviews weird judge failures and fixture labels;
- disagreement between judge and human feedback is a first-class signal, not a
  reason to hide one side.

## Variant Config Surface

The first implementation can start with one real current config plus named
metadata, but the benchmark contract should reserve room for variant comparison:

```json
{
  "variant_id": "current",
  "description": "current shipped prompt/gates/workers",
  "knobs": {
    "visible_reply_gate": "anchor_required",
    "secretary_lookup": "enabled",
    "memory_budget": "current",
    "identity_context": "layered"
  }
}
```

Candidate future knobs:

- visible reply gate: deny-list only vs evidence-anchor allow-list;
- memory context budget: current vs capped vs dream-consolidated facts only;
- secretary lookup: off vs current vs richer source-following contract;
- self-identity handling: no envelope vs layered identity envelope;
- prompt variant: current Pi stable prompt vs proposed prompt patch.

The benchmark should always report which variant produced each output.

## Output Contract

Each replayed thread should emit a compact decision row:

```json
{
  "channel_id": "C123",
  "thread_ts": "1770000000.000000",
  "variant_id": "current",
  "message_count": 4,
  "persona_decision": "reply | delegate_worker | react | stay_silent",
  "final_decision": "would_reply | would_delegate_worker | would_react | would_stay_silent",
  "visible_reply": {
    "text": "human-facing draft if any",
    "allowed": true,
    "gate_reason": "allowed | missing_evidence_anchor | internal_meta | ...",
    "evidence_anchors": []
  },
  "worker_requests": [
    {
      "id": "secretary-link-fact-lookup",
      "kind": "codex",
      "session_kind": "secretary_lookup",
      "would_start": true
    }
  ],
  "side_effects_blocked": [
    "slack_post",
    "approval_card",
    "pending_action",
    "worker_start",
    "memory_write"
  ],
  "signals": {
    "production_outcome": "replied | delegated | reacted | silent | blocked | unknown",
    "old_slackd_outcome": "replied | delegated | reacted | silent | unknown",
    "peng_feedback": "confirmed | rejected | deleted | diss | unknown",
    "human_followup": "supported | contradicted | answered_elsewhere | ridiculed | unknown",
    "fixture_expectation": "must_allow | must_block | should_delegate | freely_silent | none",
    "llm_judge": {
      "score": 0.82,
      "flags": ["missing_evidence"],
      "reasoning": "private judge note"
    }
  },
  "drift": {
    "changed_from_production": true,
    "changed_from_old_slackd": false,
    "review_reason": "current_replay_blocks_old_reply"
  }
}
```

The benchmark summary should aggregate:

- `threads_replayed`
- `would_reply`
- `would_delegate_worker`
- `would_react`
- `would_stay_silent`
- `visible_reply_allowed`
- `visible_reply_blocked`
- `worker_requests`
- `must_allow_signal_conflicts`
- `must_block_signal_conflicts`
- `should_delegate_signal_conflicts`
- `unknown_label_samples`
- `outcome_drift_samples`
- `pipeline_smell_samples`
- `variant_scores`
- `llm_judge_flag_counts`
- `judge_human_disagreement_samples`

## Pipeline-Smell Signals

The benchmark should report pipeline smells even when no explicit label exists:

| Signal | What it suggests |
|---|---|
| `high_silent_rate_with_questions` | Pi-first or context fetch may be under-responding. |
| `high_gate_block_rate` | Upstream Pi/worker output contract is weak; the gate is doing too much rescue work. |
| `delegate_without_worker_result_contract` | Worker prompt/schema cannot produce source-backed visible results. |
| `link_or_file_context_missing` | The pipeline is deciding before it has the evidence the old slackd would have fetched. |
| `approval_reject_cluster` | Oneesama is creating reviewer burden; positive allow-list features are not strong enough. |
| `would_change_outcome_spike` | A prompt/gate/worker change has shifted behavior and needs manual review. |
| `self_identity_overreach` | A worker or Pi claimed the wrong layer/model/provider identity. |
| `memory_scope_confusion` | Retrieved memory from another agent/project was used as if it applied to Oneesama. |

These signals should be treated as design-review prompts, not automatic
failures. The point is to make wrong assumptions visible early.

## Side-Effect Firewall

The replay path must not call the live side-effect functions:

- `executeSlackTriageDirectActions*`
- `insertSlackTriagePendingActions`
- `postSlackTriagePendingActionCard`
- `startPersonaDelegatedWorkerJobs`
- Slack API write calls
- memory write persistence

Instead it should call dry-run mirrors that only summarize:

- post/reaction actions after gates;
- approval eligibility;
- worker requests after delegation policy;
- memory write intents.

This is a hard invariant. Any benchmark result that mutates Slack or starts a
worker is a red failure.

## Signal Comparison

Hard fixture gates:

- `must_block` cases must not produce an allowed visible reply.
- framework/protocol/internal-meta leaks must have 100% block coverage.
- benchmark execution must have zero side effects.

Soft signal comparisons:

- `must_allow` false-block rate should not exceed the baseline by more than
  20% without reviewer sign-off, but the reviewer may decide the old label was
  wrong.
- `should_delegate` false-silent rate should trend down after secretary lookup
  changes.
- rolling 24h unlabeled windows should report drift, not fail CI.
- old `slackd` outcome is a calibration signal, not an oracle.
- Peng approval/reject is a high-value product signal, not an automatic
  permanent truth label.

## Fixture Evolution

Fixture additions should come from real evidence:

- Peng rejects an approval card -> candidate negative fixture.
- Peng confirms an approval card -> candidate positive fixture.
- sweep/benchmark false positive -> negative fixture.
- production incident -> fixture with expected outcome matching the fix.
- old slackd vs new Oneesama quality delta -> fixture when the old answer was
  clearly better.

Reviewer rule:

- `@喵喵` owns fixture labeling sanity checks.
- Do not auto-promote every label without reviewing whether the label expresses
  the product axiom rather than a one-off preference.

## Rollout Plan

### Phase 0 — RFC And Seed Case Inventory

- [x] Write this RFC.
- [x] Collect v0 case list from today's incidents:
      DSML/tool protocol leak, persona meta leak, over-respond approval-card
      cases, HN identity lookup under-response, product-link commentary, and a
  direct smoke command.
- [x] Include the 2026-05-22 self-identity incident where a Codex worker
      answered "你是什么模型" as if Oneesama itself were Codex/OpenRouter.
- [x] Include the 2026-05-22 raw JSON worker output incident where
      `{visible_text,evidence_anchors}` was posted as JSON instead of rendering
      `visible_text`.
- [x] Mark each case as `must_block`, `must_allow`, `should_delegate`, or
      `freely_silent`.
- [ ] Acceptance: Peng and `@喵喵` can read the case list and understand why
      each label exists.

### Phase 1 — Internal Dry-Run Triage API

- [ ] Add `dry_run` support to `/slack/triage/run`, or an equivalent internal
      service method called by both HTTP and CLI.
- [ ] Reuse the same Pi foreground request builder and disposition/gate
      sequence as live triage.
- [ ] Return `SlackTriageDryRunResult` with final decision, gate verdicts,
      would-start worker requests, and blocked side-effect list.
- [ ] Acceptance: focused tests prove dry-run reply blocks do not create pending
      actions and dry-run delegation does not start an agentrunner job.

### Phase 2 — Benchmark CLI

- [ ] Add `cmd/oneesama-triage-benchmark`.
- [ ] Support `--live --since 24h --channel auto|C1,C2`.
- [ ] Emit `variant_id=current` in every row and leave the report schema ready
      for multi-config comparison.
- [ ] Support fixture JSON input.
- [ ] Write JSON report and short Markdown summary.
- [ ] Add row to `cmd/README.md`.
- [ ] Acceptance: running the CLI against a small fixture produces deterministic
      summary counts and zero side effects.

### Phase 3 — V0 Fixture Suite

- [x] Add `internal/slackagent/testdata/triage_benchmark/*.json`.
- [x] Include positive, negative, delegate, and freely-silent cases.
- [x] Add a unit/integration test that runs fixtures through the dry-run method.
- [ ] Acceptance: known leak cases are blocked; known source-backed cases do not
      fail the allow-list only because of missing fixture labels.

### Phase 4 — Rolling 24h Operator Benchmark

- [ ] Wire live Slack fetch for the previous 24h.
- [ ] De-dupe by `(channel_id, thread_ts)`.
- [ ] Sample or cap threads to keep runtime bounded.
- [ ] Produce report under `ONEESAMA_STATUS_OUTPUT_DIR` when set.
- [ ] Acceptance: Peng can run one command and get a "today replayed" report
      without waiting for production shadow.

### Phase 5 — CI / Cadence Integration

- [x] Add `make triage-benchmark-fixtures` for labeled fixtures.
- [ ] Keep rolling live replay as manual/ops, not CI hard gate.
- [x] Add optional benchmark line to `oneesama-status-report.sh`; keep it
      skipped by default until runtime is stable enough.
- [ ] Acceptance: PRs touching triage prompts/gates/workers have a focused
      benchmark command in their validation notes.

### Phase 6 — Multi-Config Sweep + LLM Judge

- [x] Add variant config input (`--config-set`) and per-variant report
      aggregation scaffold.
- [ ] Wire variant knobs into prompt/gate/worker behavior.
- [ ] Run all variants against the same case set.
- [ ] Add judge request/response schema and report column.
- [ ] Calibrate judge against Peng approval/reject samples.
- [ ] Acceptance: one benchmark run can rank variants and surface
      judge/human/fixture disagreement samples.

### Phase 7 — Daily Dream Memory Consolidation

- [ ] Add a nightly/idle "dream" pass that consolidates noisy triage memory
      into typed facts: `identity_fact`, `project_fact`, `user_preference`,
      `incident_lesson`, `stale_or_scoped_fact`.
- [ ] Every fact must carry `applies_to`, `source_refs`, `validity`, and
      optional `do_not_generalize_to`.
- [ ] Use benchmark/judge failures such as `memory_scope_confusion` to mark or
      rewrite memory that caused bad answers.
- [ ] Acceptance: memory about `codex-3720` self-identity cannot be retrieved
      as Oneesama identity without an explicit scope mismatch warning.

## Non-Goals

- Do not post Slack messages during benchmark.
- Do not create Peng approval cards during benchmark.
- Do not start worker jobs during benchmark.
- Do not use the benchmark to auto-close Linear/GitHub/Slack tasks.
- Do not make rolling live 24h replay a hard CI gate; it is too noisy.
- Do not replace human review for new fixture labels.
- Do not let the LLM judge auto-ship a variant without human-reviewable
  disagreement samples.

## Open Questions

- Should rolling 24h replay include all visible channels or only channels with
  recent triage activity?
- What cap keeps live replay fast enough: max threads, max messages, or max
  Pi calls?
- Should `should_delegate` be a hard gate once secretary lookup is stable, or a
  warning until worker result quality has enough labels?
- How many Peng-confirmed positive samples are enough before `must_allow`
  thresholds become meaningful?
- Which judge model/provider should be the default, given production foreground
  runs PiAgent?
- What is the first safe knob set for A/B: prompt-only variants, gate variants,
  or memory-budget variants?
