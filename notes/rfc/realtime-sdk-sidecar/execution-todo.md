# Realtime SDK Sidecar Execution Todo

Parent RFC:
[Realtime SDK Sidecar for Google Meet](../realtime-sdk-sidecar-rfc-2026-06-01.md)

This is the executable worklist. Every item should correspond to code, tests,
runtime status, or live evidence.

## Phase 0: Freeze Target and Guard Inline SDK

- [x] Write the parent RFC.
- [x] Reject inline Agents SDK placement from live Google Meet entrypoints; keep
      diagnostic warnings only in lower-level non-Meet compatibility coverage.
- [x] Add a regression test that documents inline Agents SDK on Meet as removed
      from the live join path.
- [x] Keep the current jitless SDK patch only as lower-level diagnostic
      coverage outside the Meet join path; inline SDK bundle/runtime use now
      requires explicit `allowInlineAgentsSDKDiagnostic`.
- [x] Tag non-sidecar audio browser-transport replay as diagnostic-only with
      explicit inline SDK opt-in, so it cannot be mistaken for the sidecar audio
      acceptance gate.
- [x] Update handoff/memory so future agents do not restart the receiver/VAD
      investigation as the main path.

Done when:

- [x] The code and docs both say the target architecture is sidecar, not inline
      SDK on Meet.

## Phase 1: Split Runtime Placement

- [x] Add `realtimeRuntimePlacement` config, then retire `inline` from
      Google Meet/live host entrypoints so `sidecar` is the only accepted live
      placement; lower-level non-Meet inline coverage remains diagnostic only.
- [x] Teach the joiner to build page-scoped init-script sets:
  - Meet page: avatar, screen share, worker/local surface helpers, no SDK;
  - sidecar page: Realtime bridge plus Agents SDK.
- [x] Create the sidecar page from the host-owned browser context.
- [x] Report placement and SDK owner in runtime status.
- [x] Test that a Meet page in sidecar mode has no SDK global or bundle marker.
- [x] Test that the sidecar page owns SDK session state.

Done when:

- [x] A strict-CSP Meet-surface fixture can prove the Meet page has no SDK while
      the sidecar has a Realtime SDK session id.

## Phase 2: Move Realtime Control Plane

- [x] Route `/realtime/text-turn` to the sidecar page.
- [x] Route allowlisted Realtime control events to the sidecar page; raw
      user/model event injection is removed from the public browser API.
- [x] Publish meeting awareness snapshots to the sidecar page.
- [x] Read Realtime bridge/runtime state from the sidecar page.
- [x] Keep Meet page state reads on the Meet page.
- [x] Add host-mediated `SurfaceToolPort`.
- [x] Delegate Meet DOM tools through the host to the Meet surface page.
- [x] Route local app/window share tools through existing app-control wrappers.
- [x] Preserve call ids through tool call, result, and `function_call_output`.
- [x] Make fake execution a hard failure at sidecar telemetry level.

Done when:

- [x] A sidecar text turn for "分享 Chrome 窗口" records SDK history and calls a
      real share/list/control tool without SDK in the Meet page.

## Phase 3: Move Realtime Audio

- [x] Push Recappi process-tap chunks to the sidecar input audio port.
- [x] Preserve Recappi chunk timing, sample rate, and energy diagnostics.
- [x] Keep receiver/WebRTC track recording diagnostic-only.
- [x] Keep receiver/WebRTC routed tracks out of `audioInputReady` until mixer
      energy is actually observed.
- [x] Remove the stale `allowGenericMediaElementAudioDiscovery` override for
      Google Meet pages, so arbitrary Meet-page media elements cannot bypass
      the host-owned Recappi/receiver diagnostic input boundary.
- [x] Quarantine the legacy Recappi-to-Meet-receiver fallback flag so receiver
      tracks cannot become Realtime input before the Recappi tap connects.
- [x] Remove legacy Recappi receiver fallback runtime state from bridge
      diagnostics after proving receiver tracks stay diagnostic-only.
- [x] Remove stale meet-runner `realtime_fallback_to_local_mic` protocol
      plumbing.
