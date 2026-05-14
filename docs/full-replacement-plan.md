# Full Replacement Plan

Goal: the open-source `meeting-avatar-bot` repo must fully replace an existing private Slack Agent D and Meet D deployment. The Slack Agent D infrastructure should be ported into this repo, but the agent brain / complex worker backend should be a selectable AgentRunner with Codex as the primary path, not the old private framework loop.

This is a cutover plan, not a parallel proof-of-concept. Shadow mode is allowed only as a temporary verification phase before replacement.

Current cutover rule: do not disable or bypass the existing Slack
Agent D / Meet D capabilities while validating this migration. First verify
feature availability with another Slock/Slack bot key through
`npm run smoke:slack-live-capability`; only promote entrypoints after explicit
approval.

## Current Replacement Status

The high-level replacement inventory is in
[docs/parity-inventory.md](parity-inventory.md).

| Area                            | Current repo status                                                                                                                                                                                                                                                                                                       | Replacement status |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Slack control plane             | `/avatar join/status/stop/help` dry-run command contract, natural-language mention routing, and mock/live Slack result poster seam                                                                                                                                                                                        | Partial            |
| Session lifecycle               | Replaceable state provider (`memory` / `json-file` / `sqlite`) and restart persistence smoke                                                                                                                                                                                                                              | Partial            |
| Google Meet joiner              | Playwright adapter, dry-run plan, strict Meet contract matrix, local non-dry-run fixture smoke, optional real-room smoke, diagnostics, stop-before-start guard                                                                                                                                                            | Partial            |
| Hiyori avatar camera/mic        | Browser fake mic/cam smoke + fallback visual hash gate + optional true Live2D pixel smoke                                                                                                                                                                                                                                 | Partial            |
| Dialog provider                 | Provider-selected speech/text route; OpenAI Realtime is optional and configurable through an OpenAI-compatible base URL                                                                                                                                                                                                   | Partial            |
| Background work routing         | Bring-your-own agent runner seam (`dry-run`, `codex`, `claude`, `ollama`, `slack-agent-d`, `command`, `http`) + worker report store + browser worker-result polling bridge + Realtime data-channel-shaped event injection + browser worker tool execution seam + Slack-side completed-job polling/formatting/posting seam | Partial            |
| Cutover / production deployment | Shadow/canary/rollback decision controller + auto-rollback fail-closed smoke + JSONL cutover report smoke + fixture-level old/new parity runner + side-effect-free shadow tap receiver + env-gated transmitter hook                                                                                                       | Partial            |

## Replacement Gates

- [ ] **Gate 1: Slack Agent D parity**
  - [x] Slack signing-secret verification for slash-command payloads.
  - [x] Low-side-effect live capability smoke for another bot key: `auth.test`
        and optional `apps.connections.open` without touching old services.
  - [x] Isolated Socket Mode live-loop smoke for another bot key and test
        channel, without touching old services.
  - [ ] Real Slack app integration: Socket Mode or Events API.
  - [ ] Slash command and mention command routing.
  - [ ] Workspace-aware permission checks.
  - [x] Local persistent session/job store with json-file and SQLite providers.
  - [x] Mock/live `chat.postMessage` adapter for result reporting into Slack threads/channels.
  - [ ] Live Slack workspace acceptance for result reporting into Slack threads/channels.
  - [ ] Acceptance: a real Slack command can start/inspect/stop a meeting session, while a natural-language mention can trigger heavier background work without exposing worker commands.

- [ ] **Gate 2: Meet D parity**
  - [x] Local non-dry-run Playwright join fixture.
  - [x] Fixture-level Meet contract matrix for URL validation, dry-run plan shape, route behavior, participant audio seam, diagnostics, replacement stop, and stop/status lifecycle.
  - [x] Single active bot lifecycle guard: stop old bot before starting a new one.
  - [x] Real Google Meet join with `--dry-run false` behind `MAB_REAL_MEET_URL npm run smoke:real-meet`.
  - [ ] Guest name, admit/waiting-room, rejoin, and leave handling.
  - [x] Diagnostic screenshots/logs/button inventory for join failures.
  - [x] Acceptance: the new repo can join a real Meet URL as Hiyori/fallback camera without using the old spike.
  - [ ] Production acceptance: run the same gate in a scheduled canary room with clear waiting-room/admit policy and real Realtime speech enabled.

