# Requirements

## MVP Checklist

- [x] Slack Agent is the control plane.
- [x] Slack Agent can receive a command to start a meeting bot.
- [x] Slack Agent stores workspace context: requester, meeting URL, current session ID, and worker jobs.
- [x] Slack Agent and Meeting Agent can persist local session/job state across service restart through the selected state provider (`memory`, `json-file`, or `sqlite`; `json-file` is the default local provider and `sqlite` is the single-node production store).
- [x] Meeting Agent can create a Google Meet session through a provider adapter dry-run.
- [x] Meeting Agent can create a non-dry-run Playwright session against a local Meet fixture.
- [x] Meeting Agent can inject fake camera and mic streams through Playwright in local smoke.
- [x] Meeting Agent has fixture-level Meet contract coverage for URL validation, dry-run planning, route behavior, participant audio, diagnostics, and lifecycle replacement parity.
- [x] Avatar renderer can load a Live2D model URL or fallback canvas and expose it as a camera track.
- [x] Slack Agent verifies Slack signing-secret signatures for slash command payloads.
- [x] Slack Agent has fixture-level parser/signature/command contract coverage for slash command replacement parity.
- [ ] Dialog provider bridge can connect participant audio to the selected local/API provider and return response audio/text to the fake mic.
- [x] The repo does not implement its own agent brain; complex work goes through a configured provider.
- [x] Complex work is delegated to a worker runner instead of being improvised by the realtime model.
- [x] Worker results are reported to both Slack Agent and Meeting Agent for live Realtime polling.
- [x] Realtime prompt/tool contract exists for worker delegation.
- [x] Worker completion store can poll undelivered results for Realtime auto-report.
- [x] Browser worker-result bridge can poll completed jobs and mark them delivered for Realtime consumption.
- [x] Browser Realtime bridge can convert a completed worker result into `conversation.item.create` + `response.create` events in local mock mode.
- [x] Browser Realtime bridge has a WebRTC-shaped connection state machine and data-channel seam covered by local `webrtc-mock` smoke.
- [x] Browser Realtime bridge can discover participant audio streams for Realtime input.
- [x] Browser Realtime remote audio can route into the avatar fake mic audio bus in local mock mode.
- [x] Browser Realtime bridge dedupes repeated worker results and can cancel an active response on user speech interrupt in local mock mode.
- [x] Browser Realtime bridge sends `session.update` with runtime instructions and tools after the data channel opens in local mock mode.
- [x] Browser Realtime bridge can execute `delegate_to_worker` / `worker_status` tool calls through Meeting Agent and return `function_call_output`.
- [x] Local JSON services send Private Network Access CORS headers so secure Meet pages can call localhost control-plane routes.
- [x] Browser Realtime avatar-state tools can update Hiyori/fallback mood and action state in local mock mode.
- [x] Avatar visual smoke can compare deterministic mouth/action snapshot hashes and pixel diffs in local mock mode.
- [x] Optional true Hiyori Live2D pixel smoke exists and skips cleanly when headless WebGL/CDN loading is unavailable; with `MAB_REQUIRE_HIYORI_LIVE2D=1` it becomes mandatory.
- [x] Fixture-level runtime acceptance combines join, participant audio discovery, Realtime session state, worker-result delivery, worker tool calls, and avatar state.
- [x] Local dialog bridge smoke proves synthetic local-STT utterance -> selected AgentRunner provider -> response text -> TTS fake-mic route -> Hiyori `speak` action.
- [x] Optional real Meet local-dialog smoke can join a real room and run the same provider/TTS/avatar loop without requiring an OpenAI key.
- [x] Optional real OpenAI Agents SDK Realtime smoke exists and skips cleanly without `MAB_OPENAI_API_KEY` / `OPENAI_API_KEY`.
- [x] Optional real OpenAI Realtime live tool smoke exists and skips cleanly without `MAB_OPENAI_API_KEY` / `OPENAI_API_KEY`; with a key it verifies `delegate_to_worker` reaches Meeting Agent.
- [x] Agent runner provider seam supports dry-run, Codex, Claude Code, Ollama, Slack Agent D bridge, shell-command, and HTTP backends.
- [x] Optional live AgentRunner real-task smoke can ask selected providers to summarize a transcript, verify acceptance keywords, and write reports for the cutover evidence bundle.
- [x] Provider examples document Codex, Claude Code, Ollama, Slack Agent D bridge, command, HTTP, TTS command, and real Meet local-dialog usage.
- [x] Slack Agent can poll completed Meeting Agent worker jobs, format them for Slack, and mark them delivered once.
- [x] Slack Agent has a mock/live `chat.postMessage` adapter for completed worker results with thread metadata, retry, and delivery dedup keys.
- [x] Cutover controller can run in `shadow`, `canary`, and `rollback` modes with a JSONL parity report.
- [x] Cutover can auto-rollback a selected new-stack join when Meeting Agent is down and record the fail-closed decision.
- [x] Fixture-level shadow parity runner can mirror join/work/status/stop across an old-stack fixture and the new repo.
- [x] Shadow tap receiver can accept old-stack mirrored Slack commands with a shared secret and record them without starting a second bot.
- [x] Shadow tap transmitter hook can read sanitized old-stack mirror input from stdin, stay disabled by default, and post to the side-effect-free receiver in local smoke.
- [x] Cutover evidence bundle generator can collect fixture healthz output, cutover/shadow reports, SQLite state snapshots, command logs, and a manifest into a tarball.
- [x] Every external integration is configured by environment variables or adapter config.

