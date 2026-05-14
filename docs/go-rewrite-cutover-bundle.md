# Go Rewrite Cutover Bundle

This is the R22 review bundle for replacing the old `slack-agentd` + `meetd`
runtime with the Go `oneesama` binary. It is a review artifact first: do not
restart live services from this document until the R22 commit is reviewed.

## Source Baseline

The bundle is source-driven from:

- cueboard `cmd/slack-agentd/main.go:41-176` for startup, validation, run mode,
  graceful shutdown, and framework wiring.
- cueboard `cmd/slack-agentd/main.go:178-194` for process secret scrubbing.
- cueboard `cmd/slack-agentd/main.go:196-254` for session-kind role/tool gates.
- cueboard `cmd/meetd/main.go:15-162` for meetd store, runtime watcher,
  lifecycle webhooks, and HTTP server startup.
- cueboard `deploy/docker/docker-compose.yml:1-82` for paired `meetd` /
  `slack-agentd` service wiring, persistent data directories, health checks,
  and webhook URL wiring.
- cueboard `deploy/docker/docker-compose.slack-agentd.yml:1-44` for standalone
  Slack daemon runtime/data/cache layout and health check.
- cueboard `deploy/docker/run-slack-agentd-local.sh:1-101` and
  `deploy/docker/run-with-log.sh:1-72` for local daemon env normalization,
  runtime directories, and log tee behavior.
- cueboard `deploy/docker/validate-slack-agentd.sh:1-182` for config-file
  presence checks, shared webhook secret consistency, compose validation, image
  build, health wait, and validate-only smoke.
- old oneesama `apps/slack-agent/src/index.ts:308-430` for runtime config/store
  wiring and Socket Mode state fields.
- old oneesama `apps/slack-agent/src/index.ts:522-552` for install/manifest
  model shape.
- old oneesama `apps/slack-agent/src/index.ts:3280-3344` for Socket Mode connect
  and reconnect lifecycle.
- old oneesama `apps/slack-agent/src/index.ts:3346-3741` for HTTP route surface
  and service listen/start order.
- old oneesama `packages/core/src/slack/slack-app-manifest.ts:1-260` for Slack
  manifest scopes, events, App Home, Assistant view, interactivity, Socket Mode,
  validation checks, and install checklist.

## Review-Gated Live Rule

Live currently stays pinned to `2dab7d2`. R22 may build, test, document, and
produce an operator plan, but it must not stop the old live processes or restart
Go live services before review approval.

## Full Regression

Run the same command locally before review:

```bash
./scripts/r22-cutover-regression.sh
```

The script performs:

1. `make ensure-js-deps`
2. `make vet`
3. `make build`
4. `make test`
5. targeted package tests for Slack, Meeting, meet-runner, agentrunner, config,
   and integration
6. raw `go test ./...` to catch accidental package discovery
7. race tests over the core runtime packages
8. `git diff --check`

## Old-vs-New Behavior Matrix

This matrix intentionally uses the replacement gate as the row model. Each row
maps old cueboard / old oneesama behavior to the reviewed Go implementation and
the acceptance evidence required for cutover.