- [x] Add sidecar output audio tap from SDK remote audio to PCM chunks.
- [x] Add an explicit Meet-page avatar audio bus PCM enqueue API.
- [x] Forward sidecar PCM chunks into the Meet avatar audio bus.
- [x] Verify avatar output energy after a model speech response.
- [x] Verify the fixture avatar output track remains live while sidecar output
      audio is routed.
- [ ] Capture fresh real-room primary Meet fake-mic sender stats showing the
      avatar-bus sender is live and sending bytes.
- [x] Assert no Realtime local speaker sink is used in Meet sessions.

Done when:

- [x] A real-room or fixture voice response produces sidecar output evidence,
      avatar audio bus energy, and Meet fake mic sender activity.

## Phase 4: Replace Benchmark Gate

- [x] Make the default share replay benchmark exercise the sidecar placement.
- [x] Add `sidecar-control` benchmark mode.
- [x] Add `sidecar-audio` benchmark mode using the uploaded Recappi sample path.
- [x] Add `meet-page-csp` fixture/live mode proving Meet page restrictions do
      not break sidecar SDK history or tool calls.
- [x] Fail if assistant progress text appears without a correlated tool call.
- [x] Fail if raw SDK/tool events exist but wrapper telemetry is missing.
- [x] Include SDK runtime status, assistant text, tool calls, and
      fake-execution verdict in the sidecar benchmark report.
- [x] Extend sidecar reports with full wrapper telemetry, app-control telemetry,
      and `function_call_output` delivery evidence.
- [x] Fail app-control benchmark rows when terminal app-control telemetry is
      `timeout`, `failed`, `stale`, or `blocked`.
- [x] Add regression coverage that foreground app-control prompts and results
      receive compact share status instead of full `/join/status` runtime blobs.
- [x] Make sidecar-audio scoring require runtime health and user
      transcript/history evidence before accepting a matching tool call.

Done when:

- [x] The benchmark would have failed the original "口头假执行" bug.

## Phase 5: Roll Out and Retire Inline Meet SDK

- [x] Restart meeting-agent with sidecar enabled in a controlled live smoke.
- [x] Run real-room share replay and archive one complete evidence artifact.
- [x] Run real-room voice-output smoke after output audio bridge lands.
- [x] Archive a local fixture tool-share smoke proving sidecar input, model
      turn, tool call, and output route without loading SDK into the Meet
      surface.
- [x] Make sidecar the default for `agents-sdk + google_meet`.
- [x] Remove inline placement from the Google Meet join path.
- [x] Reject direct Go `/join/google-meet`, TS meet-runner, and low-level
      `google-meet-joiner` inline placement even when stale emergency override
      env is present, not only when using the shell runbook.
- [x] Default missing Realtime bridge mode to `agents-sdk` for Agents SDK
      runtime instead of the old mock runtime.
- [x] Add Go `/realtime/event` -> meet-runner -> sidecar routing parity with
      the TS meeting-agent control port.
- [x] Make sidecar text/event sends report `not_connected` instead of
      succeeding through the legacy custom-event fallback when SDK transport is
      unavailable.
- [x] Narrow host `/realtime/event` / meet-runner `realtime.event` to
      allowlisted control events so user/model turns cannot bypass
      `/realtime/text-turn`.
- [x] Reject browser-side mock SDK tool simulation in non-mock sessions unless a
      fixture explicitly opts in.
- [x] Remove the older `runRealtimeAgentSDKTool` public alias so mock tool
      execution stays visibly fixture-only.
- [x] Reject browser-side custom Realtime server events in non-mock sessions
      unless a fixture explicitly opts in.
- [x] Reject browser-side custom speech-start events in non-mock sessions unless
      a fixture explicitly opts in.
- [x] Reject browser-side custom worker-result events in non-mock sessions, and
      suppress worker results that do not carry the current meeting session id.
- [x] Keep `allowMockToolSimulation` scoped to
      `simulateRealtimeAgentToolCall`; it no longer opts non-mock pages into
      custom Realtime server, speech-start, or worker-result DOM events. Those
      require mock mode or the explicit custom-event fixture flags.
