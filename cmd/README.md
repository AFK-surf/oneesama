# cmd/

Entry-point binaries for the oneesama codebase. Each subdirectory is a
self-contained `main` package; build any of them with `go build ./cmd/<name>`.

This index exists so the operational scripts (`scripts/oneesama-live.sh`,
`scripts/oneesama-monitor.sh`, etc.) and new contributors can find the right
binary without reading each `main.go` header. If a new binary is added under
`cmd/`, add a row here in the same commit. Task #277.

## Service binaries

| Binary | One-line purpose | Used by |
|---|---|---|
| `oneesama` | Unified entry for the slack-agent and meeting-agent HTTP services; first positional arg selects the service. | `scripts/oneesama-live.sh`, live deployment |

## Operational / migration tools

| Binary | One-line purpose | Default mode |
|---|---|---|
| `oneesama-config-migrate` | Convert a cueboard-era YAML config into the JSON shape the oneesama loader expects. | dry-run → stdout; `--out PATH` to write |
| `oneesama-daily-dream` | Cluster LearningSignal NDJSON into review-gated Daily Dream memory candidates. | dry-run → stdout; `--output PATH` to write report |
| `oneesama-legacy-slack-memory-import` | Import old Slack Agent D workspace memory + sqlite triage runs into `memory/legacy/slack-agent-d/` Markdown. | dry-run; `--write` to apply |
| `oneesama-slock-workspace-import` | Import per-agent Slock D workspace knowledge into `memory/legacy/slock-d/` Markdown. | dry-run; `--write` to apply |
| `oneesama-triage-benchmark` | Replay live Slack threads or labeled fixtures through the triage dry-run path and summarize expected-vs-actual quality signals; supports `--config-set` variant metadata and optional `--judge-model` LLM scoring. | read-only; dry-run endpoint only |
| `oneesama-triage-replay` | Scan a window of recent Slack messages and propose lightweight follow-up replies for ones oneesama should have caught. | read-only by default |

## Audit / inventory tools

| Binary | One-line purpose | Output |
|---|---|---|
| `cueboard-function-inventory` | Walk Go source roots and emit a Markdown function/method inventory with a per-row Suggested status column for migration audits. | stdout markdown by default; `--out PATH` to write |

## Build / test conventions

- Build everything: `go build ./...`
- Test a single binary: `go test ./cmd/<name>`
- Operational binaries (`oneesama`) start the long-running HTTP services and
  should be run under a process manager (`scripts/oneesama-live.sh` uses
  tmux). Migration / audit tools (`*-import`, `*-replay`, `*-inventory`,
  `*-config-migrate`) are one-shot CLI utilities; default mode is read-only
  / dry-run unless a `--write` flag is present.

## Reference

- Operational scripts that wrap these binaries live in `../scripts/`; see
  `../scripts/README.md` for the matching scripts index.
- Architectural context: `../docs/architecture.md`.
- Per-binary detail lives in the `main.go` header doc comment.