| Gate | Old cueboard / TS behavior | Go replacement status | Cutover acceptance |
|---|---|---|---|
| Gate 0: architecture and runtime invariants | Two daemon binaries (`slack-agentd`, `meetd`), env/config startup, secret scrub, small Go packages, graceful shutdown, persistent stores. | `oneesama slack-agent` and `oneesama meeting-agent`; ManagedServer graceful shutdown; R16 secret scrub; typed persistence; file-size rule preserved. | `make build`; both subcommands start; shutdown test evidence; no private cueboard framework dependency; `ScrubProcessSecrets` tests green. |
| Gate 1: slack-agentd startup/config/validation | `SLACK_RUN_MODE=validate`, workspace file sync, backend auth probe, repo/runtime setup, people memory projection. | R16 validate mode + provider preflight; workspace bootstrap; R20c memory projection; cueboard repo-runtime intentionally replaced by Codex/OpenAI runner config. | `oneesama slack-agent --validate`; `/slack/validate`; workspace bootstrap tests; provider preflight tests. |
| Gate 2: Slack Socket Mode and events | Socket Mode opens via `apps.connections.open`, acks envelopes, handles app mention / DM / assistant thread events, reconnects. | R8/R8.2 Socket Mode with ack-before-dispatch, heartbeat, write deadlines, exponential backoff; R13/R14 event lifecycle/context parity. | Socket Mode fake-server tests; negative event tests; live `/slack/status` shows connected before cutover. |
| Gate 3: Slack Assistant / mention behavior | Assistant status lifecycle (`Thinking...`, progress, clear), suggested prompts, suppressed immediate worker ack, rich thread context. | R13 assistant status client/lifecycle, prompt setting, worker callbacks; R14 rich context and hidden Go-only commands. | Assistant status tests, app mention delegate tests, no immediate `Delegated to...` text, terminal result posts once. |
| Gate 4: Slack user command surface | Text commands for join/status/stop/delegate/jobs; slash menu was product-removed. | R12/R14 command surface matches the agreed five-line help; join/stop call meeting-agent; slash command omitted from manifest. | Golden help text; app mention/DM command tests; manifest has no `slash_commands` and no `commands` scope. |
| Gate 5: interactivity and pending actions | Block actions, selected options, pending-action confirmation/dismissal, action status updates. | R9 command action parsing; R20b pending action store/cards/interactions for triage actions. | Interaction tests for embedded JSON, selected option, pending-action status update, invalid payload ack. |
| Gate 6: Slack API tools and rendering | Slack post/reply/update/fetch/canvas/mrkdwn/channel/member tooling, with excluded credentialed tools. | Poster/canvas route and app mention context are implemented; channel/member cache and full mrkdwn/tool registry are documented as remaining non-cutover blockers unless product reopens them. | Poster retry/dedup tests; canvas tests; app mention context tests; remaining Gate 6 caveats acknowledged in review. |
| Gate 7: Slack intelligence loops | Inbound buffer, scanner sweep/compact, triage planner, cognition/channel brain, followups/heartbeat, local/team memory. | R20a-c port inbound buffer, scanner, triage/pending actions, cognition stores, followups, heartbeat context, local memory, team/people projection. | R20a-c route/store tests; memory projection tests; triage/followup/compact tests. |
| Gate 8: Slack meeting control plane | Slack receives signed meetd lifecycle webhooks, maps meetings to threads, posts joined/processing/result and Canvas summaries. | R19 adds HMAC `/webhooks/meeting-result`, thread/result stores, lifecycle statuses, result dedupe, failure notices, Canvas/thread rendering. | Meeting webhook tests; force-delivery/redelivery test; Slack post/canvas mock evidence. |
| Gate 9: meetd config/API/store | Pure execution layer, `/health`, `/meetings` CRUD, captions/chat/artifacts/redeliver/resummarize, durable records. | R17a-c port the 10-route meetd HTTP surface and durable meeting/caption/summary stores; R18 adds runtime aliases. | `TestMeetd*` route matrix; exact cueboard error text; artifact/caption/redeliver/resummarize tests. |
| Gate 10: meetd runtime/watchers | Poll pending meetings, launch joiner, transition status, capture captions/chat/audio, summarize, send signed lifecycle webhooks. | R18 watcher, wake/tick, ready-window claim, stale cleanup, persistent meet-runner scheduling, fallback summary, HMAC joined/processing/result webhooks. | Runtime watcher tests; signed webhook tests; manual `/meetings/runtime/tick`; explicit remaining live ingestion caveats reviewed. |
| Gate 11: oneesama live meeting extension | Old cueboard has no equivalent; old oneesama adds Realtime, dialog/TTS, worker-result bridge, screen share/video stage. | R21a realtime config/token, R21b dialog/TTS, R21c worker-result injection + screen-share/video stage + meet-runner protocol flags. | R21a-c tests; live browser/realtime smoke remains R22 review-gated and must not be requested from Peng before green evidence. |
| Gate 12: replacement evidence | Old stack uses operator validate scripts, compose health checks, logs, and rollback-ready runtime data. | R22 adds this bundle and `scripts/r22-cutover-regression.sh`; live restart remains review-gated. | Regression script output, clean git diff, behavior matrix review, and then one approved live restart with health/status/counter evidence. |

