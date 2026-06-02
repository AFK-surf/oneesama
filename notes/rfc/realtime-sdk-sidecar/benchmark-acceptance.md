# Realtime SDK Sidecar Benchmark and Acceptance

Parent RFC:
[Realtime SDK Sidecar for Google Meet](../realtime-sdk-sidecar-rfc-2026-06-01.md)

This file defines the red/green gates. A benchmark that does not exercise the
sidecar runtime placement is not the live gate.

## Benchmark Contract

The benchmark must replay the same runtime placement as live Google Meet joins.

Required benchmark modes:

- `sidecar-control`: text turn into sidecar, dry-run local tool execution,
  wrapper/function-output telemetry, and SDK history required. This is a
  sidecar recall/tool-routing gate, not proof that a real app/window was
  controlled.
- `sidecar-audio`: user audio sample into sidecar through the same
  `RealtimeInputAudioPort`, SDK user turn and dry-run local tool telemetry
  required. This is an audio turn/tool-routing gate, not proof that a real
  app/window was controlled.
- `meet-page-csp`: real or fixture Meet page with strict page restrictions; Meet
  page must not contain SDK; sidecar must still form turns and call tools.
- `live-room-smoke`: real Meet room, Recappi input, sidecar SDK history, real
  tool telemetry, and avatar output route evidence.
- `realtime-real-app-control`: strict real-room app-control gate for real
  app/window execution evidence.

Diagnostic-only comparison modes such as `raw-websocket`, `agents-sdk`, and
`browser-transport` may remain useful for narrowing regressions, but they cannot
stand in for the sidecar acceptance gate. They also must not run inside a real
`meet.google.com` browser page: real Meet page probes are sidecar-only so a
diagnostic inline/browser transport path cannot masquerade as live-room evidence.

Benchmark failure conditions:

- share intent enters SDK history but no share/list/control tool call appears in
  the same turn;
- assistant says "处理中" / "正在共享" / equivalent progress text with no tool
  call;
- tool call appears in raw SDK events but not in wrapper telemetry;
- tool result is produced but no `function_call_output` delivery evidence is
  recorded, either through an explicit datachannel output item or the Agents SDK
  execute-return channel;
- Meet page contains Agents SDK globals or bundle text;
- diagnostics only prove raw `speech_started` / raw response events without SDK
  history and tool telemetry.

## Implementation Snapshot

- [x] `benchmark:realtime-tool-recall` now defaults to `sidecar-control`.
- [x] `benchmark:realtime-sidecar-audio` runs the sidecar audio replay path.
- [x] `benchmark:realtime-sidecar-audio` cannot pass on a tool call alone; it
      requires runtime health plus user transcript/history evidence first.
- [x] Sidecar benchmark modes create a Meet-surface page without SDK plus a
      Realtime SDK sidecar page.
- [x] Fake execution is scored as a hard failure when assistant progress text
      appears without the expected share/list/control tool call.
- [x] Dedicated strict-CSP Meet fixture/live gate is available through
      `--runtime meet-page-csp`.
- [x] Full report parity for wrapper telemetry, app-control telemetry, and
      `function_call_output` delivery is included in sidecar benchmark rows.
- [x] Agents SDK local-tool execution records `agents_sdk_execute_return` as
      function-output delivery evidence, so benchmark rows can distinguish a
      real SDK tool return from fake execution.
- [x] Terminal app-control telemetry (`timeout`, `failed`, `stale`, `blocked`)
      now fails ordinary share/control benchmark rows. The dedicated real-room
      app-control gate is narrower: it accepts success, or `blocked` / `failed`
      only when a compact explicit blocker is present, so the prompt-bloat
      regression can be distinguished from an expected live-room blocker.
- [x] App-control and share tool outputs are compacted before entering
      foreground model-visible function output, SDK history, and status state.
- [x] High-confidence manual text turns for background-job status and
      GitHub/repo issue lookup force the matching foreground tool choice instead
      of allowing spoken progress text with no tool call.
- [x] Non-sidecar diagnostic benchmark modes are explicitly marked
      `notAcceptanceGate` in reports.
- [x] Real `meet.google.com` browser-page probes are rejected for non-sidecar
      audio benchmark runtimes, so browser-transport/agents/raw diagnostics
      cannot be mistaken for live Meet evidence.
- [x] Routed Meet/host PCM/Recappi input is not reported as `audioInputReady`
      until mixer energy is observed and not stale; receiver/WebRTC track
      presence alone stays diagnostic.

## Acceptance Criteria

This RFC is accepted only when the sidecar path proves the live failure mode is
gone, not merely when the code compiles.

### Architecture Acceptance

- [x] In a Google Meet session using `agents-sdk`, `meet.google.com` does not
      load the Agents SDK bundle and does not expose `OpenAIAgentsRealtime`.
- [x] Exactly one sidecar page owns the Agents SDK connection, SDK session id,
      SDK history tail, model turn observation, and tool-call telemetry.
- [x] `join/status` or an equivalent runtime status payload reports
      `realtimeRuntimePlacement: "sidecar"` and identifies the sidecar owner of SDK
      state.
- [x] `join/status` reports explicit sidecar page counts
      (`realtimeSidecar.pageCount` and `realtimeSidecar.sdkOwnerPageCount`) so
      the real-room app-control benchmark can require exactly one active
      sidecar SDK owner instead of inferring it from placement strings.
- [x] Inline Agents SDK on a Meet page is removed from the live join path; live
      Google Meet entrypoints reject stale inline placement instead of silently
      falling back. Lower-level non-Meet init builders may still emit diagnostic
      warnings for compatibility tests only.
- [x] Go and TS meeting-agent, meet-runner, and low-level Google Meet joiner
      entrypoints reject inline placement even when stale emergency override env
      is present.
- [x] In sidecar mode, the Meet surface placeholder does not carry
      `toolCallbackToken` or SDK-owned `tools` / `session` / `instructions`, and
      refuses local screen/app-share tools.

### Share-Intent Acceptance

- [x] Given Peng says "分享/共享 Chrome 窗口" in a real or replayed room, the
      sidecar SDK history contains the user turn text or transcription for that
      utterance.
- [x] In the same model turn, sidecar telemetry records one of:
      `list_shareable_windows`, `share_existing_app_window`, or
      `control_shared_app_window`.
- [x] The matching tool wrapper telemetry records the call id, arguments,
      result, and `function_call_output` delivery.
- [x] The app-control job starts when the chosen tool requires local
      window/share control.
- [x] If the assistant says "处理中", "正在共享", or equivalent progress text
      without a correlated share/list/control tool call, the run fails hard.
- [x] A post-hardening real-room app-control rerun proves compact app-control
      prompts/results do not time out due full runtime/status bloat.

### Benchmark Acceptance

- [x] The default share replay benchmark exercises the same placement as live
      Google Meet: Meet surface page plus Realtime SDK sidecar.
- [x] `benchmark:realtime-tool-recall` passes sidecar-control with retries
      disabled: full surface `9/9` positive recall plus `2/2` negatives, and
      share/control-only `9/9` positive recall plus `2/2` negatives.
- [x] `benchmark:realtime-tool-lanes` passes sidecar-control with retries
      disabled: full surface `7/7` positive recall across worker delegation,
      worker status, Meet chat, GitHub lookup delegation, and identity-first
      Linear routing.
- [x] The uploaded Recappi user-audio sample can drive the sidecar through the
      normal audio input port and produce the expected share/list/control tool call.
- [x] The benchmark report includes SDK history tail, assistant text, tool calls,
      tool wrapper telemetry, app-control telemetry, and fake-execution verdict.
- [x] A benchmark that only proves raw speech events, raw response events, or
      "given text -> selected tool" is not accepted as the live gate.

### Audio Acceptance

- [x] Recappi remains the live Realtime input source unless a separate RFC or
      investigation proves a replacement.
- [x] Receiver/WebRTC track capture is diagnostic-only and cannot be promoted to
      input source by this RFC.
- [x] A routed receiver/WebRTC/host PCM input with no observed mixer energy
      reports `meet_audio_no_energy_observed` instead of `input_audio_ready`.
- [x] Realtime output audio from the sidecar reaches the Meet page avatar audio
      bus through the output audio port.
- [x] Avatar output energy is observed after a model speech response.
- [x] Fixture avatar output track stays live while sidecar output audio is routed.
- [x] Fresh real-room evidence records the primary Meet fake-mic sender stats
      (`trackReadyState=live`, bytes sent, avatar-bus source) while sidecar
      output audio is routed.
- [x] No Realtime local speaker sink is used in the Meet session.

### Rollout Acceptance

- [x] Sidecar default rollout is enforced by rejecting inline Meet SDK in live
      join paths, and live-room reliability now has a strict combined real-room
      acceptance artifact.
- [x] Once sidecar became default, the inline Meet SDK path was removed from the
      Google Meet join surface.
- [x] The live meeting-agent restart runbook remains valid:
      `scripts/oneesama-live-screen.sh --restart meeting-agent`.
- [x] A real-room smoke records a single artifact/report that contains enough
      evidence to answer: user turn observed, model turn observed, tool called, tool
      output delivered, app-control job started, and avatar output routed.

### Current Completion Audit

- Proven locally: sidecar-control recall and lane coverage pass with retries
  disabled; terminal app-control failures are benchmark failures; foreground
  share/app-control outputs are compacted; deprecated aliases and older
  fine-grained helper names cannot return through foreground or mock/local
  tool paths.
- Proven by fixture: strict-CSP Meet-surface pages do not contain the SDK while
  the sidecar owns SDK history/tool telemetry; Meet DOM tools route through
  the host-mediated surface port; sidecar output PCM reaches the Meet avatar
  audio bus.
- Proven by existing real-room artifact `session_904489e8`: sidecar placement,
  Recappi input, model turn observation, `share_existing_app_window` tool
  call/result, app-control job creation, screen share, and avatar output
  routing happened in one run.