- [ ] **Gate 3: Realtime audio/avatar parity**
  - [x] OpenAI Realtime is an optional provider, not the built-in agent brain.
  - [x] OpenAI-compatible endpoint selection through `MAB_OPENAI_BASE_URL`.
  - [x] Realtime 2 contract defaults: `gpt-realtime-2`, nested audio session config, `semantic_vad`, `marin`, and `reasoning.effort=high`.
  - [x] Browser-side Realtime connection state machine and data-channel seam in local mock mode.
  - [x] Browser-side meeting participant audio discovery seam.
  - [x] Browser-side remote audio can route into the avatar fake mic audio bus in local mock mode.
  - [x] Optional real OpenAI Realtime SDP smoke command that skips without `MAB_OPENAI_API_KEY` / `OPENAI_API_KEY`.
  - [x] Browser-side duplicate worker-result suppression and user-speech response cancellation guard in local mock mode.
  - [x] Browser-side session.update registration for instructions and tools in local mock mode.
  - [x] Browser-side avatar mood/action tool bridge in local mock mode.
  - [x] Avatar visual smoke that gates deterministic mouth/action snapshot hashes and visible pixel diffs.
  - [x] Optional true Hiyori Live2D pixel smoke that can be forced with `MAB_REQUIRE_HIYORI_LIVE2D=1` on a WebGL-capable runner.
  - [x] Fixture-level runtime acceptance smoke that combines join, participant audio, worker-result delivery, worker tool calls, and avatar state.
  - [x] Browser-side worker tool bridge for `delegate_to_worker` / `worker_status` in local mock mode.
  - [x] Optional real Realtime live-tool smoke that verifies `delegate_to_worker` can traverse the real data channel when `MAB_OPENAI_API_KEY` / `OPENAI_API_KEY` is present.
  - [x] Local dialog bridge smoke that sends a synthetic local-STT utterance to the selected AgentRunner provider, synthesizes provider audio through `/tts/synthesize`, routes the decoded buffer into the fake mic, and drives Hiyori `speak` action without OpenAI API keys.
  - [x] Optional real Meet + local dialog smoke that clicks into a real Meet room and runs the same local provider/TTS/avatar loop behind `MAB_REAL_MEET_URL`.
  - [ ] Browser-side OpenAI Realtime WebRTC connection with real SDP exchange.
  - [ ] Meet participant audio forwarding into Realtime.
  - [x] Selected local TTS provider seam (`tone-wav`, command, or HTTP) routed to fake mic in local provider mode.
  - [ ] Real speech-recognition input from Meet participant audio into the selected provider.
  - [ ] Interrupt/repeat protection accepted in a real Meet + OpenAI Realtime session.
  - [ ] Hiyori mouth/expression/action state accepted in a real Meet + OpenAI Realtime session.
  - [ ] Acceptance: in a real Meet, the bot hears, answers once, mouth moves while speaking, and can be interrupted.

- [ ] **Gate 4: Background work routing parity**
  - [x] Agent runner provider seam supports dry-run, Codex, Claude Code, Ollama, Slack Agent D bridge, shell-command, and HTTP backends.
  - [x] Realtime tool call starts a worker job in local mock mode.
  - [x] Slack Agent can poll completed Meeting Agent worker jobs and format status/result for Slack.
  - [x] Slack Agent can post completed worker results through a Slack poster adapter with `channel`, `thread_ts`, retry, and dedup key.
  - [x] Meeting Agent exposes completed job polling for browser runtime.
  - [x] Meeting Agent exposes completed job polling for Slack delivery and marks `deliveredToSlack`.
  - [x] Browser runtime polls completed jobs and marks them delivered.
  - [x] Browser runtime converts completed job results into Realtime `conversation.item.create` + `response.create` events and sends them over the data-channel seam in local mock mode.
  - [x] Browser runtime converts model-style `delegate_to_worker` / `worker_status` calls into Meeting Agent requests and returns `function_call_output` in local mock mode.
  - [x] Browser runtime has an optional real Realtime live-tool smoke for `delegate_to_worker` when `MAB_OPENAI_API_KEY` / `OPENAI_API_KEY` is present; the smoke can run the selected AgentRunner provider (for example `MAB_AGENT_RUNNER=codex`) instead of the dry-run worker.
  - [ ] Meeting Agent injects completed job result into the actual OpenAI Realtime data channel.
  - [ ] Bot proactively reports the result in the live meeting.
  - [ ] Acceptance: a complex request completes through the selected provider, appears in Slack, and is spoken by Hiyori without user polling or provider-specific commands.