- [x] Remove host worker-result fallback to DOM custom events when the Realtime
      client API is missing.
- [x] Keep suppressed worker results out of `deliveredToRealtime`: direct
      `/worker/report`, poll-based worker-result bridge, and Go parity now mark
      session-missing / session-mismatch / no-action results as
      `realtimeSuppressed` instead of fake delivered evidence.
- [x] Harden the sidecar-control recall benchmark runner so SDK-connect jitter
      does not become an opaque `benchmark_error`: the runner captures sidecar
      state after client API readiness, records `sdkConnectTimedOut`, and still
      fails true silent/no-SDK rows as `sidecar_sdk_not_connected`.
- [x] Bind the TS meeting-agent control API to loopback by default
      (`MAB_MEETING_HOST=127.0.0.1`) so `/tools/*`, `/worker/report`,
      `/realtime/text-turn`, and `/join/status` are not exposed to the local
      network unless a live run explicitly opts into another host.
- [x] Remove `mockRemoteAudioInjected` diagnostics from connection state, even
      after mock remote audio routes; use generic
      `remoteAudioRoutedToAvatarBus` evidence instead.
- [x] Rename stale receiver fallback disconnect telemetry to receiver diagnostic
      disconnect telemetry.
- [x] Remove old local-fake `tool_start` / `tool_end` SDK event compatibility from
      production-side Agents SDK event handlers.
- [x] Remove hidden deprecated foreground aliases from browser local tool
      execution (`delegate_to_codex`, `delegate_status`,
      `list_shareable_apps`, `present_app_share`) so old names cannot bypass
      the current schema through mock/local tool paths.
- [x] Reject browser/demo-surface tool aliases in the browser local tool router
      unless demo-surface tools are explicitly exposed by config, so hidden
      `open_shared_browser_surface` / `control_shared_browser_surface` routes
      cannot bypass the server-gated schema.
- [x] Reject any browser local tool call that is absent from the current
      Realtime session schema, even in mock/dry-run tool simulation, so stale
      local tool handlers such as `github_search` cannot execute after the
      server tool inventory stops exposing them.
- [x] Make the TS meeting-agent `/realtime/config` endpoint use the same
      live-safe default Google Meet tool surface as the joiner, instead of
      returning the full TS schema with demo/browser-surface tools by default;
      the nested `session.tools` now uses that same live-safe surface.
- [x] Make raw TS and Go `buildRealtimeSessionConfig()` default to the
      live-safe Google Meet tool surface; demo/browser-surface tools now require
      explicit schema opt-in or the server-side demo-surface Realtime exposure
      gate. `DemoSurface.Enabled` alone must not expose browser-surface tools.
- [x] Make Go join metadata hash the actually exposed Realtime tool surface and
      reject hidden browser/demo-surface Realtime routes unless
      `ExposeRealtimeTools` is enabled.
- [x] Make Go `/realtime/client-secret` honor explicit requested tool subsets
      by intersecting them with the currently exposed server schema; omitted
      tools still mean server canonical default, but stale-only requests no
      longer fall back to full foreground tools.
- [x] Harden KWWK direct app-control so mixed observe+action instructions cannot
      pass as observe-only success; direct helper now blocks unsafe/unmapped
      mixed requests, Codex fallback only handles exact KWWK availability
      reasons, and the live KWWK benchmark includes a mixed-instruction
      negative smoke.
- [x] Require action semantics in real-Meet app-control acceptance: an
      action-bearing instruction must produce a non-observe app-control action
      or a compact explicit blocker, not just `status=completed` plus
      `actions:["observe"]`.
- [x] Remove stale `start_screen_share` / `present_screen_share` /
      `stop_screen_share` names from Realtime production compact-result and
      turn-policy lists; current app/window share and video-stage tools remain
      the only share tools in those paths, and the old names are pinned as
      hidden legacy names in contract tests.
- [x] Reject deprecated backend demo `/tools` names (`start_demo_surface`,
      `start_demo_execution`, `control_demo_surface`, `cancel_demo_surface`)
      with `deprecated_demo_surface_tool` even when browser-surface tools are
      explicitly exposed; browser helpers now post the current schema names
      directly.
