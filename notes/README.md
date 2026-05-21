# notes/

Navigation hub for the long-form audit, RFC, polish, and migration-lesson
documents that back the oneesama codebase. Use this index instead of grepping
the tree. Task #278 (docs/audit/canary suite consolidation).

If a new long-form note lands under `notes/`, add a row to the matching
subsection below in the same commit.

## Layout

| Subdirectory | What lives there | Hub doc |
|---|---|---|
| `notes/cueboard-function-audit/` | Per-area Cueboard → Oneesama function parity audits, the migration-lessons drift-class catalogue, and the dated quality canary / parity audit notes that drove the migration. | `notes/cueboard-function-audit/README.md` |
| `notes/code-polish/` | Polish-pass artefacts produced during task #269+: module punch list, ownership/ranking matrices, canary fixture index, drift-class index, OpenClaw/Hermes roadmap, memory-provider ownership matrix. | `notes/code-polish/README.md` |
| `notes/rfc/` | Active RFC drafts for in-flight architectural decisions (foreground cognition pivot, secretary routing delegation, future capabilities). | (this README; small set, one row each below) |

## Polish-era hubs (task #269+)

These are the curated, scannable indexes that point into the long-form notes.
Start here when navigating the polish work.

| Hub doc | Role |
|---|---|
| `notes/code-polish/oneesama-module-punch-list-2026-05-21.md` | Master punch list / module map produced during task #270 Phase 0. Lists every module + bytes + risk + suggested slice. |
| `notes/code-polish/canary-fixture-index-2026-05-21.md` | Curated index of every behavioural canary fixture in the codebase (JSON fixtures + dedicated Go regression canaries + the 62 `cueboard_*_parity_test.go` group). Task #296. |
| `notes/code-polish/drift-class-index-2026-05-21.md` | Compact index of the 13 migration-audit drift classes (7 foundational + 6 promoted first-class + 2 observed-not-yet-promoted), each with anchor commit and the single audit reflex to run. Task #297. |
| `notes/code-polish/memory-provider-ownership-matrix-2026-05-21.md` | Memory provider × Kind ownership matrix + ranking weights table + resolved/residual overlaps. Task #284 / #272. |
| `notes/code-polish/openclaw-hermes-memory-roadmap-canary-first-2026-05-21.md` | Splits the remaining OpenClaw + Hermes Memory capabilities into canary-first sub-tasks (289-A trust scoring … 289-F contradiction at write). Task #289. |

## Cueboard-era hubs (task #161-#234 era)

These are the migration-era hubs that pre-date the polish pass. They are
still load-bearing reference for "why does the code look like this".

| Hub doc | Role |
|---|---|
| `notes/cueboard-function-audit/README.md` | Top-of-tree audit README. Inventory tool usage + review workflow. |
| `notes/cueboard-function-audit/migration-lessons.md` | Canonical migration gates + definition of done. |
| `notes/cueboard-function-audit/migration-lessons-audit-method.md` | Long-form catalogue of the 8+ drift classes with worked examples (consolidated into the polish-era index above; the long-form here remains the evidence). |
| `notes/cueboard-function-audit/consolidated-backlog.md` | Implementation backlog produced from #161-#171. |
| `notes/cueboard-function-audit/memory-recall-parity-inventory.md` | OpenClaw-style memory recall parity reference. |
| `notes/cueboard-function-audit/module-template.md` | Template for new per-area parity audit docs. |

## RFCs

| RFC | Status | Anchor |
|---|---|---|
| `notes/rfc/foreground-cognition-pivot-rfc-2026-05-19.md` | Accepted (drove tasks #200 through #237). | Establishes the persona-runtime + secretary boundary that the Pi runtime + delegation policy now enforce. |
| `notes/rfc/secretary-routing-delegation-rfc-2026-05-21.md` | Accepted (implemented in task #283). | Tightens `delegate_worker` to bounded secretary scope; covers prompt + Go guard + canary fixtures. |
| `notes/rfc/kwwk-cu-demo-surface-poc-rfc-2026-05-21.md` | Proposed (task #304). | Splits the mainline-bound KWWK / Computer Use meeting demo-surface POC into independently testable lifecycle, adapter, controller, presentation, realtime, feedback, safety, and audit/runbook slices. |

## Maintenance rules

- A new long-form note must add a row here AND in the matching subdirectory
  README in the same commit. No silent additions.
- When a doc is superseded by a polish-era hub (e.g. a dated parity audit
  whose findings are now folded into the canary index), add a `> Status:
  superseded by <hub doc>` line at the top of the older file. Do not delete.
- Dated docs (`*-YYYY-MM-DD.md`) are point-in-time records and should not be
  edited after the date unless a clearly-marked retro / correction section is
  added.
- The two README hubs under subdirectories (this one + the two per-dir
  READMEs) are always-loaded entry points; keep them shorter than ~200 lines
  to remain easy to scan.

## Reference

- Code-level entry-point indexes: `cmd/README.md` (binaries) +
  `scripts/README.md` (operational scripts). Task #277.
- Architecture context: `docs/architecture.md`, `docs/persona-runtime.md`,
  `docs/persona-protocol.md`.
