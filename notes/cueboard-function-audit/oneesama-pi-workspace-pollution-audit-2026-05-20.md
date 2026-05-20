# Oneesama Pi Workspace Pollution Audit

Date: 2026-05-20

## Trigger

Peng asked to re-walk the 2026-05-19 Oneesama migration work and look for
pollution, especially from old slackd workspace context and the temporary
Linger/telegram-pi-agent path.

## Scope

- 2026-05-19 migration commits that touched Slack triage, Pi foreground,
  related-memory, Memory providers, workspace policy, and daily comparison.
- Active Oneesama code paths under `internal/`, `pkg/`, `cmd/`, and `scripts/`.
- Live runtime state under `/tmp/oneesama-*.sh` and
  `runtime/live-workspace/memory/`.
- Documentation that could mislead future implementation.

## Findings

| Area | Finding | Decision |
|---|---|---|
| Oneesama Pi runtime | `oneesama-pi` is a separate provider from `pi`; live status reports `provider=oneesama-pi`, `mode=live`, `healthy=true`, and no Linger sidecar is required. | Keep. |
| Linger runtime docs | `docs/persona-runtime.md` still framed `telegram-pi-agent` as directly reusable. That directory is Linger and must be historical reference only. | Patched docs to say concepts may be ported, not live dependency. |
| Live env | `/tmp/oneesama-live-env-from-proc.sh` still contained stale `ONEESAMA_PERSONA_RUNTIME=pi` and sidecar URL variables. Current workspace policy overrode them, but source-order changes could resurrect Linger. | Removed stale runtime lines from the live env snapshot. |
| Old slackd workspace import | Old slackd workspace memory is intentionally imported under `runtime/live-workspace/memory/legacy/slack-agent-d/...`. This is correct evidence, not pollution. | Keep as line-citable evidence. |
| Old slackd actionless policy traces | Old legacy triage archives include many "office helper / watercooler / pure technical / skip" decisions. Those are historical decisions, not Oneesama's current workspace policy. | Suppress actionless legacy policy traces from related-memory/local-memory retrieval unless they contain real tool/memory trace evidence. |
| Linger marker tokens in memory | One bad 2026-05-20 triage archive entry had `[[MSG_BREAK]]` in `summary` and `visible_text`. Output scrub existed, but Memory retrieval could re-feed the marker to Pi. | Scrub Memory snippets, related-memory records, persona memory items, and citations; repaired the live archive JSON. |
| Workspace policy | Active policy should be deployment config, not hardcoded model behavior. Current code uses `workspace_triage_policy` context and no hardcoded Oneesama-specific default. | Keep; future work should make link-synthesis policy more structured. |
| Daily legacy comparison | `legacy_db_path` / `legacy_triage_archive_dir` point to old cueboard data only for daily report comparison. They do not enter persona foreground. | Keep; add staleness flag later if legacy data stops updating. |

## Code Changes

- `memorySnippet`, related-memory records, triage-memory formatting, persona
  memory items, and persona citations now call `sanitizeSlackVisibleText`.
- Related-memory/local-memory retrieval suppresses imported old slackd
  actionless policy traces while preserving old traces that include
  `tool calls:`, `memory_search`, `memory_get`, or `person_memory`.
- Added regression tests for marker scrub and actionless policy trace
  suppression.
- `docs/persona-runtime.md` now records the Oneesama/Linger boundary and
  `oneesama-pi` capability limitations.

## Verification

- `jq empty runtime/live-workspace/memory/triage-archive/2026-05-20.json`
- `rg "MSG_BREAK|MSGBREAK|WORLD_BRIEF|KNOWLEDGE_BRIEF" runtime/live-workspace/memory/triage-archive/2026-05-20.json`
- Focused cueboard-parity tests for marker scrub, related-memory suppression,
  and legacy tool-trace preservation.

## Follow-Ups

- Replace `workspacePolicyEnablesSharedLinkSynthesis` substring detection with a
  structured policy flag or explicit positive/negative policy parser.
- Add a daily report "legacy comparison stale" flag when old slackd source data
  stops updating.
