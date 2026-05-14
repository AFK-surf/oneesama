# Cutover Runbook

This runbook keeps the existing Slack Agent D / Meet D stack primary until the new repo passes live parity.

For the Go rewrite replacement gate, use
[`go-rewrite-cutover-bundle.md`](go-rewrite-cutover-bundle.md). That bundle is
the R22 review artifact and must pass before any live restart.

## Modes

| Mode     | Env                                                              | Primary path         | New repo side effect                      |
| -------- | ---------------------------------------------------------------- | -------------------- | ----------------------------------------- |
| New      | `MAB_CUTOVER_MODE=new`                                           | new repo             | starts Meeting Agent normally             |
| Shadow   | `MAB_CUTOVER_MODE=shadow`                                        | old stack            | records a shadow decision only            |
| Canary   | `MAB_CUTOVER_MODE=canary` + `MAB_CUTOVER_CANARY_PERCENT=<0-100>` | deterministic bucket | starts new repo only for selected buckets |
| Rollback | `MAB_CUTOVER_MODE=rollback`                                      | old stack            | records rollback decision only            |

Set `MAB_CUTOVER_AUTO_ROLLBACK_ON_FAILURE=1` during canary/new promotion to fail closed: if the selected new Meeting Agent path is unreachable or returns an error, Slack Agent records `join_auto_rollback_decision` and keeps the old stack primary for that join.

## Recommended Progression

1. Start with `shadow`.
   - Expected: Slack Agent accepts `/avatar join`, but keeps old stack primary.
   - Expected: no new Meeting Agent session is started by this repo.
   - Verify: `GET /cutover/report` returns `join_shadow_decision` events.
2. Move to `canary` with `MAB_CUTOVER_CANARY_PERCENT=5`.
   - Expected: only a small deterministic bucket starts the new Meeting Agent path.
   - Verify: compare new repo diagnostics with old-stack demo notes.
3. Increase canary after parity is stable.
   - Suggested steps: 5 -> 25 -> 50 -> 100.
4. Switch to `new` only after Gate 1-5 acceptance is done.
5. Roll back instantly with `MAB_CUTOVER_MODE=rollback`.
   - Expected: all joins keep old stack primary and record rollback decisions.

## Report

Set:

```bash
MAB_CUTOVER_REPORT_PATH=/tmp/meeting-avatar-bot-cutover/report.jsonl
```

Inspect:

```bash
curl http://127.0.0.1:8780/cutover/report
```

Each event includes:

- timestamp
- mode
- command/session metadata
- routing decision
- whether the new stack was primary, shadow-only, or suppressed

## CI Smoke

```bash
npm run smoke:cutover-shadow
npm run smoke:cutover-rollback
npm run smoke:shadow-parity
npm run smoke:shadow-tap
npm run smoke:shadow-transmitter
npm run smoke:cutover-evidence
npm run smoke:hiyori-live2d
```

`smoke:cutover-shadow` verifies:

- `shadow` keeps old stack primary and suppresses new Meeting Agent sessions
- `rollback` keeps old stack primary
- `canary` can route 100% to the new stack
- cutover decisions are written to a JSONL report

`smoke:cutover-rollback` verifies:

- `MAB_CUTOVER_AUTO_ROLLBACK_ON_FAILURE=1` fails closed when the selected new Meeting Agent path is down
- the Slack session is marked `auto_rollback_old_stack_primary`
- `/cutover/report` records `join_auto_rollback_decision` with the original new-stack decision and the rollback decision

`smoke:shadow-parity` verifies:

- a fixture old stack and the new repo both accept the same join/work/status/stop sequence
- the new stack starts the Meeting Agent path in an isolated fixture environment
- worker delegation and Slack-facing job summaries stay semantically compatible
- the parity report lists command-level pass/fail checks before any real legacy shadow tap is installed

`smoke:shadow-tap` verifies:

- `/shadow/slack-command` rejects invalid shadow tap secrets
- mirrored old-stack join/work/status/stop payloads are parsed and recorded
- no Slack session or Meeting Agent side effect is created by the receiver
- `GET /shadow/report` returns the side-effect-free receiver report

`smoke:shadow-transmitter` verifies:

- the runnable stdin hook `npm run shadow:transmit` stays disabled by default and fails closed when enabled without URL/secret
- sanitized old-stack mirror payloads can be built without Slack `token`, `response_url`, or `trigger_id`
- missing transmitter secret fails closed
- join/work/status/stop payloads can post to `/shadow/slack-command`
- the receiver records every mirrored command without creating Slack sessions or Meeting Agent side effects

