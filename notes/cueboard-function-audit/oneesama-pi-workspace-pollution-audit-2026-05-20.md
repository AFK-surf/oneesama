# Oneesama Pi Workspace Pollution Audit

Date: 2026-05-20

## Trigger

Peng asked to re-walk the 2026-05-19 Oneesama migration work and look for
pollution, especially from old slackd workspace context and temporary
compatibility-runtime assumptions. Peng later clarified that Oneesama memory
capability should learn from **OpenClaw + Hermes**, not from any old sidecar.

## Scope

- 2026-05-19 migration commits that touched Slack triage, Pi foreground,
  related-memory, Memory providers, workspace policy, and daily comparison.
- Active Oneesama code paths under `internal/`, `pkg/`, `cmd/`, and `scripts/`.
- Live runtime state under `/tmp/oneesama-*.sh` and
  `runtime/live-workspace/memory/`.
- Documentation that could mislead future implementation.

## Findings

| Area                                | Finding                                                                                                                                                                                                                            | Decision                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Oneesama Pi runtime                 | `oneesama-pi` is a separate provider from `pi`; live status reports `provider=oneesama-pi`, `mode=live`, `healthy=true`, and no compatibility sidecar is required.                                                                 | Keep.                                                                                                                                    |
| Memory reference docs               | `docs/persona-runtime.md` still framed an old local runtime as directly reusable. The target should instead be OpenClaw + Hermes-style Memory capability.                                                                          | Patched docs to use OpenClaw + Hermes as the memory reference shape.                                                                     |
| Live env                            | `/tmp/oneesama-live-env-from-proc.sh` still contained stale `ONEESAMA_PERSONA_RUNTIME=pi` and sidecar URL variables. Current workspace policy overrode them, but source-order changes could resurrect the old compatibility route. | Removed stale runtime lines from the live env snapshot.                                                                                  |
| Old slackd workspace import         | Old slackd workspace memory is intentionally imported under `runtime/live-workspace/memory/legacy/slack-agent-d/...`. This is correct evidence, not pollution.                                                                     | Keep as line-citable evidence.                                                                                                           |
| Old slackd actionless policy traces | Old legacy triage archives include many "office helper / watercooler / pure technical / skip" decisions. Those are historical decisions, not Oneesama's current workspace policy.                                                  | Suppress actionless legacy policy traces from related-memory/local-memory retrieval unless they contain real tool/memory trace evidence. |
| Private marker tokens in memory     | One bad 2026-05-20 triage archive entry had `[[MSG_BREAK]]` in `summary` and `visible_text`. Output scrub existed, but Memory retrieval could re-feed the marker to Pi.                                                            | Scrub Memory snippets, related-memory records, persona memory items, and citations; repaired the live archive JSON.                      |
| Workspace policy                    | Active policy should be deployment config, not hardcoded model behavior. Current code uses `workspace_triage_policy` context and no hardcoded Oneesama-specific default.                                                           | Keep; future work should make link-synthesis policy more structured.                                                                     |
| Daily legacy comparison             | `legacy_db_path` / `legacy_triage_archive_dir` point to old cueboard data only for daily report comparison. They do not enter persona foreground.                                                                                  | Keep; add staleness flag later if legacy data stops updating.                                                                            |

## Code Changes

- `memorySnippet`, related-memory records, triage-memory formatting, persona
  memory items, and persona citations now call `sanitizeSlackVisibleText`.
- Related-memory/local-memory retrieval suppresses imported old slackd
  actionless policy traces while preserving old traces that include
  `tool calls:`, `memory_search`, `memory_get`, or `person_memory`.
- Pi-authored memory files under `memory/persona/writes/...` now have the
  explicit `persona_memory_write` kind and a small family boost, so self-written
  memory is visible as self-written memory rather than generic markdown.
- Added regression tests for marker scrub and actionless policy trace
  suppression, plus a round-trip assertion that Pi-authored memory is written,
  searchable, and tagged as `persona_memory_write`.
- `docs/persona-runtime.md` now records the OpenClaw + Hermes Memory target and
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
- Add Memory quota/rotation, trust/staleness scoring, and episodic consolidation
  for `memory/persona/writes/...` so the OpenClaw-style write path can grow
  toward Hermes-style long-term memory.
