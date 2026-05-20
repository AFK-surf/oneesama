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
| `legacy_triage_archive` (extra) | +0.22 | base ≥ 0.35 AND content contains `tool calls:` AND any of `memory_search / memory_get / person_memory` |
| anything else | 0 | — |

Provider records do **not** pass through `relatedMemoryScoreWithBoosts`. They keep whatever score the provider assigns:

| Provider record kind | Provider score formula |
|---|---|
| `semantic_memory` (and explicit kinds in semantic index) | cosine similarity, no boosts |
| `memory_write` (from semantic provider after `OnMemoryWrite`) | cosine similarity, no boosts |
| `entity_graph` | `entityGraphScore(queryEntities, selected)`, no family boost |
| `multimodal_memory` (provider side) | `lexical_base + 0.16` |

Project boost / recency boost / legacy-tool-trace boost are **workspace-scanner-only** today. A `persona_memory_write` returned by the workspace scanner can rank meaningfully higher than the same logical content surfaced through a provider, because only the workspace scanner adds the 0.20 family boost.

## Ownership overlaps (known, kept for now)

1. **`multimodal_memory` is double-indexed.** Both the workspace scanner and the multimodal provider scan files under `memory/multimodal/`. They emit the same `Kind`, different `Source` (`memory_provider:multimodal_memory:<path>` vs `<path>`), and different scores. Dedup does not collapse them because the keys differ. Net effect: the same file appears twice with different scores; the higher-scored one wins the top slot but the second still consumes a slot in the top-N.
2. **`persona_memory_write` can also be double-indexed** when the semantic provider has indexed `memory/persona/writes/...` documents (or after a runtime `OnMemoryWrite` event with that path). Scanner emits `persona_memory_write`; semantic emits `semantic_memory` (or `memory_write`). Different kinds → both kept, but only the scanner copy receives the 0.20 family boost.
3. **`legacy_triage_archive` boost is workspace-scanner-only.** If a future provider re-emits the same content with kind `legacy_triage_archive`, it would also get the family boost — but no provider currently does, and the suppression filter `relatedMemorySuppressesImportedPolicyTrace` only runs on the workspace path. Provider-emitted legacy archive content would bypass the suppression filter today.

## Recommendations (for follow-up tasks, not in scope of #284)

- Consider making the multimodal provider's `Search` opt-out of paths already covered by the workspace scanner, or aligning its `Source` with the scanner so dedup collapses the duplicates.
- Consider running `relatedMemoryScoreWithBoosts` over provider records too, so family/legacy boosts are not workspace-only. The current short-circuit means a semantic provider hit can rank below a scanner hit even when both reference the same evidence.
- Consider running the actionless-policy-trace suppression filter on provider records as well, so legacy-style content cannot sneak back in through a provider path.

## Regression test

`internal/slackagent/memory_provider_ownership_test.go` pins this matrix:

- Each registered provider's `Name()` and the `Kind` it returns from `Search`.
- The full family-boost table (kind → boost / condition).
- The double-index behaviour for `memory/multimodal/` and `memory/persona/writes/` (both records present today; the test should be updated when overlap is removed).

If the matrix changes, update both this doc and the test together; do not silently re-shape ownership.