- Proven by the 2026-06-02 user-provided real Meet URL
  `https://meet.google.com/ypw-fozb-anz`: strict combined
  `npm run acceptance:realtime-live-sidecar` passed with
  `acceptanceSatisfied:true` in
  `/tmp/oneesama-realtime-live-sidecar-user-meet-after-surface-output-hook.json`.
  The app-control child records provider `kwwk`, job `app_control_1`,
  `functionOutputDelivered:true`, `sidecarPageCount:1`,
  `sdkOwnerPageCount:1`, and Meet-surface `hasSDKGlobal:false`. The synthetic
  speaker child records `meetPublishSenderLive:true`, `senderLive:true`,
  `meetSurfaceAudioOutputHookStatus:"attached"`,
  `primaryMeetAudioSenderUsingAvatarBus:true`, and primary sender stats with
  `trackReadyState:"live"`, `bytesSent:11062`, `bytesDelta:2530`,
  `packetsSent:200`, `packetsDelta:25`.

## Evidence Checklist

- [x] Unit: init builder can produce Meet-only and sidecar-only script sets.
- [x] Unit: Meet script set has no `OpenAIAgentsRealtime` or SDK bundle marker.
- [x] Unit: sidecar script set has SDK runtime metadata.
- [x] Unit: share-intent fake execution fails when assistant text has no tool
      call.
- [x] Unit: tool call id is preserved through host route, tool result, and
      function output.
- [x] Fixture: strict-CSP Meet fixture plus sidecar still records SDK history.
- [x] Fixture: Meet DOM tools execute on the Meet page from a sidecar model
      call.
- [x] Fixture: local app/window share tools execute through app-control from a
      sidecar model call.
- [x] Fixture: sidecar output PCM reaches the Meet avatar audio bus with output
      energy and a live avatar output track.
- [x] Benchmark: sidecar-control tool recall passes full and share/control-only
      variants with retries disabled.
- [x] Benchmark: sidecar-control lane coverage passes full variant with retries
      disabled.
- [x] Audio benchmark: uploaded Recappi sample drives sidecar turn formation and
      share tool call.
- [x] Live: real Meet room share command produces real tool telemetry in the
      same turn.
- [x] Live: real Meet room model speech reaches avatar output energy after the
      sidecar output bridge lands.
- [x] Live: fresh real Meet room records primary Meet fake-mic sender stats in
      the same artifact.
- [x] Live: post-hardening app-control rerun proves compact prompt/result path.
- [x] Typecheck and targeted existing smoke tests pass.

## Evidence Artifacts

- 2026-06-02 strict benchmark alias correction:
  `benchmark:realtime-real-app-control` now includes `--require-real-meet-url`.
  `node --import tsx --test --test-reporter=spec
test/realtime-tool-recall-benchmark.test.mjs
test/realtime-audio-tool-replay-benchmark.test.mjs
test/realtime-real-meet-app-control-benchmark.test.mjs` passed 42 tests.
  With URL discovery disabled,
  `env -u MAB_REAL_MEET_URL -u MAB_REQUIRE_REAL_MEET_URL -u
MAB_REAL_MEET_REQUIRED MAB_REAL_MEET_URL_DISCOVERY=0 npm run
benchmark:realtime-real-app-control` exited 1 and wrote
  `/tmp/oneesama-realtime-real-app-control-latest.json` with `skipped:false`,
  `diagnosticOnly:false`, and `acceptanceSatisfied:false`. The optional
  companion `env -u MAB_REAL_MEET_URL -u MAB_REQUIRE_REAL_MEET_URL -u
MAB_REAL_MEET_REQUIRED MAB_REAL_MEET_URL_DISCOVERY=0 npm run
benchmark:realtime-real-app-control:optional` exited 0 and wrote
  `/tmp/oneesama-realtime-real-app-control-optional-latest.json` with
  `skipped:true`, `diagnosticOnly:true`, and `acceptanceSatisfied:false`.
  Retrospective: the earlier report treated a non-passing missing-URL run as a
  harmless "benchmark" diagnostic, which blurred the benchmark/optional
  boundary. Root cause was using exit-code convenience as evidence semantics.
  Future benchmark aliases must be hard red/green gates; skipped evidence is
  allowed only in explicitly named `:optional` or diagnostic commands.
- 2026-06-02 real app-control session binding:
  the strict real-room app-control benchmark now passes its generated
  `sessionId` into `realMeetAppControlEvidencePasses`, and
  `realMeetAppControlRealtimeEvidencePasses` rejects otherwise valid sidecar
  tool telemetry when `/join/status` reports a different `activeSessionId`.
  The same compactor now also treats `delivery.suppressed === true` or a
  suppressed policy decision as missing `function_call_output` delivery, even
  if an output-channel string is present.
  `node --import tsx --test --test-reporter=spec
test/realtime-tool-recall-benchmark.test.mjs
test/realtime-audio-tool-replay-benchmark.test.mjs
test/realtime-real-meet-app-control-benchmark.test.mjs` passed 42 tests.
- 2026-06-02 benchmark evidence-scope metadata:
  `realtime-tool-recall-benchmark.mjs` and
  `realtime-audio-tool-replay-benchmark.mjs` now write explicit
  `evidenceMode`, `acceptanceGateScope`, `toolExecutionMode`, and
  `realAppExecution:false` fields. `sidecar-control` reports
  `sidecar_tool_recall` plus `dry_run_local_tools`; `sidecar-audio` reports
  `sidecar_audio_tool_replay` plus `dry_run_local_tools`. These artifacts prove
  sidecar turn/tool routing and wrapper/function-output semantics, not real
  app/window execution. `node --import tsx --test --test-reporter=spec
test/realtime-tool-recall-benchmark.test.mjs
test/realtime-audio-tool-replay-benchmark.test.mjs` passed 28 tests.
  A targeted control-case rerun,
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0
--case-filter '^control_' --json-out
/tmp/oneesama-realtime-tool-recall-evidence-mode-check.json`, passed `4/4`
  control positives in both variants and the JSON contained
  `evidenceMode:"sidecar_tool_recall"`,
  `toolExecutionMode:"dry_run_local_tools"`, and `realAppExecution:false`.
- 2026-06-02 validation after strict real-room benchmark, combined live
  sidecar acceptance, and inline diagnostic
  opt-in hardening:
  `node --import tsx --test --test-reporter=spec test/realtime-agents-sdk-adapter.test.mjs test/realtime-app-control-bridge.test.mjs test/realtime-sidecar-tool-routing.test.mjs test/realtime-real-meet-app-control-benchmark.test.mjs`
  passed 49 tests; `node --import tsx --test --test-reporter=spec
  test/realtime-audio-tool-replay-benchmark.test.mjs` passed 10 tests, including
  the check that browser-transport inline SDK runs require
  `allowInlineAgentsSDKDiagnostic` and report `diagnosticOnly`; `go test
./internal/meetingagent -run 'TestWorker' -count=1` passed. `env -u
MAB_REAL_MEET_URL -u MAB_REQUIRE_REAL_MEET_URL -u MAB_REAL_MEET_REQUIRED npm
run benchmark:realtime-real-app-control -- --json-out
/tmp/oneesama-realtime-real-app-control-missing-url-strict-2026-06-02.json`
  exited 1 with `skipped: false` and `acceptanceSatisfied: false`, proving the
  main benchmark is now a hard gate. `env -u MAB_REAL_MEET_URL -u
MAB_REQUIRE_REAL_MEET_URL -u MAB_REAL_MEET_REQUIRED npm run
  benchmark:realtime-real-app-control:optional` exited 0 and wrote the
  diagnostic-only skipped artifact to
  `/tmp/oneesama-realtime-real-app-control-optional-latest.json` with
  `ok:false`, `diagnosticOnly:true`, and `acceptanceSatisfied:false`, so the
  artifact cannot be mistaken for a benchmark pass. `npm run
  acceptance:realtime-live-sidecar` is now the strict combined live gate: with a
  real Meet URL it runs both the synthetic-speaker/fake-mic sender gate and the
  real app-control gate, and missing `MAB_REAL_MEET_URL` is a hard failure. The
  explicit optional companion writes
  `/tmp/oneesama-realtime-live-sidecar-optional-latest.json` with the same
  diagnostic-only skip semantics. The combined live wrapper also requires each
  child gate process to exit 0 and to report explicit `acceptanceSatisfied:true`;
  successful-looking `ok:true` child JSON without that acceptance flag, or from
  a nonzero gate exit, cannot satisfy the combined result. Malformed or
  non-object child gate JSON is converted into a structured `invalid_json`
  failure, and child gate runtime/IO errors are converted into structured
  `gate_error` failures, including child-process `error` events, instead of
  hanging or crashing the wrapper without an evidence envelope. The combined
  target rerun with the adapter, mock guard, sidecar output, app-control bridge,
  sidecar routing, real-app-control benchmark, audio replay, sidecar surface
  audio, Meet receiver smoke, and meet-live-acceptance test files passed 111
  tests after the fresh fake-mic sender delta hardening, app-control terminal
  gate alignment, and real-Meet URL resolver regression; `npm run typecheck`,
  `npm run lint:js`, targeted Prettier
  check, and
  `git diff --check` passed.
- 2026-06-02 mock remote audio diagnostic cleanup:
  `mockRemoteAudioInjected` no longer appears in runtime connection state. The
  mock route now uses the same `remoteAudioRoutedToAvatarBus` evidence as the
  sidecar output path, and
  `node --import tsx --test --test-reporter=spec test/realtime-agents-sdk-mock-tool-guard.test.mjs`
  passed 8 tests proving the old field stays absent even after mock remote audio
  routes. The combined target rerun above includes this guard plus sidecar
  output coverage.
- 2026-06-02 participant audio injection hardening:
  direct participant-audio discovery/registration is no longer exposed on
  `MAB_REALTIME_CLIENT`; internal discovery and fixture/mock custom events keep
  their opt-in guard. The stale `allowParticipantAudioStreamRegistration` flag
  no longer opens the custom-event input path; only
  `allowParticipantAudioStreamEvents` or mock/fixture modes do.
  `node --import tsx --test --test-reporter=spec
