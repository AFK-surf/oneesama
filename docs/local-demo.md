# Local Demo Runbook

This runbook uses only public configuration and dry-run defaults. It does not require internal workspace credentials.

## 1. Install

```bash
npm ci
cp .env.example .env
npm run doctor
```

`doctor` is warning-only. Missing OpenAI and Slack tokens are expected when running the local smoke suite.

## 2. Run The Smoke Suite

```bash
npm run ci
```

`npm run ci` installs the Playwright Chromium runtime if it is missing, then runs the full smoke suite.

This verifies:

- local session + dry-run background work routing
- agent runner provider seam for dry-run, Codex, Claude Code, Ollama, Slack Agent D bridge, command, and HTTP backends
- state provider seam for `memory`, `json-file`, and WAL-backed `sqlite`, including restart restoration of sessions and worker delivery markers
- persistent local session/job store across service restart
- Hiyori/fallback avatar fake mic/cam injection in Chromium
- non-dry-run Playwright join against a local Meet fixture, including stop-before-start lifecycle, screenshots, button inventory, and fake mic/cam capture
- Meet contract matrix smoke that covers URL validation, dry-run planning, Meeting Agent route behavior, participant audio, diagnostics, replacement stop, and stop/status lifecycle
- browser worker-result polling bridge that marks completed jobs delivered for live Realtime consumption
- browser Realtime mock bridge that turns completed worker jobs into `conversation.item.create` and `response.create` events
- browser Realtime WebRTC-shaped data-channel seam in local mock mode
- browser participant audio discovery seam for Realtime input
- browser Realtime remote audio route into the avatar fake mic audio bus in local mock mode
- browser Realtime repeat/interrupt guard that skips duplicate worker-result injection and cancels an active response when user speech starts
- browser Realtime `session.update` registration for runtime instructions and tools
- browser Realtime worker tools that route work to Meeting Agent and return `function_call_output`
- browser Realtime avatar-state tools that update Hiyori/fallback mood and action state
- avatar visual smoke that compares deterministic mouth/action snapshot hashes and visible pixel diffs
- optional true Hiyori Live2D pixel smoke that skips when headless WebGL/CDN loading is unavailable and becomes mandatory with `MAB_REQUIRE_HIYORI_LIVE2D=1`
- fixture-level runtime acceptance that combines join, participant audio, worker-result delivery, worker tool calls, and avatar state
- Slack result reporting smoke that polls completed Meeting Agent worker jobs once and marks them delivered to Slack
- Slack posting smoke that sends completed worker results through a mock Slack thread poster and records delivery metadata
- Slack contract matrix smoke that covers parser flags, signed URL-encoded slash payloads, bad/stale signatures, command edge cases, and worker result deduplication
- cutover shadow/canary/rollback smoke that proves shadow mode records parity data without starting the new Meeting Agent path
- cutover rollback smoke that proves a selected new-stack failure fails closed to old-stack-primary and writes a report event
- shadow parity smoke that mirrors join/work/status/stop across an old-stack fixture and the new repo
- shadow tap smoke that verifies an old-stack transmitter can mirror commands into `/shadow/slack-command` while the new repo records/parses them with side effects suppressed
- shadow transmitter smoke that verifies sanitized old-stack mirror payloads can be built and posted to the receiver without leaking Slack secrets or creating side effects
- optional real OpenAI Agents SDK Realtime smoke when `MAB_OPENAI_API_KEY` or `OPENAI_API_KEY` is present
- optional real OpenAI Realtime live tool smoke that requires the model to trigger `delegate_to_worker`
- Realtime background work prompt/tool contract
- Slack control-plane commands against a local Meeting Agent, including Slack signing-secret verification

## 3. Start Services

Terminal A:

```bash
npm run dev:meeting
```

Terminal B:

```bash
npm run dev:slack
```

## 4. Exercise Slack Commands Without Slack

```bash
curl -X POST http://127.0.0.1:8780/commands/avatar \
  -H 'content-type: application/json' \
  -d '{"user_id":"U_LOCAL","text":"join https://meet.google.com/abc-defg-hij --avatar hiyori --bot-name DemoBot"}'

curl -X POST http://127.0.0.1:8780/commands/avatar \
  -H 'content-type: application/json' \
  -d '{"user_id":"U_LOCAL","text":"summarize this meeting bot architecture"}'

curl -X POST http://127.0.0.1:8780/commands/avatar \
  -H 'content-type: application/json' \
  -d '{"user_id":"U_LOCAL","text":"status"}'

curl -X POST http://127.0.0.1:8780/commands/avatar \
  -H 'content-type: application/json' \
  -d '{"user_id":"U_LOCAL","text":"stop --reason local_demo_done"}'
```

