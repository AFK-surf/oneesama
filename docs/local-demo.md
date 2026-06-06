# Local Demo Runbook

This runbook uses only public configuration and dry-run defaults. It does not require internal workspace credentials.

## 1. Install

```bash
vp install
cp .env.example .env
vp run doctor
```

`doctor` is warning-only. Missing OpenAI and Slack tokens are expected when running the local smoke suite.

## 2. Run The Smoke Suite

```bash
vp run ci
```

`vp run ci` installs the Playwright Chromium runtime if it is missing, then runs the full smoke suite.

This verifies:

- local session + dry-run background work routing
- Local Operator Surface startup, operator-side visual composition, debug panel,
  KWWK overlay, and voice WebSocket telemetry
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
vp run dev:meeting
```

Terminal B:

```bash
vp run dev:slack
```

Terminal C, for the single-machine Local Operator Surface:

```bash
vp run dev:local-operator
```

`dev:local-operator` binds to `127.0.0.1:18913` by default. Open
`http://127.0.0.1:18913/operator` on the same Mac that runs Oneesama. The root
path remains a compatibility alias for the same app. Non-loopback
binding is a legacy diagnostic mode and is not the Local Operator RFC
acceptance path. Runtime status and debug reports expose bind mode,
`localOnlyMode`, loopback URL, and reachability blockers in
`summaries.surfaceContext`.

By default the Local Operator Surface is key-aware: if `MAB_OPENAI_API_KEY` or
`OPENAI_API_KEY` is configured, `dev:local-operator` selects
`openai_realtime`; without a key it starts the Diagnostic Conversation Engine
and marks the fallback as `openai_realtime_api_key_missing` in startup JSON,
runtime status, and Debug Reports. To force a specific replaceable Conversation
Engine transport, set `MAB_LAN_OPERATOR_TRANSPORT` explicitly:

```bash
MAB_LAN_OPERATOR_TRANSPORT=openai_realtime \
MAB_OPENAI_API_KEY=... \
MAB_LAN_OPENAI_REALTIME_MODEL=gpt-realtime-2 \
vp run dev:local-operator
```

The local live transport uses the GA Realtime WebSocket endpoint and forwards
operator PCM chunks as `input_audio_buffer.append`. It does not use the removed
`OpenAI-Beta: realtime=v1` header. `OPENAI_API_KEY` is accepted when
`MAB_OPENAI_API_KEY` is not set. For deterministic local gate runs without a
provider, set `MAB_LAN_OPERATOR_TRANSPORT=mock` or use the gate scripts, which
construct the Diagnostic Conversation Engine explicitly.

To collect a strict live-provider evidence report from the Local Operator
Surface, run:

```bash
MAB_OPENAI_API_KEY=... \
vp run acceptance:realtime-local-openai-live
```

This starts the Local Operator Surface with `openai_realtime`, connects to the
GA Realtime WebSocket transport, sends a typed operator turn through the same
surface event port as the Debug Panel, requests text-only `response.create`, and
requires `session.created`, provider text-response events, raw-event drill-down
summaries, canonical event mapping, and no diagnostic fallback. It writes
`/tmp/oneesama-realtime-local-openai-live-latest.json`. Without an OpenAI key,
the strict command fails; use `vp run acceptance:realtime-local-openai-live:optional`
only for local diagnostics. The optional command exits 0 for a missing-key skip
but still writes `ok:false` and `acceptanceSatisfied:false`, so it does not count
as acceptance evidence.

The operator UI includes microphone device selection, explicit arm/disarm,
mute/unmute, diagnostic push-to-talk, typed debug text input, and an optional
Local VAD telemetry toggle. Local VAD defaults off because Realtime turn
formation belongs to the configured Conversation Engine; when enabled, it is
UI/debug telemetry only. Typed text is also a feedback/debug aid, and the
primary local voice gates still require Operator Voice Input evidence.

