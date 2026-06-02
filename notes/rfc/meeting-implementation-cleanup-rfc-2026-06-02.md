# RFC: Meeting Implementation Cleanup

Date: 2026-06-02
Status: draft cleanup plan
Owner: @劲霸仁波切
Implementation driver: local Codex session

## Summary

Recent Realtime/KWWK CU work made the meeting stack powerful enough to operate
real shared browser windows, but the implementation has accumulated several
messy boundaries:

- the default foreground tool surface, legacy compatibility tools, and Codex
  delegation paths are still too easy to confuse;
- app-control status/result payloads can drift back toward raw `/join/status`
  runtime state unless compactness is enforced at every boundary;
- HUD/status feedback shows low-value connection/audio state while missing the
  actionable "what is the agent doing or blocked on" signal;
- native cursor behavior is user-visible, so lifecycle leaks are product bugs,
  not just helper implementation details;
- `google-meet-joiner.ts`, the TS meeting-agent route, Swift app-control helper,
  and benchmark scripts have become orchestration hubs rather than small
  reviewable modules.

This RFC proposes a staged cleanup plan. The intent is not to redesign the
Realtime sidecar, but to make the current design explicit enough that future
work does not accidentally reintroduce slow CU, fake foreground execution,
oversized context, or noisy HUD state.

## Current Module Map

| Layer                          | Primary files                                                                                                                                                                                                      | Current role                                                                                             | Cleanup pressure                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Go meeting-agent app control   | `internal/meetingagent/realtime_app_control.go`, `app_control_backend.go`, `app_control_queue.go`, `app_control_factory.go`, `app_control_kwwk_stdio.go`                                                           | Owns Realtime app-control request normalization, KWWK backend, job queue, and provider selection.        | Needs hard compact-payload boundaries, queue lifecycle caps, and clear provider defaults.          |
| TS meeting-agent compatibility | `apps/meeting-agent/src/index.ts`, `apps/meeting-agent/src/app-control-routes.ts`                                                                                                                                  | Keeps the TS host usable during Go parity work and exposes app-control routes.                           | Should become an explicit compatibility shim, not a second policy owner.                           |
| Browser joiner runtime         | `packages/core/src/meeting/google-meet-joiner.ts`, `google-meet-joiner-runtime-state.ts`, `google-meet-joiner-realtime-control.ts`, `google-meet-joiner-realtime-status.ts`, `google-meet-joiner-share-actions.ts` | Launches Meet, manages admission/media/avatar/realtime/share/runtime state.                              | `join()` and `status()` still carry too much orchestration and state-shaping responsibility.       |
| Realtime browser bridge        | `packages/core/src/realtime/realtime-browser-bridge.ts` plus helpers                                                                                                                                               | Routes model tool calls, worker results, text turns, meeting events, and local tool execution.           | Tool placement and worker context compaction need regression tests around default exposure.        |
| Native KWWK helper             | `packages/core/src/meeting/app-control-helper.swift`, `app-control-helper.ts`                                                                                                                                      | Provides native cursor, window probing, and KWWK app operations.                                         | Cursor visibility/hide lifecycle and helper JSON-RPC response discipline must be invariants.       |
| Benchmarks and live gates      | `scripts/realtime-kwwk-*.mjs`, `scripts/realtime-tool-*.mjs`, `scripts/real-meet-*.mjs`                                                                                                                            | Measures tool recall, KWWK latency, planner/action quality, cursor visibility, and live Meet acceptance. | Benchmarks should prove the actual execution path, not just route selection or mocked intent.      |
| HUD/status surface             | meeting HUD/avatar/realtime status wiring                                                                                                                                                                          | Shows what the meeting agent is doing.                                                                   | Should show actionable app-control states, not obvious/low-value speaking/connection/audio badges. |

## Problem Statement

The meeting implementation has working pieces, but some boundaries are still
implicit:

- **Two CU stories look like peers.** `kwwk_computer_use` is the desired generic
  simple foreground app-operation tool, while `control_shared_app_window` still
  exists as a legacy/compatibility affordance. If both are treated as normal
  foreground tools, Realtime can choose the wrong abstraction.
- **Simple vs complex task routing is not encoded strongly enough.** Simple app
  operations should go to KWWK CU with concise natural-language instructions.
  Complex multi-step work should delegate to Codex/background execution,
  potentially including Codex's own CU, with explicit job state.
- **Status payloads are too tempting to pass through raw.** `/join/status`
  contains browser, bridge, worker, diagnostics, tool-call, and runtime state.
  That is useful for debugging, but harmful as foreground model context or tool
  result material.