By default, `join` uses the Google Meet joiner dry-run path. Pass `--dry-run false` only when you have a real browser/Meet environment ready.

For an automated non-dry-run browser proof that does not require a real Google Meet room, run:

```bash
npm run smoke:meet
npm run smoke:meet-contract
```

`smoke:meet` starts a local Meet-like fixture, launches Playwright Chromium, fills the bot name, clicks `Join now`, verifies the injected fake camera and mic tracks, then starts a second join to prove the old browser is stopped before a new bot is created.

`smoke:meet-contract` is the stricter replacement-parity matrix. It additionally checks URL rejection, dry-run plan shape, Meeting Agent API behavior, participant audio discovery, diagnostics artifacts, replacement session identity, and status/stop lifecycle. See [meet-contract-matrix.md](meet-contract-matrix.md).

## Provider Examples

The repo includes minimal provider env files under `examples/`:

```bash
source examples/provider-codex.env
npm run smoke:local-agent-dialog

source examples/provider-claude.env
npm run smoke:local-agent-dialog

source examples/provider-ollama.env
npm run smoke:ollama-provider
# To run a live local model:
#   ollama serve
#   ollama pull "$MAB_OLLAMA_MODEL"
#   MAB_RUN_OLLAMA_PROVIDER_SMOKE=1 npm run smoke:ollama-provider

source examples/provider-slack-agent-d.env
npm run smoke:slack-agent-d-provider

source examples/provider-command.env
npm run smoke:local-agent-dialog
```

For HTTP provider mode, start the sample runner first:

```bash
node examples/provider-http-runner.mjs
source examples/provider-http.env
npm run smoke:local-agent-dialog
```

For a quick operator-facing entry point, start with the root
[README](../README.md) and then follow the live checks below.

For a real Google Meet room acceptance smoke, use a throwaway room and keep a human nearby in case Google puts the bot in the waiting room:

```bash
MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz npm run smoke:real-meet
MAB_REQUIRE_REAL_MEET=1 MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz npm run smoke:real-meet
```

The real-room smoke is not part of default CI. It launches Playwright Chromium, injects the Hiyori/fake mic-cam runtime, fills the guest name, clicks `Join now` or `Ask to join`, waits briefly for in-call controls or participant audio discovery, writes screenshots/diagnostics under `/tmp/meeting-avatar-bot`, and automatically leaves the room in cleanup.

If a live Google Meet room blocks guest automation at the prejoin anti-bot check, use a dedicated logged-in browser profile instead of the disposable Playwright profile:

```bash
MAB_MEET_PROFILE_MODE=persistent \
MAB_BROWSER_USER_DATA_DIR=/path/to/automation-chrome-profile \
MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz \
npm run smoke:real-meet
```

Guest mode remains the default because it matches the old avatar-spike launcher. Frequent automated joins against the same room/IP can still trip Google's `Getting ready... confirm you're not a bot` prejoin risk check; when that happens, cool down, use a fresh room, or switch to a dedicated persistent automation profile. Use a dedicated automation profile, not the user's active daily Chrome profile, so Playwright can own the browser lifecycle.

Native Meet desktop sharing is separate from the avatar camera stream. On macOS, the browser binary selected by
`MAB_CHROMIUM_EXECUTABLE` must be enabled in **System Settings > Privacy & Security > Screen & System Audio Recording**.
If Meet shows `Can't share your screen`, grant that browser permission and restart the Meeting Agent browser session.

Realtime `control_shared_app_window` uses the `app_control` backend, not the general background worker path. The tool queues app-control events by default and returns a `job_id` immediately, so the Realtime voice turn does not wait for macOS UI automation. Call the same tool with `job_id` to inspect status/result, or pass `wait:true` only for manual debugging. Instruction-only user goals route to the high-level Computer Use executor, which owns the observe -> plan -> act -> verify loop internally. Explicit `operations` still go to the local KWWK/Computer Use stdio JSON-RPC helper for low-level smokes and direct-adapter cases. Codex fallback for KWWK startup failures should stay off in the voice loop; it is separate from the instruction-only executor path:

```bash
MAB_APP_CONTROL_PROVIDER=kwwk
MAB_APP_CONTROL_TIMEOUT=15s
MAB_APP_CONTROL_CODEX_FALLBACK=0
MAB_KWWK_APP_CONTROL_COMMAND="node --import tsx packages/core/src/meeting/app-control-helper.ts --stdio"
```