To publish a one-way Host Visual Stream from the host Mac, open
`http://127.0.0.1:18913/host-visual` on the host and click `Share Display`.
The Local Operator Surface receives the source over WebRTC and composes it into
the movable operator-side canvas/video track. Raw Host Visual Stream tracks are
inputs; the Operator Composed Video Track synthesized by the Local Operator
Surface is the user-side synthesized output for local layout, future sharing,
recording, or export. Move/resize/focus changes happen in that browser before
`canvas.captureStream()`, so the host does not need to recapture when the
operator changes the layout. For an automated diagnostic track that does not
require display-capture permission, open
`http://127.0.0.1:18913/host-visual?diagnostic=1`.
To publish the avatar renderer over the same Host Visual Stream lane, open
`http://127.0.0.1:18913/host-visual?avatar=1&sourceId=avatar&label=Avatar&kind=avatar`.
For fallback/debug-only evidence, the older diagnostic avatar canvas can still
be opened with `diagnostic=1&sourceId=avatar&label=Avatar&kind=avatar`.
The local Host Visual Stream acceptance gate opens both host-app and avatar
publishers, moves/resizes the avatar source in the operator browser, emits a
KWWK overlay, and requires both WebRTC tracks plus the local Operator Composed
Video Track to stay live. The avatar source must report
`avatarSourceMode:"avatar_renderer"` and a renderer name, so diagnostic avatar
canvas evidence cannot satisfy Gate 2 by itself. The report records
`layoutRevision`, `focusedSourceId`, `sourceRects`, `overlayCount`,
`trackReadyState`, and explicit `operatorScreenBackflow:false` evidence.
If the publisher's signaling WebSocket drops, the page reconnects and
renegotiates the current display/canvas stream automatically, so a transient
local WebSocket hiccup should not require sharing the source again.

To make Host Visual Stream a real display/app-capture gate, use `Share Display`
for the host-app publisher, then run:

```bash
vp run acceptance:realtime-local-host-visual-stream:display
```

That stricter mode adds `--require-display-capture`, requires
`visual.hostSourceMode:"display_capture"` plus
`visual.hostCaptureStatus:"live"`, and writes
`/tmp/oneesama-realtime-local-host-visual-stream-display-latest.json`. A
diagnostic host-app canvas or failed screen-share permission prompt cannot
satisfy this stricter gate. Capture attempts, status, and errors are copied into
the Debug Panel and report as `captureStatus`, `captureError`, and
`captureAttemptCount`.