- **HUD feedback confuses transport health with user-relevant progress.**
  "Connected", "audio/no audio", and speaking-state indicators are low value in
  the meeting surface; users can hear speaking and only need action/blocker
  feedback when the agent is working.
- **Native cursor is part of the product contract.** If KWWK CU moves the
  screen, users need to see a cursor during the action and then have it vanish.
  A stuck cursor overlay is a visible regression.
- **Benchmark coverage is uneven.** Some benchmarks test recall or route
  selection, while the risky question is whether Realtime really reaches KWWK
  and whether KWWK actually performs the operation with visible cursor evidence.
- **Large orchestration files hide policy drift.** When launch, admission,
  avatar fallback, Realtime sidecar, app-control status, and cleanup live in one
  large flow, small policy changes become hard to review.

## Goals

- [ ] Preserve live meeting behavior while making policy boundaries explicit.
- [ ] Make `kwwk_computer_use` the default generic foreground tool for simple
      app operations.
- [ ] Quarantine `control_shared_app_window` as compatibility-only and prevent
      it from re-entering the default Realtime foreground surface.
- [ ] Keep complex tasks on an explicit delegate/background path rather than
      pretending they are simple foreground KWWK operations.
- [ ] Enforce compact app-control inputs, outputs, worker context, and Codex
      task context.
- [ ] Make HUD feedback action-oriented: running, blocked, completed, failed,
      delegated, and "needs user action".
- [ ] Ensure native cursor appears during KWWK operation/probe and hides after.
- [ ] Keep every cleanup slice independently verifiable with focused tests and
      at least one benchmark where relevant.

## Non-Goals

- [ ] Do not redesign the Realtime sidecar architecture in this cleanup.
- [ ] Do not remove the TS implementation before Go parity is accepted.
- [ ] Do not remove old HTTP compatibility routes in the first cleanup slice.
- [ ] Do not add external avatar/runtime dependencies as part of meeting cleanup.
- [ ] Do not claim live Meet acceptance from synthetic/smoke-only evidence.
- [ ] Do not solve every large-file problem in one PR.

## Cleanup Principles

- [ ] Prefer explicit policy names over clever routing. A reader should be able
      to tell whether a path is default, compatibility, delegate, or test-only.
- [ ] Keep model-visible payloads compact by construction, not by caller habit.
- [ ] Put behavior tests around route/tool inventory before deleting or moving
      code.
- [ ] Split modules only along boundaries that already exist in the codebase.
- [ ] Treat native cursor/HUD behavior as UX contracts with regression tests or
      benchmark evidence.
- [ ] Keep live-room acceptance as a separate gate from local benchmarks.

## Proposed Cleanup Slices

### Slice 0: Baseline Audit

Purpose: freeze the current surface before cleanup so regressions are visible.

- [ ] Capture default Realtime tool inventory from Go and TS paths.
- [ ] Record which routes still accept `control_shared_app_window`.
- [ ] Record which benchmarks currently measure route selection, KWWK planning,
      KWWK execution, visible cursor, and live Meet acceptance.
- [ ] Record current large-file hotspots and proposed extraction boundaries.
- [ ] Update this RFC with accepted/rejected cleanup scope before implementation.

Verification:

```bash
go test ./internal/meetingagent -run 'RealtimeTool|RealtimeConfig|Placement' -count=1
vp test run test/realtime-contract.test.mjs test/meeting-agent-realtime-placement-guard.test.mjs
```

### Slice 1: Tool Surface Quarantine

Purpose: make the default Realtime foreground tool surface boring and safe.

- [ ] Define `kwwk_computer_use` as the generic simple app-operation tool.
- [ ] Define `control_shared_app_window` as compatibility-only in names,
      comments, tests, and reports.
- [ ] Ensure default `/realtime/config` and foreground tool inventory expose
      `kwwk_computer_use`, not `control_shared_app_window`.
- [ ] Keep compatibility HTTP routes callable for old clients during parity.
- [ ] Ensure demo/browser/Codex-CU helper tools cannot leak into default
      foreground Realtime config.
- [ ] Update the tool-surface HTML report if route semantics or labels change.

Verification:

```bash
go test ./internal/meetingagent -run 'RealtimeTool|RealtimeConfig|Placement' -count=1
vp test run test/realtime-contract.test.mjs test/meeting-agent-realtime-placement-guard.test.mjs
npm run benchmark:realtime-tool-recall -- --iterations 1 --timeout-ms 25000
```

