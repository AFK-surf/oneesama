# Self-Growth + Memory Provider Parity Audit — 2026-05-19

## Scope

This audit answers two separate questions that were getting mixed together:

1. **Cueboard / Slack Agent D parity:** did the Go Oneesama runtime keep the self-growth loop that turns feedback into durable work and follow-up surfacing?
2. **Hermes / OpenClaude-style Memory capability:** does Oneesama expose a pluggable Memory substrate for semantic recall, turn sync, memory-write mirroring, and future vector/graph backends?

The answer is intentionally split:

- Cueboard self-growth parity is mostly ported and now covered by tests.
- Hermes-level Memory provider architecture was not integrated before task #228. This audit creates the task map and the first provider contract.

## Baselines

### Cueboard / Slack Agent D

Old source:

- `agent-framework/internal/bridge/slack/improvement_self_growth.go`
- `agent-framework/internal/bridge/slack/heartbeat_auto_followup.go`
- `agent-framework/internal/bridge/slack/heartbeat_followup_events.go`
- `agent-framework/internal/bridge/slack/store_improvement.go`

Key behavior:

- `recordImprovementSignals` inserts improvement signals, clusters them, syncs heartbeat followups, and writes lesson/self-growth memory artifacts.
- `syncImprovementCluster` upserts one followup per `improvement_cluster:<cluster>` and marks open signals absorbed.
- `heartbeat_auto_followup.go` turns pending decisions, assistant commitments, confirmed actions, and meeting action items into heartbeat followups.
- Old runtime also posted an immediate visible in-thread note when a new self-growth cluster was created.

### Oneesama before this audit

Relevant files:

- `internal/slackagent/improvement_self_growth.go`
- `internal/slackagent/improvement_store.go`
- `internal/slackagent/service_heartbeat_prime.go`
- `internal/slackagent/service_heartbeat_ticker.go`
- `internal/slackagent/service_pending_action_followups.go`
- `internal/slackagent/service_heartbeat_commitments.go`

Status:

- Improvement signals are recorded from assistant-thread feedback and scanner/inbound text.
- Open/absorbed clusters are resynced on startup and converted to heartbeat followups.
- Lesson candidates and the `MEMORY.md` self-growth block are written.
- The heartbeat ticker exists and calls `SurfaceSlackFollowups` on due followups.
- Pending action, confirmed action, assistant commitment, and meeting action followups exist with canonical source refs.

### Hermes Memory

Local source:

- `~/.hermes/hermes-agent/agent/memory_provider.py`
- `~/.hermes/hermes-agent/agent/memory_manager.py`
- `~/.hermes/hermes-agent/plugins/memory/*`

Important distinction:

- Hermes currently ships provider implementations such as `mem0`, `supermemory`, `hindsight`, `honcho`, `byterover`, and `holographic`.
- The active local config has no external provider selected. So Hermes provides a richer **available architecture**, not necessarily an enabled production baseline on this machine.

Hermes provider contract includes:

- `initialize`
- `system_prompt_block`
- `prefetch`
- `queue_prefetch`
- `sync_turn`
- provider-owned tools
- `on_turn_start`
- `on_session_end`
- `on_session_switch`
- `on_pre_compress`
- `on_memory_write`
- `on_delegation`

### OpenClaude / OpenClaw

The local OpenClaw Twitter bot memory directory is effectively static/empty for this capability comparison. It is useful as an example of lightweight file memory, but it is not a richer active Memory-engine baseline.

## Parity Table

| Capability | Cueboard / Hermes baseline | Oneesama status | Decision |
|---|---|---|---|
| Self-growth signal detection | Cueboard detects repeated bot feedback topics. | Ported in `improvement_self_growth.go`; tests cover scanner feedback and thread feedback. | Keep. |
| Clustered self-growth followup | Cueboard upserts one heartbeat followup per improvement cluster. | Ported via `syncImprovementCluster` + canonical `SourceRef`. | Keep. |
| Lesson candidate writes | Cueboard writes lesson candidate Markdown and a self-growth block. | Ported via `recordLessonCandidate` + `upsertSelfGrowthMemoryBlock`. | Keep. |
| Startup resync | Cueboard resyncs open signals through heartbeat path. | Ported in `primeHeartbeatState` / `syncOpenImprovementHeartbeatFollowups`. | Keep. |
| Heartbeat surfacing cadence | Cueboard framework heartbeat delivers due followups. | Ported as `Service.startHeartbeatTicker` calling `SurfaceSlackFollowups`. | Keep; add long-window production canary separately if needed. |
| Visible "I recorded this as self-improvement" interim reply | Cueboard posted this when a new cluster was created. | Not ported. | Deliberate divergence for now; the current product feedback strongly favors fewer low-value bot replies. Revisit only with a quality canary. |
| Built-in file Memory | Hermes has always-on file memory; Cueboard had workspace memory. | Oneesama has workspace Markdown memory, legacy Slack Agent D imports, and SQLite typed collections. | Keep. |
| Memory write mirroring | Hermes calls `on_memory_write` for external providers. | Added in task #228: memory writes now notify registered providers. | Ported. |
| Pluggable provider contract | Hermes has a MemoryProvider manager and plugin lifecycle. | Added in task #228 as Go-side provider contract + manager. | Ported as foundation, no concrete external provider yet. |
| Semantic / vector recall | Hermes plugins can provide vector/semantic recall. | Not implemented. | task #229. |
| Turn sync / auto extraction | Hermes providers can `sync_turn`; mem0/supermemory can ingest turns. | Contract exists after task #228; no live auto-extraction provider yet. | task #230. |
| Entity graph / trust / user model | Hindsight/Honcho/Holographic-style capabilities. | Not implemented beyond flat person profiles and lexical ranking. | task #231 and follow-up trust/user-model work. |
| Multimodal Memory ingestion | Supermemory-style multimodal layer. | Only file metadata and delegated evidence boundaries exist. | task #233. |

## Task Split

Created follow-up tasks:

- task #228 — Memory provider contract: pluggable backend with prefetch/sync/on_memory_write hooks
- task #229 — Semantic Memory recall: hybrid lexical+vector retrieval for related-memory
- task #230 — Memory auto-extraction: turn history -> durable facts, lessons, and user/project profile updates
- task #231 — Memory graph/entity model: person/project relationships, trust, and attribution ranking
- task #232 — Memory quality canaries: real-case semantic recall and durable-write replay fixtures
- task #233 — Multimodal Memory ingestion: delegated file/image/video/PDF readers feeding searchable evidence

## Audit Conclusion

Cueboard self-growth is no longer a schema-only stub; it has a signal store, cluster followups, lesson artifacts, startup resync, and a heartbeat ticker.

The real remaining gap is not "Cueboard parity" but **Hermes-grade Memory architecture**: semantic/vector retrieval, provider lifecycle hooks, turn ingestion, backend mirroring, graph/entity modeling, and multimodal evidence ingestion. Task #228 starts that foundation without binding Oneesama to one vendor/plugin too early.