The Debug Panel can copy or download a JSON report for a live run. The same
payload is available at `http://127.0.0.1:18913/runtime/report`; use
`Open Debug` in the surface toolbar to focus the embedded panel, and use `Mark`
in the panel to tag interesting moments before exporting.
Use the Debug Panel filter box to narrow dense rows by blocker, layer, event,
tool, or source text such as `verification`, `output_audio`, `kwwk`, or
`display_capture`. Gate 5 exercises this browser-visible filter and requires
`debug_panel_filter_observed` in the SLO report.
Gate 5 also records `conversationEngine.diagnosticCanonicalParity` and requires
`diagnostic_canonical_event_parity_observed`, proving the Diagnostic
Conversation Engine emitted the same canonical event vocabulary needed by live
engines, including failure injection through `engine_error`, without leaking
provider raw events across the port boundary.
Its Transport section shows the local surface/session id, host URL, events/voice/
visual WebSocket state, reconnect/connect counts, last packet time, and
event-channel RTT, which is the first place to look when the operator UI
feels quiet or stale.
Its Voice Input section shows mic permission/device, energy, Local VAD telemetry
state, capture mode, chunk/drop counts, host chunks/gaps, voice reconnects, and
host receive lag plus voice chunk ACK RTT. The report exposes the same evidence
as `audio.hostReceiveLagMs` / `audio.maxHostReceiveLagMs`, measured from
operator-browser `sentAt` to host `receivedAt`, and `audio.voiceAckRttMs` /
`audio.maxVoiceAckRttMs`, measured on the operator browser's own clock from
chunk send to host ack. It also shows the active voice stream generation and
stale chunk rejection count so reconnects cannot silently mix old audio into a
new stream.
Its Turn Correlation section groups timeline rows by `turnId` and shows whether
the latest utterance reached heard, speech, transcript, tool, KWWK, and output
milestones, including explicit KWWK verification when the helper reports
verification evidence.
Its Turn Timeline section expands recent turns into row-level timelines, so a
single turn shows every `layer/event`, turn-relative duration, blocker/status,
response id, row id, and compact detail keys instead of only a milestone chain.
Its Conversation Turn section expands the latest turn into engine/transport,
session, response id, user transcript, assistant transcript, speech-start count,
and cancel/interruption state.
Its Conversation Engine Port section shows canonical event counts, the latest
canonical event, provider adapter kind, provider event-type counts, and raw-event
drill-down availability. Provider rows are summarized by provider/source label
and event type. The Provider Raw Event Drilldown table adds safe raw-event
summaries such as provider event id, call id, tool name, status/reason/error,
and detail keys; raw provider payloads stay out of the default panel and
acceptance scoring remains canonical-first.
Conversation Engine lifecycle controls are available through
`window.MAB_LAN_OPERATOR_SURFACE.sendEngineControl(...)` for `connect`,
`disconnect`, `reconnect`, `cancel_response`, `clear_audio_buffer`,
`reset_session`, `set_voice_armed`, and `set_voice_muted`. The visible Debug
Panel buttons currently expose cancel, clear, and reset; arm/disarm and
mute/unmute controls emit the voice-mode controls automatically after local
capture state changes. All controls report command counts, in-flight state,
latest result, detail payload, and canonical lifecycle events through the same
debug state.
The `Cancel Tool` control sends a `tool_cancel` request for the current tool
call/KWWK job and delivers a `status:"cancelled"` tool result back through the
Conversation Engine Port, so the model does not keep waiting for a missing
function output. Gate 4 also records executor-level hard-stop evidence from a
running KWWK/CU helper process: `kwwk.hardCancel` captures the cancelled job id,
call id, requested signal, exit signal, whether a response arrived before
cancel, and duration, and the SLO row `kwwk_hard_cancel_observed` is required.
The exported report also includes `summaries.surfaceContext`, which captures the
current focused visual source, Host Visual Stream state, Operator Visual
Composition track/layout state, local bind mode, and voice/operator mode at the
port boundary.
The Debug Panel benchmark also emits a Gate 5 `failureMatrix` covering audio
input, Conversation Engine, tool routing, KWWK planner, KWWK execution,
verification, and output audio. Each observed layer records the timeline layer,
event, blocker, row id, and timestamp; the SLO gate fails if any layer is
missing or if no report copy/download artifact was observed.
For bad turns, the report exposes `summaries.primaryBlocker` and the panel shows
a `Primary blocker` row in Conversation Turn. The V1 policy chooses the latest
blocker row inside the latest blocked/failed turn, then maps KWWK blockers into
operator-facing layers (`kwwk_planner`, `kwwk_execution`, or `verification`) so
the operator sees exactly one first place to look while the timeline keeps all
candidate blockers.
Large artifacts stay out of the copied/downloaded report body. Use
`window.MAB_LAN_OPERATOR_SURFACE.registerArtifactLink(...)` to attach a
linked-only manifest entry with label, kind, href, byte count, content type, and
reason. The exported report exposes these under
`summaries.artifactPolicy` with `inlineByteLimit:64000`; Gate 5 SLO fails if
large artifact payloads are inlined instead of linked.
Use `window.MAB_LAN_OPERATOR_SURFACE.createDebugBundle(...)` to create a bundle
manifest that indexes the debug report, timeline rows, turn correlation,
summaries, failure matrix, SLO scoring, and linked large artifacts. The report
exposes this under `summaries.artifactBundle`; Gate 5 requires the manifest so
live debugging artifacts are navigable instead of being a single opaque JSON
blob.
Gate 5 also records `debugPanel.embedded` and `debugPanel.openedFromSurface`;
the benchmark clicks the surface `Open Debug` control before scoring, so a
detached or unreachable panel fails even if telemetry rows still exist.

