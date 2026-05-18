# Slock D workspace import

`oneesama-slock-workspace-import` imports existing Slock agent workspace knowledge into
Oneesama workspace memory under `memory/legacy/slock-d/`.

## Cueboard parity

The old Cueboard Slack Agent D treated workspace files as behavior context, not just
operator notes:

- `cmd/slack-agentd/main.go` initialized the workspace template and called
  `fw.SetMemoryDir(cfg.WorkspaceDir)`.
- `cmd/slack-agentd/workspace_init.go` copied missing `SOUL.md`, `AGENTS.md`,
  `CODEX_GUIDANCE.md`, `MEMORY.md`, and docs from the embedded workspace template.
- `internal/bridge/slack/defaults.go` injected `SOUL.md`, `AGENTS.md`,
  `CODEX_GUIDANCE.md`, `MEMORY.md`, daily notes, and recent feedback into the
  assistant prompt.

This importer preserves that contract without overwriting Oneesama's active top-level
instructions. Imported files stay line-citable Markdown so Pi / PersonaRuntime can use
normal related-memory search.

## What is imported

For each agent directory under the Slock agents root, the importer reads:

- root `MEMORY.md`, `AGENTS.md`, `CLAUDE.md`, `CODEX_GUIDANCE.md`, `SOUL.md`
- `notes/**/*.md`
- `docs/**/*.md`
- `handoffs/**/*.md`

It skips volatile or unsafe directories such as `worktrees/`, `attachments/`, `tmp/`,
`node_modules/`, `.git/`, and `.secrets/`.

Each generated file includes source-agent metadata and the original content. Likely
secret lines and inline tokens are redacted before writing.

## Usage

Dry-run first:

```bash
go run ./cmd/oneesama-slock-workspace-import \
  --source-agents-root /Users/pengx17/.slock/agents \
  --target-workspace /path/to/oneesama/runtime/live-workspace
```

Write after inspecting the report:

```bash
go run ./cmd/oneesama-slock-workspace-import \
  --source-agents-root /Users/pengx17/.slock/agents \
  --target-workspace /path/to/oneesama/runtime/live-workspace \
  --write
```

The command is idempotent: rerunning it rewrites the generated
`memory/legacy/slock-d/` files from the current Slock workspace snapshot.
