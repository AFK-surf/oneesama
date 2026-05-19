# Memory Recall Ranking Parity Audit — 2026-05-19

Task: #222  
Status: fixed in this slice

## Scope

This audit covers one production-quality drift surfaced by the
post-cutover Bridge sweep: Oneesama had imported old Slack Agent D
runtime traces, but ranking still treated those traces as ordinary
Markdown. A generic recent note could outrank a trace that contained
the exact old `memory_search` / `memory_get` chain and the decision it
produced.

This is not a new memory surface. It is a ranking rule for the
`runtime traces as memory` drift class.

## Sources Read First

Old Slack Agent D / Cueboard:

- `internal/core/memory/search.go:49-91` — `KeywordSearcher.Search`
  chunked Markdown, scored by query keyword hit ratio, then sorted by
  score.
- `internal/core/memory/search.go:104-125` — query tokenization and
  `scoreChunk`.
- `internal/bridge/slack/defaults.go:392-403` — prompt policy telling
  the assistant to use `memory_get` / `memory_search` for old
  decisions, identity map, people memory, team context, and lesson
  guardrails.
- `internal/bridge/slack/people_memory.go:124-182` —
  person/profile ranking prioritized exact identities and durable
  person-specific context.
- Live old runtime trace:
  `runtime/live-workspace/memory/legacy/slack-agent-d/workspace/memory/triage-archive/2026-05-17.md`
  run `49eeb085-e5e1-43a3-b458-d935df43a5d6`, corresponding to
  `slack.db` run id `13289`, with
  `memory_search {"query":"Twitter reply review workflow"}` and the
  decision "waiting for human approval".

New Oneesama:

- `internal/slackagent/related_memory.go:284-303` — structured
  boosts applied after lexical score.
- `internal/slackagent/related_memory.go:359-373` — new
  `legacy_tool_trace_boost`.
- `internal/slackagent/bridge_quality_canary_test.go:144-157` —
  C222 fixture assertion that the legacy trace is the top related
  memory evidence.

## Behavior 1: old runtime traces containing memory tool calls rank as decision evidence

### Old does

Old Slack Agent D did not only read `memory/*.md`; it also left
runtime traces that show which memory calls were useful for a future
classification. The 2026-05-17 Twitter review trace records:

- `memory_get {"path":"memory/2026-05-17.md"}`
- `memory_search {"query":"Twitter reply review workflow"}`
- final decision: a Twitter reply review card is waiting for human
  approval, so the bot should not act on it.

The old prompt policy explicitly taught the assistant to use memory
tools for older decisions and durable context
(`defaults.go:392-403`).

### New did before this slice

Oneesama imported the trace into
`memory/legacy/slack-agent-d/workspace/memory/triage-archive/*.md`,
but it only received the generic `legacy_triage_archive` family boost.

That meant the following tie could go the wrong way:

- generic recent daily note: lexical score `1.00` + recent boost
  `0.18` = `1.18`
- old Agent D trace: lexical score `1.00` + legacy archive boost
  `0.14` = `1.14`

For the exact old query `Twitter reply review workflow`, the generic
note incorrectly ranked above the trace with the actual tool chain and
decision.

### New does now

`relatedMemoryLegacyToolTraceBoost` adds an additional boost only for
legacy triage archive chunks that:

- have a meaningful lexical match (`base >= 0.35`);
- contain `Tool calls:`;
- contain a memory-related old-tool marker:
  `memory_search`, `memory_get`, or `person_memory`.

This is intentionally narrow: it does not make every old log line win.
It promotes old traces that prove a memory/person-memory tool call was
part of the answer chain.

### Decision

Port / align.

Runtime traces are memory when they contain the tool calls and
evidence path that made a prior old-Agent-D answer good. A recent
generic note is useful, but it should not outrank a matching old
trace that explains the prior operational decision.

### Fixtures

- `TestSearchRelatedMemoryRanksLegacyToolTraceAboveGenericRecentNote`
  creates the exact tie: a generic recent daily note vs. a legacy
  trace for `Twitter reply review workflow`. It failed before the
  boost and passes after.
- `case_004_twitter_review_memory_ranking.json` anchors the same
  scenario in the Bridge quality canary suite. The C222 assertion
  requires the first related-memory evidence line to cite the legacy
  triage archive before the generic daily note.

## Non-goals

- This does not replace the lexical searcher with embeddings.
  Cueboard's default searcher was lexical too.
- This does not make all trace data high-priority; only matching
  old memory/person-memory tool traces get promoted.
- This does not solve fresh unknown entities; task #216 / #221 cover
  first-class tool dispatch for fresh evidence.

## Follow-ups

- Add more C222 fixtures as real regressions appear, especially where
  old Agent D used `person_memory` for owner/person recall and the new
  ranking has to choose between a person profile, a daily note, and a
  legacy trace.
- If the score rules keep growing, split ranking policy into a small
  table-driven scorer so future boosts can cite old behavior without
  burying intent in Go conditionals.