To run the current single-machine Local Operator acceptance artifacts:

```bash
vp run acceptance:realtime-local-voice
vp run preflight:realtime-local-real-mic # fast system/browser mic readiness probe
vp run acceptance:realtime-local-voice:real-mic # headed human-device mic gate
vp run acceptance:realtime-local-host-visual-stream
vp run benchmark:realtime-local-tool-routing
vp run benchmark:realtime-local-kwwk-action
vp run acceptance:realtime-local-kwwk-action:real-mic # headed spoken app-control gate
vp run benchmark:realtime-local-debug-panel
vp run benchmark:realtime-local-slo-suite
vp run acceptance:realtime-local-openai-live # strict live-provider gate, requires key
vp run acceptance:realtime-local-rfc:audit # strict final RFC evidence audit
```

The RFC audit writes
`/tmp/oneesama-realtime-local-rfc-acceptance-audit-latest.json`. It is expected
to fail until all required local artifacts are present: the five automated
local gates, the two human-device real-mic gates, the local SLO suite, real
display-capture Host Visual Stream evidence, and strict valid-key OpenAI
text/voice/tool reports.
When a real-mic gate fails with
`real_microphone_input_energy_below_threshold`, the audit copies the selected
mic label, browser-visible input labels, max energy, threshold, and
`MAB_LAN_OPERATOR_MIC_LABEL` / `MAB_LAN_OPERATOR_MIC_DEVICE_ID` recovery
commands into `requiredFailures[].failureDetail` and `nextActions[]`.
Run `vp run preflight:realtime-local-real-mic` first when debugging input
device state; it writes
`/tmp/oneesama-realtime-local-real-mic-preflight-latest.json` with macOS
`system_profiler` input devices, browser `audioinput` devices, default input,
and a blocker such as `macos_no_real_microphone_input` before spending time on
the longer human-device gates.

These write `/tmp/oneesama-realtime-local-voice-latest.json` and
`/tmp/oneesama-realtime-local-host-visual-stream-latest.json` plus
`/tmp/oneesama-realtime-local-tool-routing-latest.json` and
`/tmp/oneesama-realtime-local-kwwk-action-latest.json` plus
`/tmp/oneesama-realtime-local-debug-panel-latest.json` with local report
schemas. They use Chromium fake mic, the Diagnostic Conversation Engine,
host-app diagnostic plus avatar-runtime WebRTC publishers, diagnostic tool-call
events, a lightweight host KWWK/CU helper action, and a browser-visible dense
Debug Panel assertion, so they validate the Local Operator Surface
voice/visual/tool-routing/KWWK/debug contracts before live OpenAI Realtime is
required.
Gate 5 also proves diagnostic canonical parity with all required canonical
voice, transcript, assistant, tool, tool-result, and error events. Gate 1 and
Gate 2 reports also include
`local_operator_surface_reachability_observed`, backed by
`host.reachability` / `summaries.surfaceContext.lanReachability`. This proves
the surface advertises how it can be reached.
report now separates
`functionalOk` from `slo.ok`; the final `ok` is true only when the functional
gate passes and required UX SLO evidence is present and under threshold.
Each report also includes `perceivedUx`, a compact operator-facing summary of
required stages: first feedback timing, measured/missing stage counts, failed
stage ids, and the slowest required stage. Use this before scanning raw
`slo.entries` when a run passed but still felt quiet or slow. The SLO suite
also aggregates `perceivedUx.firstFeedbackP50Ms` and
`perceivedUx.firstFeedbackP95Ms` across reports.
Gate 1 runs with Local VAD disabled by default and requires
`operator_voice_local_vad_not_required`, proving WebSocket PCM chunks still
forward and produce Conversation Engine speech/output while local VAD is not
active. Use `vp exec tsx scripts/lan-operator-voice-acceptance.mjs --local-vad enabled`
only to diagnose the telemetry UI; that mode does not prove the V1 acceptance
invariant.
To run the human-device microphone check, use:

