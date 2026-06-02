# RFC: Realtime/KWWK CU Benchmark Gates

Date: 2026-06-02
Status: accepted implementation plan
Owner: @劲霸仁波切
Implementation driver: local Codex session

## Summary

Split Realtime/KWWK Computer Use validation into explicit gates.

The current benchmark surface can answer "did Realtime choose the right tool?"
and "can the KWWK backend execute a small helper call?", but those are not the
same as "can the assistant reliably switch tabs, click a visible target, show a
cursor, and return fast enough in a meeting?"

This RFC defines separate gates so a pass or failure tells us which layer is
broken.

The gates are deliberately not interchangeable. A recall pass proves the model
chose the right tool. A backend pass proves the helper/server path can run. A
planner/action pass proves natural language became verified app state. A
cursor-visible pass proves the audience saw feedback. A latency pass proves the
experience is fast enough and explains where time went. A real-room pass proves
the whole meeting product works together.

## Decision Snapshot

- Tool recall, KWWK backend execution, planner/action correctness, cursor
  visibility, latency, and real-room acceptance are separate gates.
- `benchmark:realtime-tool-recall` is a Realtime tool-selection/function-output
  gate. It is not proof that KWWK can execute the operation.
- `benchmark:realtime-kwwk-app-control` is a backend execution gate. It is not
  proof that natural instructions like "切换 tab" plan correctly.
- Add a KWWK planner/action benchmark that runs real or fixture app operations
  and verifies final app state.
- Add cold/warm latency reporting for helper compile, helper startup,
  observation, planning, execution, and verification.
- Add a cursor-visible benchmark once the overlay RFC is implemented.
- Real-room gates remain the final integration proof, not the default inner loop.

## Gate Ownership

| Gate                   | Owner layer                                                                    | Default loop                           | Requires macOS app permissions                             | Requires real Meet room           |
| ---------------------- | ------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------- | --------------------------------- |
| Realtime tool recall   | Realtime sidecar/tool surface                                                  | local/CI when API is available         | No                                                         | No                                |
| KWWK backend execution | meeting-agent + KWWK helper/backend                                            | local macOS                            | Yes for live helper paths                                  | No                                |
| KWWK planner/action    | KWWK planner + executor                                                        | local fixture first, macOS live second | Fixture: no; live: yes                                     | No                                |
| Cursor-visible         | KWWK native foreground cursor + cursor bus + shared-surface overlay/HUD mirror | local screenshot/pixel gate            | Usually yes for native overlay; no for mirror-only fixture | No for local, yes for final smoke |
| Cold/warm latency      | all timing boundaries                                                          | local benchmark                        | Depends on case                                            | No                                |
| Real-room integrated   | full product path                                                              | manual/release gate                    | Yes                                                        | Yes                               |

Each gate must emit enough metadata to prove it ran against the intended layer,
not a stale server or diagnostic-only runtime.

## Problem

The live issues discussed here span multiple layers:

- Realtime may choose no app-control tool.
- Realtime may choose the old compatibility tool instead of `kwwk_computer_use`.
- Realtime may call KWWK with a good instruction, but KWWK cannot plan the
  operation.
- KWWK may plan and execute, but the app state does not change.
- KWWK may execute, but the meeting audience sees no cursor or useful feedback.
- Cold start may make simple CU feel slower than competing implementations.
- Existing HUD status may be technically true but not helpful to the audience.

One benchmark cannot diagnose all of that unless it records layer-specific
evidence.

## Gate Matrix

| Gate                   | Primary question                                                                              | Required evidence                                                                             | Not sufficient for                   |
| ---------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| Realtime tool recall   | Did the model select `kwwk_computer_use` for bounded app-control utterances?                  | SDK history, tool call name/args, wrapper telemetry, function output delivery                 | KWWK execution correctness           |
| KWWK backend execution | Can the backend/helper observe and execute direct app-control calls?                          | helper telemetry, app-control result, HTTP/stdio result                                       | Natural-language planner correctness |
| KWWK planner/action    | Can "切换 tab"/"点第二个按钮" become verified actions?                                        | plan, actions, pre/post app state, verification                                               | Meeting-visible cursor               |
| Cursor-visible         | Does the audience see pointer/click feedback, and does KWWK present a real foreground cursor? | native foreground overlay evidence, cursor events, coordinate metadata, rendered-frame marker | Action semantic success              |
| Cold/warm latency      | Is simple CU fast enough after startup, and where is time spent?                              | timing breakdown and percentiles                                                              | Correct tool choice                  |
| Real-room integrated   | Does all of it work in Meet with voice, sidecar, tool, app, cursor, and audio?                | single acceptance artifact with all correlated signals                                        | Fast local regression loop           |

