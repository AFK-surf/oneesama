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
- `internal/slackagent/testdata/memory_quality_fixtures/case_003_semantic_recall.json`
  pins the #229 semantic recall path by creating a fixture-local
  semantic index, enabling the local semantic provider, and asserting
  the provider-backed anchors appear in `SearchRelatedMemory`.
- `internal/slackagent/memory_quality_canary_test.go::
  TestMemoryQualityCanaries` loads every `case_*.json` file under
  the fixtures dir, builds a fresh `Service` with the provider
  registered, drives the appropriate code path, and asserts both
  per-scenario hook activity and `must_not_contain` fail-closed
  rules.

What is NOT in this ship:

- Assertions for `OnPreCompress` and `OnDelegation` hooks. These
  exist on the `SlackMemoryProvider` interface (commit `a4e874e`)
  but are not yet routed through `slackMemoryProviderManager`.
  `Search`, `OnMemoryWrite`, and `SyncTurn` are now routed and
  covered by fixture cases.
- Multi-provider conflict scenarios (two providers, dedup, score
  blending). Future #230 / #231 may surface these; until then a
  single-provider canary is the right baseline.

## Provider double

`memory_provider_test.go` ships the canonical test double
`simpleRecordingMemoryProvider` (Search + OnMemoryWrite + SyncTurn +
Initialize + Available + Name). This canary suite reuses that double
directly; no parallel double is defined here. Future scenarios that
need compress/delegation hook recording will extend
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

Semantic recall fixtures use this shape:

```json
{
  "scenario": {
    "type": "semantic_recall",
    "search": {"query": "<semantic query>", "limit": 5},
    "provider_seed_records": [
      {"path": "semantic/example.md", "content": "<indexable evidence>", "kind": "semantic_memory"}
    ]
  },
  "expected_search_result_anchors": ["semantic/example.md", "<evidence anchor>", "memory_provider:local_semantic"]
}
```

The test creates a fixture-local semantic index from
`provider_seed_records`, so it does not depend on live workspace data
or an external embedding backend.

## Coordination with #229 / #230 / #231 / #233

- #229 (semantic recall): owns case_003 and the local semantic
  provider implementation.
- #230 (auto-extraction): new scenario type `sync_turn_extraction` —
  drive a turn through the service, assert provider's `SyncTurn`
  hook fired, and pin the conservative extraction-provider entry
  point.
- #231 (entity graph): new scenario type `entity_resolution` — seed
  multiple relationship records with aliases, assert the provider
  returns relationship evidence with positive and negative links.
  Landed as `entity_graph_resolution` in case_005.
- #233 (multimodal ingestion): new scenario type
  `multimodal_ingestion` — pass a media-heavy app mention through
  the real app-mention context builder, assert a reviewable
  multimodal Memory candidate is written, then verify
  `SearchRelatedMemory` recalls the evidence through
  `memory_provider:multimodal_memory`.

## Status

- Scaffold + 6 fixtures shipped; case_003 was flipped from pending
  to active by task #229, case_004 was flipped from pending to
  active by task #230, case_005 was flipped from pending to active
  by task #231, and case_006 landed active with task #233.
- C232-A `durable_write_replay`: green.
- C232-B `provider_search_merge`: green.
- C232-C `semantic_recall`: green.
- C232-D `sync_turn_extraction`: green.
- C232-E `entity_graph_resolution`: green.
- C232-F `multimodal_ingestion`: green.
- `go test ./internal/slackagent -count=1`: green.

## Open follow-ups

- Land the `OnPreCompress` / `OnDelegation` routing through
  `slackMemoryProviderManager`. Driver's
  `self-growth-memory-provider-parity-audit-2026-05-19.md` notes
  these as the remaining manager-side steps; canary fixtures will
  follow once those hooks are reachable.
- Add multi-provider scenarios (two providers, score-blending,
  conflict resolution) once #229 + a second provider impl exist.
- Wire `must_not_contain` to also scan `Search` responses, not only
  `OnMemoryWrite` event content. Currently only write events get
  banned-token scanned; if a provider's `Search` response leaks
  internal strings via record content, that should also fail.