## Required Adapters

- [x] `SlackControlPlane`
- [x] `GoogleMeetJoiner`
- [ ] `DialogProviderBridge`
- [ ] `Live2DAvatarRenderer`
- [x] `AgentRunnerProvider`

## Acceptance Criteria

- [x] A developer can clone the repo and run `vp run doctor`.
- [x] A developer can run Slack Agent and Meeting Agent locally without internal workspace credentials.
- [x] A mocked Slack command can create a meeting session record.
- [x] Slack Agent can hand off that session to Meeting Agent locally.
- [x] A mocked worker delegation can complete and report status.
- [x] Slack control-plane smoke covers join/status/stop/help and natural-language work routing.
- [x] Slack control-plane smoke rejects a bad Slack signature and accepts a valid signed slash command.
- [x] Slack contract smoke covers quoted parser flags, URL-encoded slash payloads, valid/bad/stale signatures, command edge cases, worker handoff, and worker result deduplication.
- [x] Local Meet fixture smoke covers non-dry-run Playwright join, injected media, diagnostics, and stop-before-start.
- [x] Meet contract smoke covers URL validation, dry-run plan shape, Meeting Agent route behavior, fixture participant audio, diagnostics artifacts, replacement stop, and status/stop lifecycle.
- [x] Handoff checklist documents default CI, local services, provider demos, fixture Meet, optional real Meet, optional Slack live acceptance, and cutover readiness checks.
- [x] Persistence smoke covers Slack sessions and worker jobs surviving service restart.
- [x] Worker bridge smoke covers browser polling of a completed job into the runtime bridge.
- [x] Realtime browser smoke covers worker-result injection into browser-side Realtime events.
- [x] Realtime WebRTC smoke covers data-channel delivery without requiring real OpenAI tokens.
- [x] Realtime participant-audio smoke covers browser discovery of meeting participant audio streams.
- [x] Realtime audio-route smoke covers remote-audio-to-fake-mic bus plumbing without requiring real OpenAI tokens.
- [x] Realtime repeat-guard smoke covers duplicate worker result suppression and response cancellation event emission.
- [x] Realtime session-update smoke covers data-channel registration of instructions and tools.
- [x] Realtime worker-tool smoke covers model-style worker delegation and status tool calls.
- [x] Avatar-state smoke covers Realtime `update_avatar_state` tool output and runtime mood/action update.
- [x] Avatar-visual smoke covers mouth/action visual diff gates and snapshot hashes.
- [x] Runtime-acceptance smoke covers the joined fixture runtime as one integrated contract.
- [x] Slack-result smoke covers Slack-side polling, user-facing worker result formatting, and duplicate-delivery suppression.
- [x] Slack-posting smoke covers mock thread posting, Slack delivery metadata, and duplicate post suppression.
- [x] Cutover-shadow smoke covers shadow-mode old-primary behavior, rollback behavior, 100% canary new-primary behavior, and report recording.
- [x] Cutover-rollback smoke covers new-stack failure, automatic old-stack-primary fallback, and report recording.
- [x] Shadow-parity smoke covers fixture-level old/new control-plane parity for join, delegate, jobs, and stop.
- [x] Shadow-transmitter smoke covers old-stack mirror payload construction, receiver auth, private-field stripping, side-effect suppression, and report recording.
- [x] Cutover-evidence smoke covers fixture-safe evidence bundle generation and manifest/artifact checks.
- [x] Agent-provider smoke covers dry-run, command, HTTP, Claude Code, Ollama, and Slack Agent D bridge runner contracts.
- [x] Realtime Agents SDK smoke can be run against real OpenAI Realtime or a compatible Realtime endpoint when `MAB_OPENAI_API_KEY` / `OPENAI_API_KEY` is present, without making public CI depend on secrets.
- [x] Realtime live-tool smoke can be run against real OpenAI Realtime or a compatible Realtime endpoint when `MAB_OPENAI_API_KEY` / `OPENAI_API_KEY` is present, without making public CI depend on secrets.
- [x] Slack live-capability smoke can validate a separate bot key via `auth.test`
      and optional Socket Mode URL issuance without touching the existing
      Legacy Slack Agent D / Meet D services.