```bash
vp run acceptance:realtime-local-voice:real-mic
```

This headed gate opens `/operator`, does not pass Chromium
`--use-fake-device-for-media-stream`, requires the browser to record
`microphone_pcm16`, and fails unless `audio.maxInputEnergy` crosses
`audio.inputEnergyThreshold` at least once. It writes
`/tmp/oneesama-realtime-local-voice-real-mic-latest.json` and adds the required
SLO row `operator_voice_real_microphone_energy_observed` only for real-mic
runs. Speak a short prompt after the window opens; the default automated gate
remains `acceptance:realtime-local-voice` because it is deterministic and does
not depend on a physical microphone or OS permission state.
If Chromium selects the wrong input device, set
`MAB_LAN_OPERATOR_MIC_LABEL` or pass `--mic-label <label-fragment>` to the
underlying script. The real-mic report records selected device label, browser
audioinput candidates, `audio.maxInputEnergy`, and
`real_microphone_input_energy_below_threshold` when the browser is only hearing
silence or a virtual input.
Gate 1 also records `audio.hostReceiveLagMs` and requires
`operator_voice_host_receive_lag_ms` to stay under threshold, so audio ingress
delay is separated from Conversation Engine or output latency.
It also records `audio.voiceAckRttMs` and requires
`operator_voice_ack_rtt_ms`, measured on the operator browser's own clock.
Gate 1 also requires `operator_voice_fresh_stream_observed`: the report must
show an active `audio.voiceStreamId`, a stream generation, and zero stale chunk
rejections for the accepted run.
Gate 1 now also requires `assistant_audio_playback_observed` when assistant
audio output is enabled. The acceptance report records
`output.assistantAudio.chunksReceivedDelta`,
`output.assistantAudio.chunksPlayedDelta`, received bytes, playback status, and
RMS/peak output energy so the run proves the Local Operator Surface actually
played assistant audio, not only rendered assistant text.
The KWWK action benchmark submits the host helper result back through the
Conversation Engine Port as `tool_result`, so missing post-action assistant
follow-up can be distinguished from missing host execution.
For the spoken app-control human-device check, use:

```bash
vp run acceptance:realtime-local-kwwk-action:real-mic
```

