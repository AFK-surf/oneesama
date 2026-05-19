# Entity Attribution Parity Audit — 2026-05-19

## Scope

- Cueboard source: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/people_memory_tool.go`
- Cueboard people projection: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/people_memory.go`
- Cueboard prompt defaults: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/defaults.go`
- Cueboard runtime memory: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/workspace/memory/triage-archive/*.json`
- New Oneesama: `internal/slackagent/people_memory_tool.go`, `internal/slackagent/legacy_slack_memory_import.go`, `internal/slackagent/related_memory.go`

This audit was triggered by the Cumora/yetone production case. Old Slack Agent D answered by combining `person_memory` with public search evidence. New Oneesama had imported Markdown and DB summaries, but it had not imported old triage-archive tool outputs and its people-memory search was narrower than Cueboard's.

## Summary

| Behavior | Old Cueboard Agent D | New Oneesama after this audit | Decision |
|---|---|---|---|
| Person memory actions | `person_memory` supports `lookup`, `briefing`, `list`, `correct`. | New tool now accepts `briefing` in addition to `lookup`, `list`, `correct`. | Port action parity. |
| Person search scoring | Scores exact key, file key, name, identity, and full profile text. | New search now ranks name/file/identity/full profile text, including durable context, responsibilities, meetings, and notes. | Port scoring shape. |
| Old tool-result memory | Old triage archive JSON stores the actual tool calls/results that produced answers. | Importer now renders `memory/triage-archive/*.json` into line-citable Markdown under `memory/legacy/slack-agent-d/workspace/memory/triage-archive/*.md`. | Port evidence source. |
| URL/entity related-memory query | Old Agent D could search `yetone cumora.ai` and cite Isoform/Alma evidence. | Related-memory tokenization ignores URL scheme/TLD noise so entity evidence beats generic `https`/`AI` notes. | Fix query quality drift. |

## Behavior 1: `person_memory` Actions

- Old does: declares `personMemoryActions = []string{"lookup", "briefing", "list", "correct"}` and routes both `lookup` and `briefing` through profile matching (`people_memory_tool.go:15`, `people_memory_tool.go:66-112`).
- Previous new state: `personMemoryTool.Execute` only recognized `lookup`, `list`, and `correct`; `briefing` returned `unsupported person memory action`.
- New does now: `personMemoryTool.Execute` accepts both `lookup` and `briefing`; `lookup` renders the old full card shape, while `briefing` renders the shorter collaboration brief (`internal/slackagent/people_memory_tool.go:163-185`).
- Diff:
  - New wording is not byte-for-byte identical, but the sections (`Identity`, `Operator notes`, `Durable context`, `Current responsibilities`, `Recent meetings`) and limits match the old behavior.
  - Action coverage is now aligned, so prompts/tool callers that choose `briefing` no longer fail.
- Decision: port `briefing` and restore full `lookup` output shape.
- Fixtures: `TestCueboardParityPersonMemoryToolLookupListAndCorrect`.

## Behavior 2: Person Search Scoring

- Old does: `filterPersonMemoryProfiles` scores all profiles and sorts by score desc/name asc (`people_memory.go:124-159`). `personMemoryScore` checks compact key variants, file key, exact/contains name, exact/contains identity, and full profile text (`people_memory.go:161-203`). `personMemorySearchText` includes name, file key, identity, operator notes, durable context, responsibilities, and recent meetings (`people_memory.go:205-213`).
- Previous new state: `findPersonMemoryProfiles` only matched profile name plus `IdentityMap`/`OperatorNotes`; it ignored `DurableContext`, `CurrentResponsibilities`, and `RecentMeetings`.
- New does now: `personMemoryProfileScore` ranks compact name, file key, identity, and `personMemorySearchText`, which includes durable context, current responsibilities, recent meetings, and operator notes (`internal/slackagent/people_memory_tool.go:51-93`).
- Diff:
  - New scoring uses compacted alphanumeric keys for profile text, which is slightly more tolerant of punctuation and CJK/English spacing than old raw lowercase `strings.Contains`.
  - Old key variant handling has more filename-specific nuance; new compact file-key scoring covers the normal projected filename path.