## Review-Gated Live Restart Plan

Only run this section after reviewer approval.

1. Build the reviewed binary:

   ```bash
   make build
   git rev-parse --short HEAD
   ```

2. Source the live environment without printing secrets:

   ```bash
   set -a
   source tmp/oneesama-go-live-env.sh
   set +a
   ```

3. Preflight without mutating live:

   ```bash
   ./oneesama slack-agent --validate
   curl -fsS http://127.0.0.1:8781/health || true
   pgrep -fl 'node apps/(slack-agent|meeting-agent)/src/index|node src/index.ts|oneesama'
   ```

4. Stop the old JS implementation only after the reviewed commit is approved:

   ```bash
   pkill -f 'node apps/slack-agent/src/index.js' || true
   pkill -f 'node apps/meeting-agent/src/index.js' || true
   pkill -f 'node src/index.ts' || true
   ```

5. Start Go services with append-only logs:

   ```bash
   ./oneesama meeting-agent >> logs/oneesama-go-meeting-live.log 2>&1 &
   ./oneesama slack-agent >> logs/oneesama-go-slack-live.log 2>&1 &
   ```

6. Verify service health and Slack Socket Mode:

   ```bash
   curl -fsS http://127.0.0.1:8781/healthz
   curl -fsS http://127.0.0.1:8780/slack/status
   ```

   Required fields:

   - `slack.socket_mode.connected: true`
   - `slack.poster_mode: "slack-api"`
   - `agent_runner.ready: true`
   - `agent_runner.dry_run: false`

7. Live spot checks after reviewer approval, not before:

   - app mention `help` returns the five-line command surface.
   - app mention unknown text creates a worker job without an immediate noisy
     `Delegated to ...` post.
   - terminal worker result posts once and clears assistant status.
   - meetd-compatible `POST /meetings` creates a pending record, `/runtime/tick`
     advances it, and `/meetings/{id}/redeliver` can force-deliver stored result
     once summary exists.

## Rollback Plan

If any live spot check fails:

1. Stop Go services:

   ```bash
   pkill -f './oneesama slack-agent' || true
   pkill -f './oneesama meeting-agent' || true
   ```

2. Restart the prior JS/old implementation using the previously approved live
   runbook or process supervisor.
3. Leave `runtime/live-state` and `logs/oneesama-go-*.log` intact for review.
4. Post the failing gate row, command, timestamp, and log tail in the Slock
   review thread.

## R23 Follow-Up Items

R23 is intentionally separate from cutover. R23b closes the first three
operational hardening items:

- Add a Go job to GitHub Actions (`make vet`, `make build`, `make test`).
- Refresh README/docs so OSS users see the Go replacement state instead of the
  older TypeScript-first runbook.
- Isolate config tests from host `OPENAI_API_KEY` / other ambient env leakage.
- Make Meeting Agent -> Slack Agent lifecycle webhooks zero-config on local
  loopback: default to `/webhooks/meeting-result` on the local Slack Agent and
  auto-generate the shared HMAC secret under the state data directory.

Remaining follow-ups stay separate:

- Document deployment profiles: host-native can enable future Live2D, while
  Docker defaults to realtime assistant participation with Live2D disabled.
- Add richer self-test infrastructure for Slack reactions without needing a
  human-authored app mention.