This headed gate opens `/operator`, requests the real microphone, waits until
`spokenInput.maxInputEnergy` crosses `spokenInput.inputEnergyThreshold`, then
routes the bounded fixture command through the same canonical
`kwwk_computer_use` path. It writes
`/tmp/oneesama-realtime-local-kwwk-action-real-mic-latest.json` and requires
`spoken_app_control_real_microphone_observed` only in real-mic mode.
It accepts the same `MAB_LAN_OPERATOR_MIC_LABEL` /
`MAB_LAN_OPERATOR_MIC_DEVICE_ID` environment variables as the voice gate when a
specific browser audioinput must be selected before arming the microphone.
It also requires a compact assistant follow-up after verified action:
`operator_final_response_after_verified_action_ms` measures the time from a
`kwwk_completed` timeline row to the next `assistant_text_completed`, and
`kwwk_compact_followup_observed` requires the exported
`output.compactFollowUpText` to be short and present.
The same report separates `kwwk.cold` and `kwwk.warm`: cold timing includes
helper binary setup/spawn plus the first request, while warm timing is the
second request in the same helper process. The SLO gate requires both
`cold_simple_app_action_verified_ms` and `warm_simple_app_action_verified_ms`.
The TextEdit fixture keeps full screenshot/context observation on the cold
request only; warm uses AX/light observation so the steady-state latency SLO
does not repeatedly pay ScreenCaptureKit capture cost.
It also requires `kwwk_phase_evidence_observed`, backed by compact
`metadata.state`, `metadata.planner`, and `metadata.actionTelemetry`, plus
`real_kwwk_job_state_observed`, backed by cold/warm helper state source,
KWWK core execution surface, verification schema, and verified host mutation,
plus
`kwwk_in_flight_phase_progress_observed`, backed by
`kwwk.inFlightProgress.phasesBeforeResponse` and timeline rows whose phase
evidence source is `host_helper_in_flight_stream`, plus
`kwwk_cursor_action_feedback_observed`, backed by latest action kind/count,
cursor event count, and cursor policy for pointer or no-pointer actions, plus
`kwwk_hard_cancel_observed`, backed by `kwwk.hardCancel` process-termination
evidence from the helper hard-cancel probe, plus
`kwwk_phase_blocker_matrix_observed`, backed by
`kwwk.phaseBlockers.entries` for observe/plan/execute/verify blockers and
rejecting helper-timeout-only evidence, plus
`kwwk_verification_evidence_observed`, backed by the helper's
`metadata.verification` and the Debug Panel `kwwk_verifying` timeline rows.
Gate 3 and Gate 4 also require `canonical_tool_boundary_observed`. The report
field `tool.canonicalBoundary` proves KWWK receives provider-agnostic
Conversation Engine Port tool events, not provider raw events, raw operation
arrays, or exposed coordinates.
By default the benchmark opens a disposable TextEdit temp file, types a unique
marker through the real KWWK/CU helper, and requires at least one
`kwwk_app_mutation_verified` sample. Cold and warm helper verification remain
separate SLO evidence; app mutation evidence can come from helper accessibility
state after the previous sample, direct System Events text-area reads, or
fixture cleanup. The fixture focuses the target TextEdit text area before each
helper action and records `accessibilityTextIncludesMarker` after each sample,
so mutation evidence does not depend on a later warm pre-state happening to
include the previous marker. Inspect `kwwk.mutation` for the marker, fixture
window, verification source, and check.
`kwwk.mutationCleanup` is cleanup evidence and may be diagnostic when TextEdit
does not write the temp file before close.
Inspect `perceivedUx`, `slo.entries`, `slo.failures`, and `slo.slowest` when a
benchmark feels worse than the final state suggests.
Entries prefixed with `turn_` are same-turn checks; if one fails, the report had
events but could not prove they belonged to the same utterance/action chain.
The live OpenAI gate is intentionally separate from the default five-gate local
SLO suite because it requires a real provider credential. It proves transport
and provider-to-canonical mapping, not host KWWK execution.

`benchmark:realtime-local-slo-suite` runs the five local gates sequentially once
by default and writes `/tmp/oneesama-realtime-local-slo-suite-latest.json` with
per-gate p50/p95 aggregation over the collected reports. For meaningful p95
sampling during focused latency work, run the underlying script with a larger
sample count, for example:

```bash
vp exec tsx scripts/lan-operator-slo-suite.mjs --samples 5 --json-out /tmp/oneesama-realtime-local-slo-suite-5x.json
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
vp run smoke:meet
vp run smoke:meet-contract
```

`smoke:meet` starts a local Meet-like fixture, launches Playwright Chromium, fills the bot name, clicks `Join now`, verifies the injected fake camera and mic tracks, then starts a second join to prove the old browser is stopped before a new bot is created.

`smoke:meet-contract` is the stricter replacement-parity matrix. It additionally checks URL rejection, dry-run plan shape, Meeting Agent API behavior, participant audio discovery, diagnostics artifacts, replacement session identity, and status/stop lifecycle. See [meet-contract-matrix.md](meet-contract-matrix.md).

## Provider Examples

The repo includes minimal provider env files under `examples/`:

```bash
source examples/provider-codex.env
vp run smoke:local-agent-dialog

source examples/provider-claude.env
vp run smoke:local-agent-dialog

source examples/provider-ollama.env
vp run smoke:ollama-provider
# To run a live local model:
#   ollama serve
#   ollama pull "$MAB_OLLAMA_MODEL"
#   MAB_RUN_OLLAMA_PROVIDER_SMOKE=1 vp run smoke:ollama-provider

source examples/provider-slack-agent-d.env
vp run smoke:slack-agent-d-provider

source examples/provider-command.env
vp run smoke:local-agent-dialog
```