## Shared Report Envelope

Every gate report should share a small top-level envelope so artifacts can be
compared across runs:

```ts
interface KWWKCUGateReportEnvelope {
  schema: string;
  gate:
    | "realtime_tool_recall"
    | "kwwk_backend_execution"
    | "kwwk_planner_action"
    | "cursor_visible"
    | "cold_warm_latency"
    | "real_room_integrated";
  ok: boolean;
  generatedAt: string;
  repo?: { commit?: string; dirty?: boolean };
  meetingAgent?: {
    url?: string;
    processId?: number;
    runtimePlacement?: string;
    exposedTools?: string[];
    staleServiceSuspected?: boolean;
  };
  environment?: {
    platform?: string;
    app?: string;
    model?: string;
    upstreamAvailable?: boolean;
  };
  timings?: Record<string, number>;
  cases?: Array<{ id: string; ok: boolean; status: string; blocker?: string }>;
}
```

Gate-specific reports may add richer evidence, but should not omit the shared
fields that diagnose stale process, wrong tool surface, or upstream API failure.

## Current Evidence From 2026-06-02 Session

The current implementation evidence should be interpreted carefully:

- KWWK backend execution benchmark passed for the existing helper path:
  `benchmark:realtime-kwwk-app-control`.
- The live recall run against a fresh temporary meeting-agent showed control
  cases selecting `kwwk_computer_use`, but the run could not be accepted as a
  full green gate because the temporary service used an invalid OpenAI API key
  for upstream Realtime calls.
- A run against the existing local `8781` service exposed a stale process/tool
  surface, where old compatibility tools were still present. That failure is
  useful evidence that recall gates must record the meeting-agent URL and exposed
  tool list.
- Warm instruction-only observe is fast; first state/screenshot calls can be
  several seconds because helper startup, screenshot, or compile paths are in
  the critical path.

Do not use these notes as permanent benchmark baselines. They document why the
new gate split is needed.

## Realtime Tool Recall Gate

Purpose: prove the Realtime sidecar chooses the generic KWWK tool and delivers
function outputs.

This gate proves:

- the live-safe tool list contains the intended public tool surface;
- bounded foreground app-control utterances select `kwwk_computer_use`;
- Realtime function output delivery still works.

This gate does not prove:

- KWWK can plan or execute the instruction;
- pointer/cursor feedback is visible;
- the app state changed.

Acceptance:

- [x] `/realtime/config` exposes `kwwk_computer_use` in the default live-safe
      tool list.
- [x] `/realtime/config` does not expose `control_shared_app_window` by default.
- [x] Positive app-control utterances call `kwwk_computer_use`.
- [x] Negative stop-share/meeting-control utterances do not call KWWK CU.
- [x] Tool arguments contain a natural-language `instruction`.
- [x] Tool arguments do not contain operation arrays or raw coordinates.
- [x] Tool wrapper telemetry and function-output delivery are present.
- [x] The report records meeting-agent URL, runtime placement, exposed tool
      names, model name, and API-key/upstream failure state.
- [x] The report marks stale-service suspicion when exposed tools differ from
      the expected current surface.

Example command:

```bash
npm run benchmark:realtime-tool-recall -- \
  --meeting-agent-url http://127.0.0.1:8781 \
  --json-out /tmp/oneesama-realtime-tool-recall-kwwk-cu.json
```

## KWWK Backend Execution Gate

Purpose: prove the helper/backend can execute supported operations through the
same server path used by Realtime tools.

This gate proves:

- the server/helper path is wired and callable;
- permissions/startup/backend provider problems are visible;
- direct helper operations return compact success or blocker envelopes.

This gate does not prove:

- natural-language planning is good enough;
- visible targets are resolved correctly;
- the audience saw cursor feedback.

Acceptance:

