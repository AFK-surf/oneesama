# OpenClaw + Hermes Memory Roadmap — Canary-First Task Split

Status: documentation for task #289. Splits the remaining OpenClaw / Hermes Memory capabilities into per-capability tasks where the **canary fixture is written FIRST**, defines acceptance, and only then the implementation lands. This protects against the recurring drift class "tool surface migrated, behaviour did not" (`migration-lessons-audit-method.md` drift class 8).

Source roadmap: `docs/persona-runtime.md` lines 65-71 (OpenClaw + Hermes capability reference) and the Phase 2 / Phase 4 implementation plan in the same doc.

## Capability inventory

Anchored against `notes/code-polish/memory-provider-ownership-matrix-2026-05-21.md` (task #284) and `notes/code-polish/canary-fixture-index-2026-05-21.md` (task #296). What is already implemented, what is missing.

### Already shipped (OpenClaw side)

| Capability                           | Surface                                                                                    | Anchor canary                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Structured workspace memory files    | `<workspaceDir>/memory/**/*.md` classified by `relatedMemoryKindForPath`                   | `TestRelatedMemoryKindForPathMatrix`                                                                         |
| Explicit source refs on every record | `SlackRelatedMemoryRecord.Source / SourcePath / SourceRef`                                 | `TestSearchRelatedMemoryLabelsPersonaMemoryWrites`                                                           |
| Agent-authored durable writes        | `memory/persona/writes/<date>/<kind>-<hash>.md` via `persistPersonaForegroundMemoryWrites` | `TestSlackTriageLivePersonaForegroundPostsPersonaReplyInsteadOfCodexAction` covers write → search round-trip |
| Retrieval with citation reuse        | `personaCitationsFromRelatedMemory` injects Citations into persona request                 | covered indirectly across `case_001..006` memory quality fixtures                                            |

### Already shipped (Hermes side)

| Capability                                                                   | Surface                                                                         | Anchor canary                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Semantic recall                                                              | `semanticMemoryProvider` reads `memory/indexes/semantic-memory.json`            | `case_003_semantic_recall.json`                                                                                        |
| Entity relationships                                                         | `entityGraphMemoryProvider` synthesizes person/project graph                    | `case_005_entity_graph_resolution.json`                                                                                |
| Multimodal evidence ingestion                                                | Workspace scanner walks `memory/multimodal/` (task #272 collapsed double-index) | `case_006_multimodal_ingestion.json`, `TestMultimodalMemoryNoDoubleIndex`                                              |
| Memory provider contract + ownership matrix                                  | `SlackMemoryProvider` interface + manager (task #228 + #284)                    | `memory_provider_ownership_test.go` matrix tests                                                                       |
| Memory ranking unification (provider records get family boost + suppression) | Task #272 changes to `slackMemoryProviderManager.Search`                        | `TestRelatedMemoryProviderRecordsReceiveFamilyBoost`, `TestRelatedMemoryProviderRecordsSuppressLegacyActionlessPolicy` |

### Remaining capabilities (the work this task splits)

Each row below is a candidate sub-task. The capability column is the user-visible behaviour the canary must prove; the implementation column is the change that comes after the canary lands.

| #     | Capability                                                                                                                                                                                                                                                                                                            | Canary fixture (write FIRST)                                                                                                                                                                                                                                                                                                                                                                 | Implementation slice (after canary red, then green)                                                                                                                                                                                                                                                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 289-A | **Trust scoring on Memory records** — every retrieved record carries a numeric trust score derived from source kind, provenance, age, and contradiction history. Low-trust records must rank below high-trust ones at equal lexical match.                                                                            | `case_007_trust_score_lowtrust_below_hightrust.json`: same query matches both a `legacy_triage_archive` actionless trace AND a recent `persona_memory_write`. Assert: persona_memory_write ranks first, trust delta visible in record reasons (`trust_score:<float>`), legacy hit is below cutoff or annotated low-trust.                                                                    | Add `Trust` field to `SlackRelatedMemoryRecord`. Populate via new `relatedMemoryTrustScore(kind, sourcePath, age, contradictions)` called from both workspace scanner and `slackMemoryProviderManager.Search`. Use trust to break ties + apply a configurable cutoff.                                                                                               |
| 289-B | **Staleness scoring** — records older than the freshness horizon for their kind decay in score, even if lexical match is strong. Persona must prefer fresh evidence and explicitly cite "this is from N days ago" when surfacing stale evidence.                                                                      | `case_008_staleness_decay_recent_wins.json`: two `daily_note` records match the same query, one written today and one from 60 days ago. Assert: today's record ranks first, stale record's `Reasons` contains `staleness_penalty:<days>`, score gap exceeds X.                                                                                                                               | Extend `relatedMemoryRecencyBoost` to a full kind-aware staleness curve (it currently only boosts dates within today's date math, doesn't penalize old ones). Define `relatedMemoryStalenessHorizonDays(kind)` table. Apply same direction (penalty) to provider records.                                                                                           |
| 289-C | **Episodic consolidation across sessions** — repeated facts/preferences from multiple sessions get consolidated into a single durable `memory/team/facts/*` or `memory/people/*` entry instead of accumulating duplicate per-session candidates.                                                                      | `case_009_episodic_consolidation.json`: synthesize 3 turn-extractor candidate writes across 3 sessions all asserting the same Peng preference about commit signing. Assert: after the 3rd write, a consolidator promotes them into `memory/team/facts/<canonical-slug>.md` with `consolidated_from: [session1, session2, session3]` provenance; the 3 candidates are marked `superseded_by`. | New `episodicConsolidator` background pass: scan `memory/extractions/candidates/<date>/turn-*.md` for content-similar candidates above N occurrences and propose consolidation. Initial slice: emit consolidation candidates as `memory/lessons/candidates/<date>/consolidation-*.md` for human review; do not auto-write to `memory/team/facts/` without approval. |
| 289-D | **Shared episode store between Slack and Meet** — when a Slack thread and a Meet meeting reference the same project/person, persona retrieval surfaces both as evidence (not just the surface that originated the query). Currently `meetingagent` and `slackagent` Memory paths are disjoint at the retrieval layer. | `case_010_cross_surface_episode_recall.json`: write a `memory/team/meetings/<id>.md` with "Peng asked about Linear API quota" + a `memory/triage-archive/<date>.md` with the same query. Assert: a Slack mention "Linear API quota 还卡 quota 吗" recalls BOTH records with `cross_surface_recall` reason.                                                                                   | Either (a) lift `SlackMemoryProvider` and the workspace scanner walk to a shared `internal/workspace` package that meetingagent also consumes, or (b) add a `MeetingMemoryReader` interface that slackagent can call when query tokens overlap meeting-specific markers. Recommend (a); confirm via RFC before code.                                                |
| 289-E | **Trust/staleness audit canary** — runtime status exposes a per-kind summary of retrieved record trust + age so the operator can spot the workspace going stale or a provider over-weighting low-trust evidence.                                                                                                      | `case_011_memory_quality_summary.json`: drive 50 fake queries against a fixture workspace, assert resulting `slack/status.memory_quality` block reports per-kind {count, mean_trust, mean_staleness_days, low_trust_count}.                                                                                                                                                                  | Add `memory_quality` block to slack `/status` populated by a lightweight summarizer fed off `SearchRelatedMemory` results. Reuses the trust + staleness fields from 289-A/B; gated by their landing.                                                                                                                                                                |
| 289-F | **Contradiction detection at write time** — when an agent writes a memory contradicting an existing high-trust record (e.g. "Peng prefers X" then later "Peng prefers Y"), the write lands as a `memory/lessons/candidates/contradiction-*.md` for review rather than silently shadowing the old one.                 | `case_012_contradiction_routes_to_review.json`: pre-populate `memory/people/peng.md` with "prefers signed commits". Then run a `persistPersonaForegroundMemoryWrites` with content "Peng now prefers unsigned commits". Assert: file lands under `memory/lessons/candidates/contradiction-*.md`, not silently replacing `memory/people/peng.md`.                                             | Add `contradictionDetector` that pre-checks any persona memory write against existing person/team records by canonical-slug + simple negation/conflict heuristics. Defer LLM-based conflict scoring to a follow-up.                                                                                                                                                 |

## Recommended task ordering

These rows compose into a dependency graph. Trust + staleness are foundational because 289-D, 289-E, and 289-F all depend on them. Suggested merge sequence:

1. 289-A (Trust scoring) — blocks 289-D / 289-E / 289-F
2. 289-B (Staleness scoring) — independent of 289-A but cheap and unblocks 289-E
3. 289-E (Quality summary) — observability win after 289-A + 289-B
4. 289-F (Contradiction at write) — needs trust to define "high-trust" baseline
5. 289-C (Episodic consolidation) — independent; can land in parallel with 289-A/B
6. 289-D (Shared episode store) — biggest scope; RFC first; depends on 289-A for cross-surface trust

## Canary-first protocol (mandatory for each task above)

Each sub-task must follow this protocol before any implementation code lands:

1. **Land the JSON / Go canary first** in a single commit titled `test(slack): pin <capability> canary fixture (task #289-X)`. The canary MUST fail (red) at this point — that's the definition of acceptance.
2. **Then land the implementation** in a separate commit titled `feat(slack): <capability> (task #289-X)`. The canary turns green; no other behaviour change is allowed in this commit.
3. **Then land follow-up cleanups** (test isolation, doc updates) as additional commits.

This split prevents the "tool surface migrated, behaviour did not" drift class — if the canary cannot drive acceptance from red to green, the implementation is reasoning about a moving target.

## Out of scope for #289 (explicitly)

- Choosing the exact trust/staleness formula constants (leave to per-task RFC).
- Implementing 289-A through 289-F. Each becomes its own task once the project moves to that slice.
- Re-litigating whether OpenClaw + Hermes is the right reference (settled per Peng's 2026-05-21 direction; see `~/.claude/projects/.../memory/feedback_reference_systems.md`).
- Cross-machine Memory federation (separate concern, not on the OpenClaw + Hermes shape).

## Open RFC questions

Pulled forward from `docs/persona-runtime.md` Open Questions and tagged here so the per-task RFCs answer them:

- **Q1 (289-D)**: should the Pi-style runtime be embedded in-process, called as a local HTTP service, or invoked through an agent protocol? Cross-surface episode store choice (a/b above) leans on this answer.
- **Q2 (289-C)**: where should Oneesama store episode memory and world-state updates so they can be shared by Slack and Meet? Same answer as Q1.
- **Q3 (289-E)**: which channels/meeting sessions should be the first canary cohort? Probably `#meeting-avatar` itself + the live dogfood meeting.
- **Q4 (none)**: what is the minimum "lobster" dogfood script: one meeting, one Slack thread, or both?

## Maintenance

- When a sub-task lands its canary commit, link the commit SHA next to the row above and check off the canary cell.
- When the implementation commit lands and turns the canary green, move the row to the "Already shipped (Hermes side)" table and add the canary to `notes/code-polish/canary-fixture-index-2026-05-21.md`.
- If a capability turns out to be unnecessary (e.g. trust scoring not justified by canary failures), document the retirement here rather than silently dropping it.