For HTTP provider mode, start the sample runner first:

```bash
node examples/provider-http-runner.mjs
source examples/provider-http.env
vp run smoke:local-agent-dialog
```

For a quick operator-facing entry point, start with the root
[README](../README.md) and then follow the live checks below.

For a real Google Meet room acceptance smoke, use a throwaway room and keep a human nearby in case Google puts the bot in the waiting room:

```bash
MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz vp run smoke:real-meet
MAB_REQUIRE_REAL_MEET=1 MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz vp run smoke:real-meet
```

The real-room smoke is not part of default CI. It launches Playwright Chromium, injects the Hiyori/fake mic-cam runtime, fills the guest name, clicks `Join now` or `Ask to join`, waits briefly for in-call controls or participant audio discovery, writes screenshots/diagnostics under `/tmp/meeting-avatar-bot`, and automatically leaves the room in cleanup.

Legacy optional: after the Local Operator lane is green, a separate real-room
diagnostic can compare local baseline timing with meeting-room behavior. This is
not part of the current Local Operator RFC acceptance path:

```bash
vp run benchmark:realtime-local-slo-suite
MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz \
vp run acceptance:realtime-meet-compat
vp run acceptance:realtime-meet-latency-attribution
```

The attribution command reads
`/tmp/oneesama-realtime-local-slo-suite-latest.json` and
`/tmp/oneesama-realtime-meet-compat-latest.json`, writes
`/tmp/oneesama-realtime-meet-latency-attribution-latest.json`, and compares
Meet app-control warm p95 against the local warm KWWK baseline. Missing or failed
Meet evidence is reported as a Meet-side blocker such as `missing_meet_report`
or `real_meet_admission`; it does not invalidate Local Operator acceptance. Use
`vp run acceptance:realtime-meet-latency-attribution:optional` to generate the
same diagnostic report without failing the shell when no real Meet report is
available.

If a live Google Meet room blocks guest automation at the prejoin anti-bot check, use a dedicated logged-in browser profile instead of the disposable Playwright profile:

```bash
MAB_MEET_PROFILE_MODE=persistent \
MAB_BROWSER_USER_DATA_DIR=/path/to/automation-chrome-profile \
MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz \
vp run smoke:real-meet
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
MAB_RUN_REALTIME_LIVE_ROUTING=1 vp run smoke:realtime-live-routing
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
vp run smoke:dialog-provider
vp run smoke:local-agent-dialog
MAB_AGENT_RUNNER=codex MAB_BROWSER_HEADLESS=true vp run smoke:local-agent-dialog
MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz vp run smoke:real-local-dialog
MAB_REQUIRE_REAL_LOCAL_DIALOG=1 MAB_REAL_MEET_URL=https://meet.google.com/xxx-yyyy-zzz vp run smoke:real-local-dialog
```

The fixture smoke dispatches a synthetic local-STT utterance, calls the selected AgentRunner provider, requests audio from Meeting Agent `/tts/synthesize`, decodes the returned WAV data URL into the avatar fake mic, and verifies Hiyori enters the `speak` action. The real-room variant clicks into Google Meet first, then injects the same controlled utterance so it can prove the provider/TTS/avatar loop without requiring OpenAI Realtime.

For a stronger avatar renderer gate on a WebGL-capable machine, run:

```bash
vp run smoke:hiyori-live2d
MAB_REQUIRE_HIYORI_LIVE2D=1 vp run smoke:hiyori-live2d
```

Without `MAB_REQUIRE_HIYORI_LIVE2D=1`, this smoke skips cleanly when headless Chromium cannot initialize the true Cubism/PIXI Live2D renderer. With the flag set, it fails unless true Hiyori Live2D pixels render and mood/action state changes alter the captured frame.

For operator-facing avatar/HUD iteration without Google Meet, start the standalone playground:

```bash
vp run dev:avatar-playground
```

Open the printed URL (defaults to `http://127.0.0.1:18912/`). The playground loads the avatar fake-camera runtime by itself, shows the HUD on the avatar frame, and lets you switch avatar presets plus runtime state presets (`Listening`, `Thinking`, `Speaking`, `Using Tool`, `Blocked`, `Done`). It is the fast local surface for tuning Live2D/VRM/fallback visuals, HUD placement, and future avatar-preset animation switches. Run the regression smoke with:

```bash
vp run smoke:avatar-playground
```

For the video-avatar replacement direction, use
[`docs/avatar-video-state-matrix.md`](./avatar-video-state-matrix.md) as the
source of truth for required states, assets, lip-sync policy, and playground/live
acceptance.

The v1 video preset is `oneesama-video`. It points at two muted green-screen
clips under `v1-green/`: `oneesama-video-idle-loop-subtle.mp4` and
`oneesama-video-speaking-loop-slit.mp4`. The renderer chroma-keys those clips at
runtime, so keep generated/private clips out of git and point the playground at
an asset directory:

```bash
ONEESAMA_AVATAR_ASSET_ROOT=tmp/avatar-video vp run dev:avatar-playground
```

Then open `http://127.0.0.1:18912/?avatar=oneesama-video`.

Production video assets use a two-stage flow: Image2 first, Seedance second.
Generate and review still keyframes before any video task runs:

```bash
vp run avatar:video:keyframes -- --ref /path/to/ref.png --out-dir tmp/avatar-video/keyframes
```

The command writes Image2 prompt files, a manifest, and `REVIEW.md`. Save the
approved Image2 outputs as:

- `tmp/avatar-video/keyframes/oneesama-video-idle-first.png`
- `tmp/avatar-video/keyframes/oneesama-video-speaking-first.png`
- optional `oneesama-video-idle-last.png` and
  `oneesama-video-speaking-last.png`

For v1 loops, the approved first frame can be reused as the last frame. The gate
is identity and composition consistency: face, glasses, hair, outfit, lighting,
background, and crop must match before the frames go to Seedance.

To generate the two Seedance clips, provide approved keyframes plus a
server-side Seedance/ModelArk key. The script prints only key presence/status,
never the secret value:

```bash
SEEDANCE_API_KEY=... vp run avatar:video:seedance -- --keyframe-dir tmp/avatar-video/keyframes --out-dir tmp/avatar-video
```

`ARK_API_KEY` is accepted as a fallback. If the key is missing, the script exits
before calling the network so the renderer can still be tested with local
placeholder clips. Direct portrait-reference animation is prototype-only and
requires the explicit `--allow-ref-direct --ref /path/to/ref.png` flags.

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
vp run smoke:slack-live-capability
```

To prove the bot can post into a disposable test channel, opt in explicitly:

```bash
MAB_SLACK_LIVE_ENV_FILE=/path/to/other-bot.env \
MAB_RUN_SLACK_LIVE_CAPABILITY_SMOKE=1 \
MAB_SLACK_LIVE_POST_TEST=1 \
MAB_SLACK_LIVE_TEST_CHANNEL=C0123456789 \
vp run smoke:slack-live-capability
```

To prove the same validated bot can enter the public Slack Agent Socket Mode
loop without replacing the existing Legacy services, run the live socket
smoke against a disposable test channel:

```bash
MAB_SLACK_LIVE_ENV_FILE=/path/to/other-bot.env \
MAB_RUN_SLACK_LIVE_SOCKET_SMOKE=1 \
MAB_SLACK_LIVE_TEST_CHANNEL=C0123456789 \
vp run smoke:slack-live-socket
```

This starts an isolated `apps/slack-agent` process, connects Socket Mode, posts
one marker message to the configured channel, waits for the live event to enter
the buffered event loop, then exits. It enables bot-message handling only inside
that smoke so the test can self-trigger; the production default still ignores
bot messages to avoid loops.

The public demo should still pass without these values.
