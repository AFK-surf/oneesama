# Memory Quality Canary — 2026-05-19 (task #232)

## Goal

Pin the new Memory provider contract (`SlackMemoryProvider`,
`slackMemoryProviderManager`, commit `a4e874e`) against real
production-shape scenarios so a future regression in
provider routing or hook wiring shows up as a fixture failure, not
as a silent quality drop.

This suite is the Memory-axis analogue of `#219`'s
`bridge_quality_fixtures`. Same audit philosophy
(`migration-lessons-audit-method.md`), different layer:

- `bridge_quality_fixtures` (task #219): app-mention entry-parity
  contract items at the `buildAgentRunnerContext` layer.
- `memory_quality_fixtures` (this task): Memory provider contract
  events at the `slackMemoryProviderManager` + tool dispatch layer.

## Scope of this ship

What lands here:

- `internal/slackagent/testdata/memory_quality_fixtures/README.md`
  documents the JSON schema and the three supported scenario types.
- `internal/slackagent/testdata/memory_quality_fixtures/case_001_durable_write_replay.json`
  pins the durable-write hook: a memory_write tool invocation must
  reach `OnMemoryWrite` on every registered provider, with the
  expected path + content substring.
- `internal/slackagent/testdata/memory_quality_fixtures/case_002_provider_search_merge.json`
  pins the search-merge hook: a `SearchRelatedMemory` invocation
  must see the provider's records appear in merged results when the
  provider returns seed records.
- `internal/slackagent/testdata/memory_quality_fixtures/case_003_semantic_recall_pending.json`
  is a STUB fixture for the #229 semantic recall path. It is marked
  `pending: true` so the canary suite logs and skips, instead of
  failing or passing under false pretense. When #229 ships a
  non-Noop semantic provider, the pending flag flips off and the
  fixture's `intended_evidence` becomes the assertion.
- `internal/slackagent/memory_quality_canary_test.go::
  TestMemoryQualityCanaries` loads every `case_*.json` file under
  the fixtures dir, builds a fresh `Service` with the provider
  registered, drives the appropriate code path, and asserts both
  per-scenario hook activity and `must_not_contain` fail-closed
  rules.

What is NOT in this ship:

- A real semantic / vector provider implementation — that is task
  #229 and lands separately. Case 003 is the pre-built fixture slot
  for that work; #229 only needs to drop in a provider, not
  re-author the canary scaffold.
- Assertions for `SyncTurn`, `OnPreCompress`, `OnDelegation` hooks.
  These exist on the `SlackMemoryProvider` interface (commit
  `a4e874e`) but are not yet routed through
  `slackMemoryProviderManager` — only `Search` and `OnMemoryWrite`
  are. When the manager routes them, runMemoryQualityFixture grows
  scenario branches; today the contract for them is
  interface-only and the canary doc records that explicitly.
- Multi-provider conflict scenarios (two providers, dedup, score
  blending). Future #230 / #231 may surface these; until then a
  single-provider canary is the right baseline.

## Provider double

`memory_provider_test.go` ships the canonical test double
`simpleRecordingMemoryProvider` (Search + OnMemoryWrite +
Initialize + Available + Name). This canary suite reuses that double
directly; no parallel double is defined here. Future scenarios that
need turn/compress/delegation hook recording will extend
`simpleRecordingMemoryProvider` rather than create a new type.

## Methodology anchor

This suite is the operational form of the audit method in
`migration-lessons-audit-method.md` applied to the Memory layer:

- For each provider contract event, write a fixture file that pins
  the expected hook activity by substring.
- The fixture is JSON, replayable, and explicitly cites the
  production scenario it represents in its `source.notes`.
- Failing a fixture is the regression signal; the fix is to restore
  hook wiring or contract behavior, not to relax the fixture.

When `#229` ships a semantic provider, the next case file shape is:

```
case_NNN_semantic_<slug>.json:
  scenario.type = "semantic_recall"
  scenario.pending = false       # flip from true
  scenario.search.query = "<the semantic-only query>"
  expected_search_result_anchors = [ <the semantically-adjacent evidence> ]
```

The canary scaffold already routes that type to a scenario branch
(currently a permissive log). #229's task is to add the assertion
body to that branch + ship a real provider.

## Coordination with #229 / #230 / #231 / #233

- #229 (semantic recall): unlocks case_003 stub. Replace pending=
  true with a concrete query + anchor list.
- #230 (auto-extraction): new scenario type `sync_turn_extraction` —
  drive a turn through the service, assert provider's `SyncTurn`
  hook fired (requires the manager to route `SyncTurn`, which is
  the gating sub-task).
- #231 (entity graph): new scenario type `entity_resolution` — seed
  multiple person records with aliases, assert resolver merges
  them. Likely overlaps with `people_memory` parity tests, but the
  fixture-driven shape stays consistent.
- #233 (multimodal ingestion): new scenario type
  `multimodal_ingest` — pass a file / image evidence, assert the
  provider receives it as an indexable record. Layer: provider's
  ingestion hook (TBD by #233 design).

## Status

- Scaffold + 3 fixtures shipped.
- C232-A `durable_write_replay`: green.
- C232-B `provider_search_merge`: green.
- C232-C `semantic_recall_pending`: skipped (pending #229).
- `go test ./internal/slackagent -count=1`: green.

## Open follow-ups

- Land the `SyncTurn` / `OnPreCompress` / `OnDelegation` routing
  through `slackMemoryProviderManager`. Driver's
  `self-growth-memory-provider-parity-audit-2026-05-19.md` notes
  this as the next manager-side step; canary fixtures will follow
  once those hooks are reachable.
- Add multi-provider scenarios (two providers, score-blending,
  conflict resolution) once #229 + a second provider impl exist.
- Wire `must_not_contain` to also scan `Search` responses, not only
  `OnMemoryWrite` event content. Currently only write events get
  banned-token scanned; if a provider's `Search` response leaks
  internal strings via record content, that should also fail.
