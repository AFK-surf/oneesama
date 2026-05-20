# Memory Provider Ownership and Ranking Matrix

Status: documentation for task #284. Pins the current shape; flags overlaps that should be addressed in follow-up work, not silently.

## Source layers feeding `SearchRelatedMemory`

`internal/slackagent/related_memory.go:47 SearchRelatedMemory` aggregates from four independent sources, in order:

1. `relatedMemoryWorkspaceRecords` — passive scan of `<workspaceDir>/memory/**/*.md`.
2. `relatedMemoryFeedbackRecords` — workspace feedback store rows.
3. `relatedMemoryTriageProjectionRecords` — triage runs projection.
4. `relatedMemoryProviderRecords` — the `slackMemoryProviderManager`, which fans out to every registered `SlackMemoryProvider`.

Records are concatenated, then `dedupeRelatedMemoryRecords` runs with key = `Kind + Source + StartLine + Content`. **Different `Source` → not deduped, even when content is identical.**

## Registered providers

`internal/slackagent/service.go:245-254` registers (when their flags are set):

| Provider | Constructor | Available when | `Search` | `SyncTurn` | `OnMemoryWrite` |
|---|---|---|---|---|---|
| `turn_extractor` | `newTurnExtractionMemoryProvider` | `Slack.Memory.Enabled` | noop | writes candidate to `memory/extractions/candidates/<date>/turn-*.md` | noop |
| `entity_graph` | `newEntityGraphMemoryProvider` | `Slack.Memory.Enabled` | walks workspace md, emits one synthesized `entity_graph` record | indexes turn for entities | noop |
| `multimodal_memory` | `newMultimodalMemoryProvider` | `Slack.Memory.Enabled` | scans `memory/multimodal/**/*.md` and emits one record per match | n/a | writes attachment candidate to `memory/multimodal/...` |
| `semantic_memory` | `newSemanticMemoryProvider` | `Slack.Memory.SemanticEnabled` | cosine match against `memory/indexes/semantic-memory.json` | n/a | appends in-memory doc with kind `memory_write` |

## Kinds produced by the workspace scanner (`relatedMemoryKindForPath`)

The passive workspace scan path classifies files by path:

| Path prefix | Kind |
|---|---|
| `MEMORY.md` | `memory_index` |
| `memory/YYYY-MM-DD.md` | `daily_note` |
| `memory/persona/writes/...md` | `persona_memory_write` |
| `memory/people/...md` | `person_profile` |
| `memory/team/decisions/...` | `team_decision` |
| `memory/team/actions/...` | `team_action` |
| `memory/team/questions/...` | `team_question` |
| `memory/team/facts/...` | `team_fact` |
| `memory/team/meetings/...` | `team_meeting` |
| `memory/lessons/candidates/...` | `lesson_candidate` |
| `memory/multimodal/...` | `multimodal_memory` |
| `memory/feedback/...` | `feedback` |
| `memory/legacy/slack-agent-d/workspace/MEMORY.md` | `legacy_memory_index` |
| `memory/legacy/slack-agent-d/workspace/memory/triage-archive/...` | `legacy_triage_archive` |
| `memory/legacy/slack-agent-d/workspace/memory/people/...` | `person_profile` |
| `memory/legacy/slack-agent-d/workspace/memory/team/decisions/...` | `team_decision` (and similar for actions/questions/facts/meetings) |
| `memory/legacy/slack-agent-d/workspace/memory/lessons/candidates/...` | `lesson_candidate` |
| `memory/legacy/slack-agent-d/workspace/memory/feedback/...` | `feedback` |
| `memory/legacy/slack-agent-d/workspace/...` (other) | `legacy_memory_file` |
| `memory/legacy/slack-agent-d/db/...` | `legacy_slack_db` |
| Anything else under `memory/` | `memory_file` |

Other inline sources contribute these kinds: `feedback` (`relatedMemoryFeedbackRecords`), `triage_projection` (`relatedMemoryTriageProjectionRecords`), `workspace_memory_file` (`local_memory_search.workspaceMemoryFileSearchResults`).

`turn_extractor` only writes candidate files; those files surface back through the workspace scanner as default `memory_file`.

## Ranking weights matrix

Workspace scanner applies `relatedMemoryScoreWithBoosts`:

```
final = lexical_base
      + family_boost(kind, tokens)
      + project_boost(content+path, tokens)
      + recency_boost(relPath, now)
      + legacy_tool_trace_boost(base, kind, content)
```

`family_boost(kind, tokens)`:

