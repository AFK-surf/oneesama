# Cueboard Function Parity Audit

This directory is the long-running function-level parity audit between Cueboard and Oneesama.

The goal is not to port everything blindly. The goal is to enumerate Cueboard module by module, file by file, function by function, then mark each function as covered, intentionally excluded, or missing with evidence.

## Canonical Roots

- Cueboard source: `/Users/pengx17/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework`
- Oneesama source: `/Users/pengx17/.slock/agents/34e14f86-d6a4-48e0-aa7b-9b98507eb9de/worktrees/oneesama-go-rewrite`

## Inventory Tool

Use the AST inventory tool instead of grep when starting a module audit:

```bash
go run ./cmd/cueboard-function-inventory \
  --root slack=/Users/pengx17/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack \
  --out notes/cueboard-function-audit/slack-inventory.md
```

Useful variants:

```bash
go run ./cmd/cueboard-function-inventory \
  --root meeting=/Users/pengx17/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/meeting \
  --out notes/cueboard-function-audit/meeting-inventory.md

go run ./cmd/cueboard-function-inventory \
  --root slack=/path/to/cueboard/internal/bridge/slack \
  --root meeting=/path/to/cueboard/internal/meeting \
  --include-tests \
  --out /tmp/cueboard-inventory-with-tests.md
```

The generated table is a starting point. The reviewer fills in `Suggested status`, `Oneesama target`, `Evidence`, and `Notes`.

## Status Enum

- `identical`: behavior is intentionally identical and covered by matching tests or live evidence.
- `verbatim_port`: code or prompt was ported almost 1:1, with only naming/package drift.
- `partial`: Oneesama covers the main behavior but has known gaps or weaker tests.
- `drift`: Oneesama has an implementation, but behavior has materially diverged and needs review.
- `missing`: Cueboard behavior has no Oneesama equivalent and is not excluded.
- `product_excluded`: explicitly out of scope by product decision.
- `unreviewed`: inventory row has not been audited yet.

## Audit Row Requirements

Each reviewed row should include:

- Cueboard file/function and line range from the generated inventory.
- Oneesama file/function and line range when a counterpart exists.
- Evidence: test name, live task, commit, or reason for exclusion.
- Notes: any behavior difference, risk, or follow-up task.

Example:

| Module | Source file | Function | Kind | Exported | Lines | Suggested status | Oneesama target | Evidence | Notes |
|---|---|---|---|---:|---:|---|---|---|---|
| slack | `scanner_triage.go` | `runTriageCycle` | function | no | 210-390 | partial | `internal/slackagent/triage_decision.go:RunSlackTriage` | task #147 / task #157 audit endpoint | Prompt parity exists, but ACT/MAYBE live samples still rely on canary until real positive traffic appears. |

## Task Map

- task #162: framework, AST inventory, status schema.
- task #163: Slack scanner / triage / context.
- task #164: Slack mention / interaction / assistant surfaces.
- task #165: Slack tool surface and proxy tools.
- task #166: Slack memory / feedback / heartbeat / self-growth.
- task #167: Slack rendering / Canvas / mrkdwn / files.
- task #168: Slack persistence / admin / config / DM.
- task #169: Meeting / ASR / summary / joiner.
- task #170: Shared runtime / integrations / entrypoints.
- task #171: consolidation backlog and implementation order.

## Review Workflow

1. Generate the module inventory with `cmd/cueboard-function-inventory`.
2. Copy or commit the generated inventory into this directory under the task-specific file.
3. Review each row against Oneesama using source links and tests.
4. Mark status with evidence. Avoid "looks similar" without a file/test reference.
5. For every `missing` or `drift` row, add either a follow-up task or a product-excluded rationale.
6. End each task with a short backlog section: P0 gaps, P1 gaps, product-excluded items, and open questions.
