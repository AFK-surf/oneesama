# Harness Audit Cadence and Reviewer Checklist

Task #332. This note is the operating checklist for the Harness cache/tool
stability work from task #319 through task #331. It turns the RFC into repeatable
review and monitoring habits.

## What This Watches

- Stable prefix drift: Pi system prompt and realtime foreground tool schema.
- Dynamic context pollution: workspace policy / emoji / time / memory entering
  stable prompt text instead of typed envelopes.
- Worker boundary leaks: raw worker scratch, logs, or lifecycle gaps becoming
  user-visible product copy.
- Browser / Computer Use write risk: external writes without scoped approval.
- Context budget growth: stable / dynamic / worker-result / memory-evidence
  token estimates increasing without review.
- Compaction safety: stable prefix unchanged and source refs preserved.

## Daily Cadence

- [ ] 09:00 / 11:00 / 13:00 / 15:00 / 17:00 / 19:00 / 21:00 Asia/Shanghai:
      run the daytime triage quality self-check window for the recent 2h.
      Completion condition: red buckets are 0; review buckets are either fixed or
      explicitly disposed with a reason.
- [ ] Every 3h foreground monitor:
      run `scripts/oneesama-monitor.sh`.
      Completion condition: health is green and `harness_context` has no new drift
      signal.
- [ ] Daily report:
      run / inspect Oneesama daily audit in the old slackd format.
      Completion condition: compare reply / reaction / custom-emoji / skipped /
      failed buckets against old slackd, and include the Harness drift line.
- [ ] After any prompt, tool, Browser/CU, worker, memory, or compaction change:
      run the relevant focused canary before merge.
      Completion condition: the task's row in "Task Evidence Map" is satisfied.

## Operator Commands

```bash
ONEESAMA_TRIAGE_QUALITY_WINDOW=2h scripts/oneesama-triage-quality-sweep.sh
ONEESAMA_MONITOR_AUDIT_WINDOW=3h scripts/oneesama-monitor.sh
go test ./internal/persona ./internal/slackagent ./internal/meetingagent -count=1
go test ./... -count=1
go test -tags cueboardparity ./... -count=1
```

Use the full suite (`go vet ./...`, `go build ./...`, `git diff --check`) for
code changes that touch runtime, prompt, tool schema, worker, monitor, or daily
report surfaces.

## Red / Yellow Rules

- [ ] **Red**: triage failures without retry-scheduled recovery.
- [ ] **Red**: invalid persona JSON or placeholder summary.
- [ ] **Red**: worker scratch/log copied into a user-visible reply.
- [ ] **Red**: Browser/CU external write executed without approval token.
- [ ] **Red**: source-preserving compaction canary fails
      (`stable_prefix_changed` or `source_attribution_lost`).
- [ ] **Yellow**: dynamic context envelope missing / incomplete / stale.
- [ ] **Yellow**: `delegate_no_visible_action` requires operator review.
- [ ] **Yellow**: daily report shows reaction/custom-emoji parity gap vs old
      slackd.
- [ ] **Yellow**: context budget maxes jump materially after a PR; reviewer
      should ask which input grew and why.
- [ ] **Info only**: no-action run explicitly handled by another agent.
- [ ] **Info only**: delegate worker started and is pending worker audit.

## Reviewer Checklist

### Stable Prefix

- [ ] Run / inspect `TestOneesamaPIStablePromptHashIgnoresDynamicRequestInputs`.
- [ ] For realtime tool changes, inspect `RealtimeToolSchemaStableHash` golden
      update and the foreground tool inventory doc.
- [ ] Confirm current time, workspace policy, custom emoji, Memory evidence,
      channel brain, thread context, live status, and worker results are not added
      to stable prompt text.

### Dynamic Context Envelopes

- [ ] Dynamic context uses `DynamicContextEnvelope` with kind / source / version
      / freshness / confidence / cache policy.
- [ ] `cache_policy` remains `dynamic_not_stable_prefix`.
- [ ] `/slack/triage/audit.reviewBuckets.dynamicContextIssueCount` stays 0, or
      every sample has an explicit fix / dispose.

### Worker Isolation

- [ ] Foreground receives bounded worker result envelopes, not raw logs.
- [ ] Worker result budget is visible through audit metadata.
- [ ] No user-visible canned "done" copy is emitted when worker result is empty,
      failed, or unverifiable.

### Browser / Computer Use

- [ ] Browser/CU actions stay behind the stable demo-surface / worker boundary.
- [ ] External writes require a scoped approval token.
- [ ] Active-control defaults remain off unless a human explicitly enables a
      test run.

### Context Budget

- [ ] Audit/daily/monitor/sweep surfaces show max total / stable / dynamic /
      worker-result / memory-evidence token estimates.
- [ ] Budget increases are explained by an evidence need, not accidental prompt
      stuffing.
- [ ] Worker-result and memory-evidence growth does not become stable-prefix
      growth.

### Compaction

- [ ] Compaction canary preserves stable prompt hash.
- [ ] Every source-backed fact retains source refs after compaction.
- [ ] Worker scratch logs are absent from compacted foreground payloads.

## Task Evidence Map

| Task | Evidence to review                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------- |
| #319 | `notes/code-polish/harness-stability-inventory-2026-05-21.md` classifies stable vs dynamic surfaces. |
| #320 | Pi stable prompt hash and realtime tool hash helpers/tests exist.                                    |
| #321 | Pi stable prompt canary fails if dynamic request data changes stable text.                           |
| #322 | `DynamicContextEnvelope` exists and normalizes source/version/freshness/cache policy.                |
| #323 | Workspace policy / custom emoji / current time move into dynamic envelopes.                          |
| #324 | Triage audit catches missing/incomplete/stale dynamic envelopes.                                     |
| #325 | Worker result envelope bounds evidence and user-visible leakage.                                     |
| #326 | Worker scratch isolation canary proves scratch history is not injected into foreground.              |
| #327 | Realtime foreground tool inventory + hash gate documents tool churn.                                 |
| #328 | Browser/CU external write approval gate RFC defines scoped approvals.                                |
| #329 | Context budget metrics exist for persona + realtime surfaces.                                        |
| #330 | Source-preserving compaction canary exists.                                                          |
| #331 | Daily report + monitor + sweep expose Harness drift metrics.                                         |
| #332 | This checklist defines cadence and review rules.                                                     |

## Review Closure

- [ ] All task evidence rows above are satisfied.
- [ ] Current 2h quality sweep is green or has only accepted info-tier samples.
- [ ] Current 3h monitor is green.
- [ ] Daily audit text includes the old slackd comparison format plus Harness
      drift metrics.
- [ ] Any remaining yellow item has an owner and a follow-up task.