- [x] Slack live-socket smoke can start an isolated `apps/slack-agent` Socket
      Mode loop, self-trigger one test-channel event, and verify it reaches the
      buffered event path without replacing the existing Legacy services.
- [x] No private tokens, workspace names, or private prompts are required for local smoke tests.

## Full Replacement Criteria

- [ ] Real Slack Agent D parity: Slack app command/event flow, persistent workspace sessions, permissions, status reporting. Current slice covers signed slash-command HTTP semantics, parser/signature/command contract matrix, local JSON persistence, low-side-effect live bot-key capability checks, isolated Socket Mode event-loop smoke, and mock/live `chat.postMessage` result posting seam, not full OAuth/permissions cutover.
- [ ] Real Meet D parity: non-dry-run Google Meet join, single-bot lifecycle guard, diagnostics, stop/rejoin behavior. Current slice covers local fixture non-dry-run join, stricter Meet contract matrix, lifecycle, diagnostics, participant audio seam, and optional real-room smoke through `MAB_REAL_MEET_URL vp run smoke:real-meet`. Full production acceptance still needs a scheduled room with waiting-room/admit policy and real Realtime speech.
- [ ] Realtime/dialog parity: browser WebRTC audio bridge, interrupt/repeat protection, model/tool state reflected in Hiyori. Current slice covers the browser connection/data-channel seam in mock mode, session.update tool registration, participant audio discovery, a mock remote-audio route into the avatar fake mic bus, duplicate worker-result suppression, user-speech response cancellation, avatar mood/action tool state, local dialog provider -> TTS provider audio buffer -> fake mic -> Hiyori `speak` action, an optional true Hiyori Live2D pixel smoke, and optional real Realtime smokes; real participant speech STT acceptance still remains open.
- [ ] Worker parity: complex requests delegate to a user-selected provider, report in Slack, and are spoken in meeting when ready. Current slice covers dry-run/Codex/Claude Code/Ollama/Slack Agent D bridge/command/HTTP provider selection, local-dialog provider responses spoken through the fake mic seam, browser-side polling/delivery, model-style `delegate_to_worker` / `worker_status` calls for Realtime-compatible providers, data-channel-shaped event creation, and Slack-side polling/formatting/posting/deduplication of completed Meeting Agent jobs; production TTS/STT provider and live Slack token acceptance remain open.
- [ ] Shadow-mode parity: new repo matches or beats the existing stack on the same demo checklist. Current slice has cutover feature flags, report plumbing, fixture-level old/new control-plane comparison, side-effect-free receiver, and env-gated transmitter hook; old Slack Agent D hook wiring and real old/new stack comparison remain open.
- [ ] Cutover: demo/runbook uses only the new repo, with old stack kept only as rollback reference.
