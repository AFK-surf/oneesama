# notes/code-polish/

Polish-pass artefacts produced during the task #269+ oneesama code polish
initiative. Each doc here is a curated index or matrix, not a fresh audit; the
underlying audit evidence lives in `../cueboard-function-audit/`. Task #278
(docs/audit/canary suite consolidation).

If a new polish-era doc lands under this directory, add a row here and in
`notes/README.md` in the same commit.

## Indexes (read these first)

| Doc | Role | Anchor task |
|---|---|---|
| `oneesama-module-punch-list-2026-05-21.md` | Master module map + per-module risk + suggested polish slice ordering. Produced by driver during Phase 0. | #270 |
| `canary-fixture-index-2026-05-21.md` | Curated index of every behavioural canary fixture (JSON fixtures + dedicated Go regression canaries + the 62 `cueboard_*_parity_test.go` group), with anchor task IDs and what each pins. | #296 |
| `drift-class-index-2026-05-21.md` | Compact index of the 13 migration-audit drift classes (7 foundational + 6 promoted first-class + 2 observed-not-yet-promoted), each with anchor commit and the single audit reflex to run. Source-of-truth long-form lives in `../cueboard-function-audit/migration-lessons-audit-method.md`. | #297 |

## Matrices and roadmaps

| Doc | Role | Anchor task |
|---|---|---|
| `memory-provider-ownership-matrix-2026-05-21.md` | Memory provider × Kind ownership + ranking weights table; documents resolved overlaps (multimodal double-index, suppression provider-only) and the residual `persona_memory_write` semantic-vs-scanner overlap. | #284 (matrix), #272 (overlap fixes) |
| `openclaw-hermes-memory-roadmap-canary-first-2026-05-21.md` | Splits remaining OpenClaw + Hermes Memory capabilities into 6 canary-first sub-tasks (289-A trust scoring … 289-F contradiction at write) with dependency order + canary-first protocol. | #289 |
| `harness-stability-inventory-2026-05-21.md` | Classifies Oneesama prompt/tool inputs as stable prefix vs dynamic evidence, and defines the first hash contracts for the Harness cache/tool-stability RFC. | #319 |
| `harness-foreground-tool-inventory-2026-05-21.md` | Classifies realtime foreground tools as stable/optional/deprecated/worker-only and records the schema hash migration gate. | #327 |

## Naming conventions

- Dated polish docs use `<topic>-YYYY-MM-DD.md`. The date is the ship date,
  not the topic date. Do not edit dated docs in place once they have a row
  here; if a follow-up needs to amend, add a retro section at the bottom or
  ship a new dated companion.
- "Index" / "Matrix" / "Roadmap" docs are intentionally short (~100-200 lines)
  and link out to the long-form evidence in `../cueboard-function-audit/` or
  the code itself. If a polish doc grows past ~300 lines, that is a signal to
  split.

## Maintenance rules

- Adding a new polish doc requires a row here AND in `notes/README.md` in the
  same commit.
- When a polish-era index supersedes a dated parity audit in
  `../cueboard-function-audit/`, mark the older doc with a
  `> Status: superseded by notes/code-polish/<file>` header line.
- If a fixture / matrix row stops being true (e.g. a fix lands that removes
  an overlap), update the row + commit the doc change alongside the code
  change. Do not silently invalidate indexes.

## Reference

- Cueboard-era audit evidence: `../cueboard-function-audit/`.
- Active RFCs: `../rfc/`.
- Code-level indexes: `../../cmd/README.md`, `../../scripts/README.md`.
