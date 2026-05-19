# Entity Graph Memory Parity Audit — 2026-05-19

## Scope

Task #231 asks for Memory graph/entity modeling: person/project
relationships, trust, and attribution ranking. This first ship is not
a full knowledge-graph database. It ports the highest-value slice:
relationship evidence that `SearchRelatedMemory` can cite when a user
asks about connected entities.

Anchor production case: Cumora / yetone / Isoform / Alma. The answer
must preserve both positive relationships ("Cumora contact is yetone",
"yetone organization is Isoform") and the negative disambiguation
("Cumora is not related to Alma").

## Sources Read First

### Cueboard / Slack Agent D

- `people_memory_tool.go:15-20` exposed `person_memory` as the old
  assistant-facing tool for durable per-person context.
- `people_memory_tool.go:93-112` looked up multiple person profiles
  and rendered lookup/briefing output.
- `defaults.go:149` instructed assistants to call `person_memory`
  first for person questions.
- `people_memory.go` projected identity notes, durable team memory,
  responsibilities, and meeting participation into
  `memory/people/*.md`.

### Hermes / Holographic / Hindsight

- `hindsight/README.md:1-3` describes long-term Memory with a
  knowledge graph, entity resolution, and multi-strategy retrieval.
- `hindsight/README.md:120-122` exposes retain/recall/reflect tools
  with entity extraction and semantic + graph recall.
- `holographic/store.py:30-41` stores entities and fact/entity links.
- `holographic/store.py:150-183` inserts facts, extracts entities,
  links them, and computes an HRR vector.
- `holographic/retrieval.py:55-63` ranks retrieval with lexical,
  structural, and trust-weighted scoring.
- `holographic/retrieval.py:198-258` finds facts structurally related
  to an entity.
- `holographic/retrieval.py:266-336` supports multi-entity
  compositional queries.

## Behavior Comparison

### Behavior 1: Entity relationship evidence is first-class

- Old / reference behavior:
  - Cueboard had flat person profiles and a `person_memory` tool; it
    did not have a standalone KG provider, but it exposed identity and
    responsibilities as durable first-class evidence.
  - Hermes/Holographic stores entities and fact/entity edges.
- New behavior:
  - `entity_graph` is a `SlackMemoryProvider`.
  - It scans workspace Memory files, extracts relationship facts, and
    emits `entity_graph` `SlackRelatedMemoryRecord`s through the same
    provider merge path used by semantic Memory.
  - The evidence content renders relationship lines with source paths.
- Decision:
  - Port the relationship evidence layer now, defer full graph DB /
    HRR / trust scoring.
- Fixtures:
  - `TestEntityGraphMemoryProviderResolvesRelationshipChain`
  - `case_005_entity_graph_resolution.json`

### Behavior 2: Multi-hop context is preserved

- Old / reference behavior:
  - Holographic `related` / `reason` retrieval can traverse entity
    structure and multi-entity overlap.
- New behavior:
  - The local provider starts from query entities, expands up to two
    relationship hops, and returns a bundle. In the anchor case,
    querying Cumora also brings in yetone -> Isoform.
- Decision:
  - Keep the two-hop expansion as a bounded, inspectable local
    version of entity-graph traversal.
- Fixtures:
  - `TestEntityGraphMemoryProviderResolvesRelationshipChain`

### Behavior 3: Negative relationship / disambiguation survives

- Old / reference behavior:
  - Production traces showed that "not related" facts matter; losing
    them causes the system to blend projects/entities incorrectly.
- New behavior:
  - `not_related_to` is a separate relationship predicate and renders
    as "X is not related to Y".
  - The case_005 canary explicitly asserts "Cumora is not related to
    Alma".
- Decision:
  - Port. Negative relationship evidence is not a footnote; it is a
    quality invariant for entity attribution.
- Fixtures:
  - `case_005_entity_graph_resolution.json`

### Behavior 4: Alias resolution exists, but stays local and simple

- Old / reference behavior:
  - Cueboard person memory matched names, aliases, handles, and file
    slugs through identity-map projection.
  - Holographic resolves entity names and aliases before linking facts.
- New behavior:
  - `entity_graph` normalizes `@handle` aliases and simple explicit
    alias lines like `yetone aliases: 大yetone, @yetone`.
  - ASCII handles also get `@handle` and `大handle` variants so common
    Slack/user nickname forms hit the same canonical entity.
- Decision:
  - Keep this as a lightweight first step. Full alias governance
    belongs with a later entity model / trust task.
- Fixtures:
  - `TestEntityGraphMemoryProviderResolvesAliases`

## Known Limits

- This is not a persistent graph database. It rebuilds from workspace
  Markdown on search, which is acceptable for the current workspace
  scale and keeps provenance obvious.
- Trust scoring is not implemented. Provider scores are relevance
  scores, not truth confidence. Holographic-style trust adjustment is
  still future work.
- Relationship extraction is deliberately narrow. It recognizes
  contact/owner, organization/team, and not-related patterns. More
  predicates should come from real canary failures, not from inventing
  a taxonomy up front.
- Alias resolution is local. There is no cross-workspace entity ID or
  merge UI yet.

## Verdict

Task #231 now has a concrete first implementation:

- Entity-relationship evidence is emitted through the Memory provider
  contract.
- `SearchRelatedMemory` can retrieve relationship bundles with source
  paths and `memory_provider:entity_graph`.
- The Cumora/yetone/Isoform/Alma canary is active and asserts the
  negative Alma disambiguation.

This is enough to close the highest-value entity graph regression
without pretending Oneesama has a full Hindsight/Holographic-grade KG
yet.
