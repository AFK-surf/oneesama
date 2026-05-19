# Semantic Memory Provider Parity Audit — 2026-05-19

## Scope

Task #229 turns the task #228 provider contract into a first concrete semantic recall path.

This is intentionally a **local optional provider**, not a default live behavior change:

- Existing lexical workspace / feedback / legacy trace search remains the baseline.
- `SearchRelatedMemory` now supports hybrid merge through the Memory provider contract.
- The first semantic provider uses local deterministic vectors from an index file or mirrored memory writes.
- External embedding providers such as `mem0` / `supermemory` are still future provider implementations.

## Baselines

### Hermes Memory

Relevant source:

- `~/.hermes/hermes-agent/agent/memory_provider.py`
- `~/.hermes/hermes-agent/agent/memory_manager.py`
- `~/.hermes/hermes-agent/plugins/memory/mem0/`
- `~/.hermes/hermes-agent/plugins/memory/supermemory/`

Hermes-grade capability:

- Providers can be selected and initialized independently.
- Search is provider-backed rather than hard-coded into one lexical implementation.
- `on_memory_write` / turn sync events can feed external retrieval state.
- Semantic / vector retrieval is available when a vector-backed plugin is configured.

### Oneesama before this task

Relevant source:

- `internal/slackagent/related_memory.go`
- `internal/slackagent/memory_provider.go`
- `internal/slackagent/service_memory.go`

Status before task #229:

- Lexical related-memory search existed.
- Legacy Slack Agent D workspace and trace imports existed.
- Memory provider lifecycle existed after task #228.
- No concrete semantic/vector provider implementation existed.

## New Behavior

New source:

- `internal/slackagent/semantic_memory_provider.go`
- `internal/slackagent/semantic_memory_provider_test.go`
- `pkg/config/config.go`
- `pkg/config/raw_config.go`
- `pkg/config/raw_env.go`

Configuration:

- JSON config:
  - `slack.memory.semantic_enabled`
  - `slack.memory.semantic_index_path`
- Environment:
  - `ONEESAMA_SLACK_MEMORY_SEMANTIC_ENABLED`
  - `ONEESAMA_SLACK_MEMORY_SEMANTIC_INDEX`
  - legacy aliases `MAB_SLACK_MEMORY_SEMANTIC_ENABLED` / `MAB_SLACK_MEMORY_SEMANTIC_INDEX`

Provider behavior:

1. The provider is only registered when `semantic_enabled` is true.
2. If no index path is supplied, it looks for `memory/indexes/semantic-memory.json` under the workspace root.
3. If the index file is absent, the provider starts empty and fails closed.
4. Search embeds the query using a deterministic local hashing vector and ranks indexed documents by cosine similarity.
5. Provider records are returned as `SlackRelatedMemoryRecord` with `semantic_vector_match` and `memory_provider:local_semantic` reasons.
6. `memory_write` events append in-memory semantic documents so newly written memory can be recalled during the same process lifetime.

## Decisions

| Question | Decision |
|---|---|
| Should semantic recall be enabled by default? | No. Keep production lexical behavior unchanged until task #232 canaries and real provider quality justify enabling it. |
| Should this call an external embedding API now? | No. The first slice proves the provider contract and hybrid merge without adding network, quota, or secret risk. |
| Is the local vector backend "Hermes-equivalent"? | No. It is a scaffold provider that makes semantic recall pluggable; true mem0/supermemory-grade embeddings remain future providers. |
| Should memory writes persist the semantic index file immediately? | Not in this slice. Writes mirror into the provider's in-process index. Durable indexing belongs with the selected production backend. |

## Fixtures

- `TestSemanticMemoryProviderAddsHybridRelatedMemory`
  - loads a local semantic index,
  - enables the semantic provider,
  - asserts `SearchRelatedMemory` ranks the expected provider record and marks provider provenance.
- `TestSemanticMemoryProviderMirrorsMemoryWriteIntoSearch`
  - writes memory through the existing `memory_write` tool,
  - asserts the provider can recall that write through semantic search.
- Existing task #228 tests still assert provider merge and memory-write mirroring for arbitrary providers.

## Known Limits

- The local hashing vector is deterministic and cheap, but not a true embedding model.
- There is no semantic dedup / LLM rerank yet.
- The provider does not auto-index workspace Markdown files by itself; it reads a prepared JSON index or memory writes.
- Cross-session durability for semantic writes depends on the future backend/provider implementation.
- Multimodal evidence and graph/entity attribution remain separate follow-up work.

## Audit Conclusion

Task #229 closes the first concrete gap after task #228: Oneesama now has an opt-in semantic Memory backend and a hybrid `SearchRelatedMemory` merge path.

This is enough to validate the provider contract and support task #232 quality canaries, while keeping live behavior conservative until a real semantic backend is selected and proven.
