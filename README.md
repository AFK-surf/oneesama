# oneesama

Oneesama is a Slack-controlled meeting bot. It can join Google Meet, talk in the
meeting, keep track of speakers, delegate harder work to a local agent, share
visual context, and send meeting artifacts back to Slack.

It is not an agent brain by itself. It is the Slack + Meet + realtime runtime
shell around the agent/model you choose to run.

## What It Is Useful For

- **Join meetings from Slack**: ask the bot to join a Google Meet URL from a
  Slack thread, then control the meeting session from the same thread.
- **Realtime meeting copilot**: enable voice participation so the bot can answer
  in the meeting, read links, remember the recent speaker, and call tools.
- **Delegate real work**: route coding, research, debugging, or summarization to
  Codex, Claude Code, Ollama, an HTTP runner, a command runner, or another local
  backend.
- **Share context into Meet**: start a synthetic screen share, video stage, or
  app-share request. Native app/window sharing may still require Chrome/Meet
  picker confirmation.
- **Produce artifacts**: save transcript, chat, audio, summary, manifest, and
  publish a Slack-thread or Canvas-compatible report after the meeting.

## How You Use It

1. Build and start the two services.
2. Configure Slack if you want live Slack control.
3. Optionally configure OpenAI Realtime if you want the bot to speak in Meet.
4. Mention the bot in Slack with a Meet URL.
5. Use the Slack thread and the meeting conversation to control what it does.

Typical Slack messages:

```text
@Onee-sama join https://meet.google.com/abc-defg-hij
@Onee-sama summarize this thread and join the meeting
@Onee-sama monitor this service log and discuss problems here
```

Typical meeting requests:

```text
"What did we decide so far?"
"Who was speaking just now?"
"Look up this link and tell us the important part."
"Share Keynote."
```

## Quick Start

Requirements:

- Node.js `>=22`
- Go `1.25`
- Playwright Chromium
- Slack credentials for live Slack usage
- Optional OpenAI Realtime key for realtime voice

Install and build:

```bash
npm ci
npm run setup:browsers
make build
```

Start services:

```bash
./oneesama meeting-agent
./oneesama slack-agent
```

Live restarts should use the checked wrapper so env files are sourced with
exports preserved and provider tokens are preflighted before the child process
starts:

```bash
scripts/oneesama-live.sh slack-agent
scripts/oneesama-live.sh --preflight-only slack-agent
scripts/oneesama-live.sh --check-pid "$PID" slack-agent
```

By default the wrapper looks for live env files under the persistent repo-external
directory `${XDG_CONFIG_HOME:-$HOME/.config}/oneesama/live-env/`, not `/tmp`.
Use `ONEESAMA_LIVE_DEFAULT_ENV_DIR` or repeated `--env <path>` only for an
explicit override.

Minimal live Slack env:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
MAB_SLACK_SOCKET_MODE=1
```

Optional realtime voice env:

```bash
MAB_OPENAI_API_KEY=...
MAB_OPENAI_REALTIME_MODEL=gpt-realtime-2
MAB_OPENAI_REALTIME_VOICE=marin
```

Optional worker backend:

```bash
MAB_AGENT_RUNNER=codex
MAB_CODEX_BIN=codex
MAB_CODEX_MODEL=gpt-5.5
```

## Common Controls

Slack command shape:

```text
join <meet-url>
status [session-id]
stop [session-id]
help
```

Useful local endpoints:

```bash
curl http://127.0.0.1:8780/healthz
curl http://127.0.0.1:8781/healthz
curl http://127.0.0.1:8781/realtime/config
curl http://127.0.0.1:8781/realtime/context-health
curl -X POST http://127.0.0.1:8781/screen-share/apps
```

## What Runs Without Secrets

These checks do not need Slack or OpenAI credentials:

```bash
npm run ci
go test ./...
go test -tags cueboardparity ./...
npm run smoke:meet-contract
npm run smoke:screen-share
npm run smoke:local-agent-dialog
npm run smoke:realtime-agents-sdk
```

## Product Boundaries

- Google Meet is the first meeting provider.
- Slack is the first workspace control plane.
- OpenAI Realtime is optional; local dialog and worker-provider paths still run
  without it.
- Live2D/avatar rendering is optional. The default product value is meeting
  participation, context, delegation, sharing, and artifacts.
- Private credentials, prompts, workspace memory, recordings, and generated
  meeting data should not be committed.

## More Docs

- [Architecture](docs/architecture.md)
- [Local demo runbook](docs/local-demo.md)
- [Deployment](docs/deployment.md)
- [Realtime 2 provider](docs/realtime-2.md)
- [Meet contract matrix](docs/meet-contract-matrix.md)
- [Slack contract matrix](docs/slack-contract-matrix.md)
- [Assets and licenses](docs/assets-and-licenses.md)
