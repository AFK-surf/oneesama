# Bridge Quality Canary — 2026-05-19 (task #219)

## Goal

Build an old-vs-new canary fixture suite anchored on past-week real
Bridge production cases. The point is **not** to write more unit
tests; it is to make every entry-parity contract item verifiable on a
real production prompt, so a future regression cannot pass `health =
green` while breaking user-visible quality.

This is the operational arm of the audit method in
`notes/cueboard-function-audit/migration-lessons-audit-method.md`.

## Scope of this ship

This is the **framework + scaffold + first fixture**, not the full
suite. Subsequent fixtures land as tasks #220–#223 ship (each ship
adds at least one anchor case under
`internal/slackagent/testdata/bridge_quality_fixtures/`).

What is in this ship:

- `internal/slackagent/testdata/bridge_quality_fixtures/README.md` — fixture
  format + contract-mapping table.
- `internal/slackagent/testdata/bridge_quality_fixtures/case_001_jc_case_study.json`
  — first concrete case, anchoring C4 (related-memory evidence
  injection) on the Jc Case Study production prompt.
- `internal/slackagent/bridge_quality_canary_test.go` —
  `TestBridgeQualityCanaries` loads every `case_*.json` file and runs
  per-contract assertions; logs (not fails) when a fixture lists a
  contract item the scaffold does not yet assert, so partial fixtures
  can be added without breaking the suite.

What is NOT in this ship:

- Full end-to-end Slack event replay against a live bot. The scaffold
  exercises `buildAgentRunnerContext`, which is where C4 evidence
  injection lives. Other contract items (C1 Socket→job creation, C2
  scanner reconciliation, C3 orphan recovery, C5 Canvas reuse, C7
  output-boundary fail-closed) need their own per-item harnesses
  layered on the same fixture file. See `runBridgeQualityFixture`
  default branch — adding a new contract item is a new `case` clause.
- Replay of the 17 mutating Bridge runs as full automated diff. The
  audit author selects representative cases; total enumeration is
  explicitly not the goal (see migration-lessons-audit-method.md
  "audit by user entry, not module").

## Methodology

1. **Source pool**: Cueboard slack.db `triage_run` table joined with
   `triage_tool_call`. The 2026-05-19 sweep enumerated 1828 total
   triage runs since 2026-05-12, ~307 Bridge-related, 56 mutating.
   Path: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/slack.db`.
2. **Selection criteria per fixture**:
   - Each new fixture must cite at least one contract item it
     exercises (`expected_contract_items` field).
   - Each new fixture must include at least one evidence anchor
     substring that the old agent's reply cited (or a path that
     should be reachable to the worker).
   - `must_not_contain` always pins the C7 fail-closed rule.
3. **Coverage target across all #219 work**:
   - C4 (related-memory injection): ≥ 1 fixture. **Shipped**:
     `case_001_jc_case_study.json`.
   - C5 (Canvas reuse): ≥ 1 fixture. **Pending** (anchor: driver's
     `b2114ff` / `240d9e2` test cases).
   - C6 (entity attribution): ≥ 1 fixture. **Pending** (anchor:
     Cumora/yetone live import — `555feac`).
   - C218 (link-conceptual memory): ≥ 1 fixture. **Pending** (anchor:
     driver's `9fa69eb` agency-agents case).
   - C220 (media/file/video): ≥ 1 fixture. **Shipped**:
     `case_002_bridge_video_assets.json`.
   - C222 (memory ranking parity): ≥ 1 fixture. **Shipped**:
     `case_004_twitter_review_memory_ranking.json`.
   - C223 (workflow / product-context): ≥ 1 fixture. **Shipped**:
     `case_003_pr_review_workflow.json`.
4. **Source data discoverability**: `slack.db` schema is documented
   in this audit doc; future fixtures can pull `triage_run` rows
   directly by `run_id` and cite them in `source.old_slack_db_run_id`.

## Slack.db schema reference

Relevant tables for fixture extraction:

```text
triage_run (id, session_id, occurred_at, status, summary, error, digest, steps,
            duration_seconds, mutations, failures, tokens_used, channels_json,
            created_at, raw_output)
