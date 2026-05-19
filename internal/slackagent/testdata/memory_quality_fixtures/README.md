# Memory Quality Fixtures

These fixtures back task #232: real-case semantic recall and durable-
write replay canaries for the pluggable Memory provider contract
(`SlackMemoryProvider`, `slackMemoryProviderManager`, commit `a4e874e`).

This suite is distinct from `bridge_quality_fixtures/` (task #219):
- `bridge_quality_fixtures` pins app-mention entry-parity contract items
  (C1-C7 + C218 + C220 + C222 + C223). Layer:
  `buildAgentRunnerContext`.
- `memory_quality_fixtures` (this dir) pins **Memory provider contract
  events** (Search / OnMemoryWrite / SyncTurn / OnPreCompress /
  OnDelegation). Layer: `slackMemoryProviderManager` + tool dispatch.

## Fixture schema

Each `case_NNN_<slug>.json`:

```json
{
  "case_id": "case_001_durable_write_replay",
  "source": {
    "occurred_at": "2026-05-19T15:00:00+08:00",
    "notes": "..."
  },
  "scenario": {
    "type": "durable_write_replay" | "semantic_recall" | "provider_hook_wiring",
    "memory_write": {
      "path": "memory/team/example.md",
      "content": "fact body",
      "mode": "append" | "overwrite",
      "session_id": "session_test"
    },
    "search": {
      "query": "example query",
      "limit": 5
    },
    "provider_seed_records": [
      {
        "path": "memory/seed.md",
        "content": "...",
        "score": 0.9,
        "reasons": ["seed_provider"]
      }
    ]
  },
  "expected_provider_events": {
    "on_memory_write_count": 1,
    "search_query_seen": "example query",
    "search_records_returned_min": 1
  },
  "expected_search_result_anchors": [
    "fact body",
    "memory/team/example.md"
  ],
  "must_not_contain": [
    "127.0.0.1",
    "/slack/tools/call"
  ]
}
```

## Scenario types

- `durable_write_replay`: invoke the memory_write tool, assert the
  Memory provider receives `OnMemoryWrite`, then assert subsequent
  `SearchRelatedMemory` (which polls providers) returns evidence.
- `semantic_recall`: STUB until #229 ships a real
  semantic/vector provider. The fixture is shipped with stub
  data; `runMemoryQualityFixture` will skip the assertion with a
  `t.Logf` until a non-`SlackMemoryNoopProvider` impl is registered.
- `provider_hook_wiring`: trigger lifecycle / pre-compress /
  delegation events through service code paths (when wired through
  manager). Currently only `OnMemoryWrite` and `Search` are routed
  through the manager (`a4e874e`); `SyncTurn` / `OnPreCompress` /
  `OnDelegation` are interface-only and remain manager-side
  follow-ups documented in this suite.

## Provider double

`memory_quality_canary_test.go` defines a test-only
`recordingMemoryProvider` that:

- Records every hook invocation (search requests, write events,
  turns, compressions, delegations).
- Returns seed records on `Search`, configurable per fixture.

This is the canonical doubleable provider for any future Memory test
that wants to assert hook wiring without spinning up mem0 /
supermemory etc.