- [x] Make the TS meeting-agent `/realtime/client-secret` endpoint ignore
      caller-supplied stale tools and mint sessions from the same server-owned
      live-safe tool surface.
- [x] Make the optional TS `smoke:realtime-live-routing` default to the
      live-safe Meet/app-control tool surface; browser/demo-surface routing
      cases now require explicit diagnostic opt-in.
- [x] Make the local fixture tool-share smoke deterministic by requiring audio
      readiness first, then allowing `/realtime/text-turn` to satisfy the tool
      gate if fixture TTS/ASR misses the command.
- [x] Make sidecar output-audio telemetry report routed only after the Meet
      avatar PCM enqueue succeeds.
- [x] Remove low-value HUD cells for connection/audio/speaking waiting states
      (`连接中`, `没音频`, `没开口`, `没出声`); keep tool activity and blockers visible.
- [x] Make the avatar playground HUD visual regression wait for the listening
      HUD cell and painted canvas pixels before snapshotting, so HUD cleanup
      cannot create a false "blank HUD" failure.
- [x] Include surface tool `callId` / `responseId` in sidecar host-port
      diagnostics.
- [x] Extend live `meeting-agent` preflight/pid-check coverage to OpenAI key
      aliases and runtime placement.
- [x] Update runbooks/scripts to call the sidecar benchmark by default.
- [x] Remove the inline SDK-on-Meet path from Go/TS meeting-agent,
      meet-runner, and low-level Google Meet joiner entrypoints.
- [x] Delete the inline SDK-on-Meet path once fallback is no
      longer needed.
- [x] Remove internal `toolCallbackToken` and SDK-owned
      `tools`/`session`/`instructions` from the Meet-surface sidecar
      placeholder, and reject local screen/app-share tools from that page.
- [x] Compact share/app-control tool results before they enter SDK history,
      wrapper state, or foreground model-visible function output.
- [x] Report queued app-control terminal worker results before exposing the
      terminal job status, preventing status polling from racing ahead of the
      evidence event.
- [x] Remove low-level app-control `operations` primitives from the foreground
      Realtime tool schema; the model now supplies natural-language
      `instruction` plus `executionMode`, while KWWK/direct or Codex/delegate
      owns observe/plan/act/verify.
- [x] Teach the KWWK helper's direct path to accept instruction-only bounded
      observe/key/type/scroll requests, so foreground Realtime no longer needs
      to generate operation arrays.
- [x] Strip stale foreground top-level `operations` and `context.operations`
      arguments at the browser local-tool boundary before dry-run simulation or
      host POST, strip the same fields in the Go `/tools/control_shared_app_window`
      handler, and stop the KWWK helper from reading hidden context operations
      so old prompts cannot fake a completed app-control primitive action.
- [x] Suppress backend raw primitive `operations` before app-control results are
      returned from `/tools/control_shared_app_window` or captured in real-room
      app-control artifacts; only compact summaries/actions/metadata and a
      suppressed operation count remain visible.
- [x] Reject the hidden `standalone` flag on
      `/tools/control_shared_app_window`, so Realtime app-control cannot bypass
      active meeting/share resolution through an unexposed schema parameter;
      remove the old synthetic standalone target/status/context branch so the
      flag is rejection-only.
- [x] Keep foreground Realtime from supplying primitive `operations`, while
      still allowing internal KWWK JSON-RPC callers and live benchmarks to pass
      explicit `operations`; the Swift helper prefers those explicit operations
      and otherwise derives bounded direct actions from natural-language
      `instruction`.
- [x] Remove the optional live-routing smoke's stale `requireOperations` branch
      so diagnostics cannot reintroduce the old "model emits direct primitive
      operations after state" contract.
- [x] Remove direct participant-audio discovery/registration from
      `MAB_REALTIME_CLIENT`; production-like
      `meeting-avatar-participant-audio-stream` custom events are still rejected
      unless a fixture/mock path explicitly opts in, and the stale
      `allowParticipantAudioStreamRegistration` flag alone cannot reopen the
      event path.