The bundled helper compiles a small Swift stdio JSON-RPC binary into the system temp directory. It supports `list_apps`, `list_windows`, `state`, `click`, `type`/`type_text`, `press_key`, `scroll`, `drag`, and `app_control.control_shared_app_window`. `state` accepts `includeScreenshot:true` and writes a PNG to `screenshotOutput` or a temp path, returning the path and dimensions instead of inlining image bytes. For normal user goals, send `instruction` and omit `operations`; the foreground Realtime model should not invent click/drag primitives or ask the user to provide them. Use `operations` only for debug, harnesses, or direct-adapter tests where the caller already has exact safe primitives. When the screen-share path knows `windowId` or `processId`, Meeting Agent forwards that stable target so the executor/helper can control the shared app/window without guessing by app name. The helper needs macOS Accessibility permission for input events.

Host app-control live smokes are opt-in because they inspect or mutate the local GUI:

```bash
MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE=1 \
go test ./internal/meetingagent -run 'TestLive(KWWKStdioAppControlBackendControlsHostApp|RealtimeSharedAppControlHTTPUsesKWWKBackend)' -count=1 -v

MAB_RUN_KWWK_APP_CONTROL_LIVE_MUTATE=1 \
go test ./internal/meetingagent -run TestLiveRealtimeSharedAppControlHTTPMutatesHostApp -count=1 -v
```

The first command observes the shared app/window and writes a screenshot through the real KWWK backend. The second command sends click/type operations through `/tools/control_shared_app_window` and should leave a visible smoke label in the target app.

To verify the live Realtime model routes a shared-app edit request to the app-control tool without making the foreground model produce primitives, run:

```bash
MAB_RUN_REALTIME_LIVE_ROUTING=1 npm run smoke:realtime-live-routing
```

This smoke uses real OpenAI Realtime but dry-runs local tools. It proves routing, queued/running turn policy, and argument shape, not visible Pencil mutation.

Final app-control acceptance still needs a real-room manual smoke because it crosses Google Meet admission, native app sharing, Realtime speech input, and host app mutation:

1. Open Pencil to a disposable `.pen` file and keep the canvas visible.
2. Start the Meeting Agent with the KWWK app-control env above and a real OpenAI Realtime key.
3. Join a throwaway Meet room with native desktop sharing permission already granted to the selected Chromium binary.
4. In the meeting, say “共享 Pencil 屏幕” and verify the shared surface is the existing Pencil window, not a browser/workspace fallback.
5. Then say “在 Pencil 里画一个圆” without telling the bot which Pencil tool to use.
6. Pass condition: Pencil receives a visible mutation, such as a new circle/shape/stroke, and `/tools/control_shared_app_window` reports `ok:true` with high-level CU actions or a queued job that completes.
7. Blocker condition: if mutation does not happen, capture the exact tool result. Acceptable blockers must be specific, for example `accessibility_permission_required`, `shared_window_not_found`, `agent_runner_unavailable`, or another executor/helper error. A silent Realtime turn, foreground primitive prompt, or generic success without visible mutation is a failure.

For the no-OpenAI-key local dialog bridge, run:

```bash
npm run smoke:dialog-provider
npm run smoke:local-agent-dialog
MAB_AGENT_RUNNER=codex MAB_BROWSER_HEADLESS=true npm run smoke:local-agent-dialog
MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz npm run smoke:real-local-dialog
MAB_REQUIRE_REAL_LOCAL_DIALOG=1 MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz npm run smoke:real-local-dialog
```

The fixture smoke dispatches a synthetic local-STT utterance, calls the selected AgentRunner provider, requests audio from Meeting Agent `/tts/synthesize`, decodes the returned WAV data URL into the avatar fake mic, and verifies Hiyori enters the `speak` action. The real-room variant clicks into Google Meet first, then injects the same controlled utterance so it can prove the provider/TTS/avatar loop without requiring OpenAI Realtime.

For a stronger avatar renderer gate on a WebGL-capable machine, run:

```bash
npm run smoke:hiyori-live2d
MAB_REQUIRE_HIYORI_LIVE2D=1 npm run smoke:hiyori-live2d
```

Without `MAB_REQUIRE_HIYORI_LIVE2D=1`, this smoke skips cleanly when headless Chromium cannot initialize the true Cubism/PIXI Live2D renderer. With the flag set, it fails unless true Hiyori Live2D pixels render and mood/action state changes alter the captured frame.

For operator-facing avatar/HUD iteration without Google Meet, start the standalone playground:

```bash
npm run dev:avatar-playground
```

Open the printed URL (defaults to `http://127.0.0.1:18912/`). The playground loads the avatar fake-camera runtime by itself, shows the HUD on the avatar frame, and lets you switch avatar presets plus runtime state presets (`Listening`, `Thinking`, `Speaking`, `Using Tool`, `Blocked`, `Done`). It is the fast local surface for tuning Live2D/VRM/fallback visuals, HUD placement, and future avatar-preset animation switches. Run the regression smoke with:

```bash
npm run smoke:avatar-playground
```

For the video-avatar replacement direction, use
[`docs/avatar-video-state-matrix.md`](./avatar-video-state-matrix.md) as the
source of truth for required states, assets, lip-sync policy, and playground/live
acceptance.

The v1 video preset is `oneesama-video`. It expects two muted clips named
`oneesama-video-idle-loop.mp4` and `oneesama-video-speaking-loop.mp4`. For local
iteration, keep generated/private clips out of git and point the playground at
an asset directory:

```bash
ONEESAMA_AVATAR_ASSET_ROOT=tmp/avatar-video npm run dev:avatar-playground
```

Then open `http://127.0.0.1:18912/?avatar=oneesama-video`.

To generate the two Seedance clips, provide the portrait reference and a
server-side Seedance/ModelArk key. The script prints only key presence/status,
never the secret value:

```bash
SEEDANCE_API_KEY=... npm run avatar:video:seedance -- --ref /path/to/ref.png --out-dir tmp/avatar-video
```

`ARK_API_KEY` is accepted as a fallback. If the key is missing, the script exits
before calling the network so the renderer can still be tested with local
placeholder clips.

## 5. Optional Real Integrations

Set these only when you are ready to connect real providers:

```bash
MAB_AGENT_RUNNER=codex
MAB_CODEX_BIN=codex
MAB_CODEX_MODEL=gpt-5.5

MAB_AGENT_RUNNER=claude
MAB_CLAUDE_BIN=claude
MAB_CLAUDE_MODEL=sonnet
MAB_CLAUDE_READ_PERMISSION_MODE=dontAsk
MAB_CLAUDE_WRITE_PERMISSION_MODE=acceptEdits

# Or bridge to the old Legacy Slack Agent D through an explicitly configured
# adapter endpoint. The provider strips private Slack fields before forwarding.
MAB_AGENT_RUNNER=slack-agent-d
MAB_SLACK_AGENT_D_URL=http://127.0.0.1:9001/agent/run
MAB_SLACK_AGENT_D_TOKEN=...

# Or bridge to any local command that reads a JSON job on stdin.
MAB_AGENT_RUNNER=command
MAB_AGENT_COMMAND='my-local-agent --json'

# Or bridge to any local/remote HTTP runner that accepts POSTed job JSON.
MAB_AGENT_RUNNER=http
MAB_AGENT_HTTP_URL=http://127.0.0.1:9000/agent/run

# Optional OpenAI Realtime dialog provider.
MAB_OPENAI_API_KEY=...
MAB_OPENAI_BASE_URL=https://api.openai.com/v1
MAB_OPENAI_REALTIME_MODEL=gpt-realtime-2
MAB_OPENAI_REALTIME_REASONING_EFFORT=high
MAB_OPENAI_REALTIME_VOICE=marin
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
SLACK_SIGNING_SECRET=...
```

To validate another Slock/Slack bot key without touching the existing Legacy
Slack Agent D / Meet D services, use the live capability smoke. By default it
only checks Slack auth and optional Socket Mode URL issuance; it does not open a
Socket Mode WebSocket, ack real events, or post messages.

```bash
MAB_SLACK_LIVE_ENV_FILE=/path/to/other-bot.env \
MAB_RUN_SLACK_LIVE_CAPABILITY_SMOKE=1 \
npm run smoke:slack-live-capability
```

To prove the bot can post into a disposable test channel, opt in explicitly:

```bash
MAB_SLACK_LIVE_ENV_FILE=/path/to/other-bot.env \
MAB_RUN_SLACK_LIVE_CAPABILITY_SMOKE=1 \
MAB_SLACK_LIVE_POST_TEST=1 \
MAB_SLACK_LIVE_TEST_CHANNEL=C0123456789 \
npm run smoke:slack-live-capability
```

To prove the same validated bot can enter the public Slack Agent Socket Mode
loop without replacing the existing Legacy services, run the live socket
smoke against a disposable test channel:

```bash
MAB_SLACK_LIVE_ENV_FILE=/path/to/other-bot.env \
MAB_RUN_SLACK_LIVE_SOCKET_SMOKE=1 \
MAB_SLACK_LIVE_TEST_CHANNEL=C0123456789 \
npm run smoke:slack-live-socket
```

This starts an isolated `apps/slack-agent` process, connects Socket Mode, posts
one marker message to the configured channel, waits for the live event to enter
the buffered event loop, then exits. It enables bot-message handling only inside
that smoke so the test can self-trigger; the production default still ignores
bot messages to avoid loops.

The public demo should still pass without these values.