### Slice 2: Simple vs Complex App-Control Routing

Purpose: encode the user's intended routing model in the implementation.

- [ ] Simple foreground operations route to KWWK CU with concise instructions.
- [ ] Realtime provides task intent/instructions to KWWK; it should not need to
      invent every low-level click/drag operation itself for normal cases.
- [ ] If low-level operations are accepted, keep them internal/backend-facing
      rather than primary Realtime tool-schema surface.
- [ ] Complex tasks route to explicit delegate/background execution with job
      status and result delivery.
- [ ] Codex CU remains available only behind explicit delegate/background paths,
      not as a competing foreground simple-operation tool.
- [ ] Add tests for forced direct mode on `kwwk_computer_use` and explicit
      delegate mode on compatibility/background paths.

Verification:

```bash
go test ./internal/meetingagent -run 'RealtimeSharedAppControl|AppControlBackend' -count=1
vp test run test/realtime-app-control-bridge.test.mjs test/realtime-app-control-text-routing.test.mjs
```

### Slice 3: Compact App-Control Boundary

Purpose: prevent raw meeting runtime state from reaching the foreground model,
worker context, app-control backend requests, or Codex delegate task.

- [ ] Rename compact status variables to `compactStatus` or
      `screenShareStatus` where possible.
- [ ] Return compact `screenShare` data on both success and backend-error paths.
- [ ] Strip or tail noisy fields such as `realtimeBridge`, `workerResultBridge`,
      tool-call arrays, operation arrays, connection diagnostics, and raw
      browser diagnostics from model-visible results.
- [ ] Add regression tests with intentionally huge runtime status payloads.
- [ ] Cap queued app-control job result/error retention.

Verification:

```bash
go test ./internal/meetingagent -run 'RealtimeSharedAppControl|QueuedAppControl' -count=1
vp test run test/google-meet-joiner-runtime-state.test.mjs test/realtime-app-control-bridge.test.mjs
```

### Slice 4: HUD and Voice Feedback Cleanup

Purpose: make meeting feedback useful while the user is watching/listening.

- [ ] Remove or suppress foreground HUD cells for obvious speaking state.
- [ ] Remove or suppress low-value "connected/connecting" and "audio/no audio"
      badges unless they represent an actionable blocker.
- [ ] Show app-control state transitions: queued, running, blocked, completed,
      failed, delegated, and needs-user-action.
- [ ] Keep verbal feedback focused on action starts, blockers, and final
      results; do not narrate every transport state.
- [ ] Add visual/snapshot tests or fixture tests that fail when connection/audio
      noise returns to the default HUD.

Verification:

```bash
vp test run test/realtime-app-control-bridge.test.mjs test/google-meet-joiner-ui.test.mjs
```

### Slice 5: Native Cursor Lifecycle Guard

Purpose: make visible cursor behavior a stable invariant for KWWK CU.

- [ ] Ensure cursor overlay is shown during native KWWK actions/probes.
- [ ] Ensure cursor overlay is hidden after action/probe completion and error
      paths where a panel was created.
- [ ] Add helper diagnostics or benchmark evidence for visible cursor during
      action and no stuck helper/panel residue afterward.
- [ ] Keep MouseDo/cueboard cursor behavior as the reference for visibility
      semantics where applicable.
- [ ] Avoid external dependencies for this cleanup.

Verification:

```bash
swiftc packages/core/src/meeting/app-control-helper.swift \
  -module-cache-path /tmp/oneesama-swift-module-cache \
  -o /tmp/oneesama-app-control-helper-compile-check
npm run benchmark:realtime-kwwk-native-cursor -- --timeout-ms 15000
npm run benchmark:realtime-kwwk-cursor-visible -- --timeout-ms 15000
pgrep -f 'oneesama-app-control-helper|app-control-helper' || true
```

### Slice 6: Benchmark Coverage Tightening

Purpose: make benchmarks answer the questions that caused this cleanup.

- [ ] Add/confirm a benchmark case where Realtime calls `kwwk_computer_use` and
      the KWWK helper executes an operation, not merely a mocked route response.
- [ ] Distinguish recall, routing, planner/action, latency, native cursor, and
      live acceptance in reports.
- [ ] Make invalid helper JSON and helper timeout failures produce structured
      benchmark reports.
- [ ] Capture cold-start vs warm-start latency for KWWK helper where practical.
- [ ] Keep live Meet gates separate and require explicit real meeting evidence.

Verification:

```bash
npm run benchmark:realtime-kwwk-app-control -- --timeout-ms 25000
npm run benchmark:realtime-kwwk-planner-action -- --timeout-ms 25000
npm run benchmark:realtime-kwwk-latency -- --timeout-ms 25000
npm run benchmark:realtime-kwwk-native-cursor -- --timeout-ms 15000
```

### Slice 7: Meeting Joiner File Boundary Cleanup

Purpose: reduce the risk hidden in large orchestration files after behavior is
covered by tests.

- [ ] Extract `join()` setup by stable responsibilities: launch args, browser
      record, admission, media/avatar config, Realtime sidecar init, share init,
      and final cleanup.
- [ ] Keep `google-meet-joiner-runtime-state.ts` as the single place for
      status compaction/tailing helpers.
- [ ] Avoid moving browser-injected code into Go during this cleanup.
- [ ] Keep package public exports and CLI behavior stable.
- [ ] Add focused tests for each extracted builder/helper before moving more
      orchestration code.

Verification:

```bash
vp exec tsc --noEmit
vp test run test/google-meet-joiner-camera.test.mjs \
  test/google-meet-joiner-audio-safety.test.mjs \
  test/screen-share-init-builder.test.mjs \
  test/avatar-runtime-contracts.test.mjs \
  test/google-meet-joiner-runtime-state.test.mjs
```

### Slice 8: TS Compatibility Shim Cleanup

Purpose: reduce TS/Go drift while the Go rewrite is still becoming canonical.

- [ ] Make TS app-control envelopes match Go result naming/status semantics.
- [ ] Document TS delegate mode as unavailable if direct KWWK is the only real
      TS compatibility path.
- [ ] Cap TS queued job retention and result payload size.
- [ ] Keep TS route behavior covered by tests, but avoid giving TS a separate
      policy interpretation from Go.
- [ ] Decide whether TS app-control should eventually be removed or become a
      thin proxy to the Go service.

Verification:

```bash
vp test run test/meeting-agent-app-control-result.test.mjs \
  test/meeting-agent-realtime-placement-guard.test.mjs \
  test/realtime-app-control-text-routing.test.mjs
```

## Acceptance Checklist

- [ ] Default Realtime tool config exposes `kwwk_computer_use` for simple app
      operations.
- [ ] Default Realtime tool config does not expose `control_shared_app_window`.
- [ ] Compatibility routes remain test-covered until intentionally removed.
- [ ] Realtime foreground app-control results never include raw
      `realtimeBridge`, `workerResultBridge`, diagnostics dumps, or large tool
      call arrays.
- [ ] Complex app-control tasks have an explicit delegate/background path and
      job status.
- [ ] HUD does not display speaking-state, generic connection-state, or generic
      audio-state noise by default.
- [ ] HUD does display action/blocker/result state for app-control work.
- [ ] KWWK cursor is visible during operation and hidden afterward.
- [ ] KWWK benchmarks distinguish planning, execution, latency, native cursor,
      and visible cursor coverage.
- [ ] Live-room acceptance is only marked passed with explicit real Meet
      evidence.

## Suggested Implementation Order

1. [ ] Slice 0: baseline audit.
2. [ ] Slice 1: tool surface quarantine.
3. [ ] Slice 2: simple vs complex app-control routing.
4. [ ] Slice 3: compact app-control boundary.
5. [ ] Slice 4: HUD and voice feedback cleanup.
6. [ ] Slice 5: native cursor lifecycle guard.
7. [ ] Slice 6: benchmark coverage tightening.
8. [ ] Slice 7: meeting joiner file boundary cleanup.
9. [ ] Slice 8: TS compatibility shim cleanup.
10. [ ] Run full quality gates.
11. [ ] Update RFC status from `draft cleanup plan` to `accepted` after the
        first cleanup PR lands.

## Open Questions

- [ ] Should `control_shared_app_window` eventually require an explicit
      compatibility flag, or can it remain callable forever behind internal
      auth?
- [ ] Should KWWK CU receive only natural-language instructions from Realtime,
      or should Realtime be allowed to pass low-level operation arrays for
      narrow deterministic cases?
- [ ] Does KWWK need a small fast planner model in front of native operations,
      or should the Realtime model provide enough intent for the helper/backend
      to act directly?
- [ ] What cold-start budget should KWWK helper satisfy for foreground meeting
      usage?
- [ ] Should native cursor post-hide evidence be a first-class benchmark field?
- [ ] Which should be split first once behavior gates pass:
      `google-meet-joiner.ts`, TS app-control routes, or benchmark harnesses?