- [x] state/observe request succeeds;
- [x] screenshot or app state capture succeeds when permissions are available;
- [x] direct instruction-only observe succeeds without action;
- [x] mixed observe/action instructions are rejected when the contract forbids
      them;
- [x] result includes backend provider, duration, status, and compact blocker
      when applicable;
- [x] helper cold-start and warm-call timings are separated.
- [x] the report identifies whether the backend path was fake, dry-run, host
      helper, stdio helper, or live macOS app control.

Example command:

```bash
npm run benchmark:realtime-kwwk-app-control -- \
  --json-out /tmp/oneesama-realtime-kwwk-app-control.json
```

## KWWK Planner/Action Gate

Purpose: prove natural-language instructions become verified app actions.

This gate proves:

- deterministic instructions become bounded action plans;
- visual/AX target references resolve or block predictably;
- post-action verification catches false success.

This gate does not prove:

- Realtime chose the tool;
- cursor feedback appeared in Meet;
- cold-start latency is acceptable in a live room.

Fixture classes:

- browser tab fixture;
- text input fixture;
- button grid fixture;
- double-click button fixture;
- AX-over-screenshot priority fixture;
- scroll fixture;
- ambiguous-target fixture;
- permission-missing fixture.

Acceptance:

- [x] "让他切换 tab" changes active tab or verified tab title in fixture mode.
- [x] "输入 hello" inserts text into a focused field in fixture mode.
- [x] "点第二个按钮" clicks the second enabled visible button.
- [x] "双击发送按钮" produces a bounded `double_click` action with target
      evidence in fixture mode.
- [x] AX observation is preferred over screenshot fallback when both are present.
- [x] "滚动一下" changes scroll position in fixture mode.
- [x] ambiguous target returns `blocked_ambiguous_target`.
- [x] permission-missing fixture returns `blocked_permission`.
- [x] multi-step task returns `needs_background_agent`.
- [x] `needs_background_agent` routes through the KWWK fallback chain to the
      Codex/background app-control executor with the same instruction and
      target hints.
- [x] report includes plan, action list, model-used flag, and timing breakdown.
- [x] report includes pre-state, post-state, and verification evidence kinds
      such as `text_appeared`, `tab_title_changed`, `button_state_changed`,
      `scroll_position_changed`, and `explicit_blocker`.
- [x] report distinguishes fixture verifier success from live app verifier
      success.

Suggested command:

```bash
npm run benchmark:realtime-kwwk-planner-action -- \
  --json-out /tmp/oneesama-kwwk-planner-actions.json
```

## Cursor-Visible Gate

Purpose: prove KWWK action feedback is visible in the meeting/shared surface.

This gate proves:

- pointer actions emit cursor events with coordinate metadata;
- native Cueboard-style foreground cursor presentation exists for pointer
  actions, when the live macOS helper path is used;
- the shared-surface mirror rendered a visible marker in captured frames;
- drag trail and target ring styles are represented in both cursor artifacts
  and rendered-frame checks;
- HUD cleanup did not reintroduce noisy speech/listening labels.

This gate does not prove:

- the semantic app action succeeded;
- Realtime chose the correct tool;
- the full room audio/video path works.

Acceptance:

- [x] pointer actions emit cursor telemetry;
- [x] telemetry has coordinate-space metadata;
- [x] rendered shared-surface frame includes pointer/click marker;
- [x] screenshot/pixel check detects marker;
- [x] screenshot/pixel check covers drag trail and target highlight evidence;
- [x] live/native helper path materializes a transparent non-activating
      Cueboard-style foreground cursor overlay, not only HUD pixels;
- [x] live/native helper path reports approach/drag animation evidence;
- [x] live/native helper path reports Cueboard Bezier planner evidence with
      passing turn-bound diagnostics;
- [x] native foreground cursor renders visibly on light and dark backgrounds;
- [x] native foreground drag trail renders in native PNG pixel evidence;
- [x] report distinguishes `native_foreground_cursor` evidence from
      `shared_surface_cursor_mirror` evidence;
- [x] keyboard-only actions do not show noisy speech/listening text;
- [x] live-room smoke confirms the audience-visible stream shows the cursor.
- [x] rendered-frame checks use a deterministic marker detector or explicit
      screenshot assertion, not manual visual inspection only.

Suggested command:

```bash
npm run benchmark:realtime-kwwk-cursor-visible -- \
  --json-out /tmp/oneesama-kwwk-cursor-visible.json
```