test/realtime-sidecar-surface-audio-input.test.mjs` passed 3 tests proving the
  host-forwarded fixture path still works while production-like custom events
  fail closed, the stale registration flag is ignored, and direct public
  registration/discovery APIs are absent. The Meet
  receiver smoke was rerun with an explicit `update_avatar_state` fixture schema
  so the local tool schema gate stays enforced while avatar follow-up policy
  remains testable.
- 2026-06-02 participant public API / token mint retry benchmark rerun:
  the first post-hardening control benchmark failure was not a recall miss:
  every bad row had already called `control_shared_app_window`, but sidecar
  runtime had recorded a transient Realtime client-secret mint failure from the
  Go host. The Go `/realtime/client-secret` path now retries retryable OpenAI
  client-secret post errors and upstream 5xx responses up to three short
  attempts, rebuilding the request body each time, and preserves `502` after
  retry exhaustion instead of wrapping upstream/network failure as a generic
  `500`. Validation passed:
  `go test ./internal/meetingagent -run
'TestRealtimeClientSecret(RetriesTransientEOF|ReturnsBadGatewayAfterTransientRetryExhaustion|PostsToOpenAI|UpstreamError)'
-count=1`;
  `npm run benchmark:realtime-tool-lanes -- --iterations 1 --retries 0
--json-out /tmp/oneesama-realtime-tool-lanes-after-token-retry-rerun.json`
  passed `7/7` after the transient token-mint retry hardening;
  `node --import tsx --test --test-reporter=spec
test/realtime-sidecar-surface-audio-input.test.mjs
test/realtime-agents-sdk-mock-tool-guard.test.mjs
test/realtime-browser-bridge-meet-receiver-smoke.test.mjs` (`30/30`);
  `npm run benchmark:realtime-tool-recall -- --meeting-agent-url
http://127.0.0.1:18782 --iterations 1 --retries 0 --case-filter
'^control_' --json-out
/tmp/oneesama-realtime-tool-recall-participant-api-hardening.json` passed
  `4/4` full control rows and `4/4` share/control-only rows against a temporary
  live-wrapper-started Go meeting-agent built from the current source; `npm run
typecheck`, `npm run lint:js`, and `git diff --check` passed.
- 2026-06-02 sidecar-audio benchmark entrypoint fix:
  `npm run benchmark:realtime-sidecar-audio -- --timeout-ms 45000 --duration-sec
25 --json-out
/tmp/oneesama-realtime-sidecar-audio-2026-06-02-rerun-after-fix.json` passed
  without an explicit `--audio` argument. The script now defaults to the RFC
  Recappi sample
  `runtime/meeting-artifacts/runner-dual_audio_truebot_1200/recappi-audio.wav`,
  and the rerun passed both full and share-control-only variants with non-empty
  user transcript evidence, sidecar SDK sessions, no SDK global on the Meet
  surface, and `share_existing_app_window` telemetry.
- 2026-06-02 live fake-mic sender gate hardening:
  `meet-live-acceptance` now fails a diagnostics artifact when sidecar output
  is observed but the primary Meet fake-mic sender is not using the avatar bus,
  does not have `trackReadyState: "live"`, has not sent bytes, or has no fresh
  sender delta (`bytesDelta > 0` or `packetsDelta > 0`). The synthetic-speaker
  smoke gate applies the same fresh-delta requirement to
  `primaryMeetAudioSenderStats`. This does not replace the still-open fresh
  real-room evidence item; it ensures the next real-room run cannot pass on
  stale cumulative sender stats.
- 2026-06-02 real app-control sidecar ownership gate hardening:
  `/join/status` now exposes `realtimeSidecar.pageCount` and
  `realtimeSidecar.sdkOwnerPageCount`, and the strict real-room app-control
  benchmark requires both counts to be exactly `1` alongside `sidecarActive`.
  `node --import tsx --test --test-reporter=spec test/realtime-real-meet-app-control-benchmark.test.mjs`
  passed 8 tests, including regressions that fail `sidecarActive=false`,
  missing sidecar pages, duplicate sidecar pages, or missing/duplicate SDK-owner
  pages.
- 2026-06-02 real app-control compact-blocker gate alignment:
  `realMeetAppControlEvidencePasses()` now matches the live TODO wording:
  app-control success passes, and `blocked` / `failed` also passes only when a
  compact explicit `blocker` is present. `timeout`, `stale`, `error`, canceled
  states, missing blockers, and oversized blockers remain hard failures. The
  focused test `test/realtime-real-meet-app-control-benchmark.test.mjs` passed
  9 tests after this alignment.
- 2026-06-02 meet-live app-control terminal gate alignment:
  `meet-live-acceptance --expect-tool=control_shared_app_window` now requires
  an explicit app-control terminal result, not merely a matching tool name.
  Completed/done app-control results pass; compact explicit blockers pass;
  pending/stale jobs and blocked jobs without compact blockers fail. Pending or
  stale jobs also fail even when the artifact contains an older completed
  app-control job, so stale evidence cannot mask the current live gate. A
  `blocked` / `failed` result with a compact blocker but contradictory `ok:true`
  also fails. The focused `test/meet-live-acceptance.test.mjs` file passed 22
  tests after this alignment.
- 2026-06-02 validation after worker-result/live-input gate hardening:
  `node --import tsx --test --test-reporter=spec test/meet-live-acceptance.test.mjs test/realtime-real-meet-app-control-benchmark.test.mjs test/realtime-app-control-bridge.test.mjs`
  passed 33 tests; after moving worker-result polling to sidecar and requiring
  Realtime app-control telemetry, `node --import tsx --test --test-reporter=spec test/realtime-app-control-bridge.test.mjs test/realtime-sidecar-tool-routing.test.mjs test/realtime-real-meet-app-control-benchmark.test.mjs`
  passed 24 tests; `go test ./internal/meetingagent -run 'TestWorker' -count=1`
  passed. The earlier missing-URL benchmark artifact from this phase is
  superseded by the strict/optional split recorded above.
- 2026-06-01 strict-CSP fixture:
  `test/realtime-sidecar-csp-fixture.test.mjs` proves a Meet-surface page with
  Trusted Types/CSP keeps SDK globals suppressed while the sidecar records SDK
  session id, SDK history for "分享 Chrome 窗口", and a real
  `list_shareable_windows` tool call.
- 2026-06-01 sidecar-audio benchmark:
  `runtime/meeting-artifacts/realtime-sidecar-audio-benchmark-2026-06-01.json`
  replays
  `runtime/meeting-artifacts/runner-dual_audio_truebot_1200/recappi-audio.wav`
  through `--runtime sidecar-audio` and passes with `share_existing_app_window`.
  The replay scorer now checks runtime health and transcript/history evidence
  before accepting a matching tool call, so a tool-only response cannot satisfy
  the audio gate.
- 2026-06-01 sidecar-audio benchmark rerun after scorer hardening:
  `/tmp/oneesama-realtime-sidecar-audio-current-after-scorer-hardening.json` was
  produced by
  `npm run benchmark:realtime-sidecar-audio -- --audio runtime/meeting-artifacts/runner-dual_audio_truebot_1200/recappi-audio.wav --timeout-ms 45000 --duration-sec 25 --json-out /tmp/oneesama-realtime-sidecar-audio-current-after-scorer-hardening.json`
  and passed both variants: full and share/control-only both called
  `share_existing_app_window`, had non-empty user transcript evidence, connected
  sidecar SDK sessions, and reported no SDK global on the Meet surface.
- 2026-06-01 sidecar-audio benchmark rerun after audio-readiness hardening:
  `/tmp/oneesama-realtime-sidecar-audio-current-after-audio-readiness-final.json` was
  produced by
  `npm run benchmark:realtime-sidecar-audio -- --audio runtime/meeting-artifacts/runner-dual_audio_truebot_1200/recappi-audio.wav --timeout-ms 45000 --duration-sec 25 --json-out /tmp/oneesama-realtime-sidecar-audio-current-after-audio-readiness-final.json`
  and passed both variants. Both rows had non-empty user transcript evidence,
  connected sidecar SDK sessions, no SDK global on the Meet surface, and a
  matching share-intent tool call (`share_existing_app_window` for full,
  `list_shareable_windows` for share-control-only).
- 2026-06-01 sidecar-control tool recall benchmark after tool-routing and
  alias-cleanup hardening:
  `/tmp/oneesama-realtime-tool-recall-current-after-real-gate.json` was produced by
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0 --timeout-ms 30000`
  and passed both variants: full `9/9` positives plus `2/2` negatives, and
  share/control-only `9/9` positives plus `2/2` negatives. Earlier failure mode
  `function_call_output_missing` was fixed by recording the Agents SDK
  execute-return channel as tool-output delivery evidence.
- 2026-06-01 sidecar-control benchmark runner reliability hardening:
  the browser-side benchmark now gives SDK connect the full per-turn timeout and
  explicitly calls `MAB_REALTIME_CLIENT.disconnect()` plus a short cooldown
  between cases, so a previous sidecar session cannot make later rows fail as
  Playwright connection timeouts. The same command was rerun in this session and
  passed full `9/9` plus `2/2` negatives and share/control-only `9/9` plus `2/2`
  negatives with retries disabled.
- 2026-06-02 benchmark runner concurrency hardening:
  `realtime-tool-recall-benchmark.mjs` and
  `realtime-audio-tool-replay-benchmark.mjs` now share a cross-process lock, so
  parallel local runs wait instead of competing for the same meeting-agent and
  Realtime resources. Before this fix, running recall and lane benchmarks in
  parallel caused false `page.waitForFunction` timeouts and one wrong first
  Linear routing step. The serial artifacts from this investigation are
  superseded by the strict 2026-06-02 artifacts below, which were produced after
  `minRecall: 1` became mandatory.
- 2026-06-01 sidecar-control lane benchmark after text-turn guard and
  alias-cleanup hardening:
  `/tmp/oneesama-realtime-tool-lanes-current-after-real-gate.json` was produced by
  `npm run benchmark:realtime-tool-lanes -- --iterations 1 --retries 0 --timeout-ms 30000`
  and passed full `7/7` positives. The repaired cases were
  `delegate_status_codex_zh` (`worker_status`) and `github_search_zh`
  (`delegate_to_worker`), plus the broader background-job lane
  `delegate_to_codex_script_zh`, which previously could speak progress text
  without a same-turn `delegate_to_worker` call.