triage_tool_call (id, run_id, position, tool, action, args, success, brief,
                  created_at, result)
outbound_action (id, action_type, target, reference, session_id, summary,
                 status, created_at, updated_at)
```

A representative Bridge mutating run sequence:

```text
triage_run id=12465 (2026-05-14 04:16, mutations=1, channel=C0AN9NDQUPN)
  tool_call 1: slack_api/fetch_thread (success=1)
  tool_call 2: exa_contents (success=1)
  tool_call 3: exa_search (success=1) - JeoCryp twitter status 2054661824176365962
  tool_call 4: slack_api/post_thread_reply (success=1)
```

Mining queries (read-only):

```sql
-- Bridge mutating runs in past week
SELECT id, occurred_at, status, mutations, summary
FROM triage_run
WHERE occurred_at >= '2026-05-12'
  AND (summary LIKE '%Bridge%' OR summary LIKE '%bridge%')
  AND mutations > 0
ORDER BY occurred_at DESC;

-- Tool call shape for a chosen run
SELECT position, tool, action, success, brief
FROM triage_tool_call
WHERE run_id = ?
ORDER BY position;
```

## Coordination with #220–#223

Each of those tasks should:

1. Read the cueboard reference source (per migration-lessons audit
   rule).
2. Ship the fix + parity audit doc as usual.
3. Drop a new `case_NNN_<slug>.json` here citing the production case
   the fix is anchored on, and extend
   `runBridgeQualityFixture` if it introduces a new contract item.
4. Verify `go test ./internal/slackagent -run TestBridgeQualityCanaries -count=1` is green.

This way the canary suite grows with the entry-parity contract.

## Open follow-ups

- Wire `expected_tools_invoked` assertion (currently parsed and
  partially enforced for C220/C223 via slackToolEvidence substring;
  a full assertion needs an Agent runner mock that records
  `ExecuteSlackTool` invocations directly).
- Wire `expected_decision_shape.min_chars` / `max_chars` once worker
  results are captured (currently only the `must_not_contain` check
  runs and only against `relatedMemoryEvidence` + `slackToolEvidence`;
  output-boundary check should also scan `slackWorkerResultText` once
  a worker-result fixture lands).
- **Scaffold layer extension for C221** (worker interactive tool
  loop, commit `b3ed69e`): the scaffold currently exercises
  `buildAgentRunnerContext`, which runs before the worker executes.
  The `<oneesama_tool_request>` interception happens in
  `handleAgentRunnerUpdate` on job completion, with a continuation
  job. To canary C221 the fixture suite needs a mock runner +
  recording poster (driver's `service_worker_jobs_test.go::
TestSlackWorkerToolRequestStartsContinuationWithDispatcherEvidence`
  is the existing pin and can be ported into a fixture-driven shape
  in a future scaffold pass). Until then, treat that test as the
  C221 canary anchor.
- **Scaffold layer extension for C224** (automatic scanner triage
  entry, commit `a74db59`): the scanner entry runs through
  `scanSlackHistoryOnce` → `SweepSlackScanner` → `StartSlackTriage`,
  which requires an httptest Slack API server + a `fakeRunner` /
  recording-runner. Driver's `triage_scanner_entry_parity_test.go::
TestSlackHistoryScannerTriageCarriesMemoryAndPlannerContext`
  (146 lines) is the existing pin. To canary C224 in this fixture
  suite, the scaffold would need to accept fixture fields for
  fake-Slack history responses + previous-triage seed context, and
  drive the same pipeline. Until then, that test is the C224 canary
  anchor.
- Extract 4–6 additional fixture candidates from the 56 mutating
  Bridge runs (anchor each to a contract item that does not yet have
  a real-production fixture).

## Status

- Scaffold + 1 fixture shipped (this commit).
- C4 covered with a production-shape prompt.
- C5/C6/C220/C222/C223 fixtures wait on each task's ship.
- `TestBridgeQualityCanaries` green.