## Cold/Warm Latency Gate

Purpose: explain why KWWK CU feels slower or faster than other implementations.

This gate proves:

- cold and warm paths are labeled correctly;
- expensive segments are attributable;
- deterministic planner cases are fast without model calls.

This gate does not prove:

- semantic correctness beyond the included cases;
- visible cursor feedback;
- Realtime recall quality.

Record timings separately:

- helper binary compile/check;
- helper process startup;
- first permission/screen capture setup;
- observe;
- deterministic planning;
- optional model planning;
- execute;
- verify;
- server/tool wrapper overhead;
- Realtime model turn latency.

Acceptance:

- [x] cold-start report is labeled cold and includes compile/startup timings;
- [x] warm-call report reuses an existing helper session;
- [x] p50/p95 are reported for deterministic planner cases;
- [x] optional model planner cases report model name and model latency;
- [x] failures include blocker taxonomy instead of only timeout.
- [x] cold reports include whether helper compile was necessary or reused.

Suggested command:

```bash
npm run benchmark:realtime-kwwk-latency -- \
  --cases deterministic,visual,observe \
  --json-out /tmp/oneesama-kwwk-cu-latency.json
```

## Real-Room Integrated Gate

Purpose: prove the meeting product works end-to-end.

This gate proves:

- the actual meeting path works with voice/text, sidecar, KWWK, app state,
  cursor overlay, HUD, function outputs, and avatar audio;
- local gate assumptions still hold under room conditions.

This gate does not prove:

- every planner fixture is covered;
- latency regressions can be diagnosed without the specialized latency gate;
- the failure belongs to one layer unless it links the other gate reports.

Acceptance:

- [x] user voice/text turn enters sidecar SDK history;
- [x] Realtime calls `kwwk_computer_use`;
- [x] KWWK planner produces a bounded plan;
- [x] executor changes app state or returns explicit app-control action
      evidence for the shared app/window;
- [x] cursor overlay is visible in the shared stream for pointer actions;
- [x] function output is delivered back to Realtime;
- [x] avatar speech audio routes to Meet fake mic;
- [x] HUD avoids redundant speech/listening text and only shows meaningful CU
      state or blockers.
- [x] artifact links or embeds the latest recall/backend/planner/cursor/latency
      reports when available.

Example room command can continue using the real Meet URL gate when available:

```bash
MAB_REAL_MEET_URL=https://meet.google.com/ypw-fozb-anz \
  npm run smoke:real-meet-sidecar
```

## Implementation Checklist

- [x] Lock RFC decision: recall, KWWK backend, planner/action,
      cursor-visible, cold/warm latency, and real-room gates each prove a
      different layer and must stay separate.
- [x] Add report fields for exposed tool names and meeting-agent URL to recall
      benchmark artifacts.
- [x] Add a planner/action helper-fixture benchmark for deterministic
      instruction plans, action kinds, normalize timing, and model-used state.
- [x] Extend planner/action helper-fixture benchmark with AX-like button target
      resolution and ambiguity blocker cases.
- [x] Add planner/action helper fixtures.
- [x] Add optional native fixture app for live macOS verifier coverage.
- [x] Add a cold/warm deterministic-helper latency benchmark script.
- [x] Add shared-surface cursor-visible benchmark after mirror overlay exists.
- [x] Add native foreground cursor overlay benchmark once Cueboard cursor is
      ported.
- [x] Teach benchmark reports to distinguish stale-service failures from model
      failures.
- [x] Add CI/local labels: recall, backend, planner-action, cursor-visible,
      latency, real-room.
- [x] Update the RFC sidecar benchmark document to reference these specialized
      gates once implemented.

## Rollout Plan

### Phase 0: Report Metadata Hardening

- [x] Add shared envelope fields to existing recall and backend reports.
- [x] Record meeting-agent URL, runtime placement, exposed tools, model name,
      upstream/API-key state, and stale-service suspicion.
- [x] Mark diagnostic-only runtimes as non-acceptance in report output.

Done when: an old/stale `8781` service failure is visible as a stale tool-surface
problem instead of being misread as a model failure.

### Phase 1: Existing Gate Cleanup

- [x] Update `benchmark:realtime-tool-recall` to assert
      `kwwk_computer_use`/no default `control_shared_app_window`.