- 2026-06-01 rollout defaults:
  `openaiRealtimeRuntimePlacement` / `openai.realtime_runtime_placement`
  default to `sidecar`; `scripts/oneesama-live.sh meeting-agent` rejects
  inline Meet SDK outright, including stale emergency override env. The
  lower-level `google-meet-joiner` and TS meet-runner plan builder reject the
  same inline placement, so direct runner calls cannot recreate the removed
  Meet inline path.
- 2026-06-01 live restart runbook:
  `scripts/oneesama-live-screen.sh --restart meeting-agent` passed preflight,
  verified sidecar default runtime placement, and restarted `meeting-agent` as
  pid `93617`.
- 2026-06-01 cleanup:
  the unused meet-runner `realtime_fallback_to_local_mic` field was removed,
  and the legacy Recappi receiver fallback runtime state was removed so
  receiver/WebRTC tracks remain diagnostic-only even when Recappi has not yet
  connected. The stale `allowGenericMediaElementAudioDiscovery` override no
  longer enables generic media element scanning on `meet.google.com`; even if
  old config still passes it, Google Meet pages ignore arbitrary audio/video
  elements and keep the receiver hook / Recappi-owned input boundary.
  `node --import tsx --test --test-reporter=spec
test/realtime-browser-bridge-meet-receiver-smoke.test.mjs` passed `17/17`
  after this cleanup.
- 2026-06-01 control-plane hardening:
  missing Realtime bridge mode now defaults to `agents-sdk` for Agents SDK
  runtime, Go exposes `/realtime/event` routing to the meet-runner sidecar,
  and that raw event route is now narrowed to allowlisted control events so
  user/model turn injection must use `/realtime/text-turn`. Direct Go joins
  reject inline Meet SDK even when stale emergency override env is present,
  sidecar text/event sends fail as `not_connected` without SDK transport, and
  output-audio telemetry is marked routed only after Meet avatar PCM enqueue
  succeeds. The browser `simulateRealtimeAgentToolCall` smoke helper is rejected
  in non-mock sessions unless a fixture explicitly sets
  `allowMockToolSimulation`; that flag is scoped to the explicit mock tool
  helper and no longer unlocks custom Realtime server, speech-start, or
  worker-result DOM events. The older `runRealtimeAgentSDKTool` alias is no
  longer exposed, and DOM `meeting-avatar-realtime-server-event`
  injection is rejected outside mock/opt-in fixtures, so production session,
  speech, and tool telemetry cannot be forged through browser custom events.
  The older `meeting-avatar-user-speech-started` event is guarded the same way,
  so page-dispatched speech markers cannot satisfy production speech gates.
  DOM `meeting-avatar-worker-result` injection is now guarded the same way, and
  direct worker-result delivery is suppressed unless the result carries the
  current meeting session id, so production worker/app-control completion events
  cannot be forged or borrowed from another meeting. Host worker-result injection
  no longer falls back to DOM custom events when the Realtime client API is
  missing, and the browser Realtime listener also records explicitly enabled
  custom worker-result events as suppressed diagnostics instead of calling
  `injectWorkerResult`. Direct participant-audio discovery/registration is no longer public
  on `MAB_REALTIME_CLIENT`, and production-like participant audio stream custom
  events remain rejected unless the fixture explicitly opts in.
  Stale receiver fallback disconnect telemetry was renamed to receiver diagnostic
  disconnect telemetry, and old local-fake `tool_start` / `tool_end` SDK event
  subscriptions were removed from the production-side event handler. Hidden
  deprecated foreground aliases (`delegate_to_codex`, `delegate_status`,
  `list_shareable_apps`, `present_app_share`) are also no longer executable
  through browser mock/local tool paths. Hidden browser/demo-surface aliases now
  also fail closed in the browser local tool router unless `demoSurface`
  explicitly exposes those tools, so raw local tool calls cannot bypass the
  server-side demo-surface schema gate. The Go service now separates
  `DemoSurface.Enabled` from `DemoSurface.ExposeRealtimeTools`, so a configured
  bridge can serve backend/demo endpoints without adding browser-surface tools
  to `/realtime/config` or `/realtime/client-secret`, and the generated
  browser/workspace prompt examples are omitted unless those tools are present.
  Join metadata hashes the same exposed surface, and current Realtime-named
  `/tools` routes for browser/demo surface tools reject by default unless the
  Realtime exposure gate is explicitly enabled. Deprecated backend `/tools` names
  (`start_demo_surface`, `start_demo_execution`, `control_demo_surface`,
  `cancel_demo_surface`) now always reject with `deprecated_demo_surface_tool`,
  so an older local tool name cannot bypass the current foreground schema even
  when browser-surface tools are explicitly exposed.
  The browser local tool router now also rejects any local tool name missing
  from the current Realtime session schema, even in mock/dry-run tool
  simulation; stale local handlers such as `github_search` can no longer execute
  after the server stops exposing them.
  Raw TS and Go `buildRealtimeSessionConfig()` now default to the live-safe
  Google Meet tool surface. The TS meeting-agent `/realtime/config` endpoint
  uses that same surface for both top-level `tools` and nested `session.tools`,
  and `/realtime/client-secret` ignores caller-supplied stale tools when minting
  the session, so neither TS nor Go services return or accept demo/browser-surface
  foreground tools by default.
  The optional live-routing smoke now has only `requireInstruction` and
  `forbidOperations` checks for app-control cases; the old `requireOperations`
  diagnostic branch was removed so routing smoke cannot bless primitive
  foreground operations again. Foreground Realtime paths strip top-level
  `operations` and `context.operations` before the Go app-control endpoint, but
  internal KWWK JSON-RPC callers and live helper benchmarks may still pass
  explicit `operations`; the Swift helper prefers those explicit internal
  operations and otherwise derives bounded direct actions from the natural
  language `instruction`. The Go `/tools/control_shared_app_window` endpoint
  now also rejects the hidden `standalone` request flag, so Realtime app-control
  cannot bypass active meeting/share resolution through an unexposed schema
  parameter; the old synthetic standalone app-control target/status/context
  branch has been removed, so no downstream Codex/KWWK request can be marked
  standalone after the endpoint rejects it.
  Production-like Meet surfaces now reject
  `meeting-avatar-participant-audio-stream` custom events unless a fixture/mock
  path explicitly opts in.
  Go host config validation now rejects `openai.realtime_runtime_placement=inline`;
  inline is kept only in lower-level browser diagnostics outside live host
  config. It also rejects `demo_surface.expose_realtime_tools=true` with the
  default/fake demo-surface adapter; exposed browser/CU surface tools must use a
  real adapter path such as `mode=safe`, `adapter=agent_browser`, or
  `adapter=codex`, so benchmark evidence cannot be satisfied by fake
  demo-surface execution.
  The optional TS `smoke:realtime-live-routing` default plan now uses only the
  live-safe Meet/app-control surface; browser/demo-surface routing cases are
  behind explicit diagnostic opt-in.
  The manual text-turn fake-execution fallback now counts workspace-tool calls
  as well as Meet-tool calls, so a real `control_shared_app_window` call is not
  misclassified as assistant progress text without a matching functional tool.
  Recall and lane fixtures now require perfect recall (`minRecall: 1`) so any
  `BAD` row fails the benchmark instead of hiding behind a partial threshold.
  The sidecar-control benchmark opts into deterministic direct routing for
  high-confidence share/control/stop/chat/worker/identity text-turns, recording
  the same local tool-wrapper telemetry while leaving ordinary Realtime
  text-turns model-driven.
  Mock remote audio diagnostics are emitted only when the mock injector actually
  runs, not as a default production connection field. Functional-tool
  fake-execution recovery has been removed entirely, including the old
  opt-in helper path, so progress text without a same-turn tool call cannot
  trigger a corrective `response.create` and remains a hard failure. HUD visible
  cells now suppress connection/audio/speaking waiting labels such as `连接中`,
  `没音频`, `没开口`, and `没出声`; tool activity and blockers remain visible.
- 2026-06-01 local fixture tool-share smoke:
  `runtime/meeting-artifacts/realtime-local-fixture-tool-share-smoke-2026-06-01-final.json`
  passed for session `realtime_speech_1780309045076`; `textTurnFallback` was
  `null`, so the expected tool call came from the audio turn in this run. The
  full diagnostic trace is
  `/tmp/meeting-avatar-bot/realtime_speech_1780309045076-diagnostics.json`.
  Evidence: sidecar placement and SDK owner are `sidecar`; the Meet surface has
  no SDK owner; host-forwarded fixture PCM uses
  `currentRealtimeInputSource: "host_meet_audio_pcm"` with 905 chunks, a
  `host-meet-audio-pcm` track state, and observed input energy; the model turn
  produced `share_existing_app_window`; sidecar output forwarded 397 PCM chunks
  to the Meet avatar audio bus; avatar output energy observed `maxRms: 0.12058`;
  local speaker sink stayed disabled. The same artifact intentionally leaves
  `participantPresent`, `realtimeInputSenderLive`, `meetPublishSenderLive`, and
  `senderLive` false because the fixture is not a real Google Meet room.
  `host_meet_audio_pcm` remains valid fixture evidence for the sidecar input
  port, but it is not accepted as the real-room live input source.
  `meet-live-acceptance` now enforces the same sidecar architecture evidence on
  diagnostics artifacts: the Realtime runtime must report sidecar SDK ownership,
  the Meet surface must report no Agents SDK global or bundle marker, and
  real Google Meet live input evidence must use the Recappi process tap rather
  than diagnostic host PCM/mix sources.
  The local fixture smoke now treats fixture TTS/ASR as best-effort: audio
  readiness, speech start, model response, and output routing must happen first;
  if the expected tool is still missing, the script can use `/realtime/text-turn`
  to verify the sidecar control plane and tool route deterministically.