- [x] Reject Go host config values that still request
      `openai.realtime_runtime_placement=inline`; inline remains only a
      lower-level non-Meet browser diagnostic.
- [x] Reject Go host config that exposes demo-surface Realtime tools while using
      the default/fake demo-surface adapter; exposed browser/CU tools must use
      `mode=safe`, `adapter=agent_browser`, or `adapter=codex`.
- [x] Remove fake-execution functional-tool auto-recovery entirely, including
      the old opt-in `allowFunctionalToolRecovery` helper path, so the original
      turn stays a hard failure instead of triggering a second corrective
      `response.create`.
- [x] Count workspace-tool calls, including `control_shared_app_window`, in the
      manual text-turn fake-execution fallback so a real app-control call is not
      misclassified as progress text without a matching tool.
- [x] Make recall/lane benchmark thresholds strict (`minRecall: 1`) so a single
      `BAD` row cannot print `PASS`; benchmark text-turns now explicitly opt
      into deterministic direct routing for high-confidence foreground and lane
      tools, while normal Realtime text-turn behavior stays model-driven.
- [x] Make recall/audio benchmark artifacts state their evidence scope
      explicitly: `sidecar-control` and `sidecar-audio` are dry-run local-tool
      gates (`realAppExecution:false`), not real app/window execution evidence.
- [x] Fail sidecar-control recall rows when the sidecar runtime reports errors,
      even if deterministic direct routing later produces the expected dry-run
      tool call.
- [x] Retry transient Go `/realtime/client-secret` mint failures so one upstream
      EOF/5xx does not turn a successful tool recall row into a false benchmark
      failure; retry exhaustion now preserves a `502` upstream failure status
      instead of being reported as generic `500`.
- [x] Add a repeatable real-room post-hardening app-control smoke command:
      `npm run acceptance:realtime-real-app-control` is the strict live gate
      where missing a discoverable real Meet URL is a hard failure. The harness
      resolves the URL from `MAB_REAL_MEET_URL`, `--real-meet-url`, or the active
      meeting-agent `/join/status`, and falls back to the live joiner
      `active-meet-browser.json` record when that recorded browser process is
      still alive. The main `benchmark:realtime-real-app-control` entrypoint is
      also strict and fails the benchmark process when no active room URL exists;
      only `benchmark:realtime-real-app-control:optional` may write local
      diagnostic skipped evidence.
- [x] Make the real-room app-control smoke write `--json-out` evidence for
      missing-URL skip results in the explicit `:optional` mode at
      `/tmp/oneesama-realtime-real-app-control-optional-latest.json`, so local
      skipped runs cannot be cited with a non-existent artifact path.
- [x] Make missing-URL skipped evidence explicitly non-passing
      (`ok:false`, `diagnosticOnly:true`, `acceptanceSatisfied:false`) and add
      `npm run acceptance:realtime-live-sidecar` as the strict combined live
      gate. The combined gate runs both the real-room synthetic-speaker/fake-mic
      sender gate and the real-room app-control gate before it can pass; its
      `:optional` companion writes
      `/tmp/oneesama-realtime-live-sidecar-optional-latest.json` only as a local
      diagnostic artifact. The combined gate also requires each child gate
      process to exit 0 and to report explicit `acceptanceSatisfied:true`, so
      old `ok:true` child JSON or a successful-looking JSON artifact from a
      crashed child cannot pass the RFC acceptance wrapper. Malformed child
      gate JSON becomes a structured `invalid_json` failure instead of an
      unhandled wrapper crash, and child gate runtime/IO errors become
      structured `gate_error` failures. Child-process `error` events are
      handled explicitly, so the wrapper cannot hang forever waiting for `exit`.
- [x] Make the real-room app-control acceptance path drive
      `/realtime/text-turn` and require sidecar app-control tool telemetry,
      function-output delivery, and the Meet-page SDK negative probe before a
      terminal app-control status can satisfy the gate.
