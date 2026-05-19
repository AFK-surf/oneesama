# Memory Auto-Extraction Parity Audit — 2026-05-19

## Scope

Task #230 asks for Memory auto-extraction: conversation turns should
be able to feed durable Memory growth without relying only on explicit
`memory_write` commands.

This audit compares:

- Cueboard / old Slack Agent D self-growth and lesson candidate loop.
- Hermes Memory providers that ingest turns through `sync_turn`.
- New Oneesama `SlackMemoryProvider.SyncTurn` routing and
  conservative extraction candidate provider.

## Sources Read First

### Cueboard / Slack Agent D

- `improvement_self_growth.go:72-136` defines a catalog of feedback
  topics, severity, and matching keywords.
- `improvement_self_growth.go:180-206` builds improvement signals
  from user text, transcript, and assistant text.
- `improvement_self_growth.go:354-409` records those signals,
  clusters them, and optionally posts an interim note.
- `improvement_self_growth.go:411-459` syncs an improvement cluster
  into heartbeat followups.
- `improvement_self_growth.go:691-724` writes lesson candidates and
  self-growth Memory blocks when the signal is eligible.
- `improvement_self_growth.go:795-821` upserts the self-growth block
  into workspace `MEMORY.md`.

### Hermes Memory

- `mem0/__init__.py:272-295` sends a user/assistant turn to Mem0 for
  server-side fact extraction in the background.
- `supermemory/__init__.py:563-590` captures cleaned user/assistant
  turns as a `conversation_turn` memory when auto-capture is enabled.
- `byterover/__init__.py:237-262` curates substantive turns in a
  background task and mirrors explicit memory writes separately at
  `byterover/__init__.py:264-280`.

## Behavior Comparison

### Behavior 1: Route user/assistant turns to Memory providers

- Old / reference behavior:
  - Hermes providers expose `sync_turn` as a first-class event for
    Memory backends.
  - Cueboard did not have this generic provider hook, but it did have
    self-growth ingestion from turn-like text and assistant output.
- New behavior:
  - `SlackMemoryProvider` already had `SyncTurn` in task #228.
  - `slackMemoryProviderManager.SyncTurn` now routes non-empty turns
    to all available initialized providers.
  - Slack worker completions call `syncSlackWorkerMemoryTurn` after
    successful thread reply or Canvas publish, preserving session,
    channel, thread, job id, and delivery surface metadata.
- Decision:
  - Port. This closes the #228 contract gap and gives future
    mem0/supermemory/hindsight-style providers an event surface.
- Fixtures:
  - `TestMemoryProviderManagerSyncTurn`
  - `TestSlackWorkerResultSyncsMemoryTurn`
  - `case_004_sync_turn_extraction.json`

### Behavior 2: Generate durable Memory candidates conservatively

- Old / reference behavior:
  - Cueboard promoted repeated or explicit self-growth signals into
    lesson candidates and a reviewable self-growth Memory block.
  - Hermes providers can auto-capture turns directly, depending on
    backend policy.
- New behavior:
  - `turn_extractor` is registered when Slack Memory is enabled.
  - It listens to `SyncTurn`, detects explicit Memory-like turn
    markers, and writes a reviewable Markdown candidate under
    `memory/extractions/candidates/YYYY-MM-DD/turn-<hash>.md`.
  - Candidate files include schema, status `review_candidate`,
    source, session, redaction count, original user turn, assistant
    turn, metadata, and review guidance.
  - It does **not** promote extracted facts straight into stable
    person/project/team Memory.
- Decision:
  - Keep current conservative gate. Direct auto-promote would be too
    aggressive for cutover; review candidates provide durable growth
    without treating every assistant statement as verified truth.
- Fixtures:
  - `TestTurnExtractionMemoryProviderWritesReviewCandidate`

### Behavior 3: Avoid duplicating the same candidate repeatedly

- Old / reference behavior:
  - Cueboard clusters improvement signals and upserts heartbeat
    followups by cluster source ref instead of creating unbounded
    duplicate reminders.
- New behavior:
  - `turn_extractor` deduplicates by session + user content +
    assistant content + candidate hash before writing.
- Decision:
  - Port the boundedness principle in provider-local form. Later
    work can add workspace-level semantic dedup once #231 entity
    graph / #232 quality canaries mature.
- Fixtures:
  - `TestTurnExtractionMemoryProviderWritesReviewCandidate`

## Differences and Known Limits

- The first provider is marker-based and conservative. The marker
  list (`记下来`, `remember`, `contact`, etc.) is a Class 2 routing
  keyword debt and should eventually move to workspace-configurable
  policy with the other #199 keyword externalization work.
- This does not yet run on every possible turn source. It currently
  covers Slack worker results because that is the production user-
  visible Memory path with the clearest request/result pair. Scanner
  triage, delayed followup, and persona-internal turns can be added
  once their turn boundaries are explicitly defined.
- Candidate generation is not semantic fact extraction. It persists
  reviewable source material. A future provider may call a delegated
  extractor or a vector/graph backend, but the write should still stay
  reviewable unless trust scoring marks it safe.
- `OnPreCompress` and `OnDelegation` remain interface hooks without
  manager routing. They are separate follow-ups from #230.

## Verdict

Task #230 closes the immediate Memory auto-extraction gap at the
provider-contract layer:

- `SyncTurn` now has real manager routing.
- Slack worker result turns are mirrored into Memory providers.
- A default conservative `turn_extractor` provider creates durable
  review candidates.
- The #232 canary suite now has an active `sync_turn_extraction`
  fixture.

This is intentionally **not** a high-confidence automatic fact writer.
It is the first safe rung: production turns become durable,
reviewable Memory candidates, and stronger Hermes-style providers can
plug into the same `SyncTurn` surface later.
