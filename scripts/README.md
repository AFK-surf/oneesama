# scripts/

Operational shell scripts for the oneesama codebase. Each script is a thin
bash wrapper that composes the binaries in `../cmd/` and the live HTTP
endpoints they expose. If a new script lands here, add a row to the table
below in the same commit. Task #277.

## Live service control + health

| Script | Purpose | Notes |
|---|---|---|
| `oneesama-live.sh` | Canonical env/preflight/exec wrapper for a single live `oneesama` subcommand. | Sources the live env files with `set -a`, rejects stale alias conflicts, and for `slack-agent` requires the Pi foreground posture (`pi_first_live`, `oneesama-pi`, `live`, `shadow=false`, workspace policy) unless `--allow-legacy-slack` is explicitly passed for local/dev smoke tests. |
| `oneesama-live-screen.sh` | Canonical detached `screen` lifecycle wrapper for live services. | Defaults to `meeting-agent`; refuses to start or restart `slack-agent` unless `--allow-slack-agent-restart` is passed, and always routes startup/postcheck through `oneesama-live.sh`. |
| `oneesama-monitor.sh` | Probe live `/healthz` + `/slack/status` + `/slack/triage/audit` for both services; exit non-zero on any red flag. | Default audit window `3h` (env: `ONEESAMA_MONITOR_AUDIT_WINDOW`). When `ONEESAMA_STATUS_OUTPUT_DIR` is set, writes `monitor-result.json` for the report wrapper (task #295). |
| `oneesama-triage-quality-sweep.sh` | Walk the triage status feed for a window and bucket runs into red (failures / invalid persona JSON / placeholder summaries) and review (high-context / link-context / low-confidence no-action) buckets. | Default window inherits from monitor; thresholds come from the live audit (`qualityThresholds` block, task #285) with `7000` / `0.75` fallback. Writes `triage-quality-result.json` when `ONEESAMA_STATUS_OUTPUT_DIR` is set. |
| `oneesama-status-report.sh` | Run `oneesama-monitor.sh` + `oneesama-triage-quality-sweep.sh` into a shared output dir, optionally add live triage benchmark fixtures, then emit a merged `status-report.json` (schema `oneesama.status-report.v1`) and `status-report.md`. | Exit 0 only when enabled checks are ok. Output dir defaults to `mktemp -d`; override via `ONEESAMA_STATUS_REPORT_OUTPUT_DIR`. Enable live fixtures with `ONEESAMA_STATUS_REPORT_TRIAGE_BENCHMARK=1`. |

## Pre-merge / regression smoke

| Script | Purpose | Notes |
|---|---|---|
| `docker-meeting-surfaces-smoke.sh` | Docker-based smoke test for the meeting-agent's caption / audio / lifecycle surfaces. | Use before shipping changes that touch `internal/meetingagent`. |
| `r22-cutover-regression.sh` | r22 cutover regression bundle (Slack triage parity + meeting agent surfaces). | Use as the pre-merge "did I break the cueboard parity" check. |

## Go tests under scripts/

- `oneesama_live_test.go` is a Go test that exercises the live preflight logic
  inside `scripts/oneesama-live.sh` indirectly via env-variable contracts.
  Run with `go test ./scripts/...`.

## Conventions

- All shell scripts use `set -euo pipefail` (or `set -eu` for POSIX `sh`).
- Required external tools are checked with a `need <tool>` helper near the
  top of the script (curl, jq, docker, etc.). If a script gains a new tool
  dep, add it to the corresponding `need` call.
- Scripts read configuration from `ONEESAMA_*` env vars (sometimes with
  `MAB_*` aliases for backwards compatibility). See `pkg/config/raw_env.go`
  for the canonical env-variable list consumed by the binaries.
- For shared structured output across scripts, set `ONEESAMA_STATUS_OUTPUT_DIR`
  and use `oneesama-status-report.sh` as the merge surface (task #295).

## Reference

- The binaries these scripts wrap live in `../cmd/`; see `../cmd/README.md`.
- Per-script header / argument docs live in the file itself (top-of-file
  comments).