- [x] Move worker-result polling ownership to the sidecar page and require the
      poll-issued realtime delivery token before `/worker/mark-realtime-delivered`
      can mark a job delivered.
- [x] Downgrade worker-result custom-event fallback to diagnostic-only: even
      when a fixture explicitly enables `allowCustomWorkerResultEvents`, the
      bridge records a suppressed diagnostic delivery instead of calling
      `/worker/mark-realtime-delivered`; the browser Realtime listener now also
      records the DOM event as diagnostic-only instead of updating HUD state or
      calling `injectWorkerResult`.
- [x] Serialize Realtime benchmark processes with a cross-process lock so
      recall/lane/audio gates cannot create false failures by running in
      parallel against the same local meeting-agent and Realtime resources.
- [x] Harden the legacy TS meeting-agent browser-facing control routes with a
      same-origin/internal-key guard. Cross-origin browser callers are rejected
      unless they provide `X-Oneesama-Internal-Key`, while same-origin sidecar
      calls and local no-Origin scripts continue to work.
- [x] Restrict legacy TS meeting-agent `/tools/*` to the currently exposed
      live-safe Realtime tool surface, so hidden workspace connector/memory
      handlers cannot bypass the server-owned schema after they are removed
      from Realtime tools.
- [x] Keep Agents SDK `execute` returns model-visible only: silent/background
      app-control returns now send the compact tool result through
      `backgroundResult`, while `turnPolicy` remains in diagnostics rather than
      the model-visible output.
- [x] Remove low-level local tool executors from `MAB_REALTIME_CLIENT` public
      API (`runLocalAvatarTool`, `runLocalWorkerTool`, `runLocalMeetTool`) and
      remove the `sendWorkerResult` alias. Realtime-visible execution now uses
      SDK/simulated tool calls, `injectWorkerResult`, or the dedicated
      `MAB_MEET_SURFACE_TOOLS.run` port for Meet-surface DOM tools.
- [x] Remove Meet-page fallback for Realtime control-page operations. Worker
      result injection, raw control events, text turns, Realtime bridge state,
      worker-result bridge state, Recappi Realtime audio input, and pushed
      meeting awareness now require a live sidecar page; the Meet page may only
      keep the non-pushed awareness surface store and Meet DOM tools.
- [x] Remove sidecar-page DOM fallback for Meet chat surface tools. In sidecar
      page role, `send_meet_chat` and `read_meet_chat` now require
      `MAB_HOST_RUN_SURFACE_TOOL`; if the host surface port is missing they fail
      closed with `meet_surface_tool_port_missing` instead of probing the
      sidecar DOM or fixture state.
- [x] Stop installing the Meet chat DOM observer on the Realtime sidecar page.
      A sidecar SDK-owner page now records `meet_chat_observer_skipped` with
      `sidecar_page_not_meet_surface` instead of scanning its own DOM and
      injecting `meet_chat_observer` user events through the internal realtime
      event path.
- [x] Remove raw `sendRealtimeEvent` from `MAB_REALTIME_CLIENT` public API.
      Host-side `/realtime/event` now reaches the browser through
      `sendRealtimeControlEvent`, which only allows `response.cancel` and
      `input_audio_buffer.clear`; browser-side rejections are propagated as
      host failures instead of `ok:true` sends; meeting awareness context no
      longer falls back to raw `conversation.item.create` event injection.

Done when:

- [ ] Live rooms use sidecar placement by default, inline SDK on
      `meet.google.com` cannot return silently, real-room share/output artifacts
      exist, and one fresh post-hardening real-room app-control run shows the
      compacted prompt/result path no longer times out due runtime bloat.

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
- [x] Fixture: host-forwarded Meet-surface PCM drives a sidecar speech turn and
      expected share tool call in a non-Google local fixture. This is fixture
      evidence only; it does not prove real-room participant presence or fake-mic
      sender stats.
- [x] Real-room smoke gate distinguishes Realtime input sender health from Meet
      avatar/fake-mic publication sender health.
- [x] Real-room smoke gate requires `recappi_process_audio_tap` as the live
      Realtime sender source; `host_meet_audio_pcm` and `meet_audio_mix` remain
      fixture/diagnostic-only sources.