- 2026-06-01 real-room sidecar share/output artifact:
  `/tmp/meeting-avatar-bot/session_904489e8-diagnostics.json` for Google Meet
  `kwa-qogg-hti` records `realtimeRuntimePlacement: "sidecar"` and
  `realtimeSdkOwner: "sidecar"` at join start, Recappi process-tap input,
  sidecar SDK connection, user transcript containing a browser/window share
  request, `share_existing_app_window` with call id
  `call_Y385Hbp0St8vgQvA`, visual-only tool result delivery, active synthetic
  Chrome window share, and sidecar output PCM routed into the Meet avatar audio
  bus with observed output energy and no local speaker sink. The same run also
  exposed the app-control prompt-bloat bug: `control_shared_app_window` queued
  job `app_control_1`, then timed out after receiving a full runtime/status blob
  in the task context. That failure is now covered by compact status/result
  tests and terminal app-control benchmark failure scoring; a fresh real-room
  app-control rerun remains the final live evidence item.
- 2026-06-01 control-surface hardening:
  `test/realtime-sidecar-tool-routing.test.mjs` proves the Meet surface page in
  sidecar mode has no internal `toolCallbackToken`, still accepts host-routed
  DOM tools such as `send_meet_chat`, and rejects local screen/app-share tools
  such as `list_shareable_windows`. The Meet-surface placeholder now also strips
  SDK-owned `tools`, `session`, `instructions`, OpenAI endpoint fields, worker
  URLs, and current-user context so the Google Meet page cannot carry stale
  sidecar foreground schema or prompt state.
  `test/meeting-agent-realtime-placement-guard.test.mjs` covers TS meeting-agent
  parity with the Go inline removal guard.
- 2026-06-01 foreground result compaction:
  `test/realtime-app-control-bridge.test.mjs` proves large
  `beforePresentation` / `postcheck` / button inventory fields from
  `share_existing_app_window` do not enter model-visible function output or
  wrapper state, and that app-control `job` / `report` / `responseText` /
  `backendResult` / `workerResult` traces are kept out of SDK-visible
  function output. `internal/meetingagent/realtime_app_control_test.go` proves
  `control_shared_app_window` receives compact share status instead of full
  `/join/status` runtime.
- 2026-06-02 app-control tool-shape cleanup:
  `control_shared_app_window` remains the single compatible app-control entry,
  but foreground Realtime schema no longer exposes low-level `operations`
  primitives. The model supplies `instruction` plus `executionMode`; KWWK/direct
  or Codex/delegate owns observe/plan/act/verify. The KWWK helper accepts
  instruction-only direct requests for bounded observe/key/type/scroll actions
  and returns an explicit blocker for instructions it cannot execute directly.
  The browser local-tool boundary strips stale foreground top-level
  `operations` and `context.operations` before dry-run simulation and before
  posting to `/tools/control_shared_app_window`; the Go handler strips the same
  fields, and the KWWK helper no longer reads hidden context operations. Bridge
  and Go tests assert stripped direct primitives stay silent or
  `instruction_required` instead of becoming a fake successful foreground
  action. The Go app-control result mapper also suppresses backend raw
  primitive `operations` before returning `/tools` responses or recording
  real-room app-control artifacts, leaving only `operationsSuppressed` plus
  compact result fields.
- 2026-06-02 sidecar-control runtime-error hardening:
  `benchmark:realtime-tool-recall` now treats sidecar runtime errors as hard
  row failures even when deterministic direct routing produced the expected
  dry-run tool call. This closes the false-green case where a Realtime
  client-secret `500` / upstream EOF was recorded in row `errors` while the
  row still passed as `expected_tool_called`.
- 2026-06-01 real-room app-control rerun harness:
  `npm run acceptance:realtime-real-app-control` wraps
  `scripts/real-meet-synthetic-speaker-smoke.mjs --real-meet-app-control-smoke
--require-real-meet-url`. It is a strict live gate: missing a discoverable real
  Meet URL is a hard failure. The harness now resolves the URL from
  `MAB_REAL_MEET_URL`, `--real-meet-url`, the active meeting-agent
  `/join/status`, or the live joiner `active-meet-browser.json` record; with a
  URL, it joins a real Meet room, shares the configured existing app window,
  drives the app-control request through `/realtime/text-turn`, then requires a
  `control_shared_app_window` sidecar tool call, function-output delivery, the
  Meet-page `OpenAIAgentsRealtime` negative probe from `/join/status`, and an
  explicit terminal compact status:
  either success (`completed` / `done`) or `blocked` / `failed` with a compact
  explicit `blocker`. Terminal `timeout`, `stale`, `error`, canceled states,
  missing blockers, and oversized blockers are hard acceptance failures once the
  live run starts. `npm run benchmark:realtime-real-app-control` is a strict
  benchmark gate and must fail hard without a discoverable URL. The
  local-friendly diagnostic entrypoint is
  `npm run benchmark:realtime-real-app-control:optional`; without a
  discoverable URL it exits 0 only to write skipped evidence with `ok:false`,
  `diagnosticOnly:true`, and `acceptanceSatisfied:false`.
- 2026-06-02 combined live sidecar acceptance:
  `npm run acceptance:realtime-live-sidecar` wraps
  `scripts/real-meet-sidecar-acceptance.mjs --require-real-meet-url`. It is the
  strict real-room acceptance command for the RFC: the synthetic-speaker/fake-mic
  sender gate and the real-room app-control gate both have to return
  `acceptanceSatisfied:true` before the combined result can pass. The optional
  companion `npm run acceptance:realtime-live-sidecar:optional` is diagnostic
  only; when the Meet URL is absent it exits 0 only to write structured evidence
  with `ok:false`, `diagnosticOnly:true`, and `acceptanceSatisfied:false`.
- 2026-06-02 missing-URL discovery hardening:
  `scripts/real-meet-url-resolver.mjs` now falls back from `/join/status` to the
  joiner-maintained `active-meet-browser.json` record under `MAB_DATA_DIR` (or
  `MAB_ACTIVE_MEET_BROWSER_PATH`) and only accepts it when the recorded browser
  process is still alive. Strict live gate JSON now lists both checked sources
  and includes `activeBrowserRecordError` when that fallback is absent. Regression
  coverage: `test/realtime-real-meet-app-control-benchmark.test.mjs` proves the
  active browser record fallback and stale-pid rejection.
- 2026-06-02 local missing-URL check:
  `npm run benchmark:realtime-real-app-control` is now strict and fails hard
  when no active room URL is available. The optional companion
  `npm run benchmark:realtime-real-app-control:optional` checks
  `http://127.0.0.1:8781/join/status` plus the active browser record and may
  write skipped diagnostic evidence with `skipped: true`, `ok:false`,
  `diagnosticOnly:true`, and `acceptanceSatisfied:false`; that optional artifact
  cannot satisfy the live acceptance checkbox.
- 2026-06-02 post-fix local rerun:
  `npm run benchmark:realtime-tool-chains` passed the diagnostic raw-websocket
  chain check (`full`, 2/2 steps). The real-room app-control optional command
  records a diagnostic skip when no room URL is active, but the benchmark alias
  itself is a hard gate. The combined live sidecar acceptance proof was later
  closed by the explicit `MAB_REAL_MEET_URL` run below.
- 2026-06-02 missing-URL resolver rerun:
  Targeted verification after adding active browser record discovery:
  `node --import tsx --test --test-reporter=spec
test/realtime-real-meet-app-control-benchmark.test.mjs` passed `21/21`.
  At this checkpoint, `npm run acceptance:realtime-live-sidecar` and
  `npm run benchmark:realtime-real-app-control` both correctly failed hard
  because neither `/join/status` nor
  `/tmp/meeting-avatar-bot-data/active-meet-browser.json` exposed a live Meet
  URL. This was a missing-URL preflight proof, not the final live acceptance
  proof. `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0
--case-filter '^control_'` passed full `4/4` and share-control-only `4/4`.
- 2026-06-02 post-cleanup sidecar-control rerun:
  after rejecting deprecated backend demo `/tools` names, tightening Go host
  inline config validation, KWWK helper primitive stripping, and
  participant-audio custom-event opt-in, the first strict rerun exposed exactly
  why the old threshold was too
  soft: an `8/9` full recall run could still print `PASS`, and a broad Chinese
  control regex briefly misrouted `现在几点了` to app-control. After tightening
  the fixture threshold and narrowing deterministic routing,
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0 --timeout-ms 30000 --json-out /tmp/oneesama-realtime-tool-recall-strict-2026-06-02.json`
  passed full `9/9` positives plus `2/2` negatives and share/control-only `9/9`
  positives plus `2/2` negatives with no `BAD` rows.
  `npm run benchmark:realtime-tool-lanes -- --iterations 1 --retries 0 --timeout-ms 30000 --json-out /tmp/oneesama-realtime-tool-lanes-strict-2026-06-02.json`
  passed full `7/7` lane coverage.
- 2026-06-02 worker-result/live-input gate hardening:
  worker-result polling now runs on the sidecar page, uses
  `markDelivered: false`, and only calls `/worker/mark-realtime-delivered` with
  the poll-issued realtime delivery token after the sidecar Realtime client
  accepts the job through `injectWorkerResult`. The removed `sendWorkerResult`
  alias and fixture custom-event path cannot confirm Realtime delivery. The
  real-room gate now accepts only `recappi_process_audio_tap` as a live Realtime
  sender source; host PCM and Meet mix are fixture/diagnostic input evidence
  only.
- 2026-06-02 worker-result suppression evidence repair:
  direct `/worker/report`, sidecar worker polling, and Go parity no longer mark
  browser/server-suppressed results as `deliveredToRealtime`. Meeting-scoped
  worker reports with a missing or mismatched meeting session id, plus
  no-action reports, are recorded as `realtimeSuppressed` with an explicit
  suppression reason; only a non-suppressed Realtime client injection can call
  `/worker/mark-realtime-delivered`.
- 2026-06-02 benchmark rerun after worker-result suppression fix:
  the first strict rerun of `benchmark:realtime-tool-recall` exposed a real
  runner evidence problem: full-surface `generic_window_share_zh` failed as an
  opaque `page.waitForFunction` timeout before sidecar state was captured,
  while the focused case and share/control-only variant passed. The benchmark
  runner now waits for the sidecar client API, records `sdkConnectTimedOut`,
  and reports `sidecar_sdk_not_connected` only when the sidecar has neither SDK
  connection nor tool/text output. A rerun with
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0 --timeout-ms 30000 --json-out /tmp/oneesama-realtime-tool-recall-worker-suppression-fix-rerun.json`
  passed full `9/9` positives plus `2/2` negatives and share/control-only
  `9/9` positives plus `2/2` negatives. `npm run
benchmark:realtime-tool-lanes -- --iterations 1 --retries 0 --timeout-ms
30000 --json-out /tmp/oneesama-realtime-tool-lanes-worker-suppression-fix.json`
  passed full `7/7`.