- Decision: port the old scoring dimensions and keep compact matching as a robustness improvement.
- Fixtures: `TestCueboardParityFindPersonMemoryProfilesMatchesAliasAndFormatsBriefing`.

## Behavior 3: Legacy Triage Archive Evidence

- Old does: runtime workspace stores detailed `memory/triage-archive/*.json` entries with assistant raw output, tool calls, summaries, and Slack actions. The Cumora case contains the old reasoning trace: `person_memory` found no `yetone`, then `exa_search` found `yetone (@yetone)`, `@Isoform`, and `Alma` evidence.
- Previous new state: `oneesama-legacy-slack-memory-import` copied allowed Markdown workspace memory plus database summaries, but skipped `.json` triage archives because `isAllowedMemoryPath` only permits `MEMORY.md` and `memory/**/*.md`.
- New does now: `legacySlackWorkspaceTriageArchiveFiles` scans `memory/triage-archive/*.json`; `legacySlackRenderTriageArchiveJSON` renders each run into Markdown preserving `summary`, `digest`, `actions`, and long `raw_output`; generated files land at `memory/legacy/slack-agent-d/workspace/memory/triage-archive/*.md` (`internal/slackagent/legacy_slack_memory_import.go:86-112`, `internal/slackagent/legacy_slack_memory_import.go:167-231`).
- Diff:
  - New renderer truncates each raw output at 12k runes to keep memory search bounded.
  - JSON source remains untouched; imported Markdown is the line-citable search surface for Pi/Oneesama.
- Decision: port old tool-result evidence into the Oneesama workspace import. Without this, the exact production-quality evidence old Agent D used is invisible to Pi.
- Fixtures: `TestImportLegacySlackAgentDMemoryWritesPiSearchableEvidence`.

## Behavior 4: Cumora/yetone Entity Attribution

- Old does: in the production case, Slack Agent D did not magically know `yetone`; it searched. The trace shows `person_memory {"person":"yetone"}` returned no profile match, then external search found `yetone (@yetone)`, `@Isoform`, and `Alma`, with no direct Cumora link.
- Previous new state: related-memory search could find some current triage projection rows after the manual rerun, but old Agent D's original tool-result evidence was absent, and URL query tokens like `https` / `ai` could score generic daily notes.
- New does now:
  - Imported old triage archives are typed as `legacy_triage_archive` (`internal/slackagent/related_memory.go:227-256`).
  - URL-derived scheme/TLD subtokens (`http`, `https`, `www`, `com`, `ai`, etc.) are filtered while keeping meaningful host/entity subtokens such as `cumora` (`internal/slackagent/related_memory.go:425-484`).
  - A regression asserts `https://cumora.ai/ 这是 yetone 搞得吗` returns the legacy triage archive with `yetone`, `Isoform`, and `Alma` before generic URL noise (`internal/slackagent/related_memory_test.go:244-282`).
- Diff:
  - This does not add a new web-search tool path. It makes old Agent D's already-captured search evidence available to the Pi/Oneesama memory layer.
  - Fresh unknown entity attribution still needs delegated search / tool fail-closed parity.
- Decision: close the known Cumora/yetone memory gap now; keep first-class fresh search as part of app-mention tool fail-closed/tool parity work.
- Fixtures: `TestSearchRelatedMemoryIgnoresURLSchemeNoiseForEntityAttribution`.

## Open Follow-Ups

1. Compare old `exa_search` / `exa_contents` availability with new app-mention worker tools. The Cumora case proves memory import helps known cases, but unknown future entities still need a safe fresh search path.
2. Consider importing old `memory/people/_corrections/*.md` exactly rather than only preserving corrections through projected profiles. This did not block the Cumora case.
3. Add an app-mention quality canary that asks the Cumora/yetone question with no existing bot reply and asserts cited evidence includes the old Agent D trace or a fresh delegated search result.
