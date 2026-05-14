# Tomorrow Handoff Checklist

This is the quick path for a human operator to verify the repo after the overnight autonomous work.

If you only have five minutes, read [requirements.md](requirements.md) first, then come back here for the executable checklist.

## 0. Confirm Repo State

```bash
git remote -v
git status --short
git log --oneline -8
```

Expected:

- remote points to `AFK-surf/meeting-avatar-bot`
- local branch is `main`
- latest commits include the provider, Slack contract, Meet contract, SQLite state provider, and docs polish PRs
- read `docs/parity-inventory.md` for the current replacement gap map

## 1. Run Default Local Gate

```bash
npm ci
npm run ci
```

This does not require Slack, Google, or OpenAI credentials. Optional live checks should skip cleanly when secrets are absent.

## 2. Start Local Services

Terminal A:

```bash
npm run dev:meeting
```

Terminal B:

```bash
npm run dev:slack
```

Health checks:

```bash
curl http://127.0.0.1:8781/healthz
curl http://127.0.0.1:8780/healthz
```

SQLite mode:

```bash
MAB_STATE_PROVIDER=sqlite \
MAB_STATE_SQLITE_PATH=/tmp/meeting-avatar-bot-data/meeting-avatar-bot.sqlite3 \
npm run smoke:persistence
```

Expected:

- Slack sessions, Meeting sessions, and worker reports use provider `sqlite`
- state survives service restart
- healthz reports the same SQLite file with separate `slack_sessions`, `meeting_sessions`, and `worker_reports` collections

## 3. Verify Local Dialog With A Real Agent Provider

Codex:

```bash
MAB_AGENT_RUNNER=codex npm run smoke:local-agent-dialog
MAB_RUN_AGENT_REAL_TASK_SMOKE=1 MAB_AGENT_RUNNER=codex npm run smoke:agent-real-task
# Optional live OpenAI Realtime + Codex worker delegation:
MAB_RUN_REALTIME_LIVE_TOOL=1 MAB_AGENT_RUNNER=codex npm run smoke:realtime-live-tool
```

Claude Code:

```bash
MAB_RUN_CLAUDE_PROVIDER_SMOKE=1 MAB_AGENT_RUNNER=claude npm run smoke:claude-provider
MAB_AGENT_RUNNER=claude npm run smoke:local-agent-dialog
MAB_RUN_AGENT_REAL_TASK_SMOKE=1 MAB_AGENT_RUNNER=claude npm run smoke:agent-real-task
```

Ollama:

```bash
npm run smoke:ollama-provider
# Optional live local model:
# ollama serve
# ollama pull llama3.2
MAB_RUN_OLLAMA_PROVIDER_SMOKE=1 MAB_AGENT_RUNNER=ollama npm run smoke:ollama-provider
MAB_AGENT_RUNNER=ollama npm run smoke:local-agent-dialog
```

Slack Agent D bridge:

```bash
npm run smoke:slack-agent-d-provider
# Live adapter mode requires a private bridge endpoint:
# MAB_AGENT_RUNNER=slack-agent-d MAB_SLACK_AGENT_D_URL=http://127.0.0.1:9001/agent/run npm run smoke:local-agent-dialog
```

Expected:

- selected local runner returns text
- optional real-task smoke writes `reports/agent-real-task-<provider>.json` with transcript summary proof
- TTS provider routes audio into the avatar fake mic
- Hiyori/fallback state changes to `happy/speak`

## 4. Verify Meet Join Without Real Google

```bash
npm run smoke:meet
npm run smoke:meet-contract
npm run smoke:screen-share
```

Expected:

- Playwright joins the local fixture
- fake mic/cam tracks are present
- participant audio seam is discovered in `smoke:meet-contract`
- screen-share smoke exposes a synthetic 1280x720 display stream and stops it cleanly
- replacement stop and status/stop lifecycle pass

## 5. Optional Real Meet Acceptance

Only run when a throwaway room is ready and a human can admit the bot if Google shows a waiting room.

```bash
MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz npm run smoke:real-meet
MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz MAB_AGENT_RUNNER=codex npm run smoke:real-local-dialog
```

Acceptance:

- bot visibly enters the room
- bot leaves automatically after smoke
- for local dialog, operator hears the generated TTS audio in the meeting

## 6. Optional Slack Live Acceptance

Keep this out of committed files.

```bash
SLACK_BOT_TOKEN=<your-bot-token> \
SLACK_SIGNING_SECRET=... \
MAB_SLACK_POSTER_MODE=live \
npm run smoke:slack-posting
```

Before replacing or disabling any existing Legacy Slack Agent D / Meet D
entrypoint, validate a separate bot key in shadow mode:

```bash
MAB_SLACK_LIVE_ENV_FILE=/path/to/other-bot.env \
MAB_RUN_SLACK_LIVE_CAPABILITY_SMOKE=1 \
npm run smoke:slack-live-capability
```

This check is intentionally low side-effect: it verifies `auth.test` and, when
`SLACK_APP_TOKEN` is available, `apps.connections.open`; it does not connect to
Socket Mode or post unless `MAB_SLACK_LIVE_POST_TEST=1` is explicitly set.

After capability passes, verify the new repo's copied Socket Mode/event-loop
shape in an isolated process:

```bash
MAB_SLACK_LIVE_ENV_FILE=/path/to/other-bot.env \
MAB_RUN_SLACK_LIVE_SOCKET_SMOKE=1 \
MAB_SLACK_LIVE_TEST_CHANNEL=C0123456789 \
npm run smoke:slack-live-socket
```

This posts one marker to the configured test channel, waits for the event to
enter `apps/slack-agent`'s buffered event path, then exits; existing Legacy
services stay untouched.

Acceptance:

- result posts to the configured test channel/thread
- duplicate poll does not post twice

## 7. Cutover Readiness Questions

Before replacing Slack Agent D / Meet D:

- Is `MAB_CUTOVER_MODE=shadow` running and writing reports?
- Is `MAB_CUTOVER_AUTO_ROLLBACK_ON_FAILURE=1` enabled before any canary/new promotion?
- Is the old-stack transmitter hook approved and deployed?
- Is there a live Slack token/channel acceptance record?
- Is there a live Meet room acceptance record?
- Is rollback documented and tested with `MAB_CUTOVER_MODE=rollback`?
- Does `npm run smoke:cutover-rollback` pass?
- Can the operator generate the standard evidence bundle?
  ```bash
  npm run cutover:evidence
  ```

## Current Known Gaps

- Google login / waiting-room admit is still operator-gated.
- Real participant speech STT is not default-CI covered.
- Production-grade TTS provider selection is still operator choice.
- True Live2D WebGL pixel-golden is optional and may require a WebGL-capable runner.
- Real Google Meet native Present-click acceptance remains operator-gated. For the boss-demo video stage, prefer the synthetic screen-share path that already avoids the native picker/TCC failure mode.
- Live Slack token acceptance needs Peng-provided dev workspace credentials.
- Private local Slack Agent D memory can be seeded with `MAB_SLACK_MEMORY_ENABLED=1 npm run slack:memory-seed`; the seed lives outside git under `MAB_SLACK_MEMORY_DIR` and is consumed by Slack delegate context. Do not commit the generated memory directory.
- Docker deployment, Slack workspace context, private Slack memory seed, MeetD-style Recappi/Pulse recording, fixture meeting artifact post-processing, ASR provider seams, and Canvas/Slack-thread publishing are now present. Live Slack token acceptance and production ASR/TTS provider selection still need operator-provided credentials/runtime.