- 2026-06-02 meeting-agent control-port exposure hardening:
  the TS meeting-agent now passes `host: config.meetingHost` to
  `createJsonServer`, and `getRuntimeConfig()` defaults `MAB_MEETING_HOST` to
  `127.0.0.1`. This keeps local Realtime/CU control endpoints such as
  `/tools/*`, `/worker/report`, `/realtime/text-turn`, and `/join/status` off
  the LAN by default while preserving an explicit `MAB_MEETING_HOST=0.0.0.0`
  override for runs that require it. After this hardening,
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0 --timeout-ms 30000 --json-out /tmp/oneesama-realtime-tool-recall-loopback-hardening.json`
  passed full `9/9` positives plus `2/2` negatives and share/control-only
  `9/9` positives plus `2/2` negatives; `npm run benchmark:realtime-tool-lanes
-- --iterations 1 --retries 0 --timeout-ms 30000 --json-out
/tmp/oneesama-realtime-tool-lanes-loopback-hardening.json` passed full `7/7`.
- 2026-06-02 TS control-route and SDK-output hardening:
  the legacy TS meeting-agent now rejects cross-origin browser calls to
  internal control routes unless `X-Oneesama-Internal-Key` matches, and
  `/tools/*` rejects names absent from the current live-safe Realtime surface,
  so hidden workspace connector/memory handlers cannot bypass the schema.
  Agents SDK `execute` returns now expose only the compact function result to
  the model; `turnPolicy` remains in bridge diagnostics but is no longer
  returned through `backgroundResult`. Targeted validation passed:
  `node --import tsx --test --test-reporter=spec test/meeting-agent-realtime-placement-guard.test.mjs test/realtime-agents-sdk-adapter.test.mjs test/realtime-agents-sdk-compact-output.test.mjs test/realtime-agents-sdk-mock-tool-guard.test.mjs test/realtime-app-control-bridge.test.mjs`
  (`50/50`); `npm run benchmark:realtime-tool-recall -- --iterations 1
--retries 0 --case-filter '^control_' --json-out
/tmp/oneesama-realtime-tool-recall-after-ts-guard.json` passed `4/4` full
  control rows and `4/4` share/control-only rows; `npm run typecheck`,
  `npm run lint:js`, and `git diff --check` passed.
- 2026-06-02 worker-result custom-event fallback hardening:
  `worker-result-bridge` no longer treats the explicit
  `allowCustomWorkerResultEvents` fallback as Realtime delivery evidence. It can
  still dispatch the diagnostic DOM event for fixture visibility, but it records
  `custom-event-diagnostic` with
  `custom_worker_result_event_diagnostic_only` and does not call
  `/worker/mark-realtime-delivered`. The browser Realtime listener now treats
  the same event as diagnostic-only even when a fixture explicitly sets
  `allowCustomWorkerResultEvents`, so it no longer updates HUD state or calls
  `injectWorkerResult`. The bridge and joiner host wrapper also ignore the
  removed `sendWorkerResult` alias; seeing only that alias is now treated as
  `realtime-client-missing` and cannot ack a worker report. Targeted validation
  passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-sidecar-tool-routing.test.mjs
test/realtime-agents-sdk-mock-tool-guard.test.mjs
test/google-meet-joiner-realtime-control.test.mjs
test/realtime-worker-report-store.test.mjs
test/realtime-app-control-bridge.test.mjs` (`33/33`);
  latest listener-hardening validation:
  `node --import tsx --test --test-reporter=spec
test/google-meet-joiner-realtime-control.test.mjs
test/realtime-app-control-bridge.test.mjs
test/realtime-agents-sdk-mock-tool-guard.test.mjs` (`40/40`);
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0
--case-filter '^control_' --json-out
/tmp/oneesama-realtime-tool-recall-worker-event-listener-hardening.json`
  passed `4/4` full control rows and `4/4` share/control-only rows;
  `npm run benchmark:realtime-kwwk-app-control` passed `3/3`;
  `node --import tsx --test --test-reporter=spec
test/realtime-real-meet-app-control-benchmark.test.mjs` passed `22/22`;
  `npm run benchmark:realtime-real-app-control:optional -- --json-out
/tmp/oneesama-realtime-real-app-control-optional-worker-event-listener-hardening.json`
  exited `0` with skipped diagnostic evidence
  (`reason=missing_env`, `missingEnv=["MAB_REAL_MEET_URL"]`);
  `npm run typecheck`, `npm run lint:js`, and `git diff --check` passed.
- 2026-06-02 Realtime browser public API hardening:
  `MAB_REALTIME_CLIENT` no longer exposes low-level local tool executors
  (`runLocalAvatarTool`, `runLocalWorkerTool`, `runLocalMeetTool`) or the
  `sendWorkerResult` alias. The foreground/fixture path still uses
  `simulateRealtimeAgentToolCall`, worker-result delivery uses
  `injectWorkerResult`, and Meet-page DOM tools use the dedicated
  `MAB_MEET_SURFACE_TOOLS.run` port. `sendMeetChatFromActive` /
  `readMeetChatFromActive` no longer fall back to `MAB_REALTIME_CLIENT`
  local meet tools. Targeted validation passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-agents-sdk-mock-tool-guard.test.mjs
test/google-meet-joiner-realtime-control.test.mjs
test/realtime-sidecar-tool-routing.test.mjs` (`19/19`);
- 2026-06-02 mock-tool flag event-gate hardening:
  `allowMockToolSimulation` is now scoped to the explicit
  `simulateRealtimeAgentToolCall` helper. It no longer enables
  browser-dispatched custom Realtime server events, custom speech-start events,
  or custom worker-result events on non-mock pages; those paths still require
  mock mode or their explicit custom-event fixture flags. Targeted validation
  passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-agents-sdk-mock-tool-guard.test.mjs
test/realtime-browser-bridge-text-guard.test.mjs
test/realtime-app-control-bridge.test.mjs
test/realtime-sidecar-tool-routing.test.mjs` (`35/35`);
  `npm run benchmark:realtime-tool-lanes -- --iterations 1 --retries 0
--case-filter 'read_meet_chat|delegate_to_worker' --json-out
/tmp/oneesama-realtime-tool-lanes-mock-flag-custom-event-hardening.json`
  passed `2/2`;
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0
--case-filter '^control_' --json-out
/tmp/oneesama-realtime-tool-recall-mock-flag-custom-event-hardening.json`
  passed `4/4` full control rows and `4/4` share/control-only rows.
- 2026-06-02 sidecar-only control page hardening:
  `getRealtimeControlPageForActive()` no longer falls back to the Google Meet
  page. Worker-result injection, allowlisted Realtime control events,
  Realtime text turns, bridge/worker-result status reads, Recappi Realtime audio
  input, and pushed meeting awareness now require a live sidecar page. If the
  sidecar page is missing or closed, those paths fail closed with
  `realtime_sidecar_page_missing`; the Meet page only keeps the non-pushed
  awareness surface store plus Meet DOM surface tools. Sidecar-page
  `send_meet_chat` / `read_meet_chat` also require
  `MAB_HOST_RUN_SURFACE_TOOL`; without the host surface port they fail as
  `meet_surface_tool_port_missing` instead of falling back to sidecar DOM or
  fixture state. Realtime sidecar pages also skip the Meet chat DOM observer
  (`meet_chat_observer_skipped` / `sidecar_page_not_meet_surface`) so sidecar
  DOM mutations cannot inject `meet_chat_observer` user events through the
  internal realtime event path. Targeted validation
  passed:
  `node --import tsx --test --test-reporter=spec
test/google-meet-joiner-realtime-control.test.mjs
test/google-meet-joiner-runtime-state.test.mjs
test/meeting-audio-inputs.test.mjs` (`24/24`);
  latest sidecar/control validation with `test/realtime-sidecar-tool-routing.test.mjs`
  and `test/realtime-app-control-bridge.test.mjs` passed `21/21`.
  The latest Meet-chat surface-port hardening validation also passed:
  `node --import tsx --test --test-reporter=spec
test/google-meet-joiner-realtime-control.test.mjs
test/realtime-agents-sdk-mock-tool-guard.test.mjs
test/realtime-sidecar-tool-routing.test.mjs` (`29/29`);
  `npm run benchmark:realtime-tool-lanes -- --iterations 1 --retries 0
--case-filter 'read_meet_chat' --json-out
/tmp/oneesama-realtime-tool-lanes-meet-chat-surface-port-hardening.json`
  passed `1/1`;
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0
--case-filter '^control_' --json-out
/tmp/oneesama-realtime-tool-recall-meet-chat-surface-port-hardening.json`
  passed `4/4` full control rows and `4/4` share/control-only rows.
  The latest sidecar chat-observer hardening validation passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-agents-sdk-adapter.test.mjs
test/realtime-meet-chat-observer.test.mjs
test/realtime-browser-bridge-text-guard.test.mjs
test/realtime-sidecar-tool-routing.test.mjs
test/realtime-agents-sdk-mock-tool-guard.test.mjs` (`37/37`);
  `npm run benchmark:realtime-tool-lanes -- --iterations 1 --retries 0
--case-filter 'read_meet_chat|delegate_to_worker' --json-out
/tmp/oneesama-realtime-tool-lanes-sidecar-chat-observer-hardening.json`
  passed `2/2`;
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0
--case-filter '^control_' --json-out
/tmp/oneesama-realtime-tool-recall-sidecar-chat-observer-hardening.json`
  passed `4/4` full control rows and `4/4` share/control-only rows.
  `node --import tsx --test --test-reporter=spec
test/realtime-app-control-bridge.test.mjs
test/realtime-agents-sdk-adapter.test.mjs
test/realtime-agents-sdk-compact-output.test.mjs` (`31/31`);
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0
--case-filter '^control_' --json-out
/tmp/oneesama-realtime-tool-recall-public-api-hardening.json` passed `4/4`
  full control rows and `4/4` share/control-only rows; `npm run typecheck` and
  `npm run lint:js` passed.
- 2026-06-02 raw Realtime event public API hardening:
  `MAB_REALTIME_CLIENT.sendRealtimeEvent` is no longer public. Host
  `/realtime/event` reaches the browser through `sendRealtimeControlEvent`,
  which only allows `response.cancel` and `input_audio_buffer.clear`, matching
  the server/meet-runner allowlist. The joiner host wrapper now also maps the
  browser-side `realtime-control-event-not-allowed` rejection to
  `ok:false` / `realtime_event_type_not_allowed`, so a rejected raw event cannot
  appear as a successful host send. Meeting awareness context now uses
  `pushSessionContext` only and no longer falls back to raw
  `conversation.item.create` injection. CLI smoke paths that previously
  constructed raw user/response events now use `requestRealtimeTextTurn`.
  Targeted validation passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-browser-bridge-text-guard.test.mjs
test/google-meet-joiner-realtime-control.test.mjs
test/meet-runner-protocol.test.mjs` (`14/14`);
  `node --import tsx --test --test-reporter=spec
test/realtime-app-control-bridge.test.mjs
test/realtime-agents-sdk-adapter.test.mjs
test/realtime-agents-sdk-compact-output.test.mjs
test/realtime-agents-sdk-mock-tool-guard.test.mjs` (`41/41`);
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0
--case-filter '^control_' --json-out
/tmp/oneesama-realtime-tool-recall-control-event-api-hardening.json` passed
  `4/4` full control rows and `4/4` share/control-only rows; `npm run
typecheck` and `npm run lint:js` passed.
- 2026-06-02 KWWK/CU local benchmark repair:
  `benchmark:realtime-tool-recall` and `benchmark:realtime-tool-lanes` only
  prove tool routing/telemetry; they do not execute host Computer Use. A new
  `npm run benchmark:realtime-kwwk-app-control` wrapper runs the non-mutating
  live KWWK app-control smoke against a local macOS app (default `Chrome`) and
  writes `/tmp/oneesama-realtime-kwwk-app-control-latest.json`. The first live
  rerun caught two real problems: the Swift KWWK helper ignored explicit
  JSON-RPC `operations`, and the HTTP live smoke did not pass `wait:true`, so
  it returned queued jobs instead of terminal app-control evidence. The helper
  now honors explicit operations before falling back to instruction-derived
  operations, and the HTTP smoke waits for terminal results. Verified with
  `MAB_RUN_KWWK_APP_CONTROL_LIVE_SMOKE=1 MAB_KWWK_APP_CONTROL_LIVE_APP=Chrome
go test ./internal/meetingagent -run
'TestLiveKWWKStdioAppControlBackendControlsHostApp|TestLiveRealtimeSharedAppControlHTTPUsesKWWKBackend|TestLiveRealtimeSharedAppControlHTTPAcceptsKWWKInstructionOnlyObserve'
-count=1 -v`, which passed `3/3`, and
  `npm run benchmark:realtime-kwwk-app-control`, which passed `3/3`.
- 2026-06-02 post-tool cleanup benchmark rerun:
  The local tool-change gates passed after removing the stale standalone
  app-control branch and fixing appended CLI output arguments to override npm
  script defaults. `npm run benchmark:realtime-kwwk-app-control` passed `3/3`.
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0
--case-filter '^control_' --json-out
/tmp/oneesama-realtime-tool-recall-control-latest.json` passed `4/4` full
  control rows and `4/4` share/control-only rows. `go test
./internal/meetingagent -run
'TestRealtimeSharedAppControl|TestQueuedAppControl|TestKWWKStdioAppControlBackend'`
  passed. `node --import tsx --test --test-reporter=spec
test/realtime-real-meet-app-control-benchmark.test.mjs
test/realtime-contract.test.mjs` passed `38/38`. `npm run typecheck`,
  `npm run lint:js`, and `git diff --check` passed. The strict
  `npm run benchmark:realtime-real-app-control` gate still exits `1` without
  `MAB_REAL_MEET_URL` or an active meeting-agent real Meet session; that is a
  live-room preflight failure (`reason: "missing_env"`) rather than local
  KWWK/CU execution failure.
- 2026-06-02 worker dry-run benchmark isolation:
  A full lane rerun exposed a benchmark-side effect: `dryRunLocalTools` covered
  app/window tools but not worker tools, so lane cases for `delegate_to_worker`
  could launch real Codex workers while the report only claimed routing
  evidence. The browser local-tool helper now dry-runs `delegate_to_worker` and
  `worker_status` whenever `dryRunLocalTools` is enabled, and the benchmark
  evidence profile now says local functional tools, including background-worker
  tools, are dry-run-only. Validation passed: `node --import tsx --test
--test-reporter=spec test/realtime-sidecar-tool-routing.test.mjs
test/realtime-tool-recall-benchmark.test.mjs` (`23/23`), and `npm run
benchmark:realtime-tool-lanes -- --iterations 1 --retries 0 --json-out
/tmp/oneesama-realtime-tool-lanes-worker-dry-run.json` passed `7/7`.
- 2026-06-02 dry-run/mock simulation and sidecar live-boundary cleanup:
  `dryRunLocalTools` no longer enables browser-side
  `simulateRealtimeAgentToolCall` in real `agents-sdk` sessions; mock tool
  simulation still requires mock mode or explicit `allowMockToolSimulation`.
  The strict real Meet app-control compact helper now reads Go meeting-agent
  runtime evidence from `status.runtime.active` when top-level `status.active`
  is only a persisted `SessionRecord`, so a valid live sidecar run is not
  misclassified as missing Realtime evidence. Sidecar host Meet PCM forwarding
  now rejects stale-session payloads before evaluating in the sidecar page, and
  sidecar startup closes the local sidecar server if page creation/setup fails
  before the caller receives the server handle. Validation passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-real-meet-app-control-benchmark.test.mjs
test/realtime-sidecar-surface-audio-input.test.mjs
test/realtime-sidecar-tool-routing.test.mjs
test/realtime-agents-sdk-mock-tool-guard.test.mjs` (`46/46`), and
  `npm run benchmark:realtime-tool-lanes -- --iterations 1 --retries 0
--json-out /tmp/oneesama-realtime-tool-lanes-fix.json` passed `7/7`.
  `npm run benchmark:realtime-real-app-control:optional` exited `0` with
  diagnostic `reason: "missing_env"` because that checkpoint had no
  `MAB_REAL_MEET_URL`, no active meeting-agent `/join/status` real Meet URL, and
  no `/tmp/meeting-avatar-bot-data/active-meet-browser.json`; this was a
  live-room preflight skip, not a KWWK/CU/tool-routing failure.
- 2026-06-02 Meet surface tool session-boundary cleanup:
  Sidecar-to-Meet surface tool calls now include the sidecar `sessionId`, and
  the host `MAB_HOST_RUN_SURFACE_TOOL` binding rejects mismatched payloads before
  evaluating on the Meet page. This closes the same stale-page class as the
  Meet PCM forwarding guard for chat/awareness tools: an old sidecar page cannot
  send `send_meet_chat` or `read_meet_chat` into the current room through the
  shared browser context. `dryRunLocalTools` also no longer bypasses
  Meet-surface authorization: the Meet surface rejects local share/app tools
  before any dry-run response, and sidecar-page Meet chat tools still require
  the host surface port in benchmark fixtures. Validation passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-sidecar-tool-routing.test.mjs` (`9/9`) and
  `npm run benchmark:realtime-tool-lanes -- --iterations 1 --retries 0
--json-out /tmp/oneesama-realtime-tool-lanes-surface-dryrun-auth.json` passed
  `7/7`.
- 2026-06-02 local-fixture text-turn fallback cleanup:
  The local fixture synthetic-speaker tool gate no longer uses
  `/realtime/text-turn` fallback by default when the audio turn produces model
  speech but no expected tool call. `MAB_REALTIME_SYNTHETIC_TEXT_TURN_FALLBACK`
  is now an explicit diagnostic opt-in, and a child result that used that
  fallback cannot satisfy the combined live-sidecar acceptance wrapper even if
  it later reports `ok:true` and `acceptanceSatisfied:true`. Validation passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-real-meet-app-control-benchmark.test.mjs` (`24/24`).
- 2026-06-02 sidecar-audio scorer runtime-evidence cleanup:
  `scoreAudioReplay()` now maps the browser run's `browserBridgeRuntime` into
  the common runtime scorer and adds a sidecar-audio-specific SDK connection
  gate. A matching tool call can no longer pass the audio replay benchmark if
  the actual browser evidence shows the Meet surface has an Agents SDK global,
  SDK suppression failed, or the sidecar SDK never connected. Validation passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-audio-tool-replay-benchmark.test.mjs` (`14/14`).
- 2026-06-02 TS meeting-agent requested-tool subset cleanup:
  `/realtime/client-secret` now intersects caller-supplied tools with the
  meeting-agent live-safe default whitelist instead of ignoring the request and
  minting the full foreground surface. Legal subsets such as
  `control_shared_app_window` are preserved; stale/hidden names such as
  `open_shared_browser_surface` or `github_search` are filtered and no longer
  broaden benchmark variants that intentionally expose a smaller tool surface.
  Validation passed: `node --import tsx --test --test-reporter=spec
test/meeting-agent-realtime-placement-guard.test.mjs` (`13/13`).
- 2026-06-02 Go meeting-agent requested-tool subset cleanup:
  The Go `/realtime/client-secret` service path now treats omitted tools as the
  server canonical default, but treats an explicit `tools` array as a requested
  subset to intersect with the currently exposed server schema. A stale-only
  request no longer falls back to the full default surface, and a lane request
  for `send_meet_chat` / `share_existing_app_window` cannot accidentally expose
  `delegate_to_worker`, `control_shared_app_window`, hidden browser-surface
  tools, or stale names such as `github_search`. Validation passed:
  `go test ./internal/meetingagent` (`ok`).
- 2026-06-02 KWWK direct app-control mixed-instruction cleanup:
  The host KWWK direct helper no longer treats every instruction containing
  observe/status wording as a state-only success. Direct executable operations
  such as press/scroll/type are parsed first; mixed observe+action requests that
  cannot be safely mapped to a bounded direct operation now return
  `instruction_not_directly_executable` instead of `ok:true` with
  `actions:["observe"]`. Go Codex fallback is also limited to exact KWWK
  availability reasons, so UI blockers such as `start button not found` do not
  get rerouted to the slower Codex executor. The real-Meet app-control
  acceptance helper now rejects observe-only success for action-bearing
  instructions unless the app-control result contains a compact explicit
  blocker. Validation passed: `node --import tsx --test --test-reporter=spec
test/realtime-real-meet-app-control-benchmark.test.mjs
test/realtime-contract.test.mjs` (`41/41`),
  `go test ./internal/meetingagent -run
'TestFallbackAppControlBackendFallsBackToCodexOnlyWhenKWWKUnavailable|TestRealtimeClientSecret.*Tool|TestJoinRealtimeUsesServerCanonicalToolSurface'
-count=1` (`ok`), and
  `npm run benchmark:realtime-kwwk-app-control -- --app Chrome --json-out
/tmp/oneesama-realtime-kwwk-app-control-mixed-negative.json` passed all four
  live host KWWK smoke cases, including
  `TestLiveKWWKStdioAppControlBackendRejectsMixedObserveActionInstruction`.
- 2026-06-02 legacy screen-share tool residue cleanup:
  Removed stale `start_screen_share`, `present_screen_share`, and
  `stop_screen_share` names from the browser local-tool compact-result and
  Realtime turn-policy compacting lists. Those names are no longer part of the
  current foreground schema or local tool router, so keeping them in production
  compact paths made old screen-share semantics look partially supported after
  the app/window share rewrite. The contract test now pins them as hidden legacy
  names. Validation passed: `node --import tsx --test --test-reporter=spec
test/realtime-contract.test.mjs test/realtime-app-control-bridge.test.mjs
test/realtime-sidecar-tool-routing.test.mjs` (`41/41`), and `rg -n
"start_screen_share|present_screen_share|stop_screen_share"
packages/core/src/realtime packages/core/src/meeting apps/meeting-agent/src
internal/meetingagent scripts test/realtime-contract.test.mjs` now only finds
  the test hidden-list plus the unrelated `auto_start_screen_share` join option.
- 2026-06-02 TS meeting-agent route parity and worker-result auth cleanup:
  The TS meeting-agent now wires `/screen-share/apps` and `/screen-share/app`
  to the same `joiner.listShareableApps()` / `joiner.presentAppShare()` APIs
  used by the sidecar local Meet tool router. Its
  `/tools/control_shared_app_window` route no longer falls through to
  `handleWorkspaceTool()` / `unknown_workspace_tool`: direct mode now queues a
  TS KWWK app-control job by default, resolves target fields from the active
  screen-share status, and writes terminal results into `worker_reports` so the
  sidecar worker-result bridge can inject them back into Realtime. `wait:true`
  still permits a synchronous direct check for diagnostics, while unsupported TS
  delegate mode returns a compact explicit blocker over HTTP `200` so Realtime
  receives a tool result instead of a transport failure. TS KWWK helper output
  is compacted before both direct tool responses and queued worker reports, so
  raw helper `metadata`, `operations`, nested `result`, and `responseText` cannot
  re-enter the foreground model or Meet chat through the TS fallback. The
  browser local workspace-tool boundary now injects the current `session_id`
  into `control_shared_app_window` host POSTs when the model omitted it, so
  queued app-control worker reports have stable meeting provenance instead of
  relying only on host active-status fallback. The sidecar worker-result bridge
  also carries
  `toolCallbackToken` as `X-Oneesama-Internal-Key` on both
  `/worker/poll-realtime` and `/worker/mark-realtime-delivered`, so guarded
  cross-port worker result delivery is no longer rejected by the host. Validation
  passed: `node --import tsx --test --test-reporter=spec
test/meeting-agent-app-control-result.test.mjs
test/realtime-sidecar-tool-routing.test.mjs
test/meeting-agent-realtime-placement-guard.test.mjs
test/realtime-app-control-bridge.test.mjs
test/realtime-worker-report-store.test.mjs` (`42/42`), `npm run typecheck`,
  `npm run benchmark:realtime-kwwk-app-control -- --app Chrome --json-out
/tmp/oneesama-realtime-kwwk-app-control-after-session-provenance-fix.json`
  (`4/4`), and `npm run benchmark:realtime-tool-lanes -- --iterations 1
--retries 0 --json-out
/tmp/oneesama-realtime-tool-lanes-after-token-retry-rerun.json` (`7/7`).
  Follow-up sweep validation also passed: the broader realtime/tool targeted
  suite (`122/122`), `npm run lint:js`, `go test ./internal/meetingagent`
  (`cached ok`), and `git diff --check`. Optional live gates were rerun and
  remain diagnostic-only skips because no `MAB_REAL_MEET_URL`, active
  `/join/status` room, or `/tmp/meeting-avatar-bot-data/active-meet-browser.json`
  exists:
  `/tmp/oneesama-realtime-real-app-control-after-ts-compact-fix-optional.json`
  and
  `/tmp/oneesama-realtime-live-sidecar-after-ts-compact-fix-optional.json`.
- 2026-06-02 sidecar-control SDK-connected benchmark gate:
  Tightening `scoreCase()` to reject direct-routed tool calls when
  `sdkConnected=false` exposed the earlier false green: with the old 5s SDK wait,
  `npm run benchmark:realtime-tool-lanes -- --iterations 1 --retries 0
--json-out /tmp/oneesama-realtime-tool-lanes-sdk-connected-gate.json` failed
  `1/7`, and the six bad rows all had `reason: "sidecar_sdk_not_connected"` plus
  `sdkConnectTimedOut:true` despite local dry-run tool calls being present. The
  benchmark now waits up to 15s by default for sidecar SDK cold start, but still
  fails hard if the SDK never connects. Validation passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-tool-recall-benchmark.test.mjs` (`17/17`) and
  `npm run benchmark:realtime-tool-lanes -- --iterations 1 --retries 0
--json-out /tmp/oneesama-realtime-tool-lanes-sdk-connected-gate-rerun.json`
  passed `7/7`; every row in that JSON has `sdkConnected:true` and
  `sdkConnectTimedOut:false`.
- 2026-06-02 functional-tool recovery cleanup:
  Removed the old fake-execution functional-tool recovery helper from the
  Realtime browser bundle. A share/control turn where the model speaks progress
  text without the expected tool call now remains a hard failure even if stale
  config still passes `allowFunctionalToolRecovery:true`; the bridge no longer
  stores `functionalToolRecoveries` state and no longer sends a corrective
  `response.cancel` / `response.create` pair with
  `metadata.source="functional_tool_recovery"`. Targeted validation passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-agents-sdk-fake-execution.test.mjs
test/realtime-browser-bridge-text-guard.test.mjs
test/realtime-agents-sdk-mock-tool-guard.test.mjs` (`18/18`), and
  `npm run benchmark:realtime-tool-recall -- --iterations 1 --retries 0
--case-filter '^control_' --json-out
/tmp/oneesama-realtime-tool-recall-after-recovery-removal.json` passed `4/4`
  full control rows and `4/4` share/control-only rows.
- 2026-06-02 real-room surface audio output and combined gate closure:
  The strict synthetic speaker gate first exposed a live-only hole: the sidecar
  proved Realtime input/output and avatar PCM routing, but the Meet page had no
  durable fake-mic publish sender evidence (`meetPublishSenderLive:false`).
  The fix installs a Meet-surface-only early RTCPeerConnection audio-output
  hook inside the sidecar placeholder, keeps the Agents SDK out of
  `meet.google.com`, merges Meet-surface publish evidence back into sidecar
  status, and publishes avatar audio to Meet with cloned avatar-bus tracks so
  Meet cannot end the original bus output track. Targeted validation passed:
  `node --import tsx --test --test-reporter=spec
test/realtime-sidecar-tool-routing.test.mjs
test/realtime-browser-bridge-meet-receiver-smoke.test.mjs` (`28/28`),
  `npm run typecheck`, `npm run lint:js`, `git diff --check`, and strict live
  `MAB_REAL_MEET_URL='https://meet.google.com/ypw-fozb-anz'
MAB_SYNTHETIC_SPEAKER_HEADLESS=false npm run acceptance:realtime-live-sidecar
-- --json-out
/tmp/oneesama-realtime-live-sidecar-user-meet-after-surface-output-hook.json`
  (`ok:true`, `acceptanceSatisfied:true`). The synthetic child records live
  publish evidence (`meetPublishSenderLive:true`,
  `primaryMeetAudioSenderUsingAvatarBus:true`, bytes/packets deltas), and the
  app-control child records KWWK provider evidence plus the compact
  `instruction_not_directly_executable` blocker for the observe-only request.
- 2026-06-02 Realtime/KWWK CU specialized gate split:
  The sidecar benchmark document now defers layer-specific KWWK Computer Use
  proof boundaries to
  [Realtime/KWWK CU Benchmark Gates](../realtime-kwwk-cu-benchmark-gates-rfc-2026-06-02.md).
  Local/CI labels are now explicit:
  `benchmark:realtime-tool-recall` proves SDK-connected recall only;
  `benchmark:realtime-kwwk-app-control` proves backend observe/state execution;
  `benchmark:realtime-kwwk-planner-action` proves deterministic planner/action
  fixture behavior; `benchmark:realtime-kwwk-cursor-visible` proves rendered
  cursor/HUD local pixels; `benchmark:realtime-kwwk-latency` proves cold/warm
  helper latency segmentation; `acceptance:realtime-live-sidecar` remains the
  strict real-room rollup. These reports are intentionally not interchangeable:
  a pass in one gate must not be cited as proof for another layer.