- [x] Update `benchmark:realtime-kwwk-app-control` to label backend provider and
      cold/warm helper timing.
- [x] Document which current tests are backend execution gates, not
      planner/action gates.

Done when: existing benchmarks produce reports whose proof boundary matches the
gate matrix.

### Phase 2: Planner/Action Fixtures

- [x] Capture plan, action list, blocker, timing, and model-used flag for helper
      fixtures.
- [x] Build browser tab, text input, button grid, double-click, scroll, and ambiguity
      fixtures.
- [x] Build AX-over-screenshot priority fixture.
- [x] Build permission-missing fixture.
- [x] Capture plan, action list, timing, and model-used flag.
- [x] Capture pre-state, post-state, and verifier result.
- [x] Capture verifier evidence kinds for tab/text/button/scroll/blocker cases.
- [x] Add fixture mode first, then optional live macOS mode.
- [x] Add optional live macOS mode.
- [x] Add optional live browser mode for real tab-title post-state evidence.

Done when: "切换 tab", "输入 hello", "点第二个按钮", "滚动一下", ambiguity, and
background-delegation cases all report precise verifier outcomes.

### Phase 3: Cursor-Visible Gate

- [x] Wait for shared-surface cursor overlay Phase 2 from the cursor RFC.
- [x] Add cursor event + rendered-frame artifact capture for the shared-surface
      mirror.
- [x] Add screenshot/pixel marker assertions and HUD negative assertions.
- [x] Add rendered-frame drag trail and target highlight assertions.
- [x] Add native foreground cursor materialization/assertion evidence.
- [x] Add native foreground approach/drag animation assertion evidence.
- [x] Add native foreground Cueboard Bezier planner / turn-bound assertions.
- [x] Add native foreground light/dark and drag-trail rendered PNG assertions.

Done when: the gate fails on telemetry-only cursor implementations, distinguishes
native foreground cursor evidence from shared-surface mirror evidence, and passes
only with native animation, Cueboard Bezier planner diagnostics, and rendered
marker evidence for the layers under test.

### Phase 4: Latency Gate

- [x] Add deterministic helper cold/warm latency script.
- [x] Add cold/warm benchmark script for deterministic helper cases.
- [x] Extend cold/warm benchmark with visual and observe cases.
- [x] Separate compile/startup/observe/plan/model/execute/verify/wrapper/Realtime
      segments.
- [x] Report p50/p95 for warm deterministic calls.

Done when: a slow run says where time was spent instead of only saying "timeout".

### Phase 5: Real-Room Rollup

- [x] Attach or link latest reports from the specialized gates.
- [x] Run a real Meet smoke with at least one keyboard action and one pointer
      action.
- [x] Verify function output, app-control action evidence, visible cursor, HUD
      cleanup, and avatar audio through the linked real-room artifacts.

Done when: release/manual acceptance has one integrated artifact when the room
admits both child sessions cleanly, or a same-room linked artifact set when Meet
admission/output routing is the unstable layer, plus specialized gate evidence
for diagnosis.

## Validation Log