`smoke:cutover-evidence` verifies:

- a fixture-safe evidence bundle can be generated without touching the old production stack
- healthz output, cutover/shadow reports, SQLite state snapshots, command logs, and a manifest are collected
- the generated tarball includes only local fixture artifacts and no Slack/OpenAI credentials

`smoke:hiyori-live2d` verifies:

- the avatar runtime reports whether it is using true Live2D or fallback canvas mode
- default CI skips cleanly if headless Chromium cannot initialize WebGL/Cubism/PIXI
- `MAB_REQUIRE_HIYORI_LIVE2D=1` makes the smoke fail unless true Hiyori Live2D pixels render and mood/action state changes alter the captured frame

## Shadow Tap Receiver

Set:

```bash
MAB_SHADOW_TAP_SECRET=<shared-secret>
MAB_SHADOW_TAP_REPORT_PATH=/tmp/meeting-avatar-bot-cutover/shadow-tap.jsonl
```

The old stack transmitter should POST mirrored commands to:

```text
POST /shadow/slack-command
x-mab-shadow-tap-secret: <shared-secret>
content-type: application/json
```

Minimal payload:

```json
{
  "source": "legacy-slack-agentd",
  "eventId": "evt_...",
  "team_id": "T...",
  "channel_id": "C...",
  "user_id": "U...",
  "text": "join https://meet.google.com/abc-defg-hij --avatar hiyori",
  "oldStack": {
    "sessionId": "meet_old_0001",
    "status": "meeting_agent_started"
  }
}
```

The receiver is intentionally side-effect-free: it records how the new repo would interpret the command, but it does not create Slack sessions, start Meeting Agent, launch browsers, or post back to Slack.

## Shadow Tap Transmitter Hook

The new repo includes a runnable transmitter hook and smoke, but the old Legacy runtime hook is not deployed by this PR.

Run:

```bash
npm run smoke:shadow-transmitter
```

For a single mirrored command:

```bash
printf '%s\n' '{"text":"status","team_id":"T...","channel_id":"C...","user_id":"U..."}' \
  | MAB_SHADOW_TAP_ENABLED=1 \
    MAB_SHADOW_TAP_URL=http://127.0.0.1:8780/shadow/slack-command \
    MAB_SHADOW_TAP_SECRET=<shared-secret> \
    npm run -s shadow:transmit
```

Use the runnable transmitter hook `npm run shadow:transmit` only after a human explicitly approves touching the old production runtime.

## Cutover Execution Checklist

Use this checklist when moving from fixture parity into live replacement. Do not switch the primary path to the new repo until every preflight item is green and the current owner has written down the rollback command.

### 1. Preflight

- [ ] `main` is clean and GitHub CI is green.
- [ ] Local validation passes:
  ```bash
  npm run ci
  ```
- [ ] Cutover and shadow receiver smokes pass explicitly:
  ```bash
  npm run smoke:cutover-shadow
  npm run smoke:cutover-rollback
  npm run smoke:shadow-parity
  npm run smoke:shadow-tap
  npm run smoke:shadow-transmitter
  npm run smoke:cutover-evidence
  ```
- [ ] Avatar visual gates pass:
  ```bash
  npm run smoke:avatar-visual
  npm run smoke:hiyori-live2d
  ```
- [ ] On a WebGL-capable runner, true Hiyori Live2D is forced at least once:
  ```bash
  MAB_REQUIRE_HIYORI_LIVE2D=1 npm run smoke:hiyori-live2d
  ```
- [ ] Real-provider gates either pass or are explicitly waived for this rollout:
  ```bash
  MAB_REQUIRE_REALTIME_SDP=1 npm run smoke:realtime-sdp
  MAB_REQUIRE_REALTIME_LIVE_TOOL=1 npm run smoke:realtime-live-tool
  ```

### 2. Shadow

