# Deployment

This repo follows the old Legacy deployment shape without modifying the old
Legacy project: one Slack control-plane service, one Meeting Agent service,
shared durable state, healthchecks, and mounted artifact directories.

## Local Docker Compose

1. Copy `.env.example` to `.env` and fill only the providers you need.
   For a no-secret container smoke, point Compose at a temporary env file:

```bash
MAB_ENV_FILE=/tmp/meeting-avatar-bot-docker-smoke.env \
  docker compose --env-file /tmp/meeting-avatar-bot-docker-smoke.env up --build
```

`MAB_ENV_FILE` affects the service `env_file`; `--env-file` also prevents
Compose interpolation from reading the local secret-bearing `.env` during
no-secret smoke runs. Keep real Slack/OpenAI tokens in ignored local env
files, not in committed files or smoke fixtures.

Docker is the realtime-assistant profile: Google Meet join, captions, dialog,
TTS, worker delegation, screen share, and Slack delivery stay enabled, while
Live2D is disabled by default. Use host-native deployment for any future
Live2D/WebGL acceptance work.

2. Start both services:

```bash
docker compose --env-file .env up --build
```

3. Health checks:

```bash
curl http://127.0.0.1:8780/healthz
curl http://127.0.0.1:8781/healthz
```

For host-local runs, `MEET_WEBHOOK_URL` and `MEET_WEBHOOK_SECRET` are optional.
When omitted, Meeting Agent derives the local Slack Agent webhook URL and both
services use the generated secret stored under the state data directory. Set
explicit values only when the services run on different hosts or networks.

Slack-driven Meet joins present an option card before launching Playwright. The
card chooses caption language and realtime participation; caption capture is
enabled for these joins so the downstream ASR/action-item/Canvas path always
has transcript input. Set `MAB_CAPTION_LANGUAGE` to change the default.

4. Validate the browser-heavy meeting surfaces directly inside the Linux image:

```bash
vp run smoke:docker-meeting-surfaces
```

This host-side helper builds `meeting-avatar-bot:local` and verifies the
synthetic 1280x720 screen-share bridge. Set `MAB_DOCKER_IMAGE`,
`MAB_DOCKER_SHM_SIZE`, or `DOCKER_BIN` if you need to override the defaults.

## Volumes

| Volume                       | Mounted path   | Purpose                                                                  |
| ---------------------------- | -------------- | ------------------------------------------------------------------------ |
| `meeting-avatar-data`        | `/data`        | SQLite state and local JSON fallback state                               |
| `meeting-avatar-screenshots` | `/screenshots` | Playwright diagnostics                                                   |
| `meeting-avatar-artifacts`   | `/artifacts`   | Meeting recordings, ASR transcripts, summaries, Canvas Markdown payloads |

## Notes

- The image installs Chromium, ffmpeg, and PulseAudio packages because the old
  MeetD deployment used browser automation plus host/audio capture.
- Live Slack tokens, OpenAI-compatible keys, and local AgentRunner credentials
  stay in `.env`; do not commit them.
- macOS Recappi capture is host-specific and should stay outside the Linux
  image. The Linux image is prepared for PulseAudio/ffmpeg recording.
- Slack Agent also mounts `/artifacts` so it can publish the `summary.md`
  produced by Meeting Agent without copying data through Slack payloads.