- 2026-06-02: `node --import tsx --test --test-reporter=spec test/app-control-helper.test.mjs test/realtime-kwwk-cursor-visible-benchmark.test.mjs test/realtime-kwwk-native-cursor-benchmark.test.mjs test/realtime-kwwk-planner-action-benchmark.test.mjs test/realtime-contract.test.mjs` passed 52/52, including native cursor probe, native animation evidence, native light/dark rendered PNG evidence, missing-animation negative, missing-native-evidence negative, optional live macOS fixture report coverage, and Realtime tool-contract coverage.
- 2026-06-02: after rebasing onto `origin/main` `b3bf2b4` and installing the new `oxfmt` / `oxlint` / `lefthook` toolchain, `npm run format:check`, `npm run lint:js`, `npm run lint:go`, `npm run typecheck`, and the same 52/52 targeted Realtime/KWWK tests passed.
- 2026-06-02: after rebasing again onto `origin/main` `2d70b3f` / Vite+ tooling, `npm install` installed `vite-plus`; `npm run format:check`, `npm run lint:js`, `npm run lint:go`, `npm run typecheck`, and `vp test run test/app-control-helper.test.mjs test/realtime-kwwk-cursor-visible-benchmark.test.mjs test/realtime-kwwk-native-cursor-benchmark.test.mjs test/realtime-kwwk-planner-action-benchmark.test.mjs test/realtime-contract.test.mjs` passed 52/52. `npm audit` still reports one moderate vulnerability; not addressed in this RFC slice.
- 2026-06-02: after the same rebase, `npm run benchmark:realtime-kwwk-planner-action -- --json-out /tmp/oneesama-realtime-kwwk-planner-action-after-rebase.json`, `npm run benchmark:realtime-kwwk-cursor-visible -- --json-out /tmp/oneesama-realtime-kwwk-cursor-visible-after-rebase.json`, `npm run benchmark:realtime-kwwk-native-cursor -- --json-out /tmp/oneesama-realtime-kwwk-native-cursor-after-rebase.json`, and `npm run benchmark:realtime-kwwk-latency -- --warm-runs 4 --json-out /tmp/oneesama-realtime-kwwk-latency-after-rebase.json` passed; latency reported compile `1118ms`, warm p50 `0ms`, warm p95 `0ms`.
- 2026-06-02: planner/action benchmark now includes `observe-title-report-en`, covering Realtime's real-room app-control prompt shape: "Observe the currently shared browser window and report the visible page title or blocker. Do not type, click, navigate, or change the page." `npm run benchmark:realtime-kwwk-planner-action -- --json-out /tmp/oneesama-realtime-kwwk-planner-action-observe-title-fix.json` passed all 14 fixture cases.
- 2026-06-02: strict sidecar acceptance with `MAB_REAL_MEET_URL=https://meet.google.com/ypw-fozb-anz vp exec tsx scripts/real-meet-sidecar-acceptance.mjs --require-real-meet-url --json-out /tmp/oneesama-realtime-live-sidecar-rfc-2026-06-02.json` did not pass the full real-room gate because the synthetic-speaker child hit Meet `cannot_join_meeting` / "You can't join this video call." The app-control child still provided partial sidecar evidence, but the full real-room checklist stays open.
- 2026-06-02: strict sidecar acceptance with the replacement room `MAB_REAL_MEET_URL=https://meet.google.com/yza-vjpx-qto vp exec tsx scripts/real-meet-sidecar-acceptance.mjs --require-real-meet-url --json-out /tmp/oneesama-realtime-live-sidecar-yza-vjpx-qto-2026-06-02.json` still did not pass the full real-room gate. `appControl` passed with `acceptanceSatisfied:true`, `status:"completed"`, `kwwk_computer_use`, function-output delivery, planner `actionKinds:["state"]`, and observed title `Meet - yza-vjpx-qto 🔊`; `syntheticSpeaker` failed with Meet `cannot_join_meeting` / "You can't join this video call." This is the same external room-admission blocker, not a KWWK app-control failure.
- 2026-06-02: after fixing the observe-title planner case and restarting stale helper state, `MAB_REAL_MEET_URL=https://meet.google.com/ypw-fozb-anz vp exec tsx scripts/real-meet-synthetic-speaker-smoke.mjs --real-meet-app-control-smoke --require-real-meet-url --json-out /tmp/oneesama-realtime-real-app-control-after-observe-fix.json` passed the app-control smoke: Realtime used `kwwk_computer_use`, function output was delivered, KWWK completed an observe/state job, and captured `Meet - ypw-fozb-anz`. This proves app-control observe routing, not avatar audio or cursor-visible acceptance.
- 2026-06-02: live-service control exposed a benchmark hygiene issue: `scripts/oneesama-live-screen.sh --restart --bin /tmp/oneesama-current-rfc meeting-agent` previously false-negatived its postcheck and could leave an old `meeting-agent`/KWWK helper process alive, which caused stale planner behavior until the old pid was terminated and the service restarted. The launcher now discovers temp binaries such as `/tmp/oneesama-current-rfc meeting-agent`, stops existing matching service pids on `--restart`, and postchecks the replacement pid. Verified with `scripts/oneesama-live-screen.sh --restart --bin /tmp/oneesama-current-rfc meeting-agent`, which stopped old pid `52078`, started pid `69621`, and passed `--check-pid`; health and `/realtime/config` still exposed `kwwk_computer_use`.
- 2026-06-02: `npm run benchmark:realtime-kwwk-app-control -- --json-out /tmp/oneesama-realtime-kwwk-app-control-rfc.json` passed live KWWK stdio/backend routing cases.
- 2026-06-02: `npm run benchmark:realtime-kwwk-planner-action -- --json-out /tmp/oneesama-realtime-kwwk-planner-action-rfc.json` passed planner/action fixture cases.
- 2026-06-02: `npm run benchmark:realtime-kwwk-planner-action -- --include-live-browser-fixture --json-out /tmp/oneesama-realtime-kwwk-planner-action-live-browser-rfc.json` passed with `evidenceMode: deterministic_helper_plan_fixture_and_live_browser_fixture`; `live-browser-tab-switch` verified a real Chrome for Testing window title changed from `KWWK Browser One` to `KWWK Browser Two`.
- 2026-06-02: `npm run benchmark:realtime-kwwk-cursor-visible -- --json-out /tmp/oneesama-realtime-kwwk-cursor-visible-rfc.json` passed with `evidenceMode: native_foreground_cursor_and_shared_surface_mirror`.
- 2026-06-02: `npm run benchmark:realtime-kwwk-native-cursor -- --json-out /tmp/oneesama-realtime-kwwk-native-cursor-rfc.json` passed with `evidenceMode: native_ns_panel_probe_and_native_view_rendered_png_pixels`.
- 2026-06-02: `node --import tsx scripts/realtime-kwwk-planner-action-benchmark.mjs --include-live-macos-fixture --timeout-ms 30000 --json-out /tmp/oneesama-realtime-kwwk-planner-action-live-macos-rfc.json` passed with `evidenceMode: deterministic_helper_plan_fixture_and_live_macos_fixture`.
- 2026-06-02: `npm run benchmark:realtime-kwwk-latency -- --warm-runs 4 --json-out /tmp/oneesama-realtime-kwwk-latency-rfc.json` passed with compile `1303ms`, warm p50 `0ms`, warm p95 `1ms`.
- 2026-06-02: the cursor-visible/native-cursor reports include `native-foreground-cursor-materialized`, `native-foreground-cursor-drag-materialized`, `native-foreground-cursor-animation`, `native-foreground-cursor-light-dark-rendered`, `native-foreground-drag-trail-rendered`, `cursor-evidence-layer-split`, shared rendered marker, drag trail, target ring, and low-value HUD negative cases.
- 2026-06-02: `vp test run test/app-control-helper.test.mjs test/realtime-kwwk-cursor-visible-benchmark.test.mjs test/realtime-kwwk-native-cursor-benchmark.test.mjs` passed 26/26 after tightening cursor animation evidence to require `cueboard_action_overlay_bezier`, `arc_length_smoothstep`, five Bezier control points, and passing turn-bound diagnostics.
- 2026-06-02: `npm run benchmark:realtime-kwwk-cursor-visible -- --json-out /tmp/oneesama-realtime-kwwk-cursor-visible-bezier-rfc.json` passed; `native-foreground-cursor-animation` now fails unless approach/drag include Cueboard Bezier planner evidence. The recorded approach and drag plans both used `quartic`, `turnBound.passed:true`, `violations:0`, and candidate pool `total:8`.
- 2026-06-02: `npm run benchmark:realtime-kwwk-native-cursor -- --json-out /tmp/oneesama-realtime-kwwk-native-cursor-bezier-rfc.json` passed with `native-foreground-cursor-cueboard-bezier-planner`, `controlPointCount:5`, `sampleCount:137`, `turnBoundPassed:true`, plus native light/dark and drag-trail PNG pixel evidence.
- 2026-06-02: latest strict sidecar rerun with `MAB_REAL_MEET_URL=https://meet.google.com/yza-vjpx-qto vp exec tsx scripts/real-meet-sidecar-acceptance.mjs --require-real-meet-url --json-out /tmp/oneesama-realtime-live-sidecar-yza-vjpx-qto-final-2026-06-02.json` still failed the full real-room gate: `gates.appControl.acceptanceSatisfied:true`, `status:"completed"`, and `functionOutputDelivered:true`, but `gates.syntheticSpeaker.acceptanceSatisfied:false` because Meet returned `cannot_join_meeting` / "You can't join this video call." The integrated real-room checklist stays open.
- 2026-06-02: the same room passed once the synthetic speaker used a headed guest browser: `MAB_REAL_MEET_URL=https://meet.google.com/yza-vjpx-qto MAB_SYNTHETIC_SPEAKER_HEADLESS=false MAB_SYNTHETIC_SPEAKER_JOIN_TIMEOUT_MS=45000 vp exec tsx scripts/real-meet-sidecar-acceptance.mjs --require-real-meet-url --json-out /tmp/oneesama-realtime-live-sidecar-yza-vjpx-qto-headed-2026-06-02.json` exited 0 with `ok:true` and `acceptanceSatisfied:true`. `gates.syntheticSpeaker` passed with `participantPresent:true`, `currentRealtimeInputSource:"recappi_process_audio_tap"`, `meetEnergyOk:true`, `speechStarted:true`, `responseSeen:true`, and `outputRouted:true`; `gates.appControl` passed with `status:"completed"`, `appControlCalled:true`, `functionOutputDelivered:true`, provider `kwwk`, planner `actionKinds:["state"]`, and observed window title `Meet - yza-vjpx-qto`. This proves the strict voice/sidecar/KWWK observe path and shows the earlier blocker was the headless synthetic-speaker admission path. It still does not prove a live-room pointer/cursor action.
- 2026-06-02: after fixing app-control terminal worker report redelivery and JSON-string result-envelope cursor extraction, the real-room app-control suite passed: `MAB_REAL_MEET_URL=https://meet.google.com/yza-vjpx-qto MAB_REAL_MEET_APP_CONTROL_WAIT_MS=240000 MAB_REAL_MEET_APP_CONTROL_CURSOR_WAIT_MS=25000 vp exec tsx scripts/real-meet-synthetic-speaker-smoke.mjs --real-meet-app-control-suite --require-real-meet-url --json-out /tmp/oneesama-realtime-real-app-control-suite-yza-vjpx-qto-cursor-json-envelope-2026-06-02.json` exited 0 with `ok:true` and `acceptanceSatisfied:true`. `keyboard-escape` passed with no pointer artifact (`eventCount:0`) and no noisy speech/connection HUD text. `pointer-visible-click` passed with `appControlJobId:"app_control_4_dd520923"`, `functionOutputDelivered:true`, `kwwkCursor.eventCount:1`, `eventKinds:["cursor.click"]`, `hasClick:true`, `latestVisible:true`, persistent cursor/click-pulse styles, and HUD `visibleText:"done 完成 "` without connection/audio/speech noise.
- 2026-06-02: the app-control suite exposed two benchmark plumbing bugs that unit tests now cover: app-control job IDs were process-local (`app_control_1`) and could collide with persisted delivered worker reports after restart, and the browser cursor collector did not parse JSON strings in `resultEnvelope.result`. The fixes add unique app-control job IDs, reset Realtime delivery state for terminal app-control reports, preserve full JSON result envelopes with a short summary, and parse JSON-string envelopes before cursor/action telemetry extraction. Verified by `go test ./internal/meetingagent -run 'TestRealtimeSharedAppControl|TestQueuedAppControl|TestAppControlResultMap' -count=1` and `vp test run test/realtime-app-control-bridge.test.mjs test/realtime-app-control-executor-loop.test.mjs test/realtime-sidecar-tool-routing.test.mjs test/realtime-real-meet-app-control-benchmark.test.mjs`.
- 2026-06-02: a later attempt to get a single strict integrated artifact with `MAB_SYNTHETIC_SPEAKER_JOIN_TIMEOUT_MS=90000` produced useful negative diagnosis but did not replace the passed linked artifacts: synthetic speaker admission/input/model response passed, but `outputRouted:false` because remote audio bytes were present with zero measured energy; the app-control child then hit a second-turn Realtime fake-execution/tool-recall miss despite having `functionOutputDelivered:true` for the first job. This confirms the remaining full-rollup flake is in room audio-output/tool-turn orchestration, not the KWWK cursor-visible path.

## Open Questions

- Should planner/action benchmarks run against a native macOS app fixture, a
  browser fixture, or both?
- What is the warm-call p95 target for "feels instant enough" in a live meeting?
- Should optional planner-model latency be part of pass/fail or reported as
  advisory until real usage data exists?
- Which gates should run in ordinary local CI, and which stay manual because
  they need macOS permissions or a real Meet room?