- [ ] **Gate 5: Shadow mode**
  - [x] Feature flag for `new` / `shadow` / `canary` / `rollback` routing.
  - [x] Shadow mode keeps old stack primary and suppresses new Meeting Agent side effects in CI.
  - [x] Rollback mode keeps old stack primary and records rollback decisions in CI.
  - [x] Auto-rollback mode keeps old stack primary when a selected new-stack join fails and records the original decision plus rollback decision.
  - [x] Canary mode can route a deterministic percentage of sessions to the new stack.
  - [x] Cutover JSONL report is exposed through Slack Agent diagnostics.
  - [x] Fixture-level old-stack runner mirrors join/work/status/stop against the new repo and emits a parity report.
  - [x] Shadow tap receiver accepts old-stack mirrored Slack commands and records a side-effect-free report.
  - [x] Shadow transmitter hook builds sanitized old-stack mirror payloads from stdin and posts them to the side-effect-free receiver in smoke.
  - [ ] Run old stack and new repo against the same demo checklist.
  - [ ] Compare join reliability, duplicate bot behavior, audio repeats, latency, avatar visibility, and worker reporting from the report.
  - [ ] Record blockers with logs/screenshots.
  - [ ] Acceptance: new repo matches or beats the old stack on the demo checklist.

- [ ] **Gate 6: Cutover**
  - [ ] Switch launch/runbook to the new repo.
  - [ ] Keep rollback command for the old stack.
  - [ ] Archive old spike as historical reference only.
  - [ ] Acceptance: a real demo can be run end-to-end from the new repo and does not depend on old spike processes or files.

## Implementation Checklist

- [ ] Phase R0: inventory old Slack Agent D / Meet D behavior and map each capability to the new repo.
- [ ] Phase R1: implement real Slack app adapter and production backup/retention policy beyond local SQLite.
- [x] Phase R2: port real Meet joiner runtime and lifecycle guard through local fixture + optional real-room smoke.
- [ ] Phase R3: port browser Realtime/audio/avatar runtime from the old spike into public-safe modules.
- [x] Phase R3.1: add optional true Hiyori Live2D pixel smoke with renderer state reporting.
- [x] Phase R4.1: first worker delegation result loop across Slack Agent, Meeting Agent, and Realtime.
- [x] Phase R4.2a: mock/live Slack thread/channel posting seam.
- [ ] Phase R4.2b: live Slack token acceptance and real meeting spoken-result acceptance.
- [x] Phase R5.1: add shadow/canary/rollback feature flags and cutover report smoke.
- [x] Phase R5.2a: add fixture old-vs-new shadow parity runner and report.
- [x] Phase R5.2b-a: add side-effect-free shadow tap receiver contract.
- [x] Phase R5.2b-b-hook: add runnable env-gated transmitter hook, smoke, and legacy hook patch plan.
- [ ] Phase R5.2b-b: wire the hook into old Slack Agent D and run real old-vs-new shadow demo runner after approval.
- [ ] Phase R6: cutover runbook, rollback runbook, and old-stack deprecation note.
- [x] Phase R6.1: document shadow/canary/new/rollback execution checklist and evidence requirements.

## Non-Negotiables

- New repo must be the only runtime used after cutover.
- No hidden dependency on old spike files, old tmux sessions, or local absolute paths.
- No bundled private tokens, internal prompts, or private workspace-specific assumptions.
- Dry-run smoke remains available, but production acceptance must include real Slack and real Meet.