| Kind | Boost | Token condition |
|---|--:|---|
| `legacy_triage_archive` | 0.14 | unconditional |
| `persona_memory_write` | 0.20 | unconditional |
| `person_profile` | 0.25 | `who / owner / review / reviewer / 找谁 / 负责人 / 谁 / review` |
| `team_action` | 0.18 | `todo / action / owner / review / 任务 / 负责人 / 推进` |
| `team_decision` | 0.18 | `decision / decide / 方案 / 决定 / 结论 / 拍板` |
| `team_question` | 0.16 | `question / why / how / 问题 / 为什么 / 怎么` |
| `team_fact` / `team_meeting` | 0.22 | `quota / reset / 配额 / 额度 / 付费 / 免费 / 用户 / 事实 / 站会 / meeting` |
| `lesson_candidate` | 0.16 | `bug / incident / mistake / regression / 教训 / 复盘 / 错误` |
| `multimodal_memory` | 0.16 | unconditional (task #272: replaces the multimodal provider's old `+0.16` inline boost) |
| `legacy_triage_archive` (extra) | +0.22 | base ≥ 0.35 AND content contains `tool calls:` AND any of `memory_search / memory_get / person_memory` |
| anything else | 0 | — |

Provider records produced by `slackMemoryProviderManager.Search` now run through the same `relatedMemoryFamilyBoost` table as the workspace scanner (task #272). The remaining provider score differences:

| Provider record kind | Score formula |
|---|---|
| `semantic_memory` (and explicit kinds in semantic index) | cosine similarity + family boost if kind matches |
| `memory_write` (from semantic provider after `OnMemoryWrite`) | cosine similarity (no family boost row for this kind today) |
| `entity_graph` | `entityGraphScore(queryEntities, selected)` (no family boost row for this kind today) |
| `multimodal_memory` (provider side) | n/a — provider `Search` is a no-op; the workspace scanner is the sole producer |

Project boost / recency boost / legacy-tool-trace boost remain **workspace-scanner-only** — they depend on `relPath` + file `mtime`, which providers do not reliably supply.

## Ownership overlaps (current state)

1. ~~**`multimodal_memory` is double-indexed.**~~ ✅ Resolved by task #272: the multimodal provider's `Search` is a no-op; the workspace scanner is the single producer of `multimodal_memory` records. Pinned by `TestMultimodalMemoryNoDoubleIndex`.
2. **`persona_memory_write` can still be double-indexed** when the semantic provider has indexed `memory/persona/writes/...` documents (or after a runtime `OnMemoryWrite` event with that path). Scanner emits `persona_memory_write`; semantic emits `semantic_memory` (or `memory_write`). Different kinds → both kept; with the task #272 unified boost path, BOTH copies now receive the 0.20 family boost (the persona-write copy from the scanner with kind `persona_memory_write`, and any semantic copy still labelled `persona_memory_write` if the index preserved that kind). Risk reduced; full resolution would require unifying source attribution across scanner + semantic.
3. ~~**`legacy_triage_archive` suppression is workspace-scanner-only.**~~ ✅ Resolved by task #272: `relatedMemorySuppressesImportedPolicyTrace` now also runs against provider records in `slackMemoryProviderManager.Search`. Provider-emitted legacy archive content no longer bypasses the suppression filter. Pinned by `TestRelatedMemoryProviderRecordsSuppressLegacyActionlessPolicy`.

## Recommendations (for follow-up tasks)

- Consider unifying source attribution so the same physical file produced by scanner + semantic provider collapses under one dedup key (would resolve the residual `persona_memory_write` duplication noted above).
- Consider adding a configurable `MemoryDir` override so semantic provider's index path and scanner's walk root can be kept in sync.

## Regression test

`internal/slackagent/memory_provider_ownership_test.go` pins this matrix:

- Each registered provider's `Name()` and availability flag wiring.
- The full family-boost table (kind → boost / condition), including the new `multimodal_memory` row.
- The legacy-tool-trace boost edge conditions.
- The `relatedMemoryKindForPath` path → kind classification.
- `TestMultimodalMemoryNoDoubleIndex`: single record for `memory/multimodal/*.md` files, with `family_boost:multimodal_memory` reason tag.
- `TestRelatedMemoryProviderRecordsReceiveFamilyBoost`: provider-emitted `persona_memory_write` record gets the 0.20 boost via the unified path.
- `TestRelatedMemoryProviderRecordsSuppressLegacyActionlessPolicy`: actionless legacy policy traces from a provider get suppressed, not just from the scanner.

If the matrix changes, update both this doc and the test together; do not silently re-shape ownership.