- [x] `meet-live-acceptance` now checks sidecar SDK ownership and the
      Meet-surface SDK negative probe, while keeping real-room Realtime input
      evidence tied to Recappi rather than diagnostic host PCM/mix sources.
- [x] `meet-live-acceptance` now checks the final output publication hop: when
      sidecar output is observed, the primary Meet fake-mic sender must use the
      avatar bus, stay `live`, report sent bytes, and show fresh sender deltas
      (`bytesDelta > 0` or `packetsDelta > 0`) so cumulative/stale stats cannot
      satisfy the gate.
- [x] `/join/status` now reports `realtimeSidecar.pageCount` and
      `realtimeSidecar.sdkOwnerPageCount`, and the strict real-room app-control
      benchmark requires both counts to equal `1` so duplicate/missing sidecar
      ownership cannot pass on placement strings alone.
- [x] The strict real-room app-control benchmark now binds `/join/status`
      Realtime/tool evidence to the app-control run's `sessionId`, so stale
      telemetry from an older active session cannot satisfy the gate.
- [x] The strict real-room app-control benchmark treats suppressed
      function-output delivery as not delivered, even if a stale delivery record
      still carries an output channel.
- [x] `meet-live-acceptance --expect-tool=control_shared_app_window` now
      requires app-control terminal evidence: completed/done, or
      `blocked`/`failed` with a compact explicit blocker. Pending/stale jobs and
      blocked jobs without compact blockers cannot pass on tool-name telemetry
      alone, even if the artifact also contains an older completed app-control
      job; `blocked`/`failed` results with contradictory `ok:true` cannot pass
      as compact blockers.
- [x] Unit: TS meeting-agent internal control guard rejects cross-origin browser
      callers, allows same-origin/internal-key callers, and rejects hidden stale
      `/tools/*` names such as `github_search`.
- [x] Unit: Agents SDK `execute` returns only compact model-visible tool output
      for silent app-control results; diagnostic `turnPolicy` is still recorded
      on bridge telemetry but is not returned to the model.
- [x] Unit: worker-result custom-event fallback is diagnostic-only and cannot
      mark a worker report as delivered to Realtime without a real
      `MAB_REALTIME_CLIENT.injectWorkerResult` delivery; the removed
      `sendWorkerResult` alias is ignored by both the host wrapper and worker
      poller.
- [x] Unit: `allowMockToolSimulation` enables only the explicit mock tool
      helper and does not unlock browser-dispatched custom Realtime server,
      speech-start, or worker-result events.
- [x] Unit: `MAB_REALTIME_CLIENT` no longer exposes the low-level local tool
      executors or the `sendWorkerResult` alias; Meet chat host helpers use
      `MAB_MEET_SURFACE_TOOLS.run` and no longer fall back to client-local meet
      tools.
- [x] Unit: sidecar-page `send_meet_chat` / `read_meet_chat` require the host
      surface port and cannot satisfy a Meet chat tool call through sidecar DOM
      or fixture fallback.
- [x] Unit: sidecar SDK-owner pages skip the Meet chat DOM observer and cannot
      inject `meet_chat_observer` user events from the sidecar DOM.
- [x] Unit/benchmark: `dryRunLocalTools` now dry-runs worker tools as well as
      app/window tools, so lane/recall routing gates can prove
      `delegate_to_worker` / `worker_status` selection without launching a real
      Codex worker or claiming real worker execution evidence.
- [x] Unit/benchmark: `dryRunLocalTools` no longer unlocks browser-side mock
      tool simulation in real `agents-sdk` sessions; dry-run only affects local
      execution after an authorized SDK/mock tool call. The same cleanup fixed
      Go-shaped `/join/status` compaction for the strict real Meet app-control
      gate, rejects stale-session Meet PCM before it reaches the sidecar, and
      stops the local sidecar server if startup fails before the caller receives
      it.
- [x] Unit: sidecar-to-Meet surface tool calls now carry the current
      `sessionId`, and the host-mediated surface port rejects stale-session
      payloads before evaluating on the Meet page. This keeps old sidecar pages
      from sending Meet chat/awareness commands into the current room.