- [ ] Run the old stack as primary.
- [ ] Run the new repo with `MAB_CUTOVER_MODE=shadow`.
- [ ] Configure `MAB_SHADOW_TAP_SECRET` and a durable `MAB_SHADOW_TAP_REPORT_PATH`.
- [ ] Mirror old-stack Slack commands to `POST /shadow/slack-command` with the env-gated transmitter hook `npm run shadow:transmit`.
- [ ] Confirm `GET /shadow/report` records join/work/status/stop commands without creating new Slack sessions or Meeting Agent sessions.
- [ ] Compare old-stack observed behavior with new parser output for at least:
  - join URL / bot name / avatar option
  - duplicate bot prevention
  - delegate task text and worker mode
  - jobs/status formatting
  - stop reason and session selection

### 3. Canary

- [ ] Set `MAB_CUTOVER_MODE=canary`.
- [ ] Set `MAB_CUTOVER_AUTO_ROLLBACK_ON_FAILURE=1`.
- [ ] Start at `MAB_CUTOVER_CANARY_PERCENT=5`.
- [ ] Record canary decisions through `GET /cutover/report`.
- [ ] Promote only after the demo checklist is stable:
  - 5% -> 25% -> 50% -> 100%
- [ ] At each step, compare:
  - join reliability
  - waiting-room/admit behavior
  - duplicate bot behavior
  - audio repeats
  - response latency
  - Hiyori visibility / mouth / expression state
  - worker result delivery to Slack and meeting voice

### 4. New Primary

- [ ] Set `MAB_CUTOVER_MODE=new`.
- [ ] Start a fresh real Meet session from the new repo using `MAB_REAL_MEET_URL npm run smoke:real-meet`.
- [ ] Repeat the real Meet session in a scheduled canary room with waiting-room/admit policy and real Realtime speech enabled.
- [ ] Verify the old stack does not launch a second bot.
- [ ] Run a complex request that delegates to the worker runner.
- [ ] Confirm the result appears in Slack and is spoken in the meeting without user polling.

### 5. Rollback

- [ ] Roll back by setting:
  ```bash
  MAB_CUTOVER_MODE=rollback
  ```
- [ ] Stop any new-repo meeting sessions.
- [ ] Confirm `/avatar join` keeps the old stack primary.
- [ ] Confirm `GET /cutover/report` records rollback decisions.
- [ ] Confirm `npm run smoke:cutover-rollback` passes before and after any canary promotion.
- [ ] Leave a note with rollback time, reason, failing gate, and linked logs/screenshots.

### 6. Evidence Bundle

For every live cutover attempt, save:

- [ ] Slack command IDs / channel / thread timestamp.
- [ ] Meet URL and bot display name.
- [ ] Cutover report path and shadow tap report path.
- [ ] Join diagnostics directory and screenshots.
- [ ] Realtime smoke output or waiver.
- [ ] Hiyori visual smoke output.
- [ ] Worker job IDs and Slack delivery metadata.
- [ ] Human-observed issues: repeats, latency, silence, avatar stuck state, mouth not moving, duplicate bots.

The fixture-safe bundle generator provides the standard artifact shape:

```bash
npm run cutover:evidence
```

By default it writes a temporary evidence directory and `<evidence-dir>.tar.gz`. Override the output locations with:

```bash
MAB_CUTOVER_EVIDENCE_DIR=/tmp/meeting-avatar-bot-evidence \
MAB_CUTOVER_EVIDENCE_BUNDLE=/tmp/meeting-avatar-bot-evidence.tar.gz \
npm run cutover:evidence
```

The bundle contains:

- `manifest.json` with repo HEAD, branch, origin, checks, command outputs, and artifact inventory.
- `commands/` with git status/log/remote and recent merged PR metadata when `gh` is available.
- `health/` with Slack Agent and Meeting Agent `/healthz` snapshots.
- `reports/` with shadow join, shadow tap, cutover, and shadow receiver reports.
- `reports/agent-real-task-<provider>.json` when optional live AgentRunner proof-of-life reports already exist.
- `state/` with the fixture SQLite state snapshot.

Optional live AgentRunner evidence can be generated before the bundle:

```bash
MAB_RUN_AGENT_REAL_TASK_SMOKE=1 MAB_AGENT_RUNNER=codex npm run smoke:agent-real-task
# or run multiple local providers:
MAB_RUN_AGENT_REAL_TASK_SMOKE=1 MAB_AGENT_REAL_TASK_PROVIDERS=codex,claude npm run smoke:agent-real-task
```

The real-task smoke defaults to skip in CI. When enabled, it asks the selected provider to summarize a fixed transcript, verifies the response contains acceptance keywords, and writes `reports/agent-real-task-<provider>.json` for the evidence bundle.