- [x] Unit/benchmark: `dryRunLocalTools` no longer bypasses Meet-surface tool
      authorization. The Meet surface rejects local share/app tools before any
      dry-run result can be returned, and sidecar-page Meet chat tools still
      require the host surface port even in dry-run benchmark fixtures.
- [x] Unit: local-fixture synthetic-speaker tool fallback is no longer an
      implicit acceptance path. `MAB_REALTIME_SYNTHETIC_TEXT_TURN_FALLBACK` must
      be explicitly enabled for diagnostic fallback, and any fallback-used child
      result cannot satisfy the combined live-sidecar acceptance gate.
- [x] Unit: sidecar-audio replay scoring now checks the actual
      `browserBridgeRuntime` evidence returned by the browser run, including
      Meet-surface SDK negative probes and sidecar SDK connection, before
      accepting a matching tool call.
- [x] Unit: TS meeting-agent `/realtime/client-secret` honors explicit
      live-safe tool subsets by intersecting caller-supplied tools with the
      default foreground whitelist; stale/hidden tools no longer cause the mint
      path to silently fall back to the full tool surface.
- [x] Unit: TS meeting-agent live-safe Realtime tool routes are concrete:
      `/screen-share/apps` forwards to `joiner.listShareableApps()`,
      `/screen-share/app` forwards to `joiner.presentAppShare()`, and
      `/tools/control_shared_app_window` is handled before workspace-tool
      fallback so it cannot return `unknown_workspace_tool`.
- [x] Unit: TS meeting-agent app-control direct mode uses the non-blocking
      foreground contract by default: it queues a KWWK app-control job, stores
      terminal evidence in `worker_reports`, and reserves synchronous execution
      for explicit `wait:true` diagnostics.
- [x] Unit: TS KWWK app-control helper output is compacted before direct tool
      responses and queued worker reports; raw `metadata`, primitive
      `operations`, nested helper `result`, and long `responseText` cannot leak
      back through the TS fallback.
- [x] Unit: browser local app-control host POSTs inject the current `session_id`
      when the model omits it, so queued app-control worker reports keep meeting
      provenance before worker-result delivery.
- [x] Unit: sidecar worker-result bridge sends `X-Oneesama-Internal-Key` on both
      `/worker/poll-realtime` and `/worker/mark-realtime-delivered`; guarded
      host worker endpoints no longer reject sidecar cross-port delivery.
- [x] Unit/benchmark: sidecar-control recall now fails direct-routed tool calls
      when the sidecar SDK never connected. The benchmark waits longer for SDK
      cold start, but `sdkConnected=false` / `sdkConnectTimedOut=true` can no
      longer pass just because direct routing produced a local dry-run tool
      call.
- [x] Unit: `MAB_REALTIME_CLIENT` no longer exposes raw `sendRealtimeEvent`;
      public browser control events are allowlisted, and host active-control
      helpers no longer fall back to raw Realtime event sends.
- [x] Unit/benchmark: `MAB_REALTIME_CLIENT` no longer exposes direct
      participant-audio discovery/registration; `control_` sidecar recall
      benchmark passed `4/4` full and `4/4` share-control-only rows after the
      token-mint retry fix.
- [x] Audio benchmark: uploaded Recappi sample drives sidecar turn formation and
      share tool call.
- [x] Live: real Meet room share command produces real tool telemetry in the
      same turn.
- [x] Live: real Meet room model speech reaches avatar output energy after the
      sidecar output bridge lands.
- [ ] Live: fresh real Meet room records primary Meet fake-mic sender stats
      (`trackReadyState=live`, bytes sent, avatar-bus source) in the same
      artifact.
- [ ] Live: post-hardening real Meet room app-control command completes or fails
      with a compact, explicit blocker rather than timing out on prompt bloat.
- [x] Typecheck and targeted existing smoke tests pass; latest local validation
      commands are recorded in
      [Benchmark and Acceptance](./benchmark-acceptance.md).
