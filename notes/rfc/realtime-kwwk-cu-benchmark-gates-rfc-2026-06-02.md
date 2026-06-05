# RFC: Realtime/KWWK CU Benchmark Gates

Date: 2026-06-02
Status: accepted gate plan; model-first rewrite amendments open
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
- Add a provider-specific live planner gate. Fixture planner success is never
  enough for model-first acceptance.
- Add cold/warm latency reporting for helper compile, helper startup,
  observation, planning, execution, and verification.
- Add a cursor-visible benchmark once the overlay RFC is implemented.
- Real-room gates remain the final integration proof, not the default inner loop.

## Model-First Rewrite Overlay

This benchmark RFC has two layers of evidence:

- the 2026-06-02 historical gates, which proved the existing KWWK app-control,
  cursor, latency, and real-room plumbing could work; and
- the 2026-06-03 model-first rewrite gates, which must prove the replacement
  KWWK/Cueboard CU execution plane works without `control_shared_app_window`,
  hidden local keyword fallback, or old-helper planner/executor/cursor
  foundations.

For the rewrite, a historical green cursor/backend/room artifact is useful
regression context but not final acceptance. Final acceptance requires rerunning
the gate suite after the replacement helper modules are wired:

- [x] default live Realtime tool surface exposes `kwwk_computer_use` and omits
      `control_shared_app_window`;
- [x] all fixture natural-language planner/action cases report
      `modelUsed:true`;
- [x] fixture planner/action cases prove schema validation, blockers,
      `needs_background_agent`, timeout/bad-output handling, and action budget;
- [x] provider-specific planner live gate passes with the current default
      OpenRouter `google/gemini-3.5-flash`;
- [x] backend app-control gate proves the wired replacement helper can observe,
      execute, verify, and report cold/warm timing;
- [x] cursor-visible and native-cursor gates prove Cueboard-style foreground
      cursor plus shared-surface mirror after the cursor module rewrite;
- [x] latency gate proves the current warm model-first fixture path stays under
      the `tool receive -> verified action` p95 <= 2500 ms budget, with hidden
      cold starts excluded from warm runs; live planner model p95 remains gated
      by the provider-specific live planner gate above;
- [x] meet-free synthetic-Realtime share gate proves real synthetic speaker
      audio, real Realtime sidecar input, and real share/app tool telemetry
      against the local fixture before spending time on Google Meet admission;
      the fixture loops the short command by default to avoid a one-shot audio
      race with Realtime session warm-up;
- [ ] full real Meet artifact includes Realtime SDK connection, voice input, active
      app share, `kwwk_computer_use`, model plan, verified action, cursor
      evidence, interruption pass, English response, and cold/warm timing
      breakdown.

## Gate Ownership

| Gate                         | Owner layer                                                                    | Default loop                           | Requires macOS app permissions                             | Requires real Meet room           |
| ---------------------------- | ------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------- | --------------------------------- |
| Realtime tool recall         | Realtime sidecar/tool surface                                                  | local/CI when API is available         | No                                                         | No                                |
| KWWK backend execution       | meeting-agent + KWWK helper/backend                                            | local macOS                            | Yes for live helper paths                                  | No                                |
| KWWK planner/action          | KWWK planner + executor                                                        | local fixture first, macOS live second | Fixture: no; live: yes                                     | No                                |
| Live planner                 | KWWK planner model client + schema validator                                   | local manual/live gate                 | No                                                         | No                                |
| Cursor-visible               | KWWK native foreground cursor + cursor bus + shared-surface overlay/HUD mirror | local screenshot/pixel gate            | Usually yes for native overlay; no for mirror-only fixture | No for local, yes for final smoke |
| Cold/warm latency            | all timing boundaries                                                          | local benchmark                        | Depends on case                                            | No                                |
| Meet-free synthetic-Realtime | synthetic speaker + Realtime sidecar + tool execution                          | local fixture integration              | Only for the selected tool path                            | No                                |
| Real-room integrated         | full product path                                                              | manual/release gate                    | Yes                                                        | Yes                               |

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

| Gate                         | Primary question                                                                                               | Required evidence                                                                                        | Not sufficient for                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Realtime tool recall         | Did the model select `kwwk_computer_use` for bounded app-control utterances?                                   | SDK history, tool call name/args, wrapper telemetry, function output delivery                            | KWWK execution correctness           |
| KWWK backend execution       | Can the backend/helper observe and execute direct app-control calls?                                           | helper telemetry, app-control result, HTTP/stdio result                                                  | Natural-language planner correctness |
| KWWK planner/action          | Can "切换 tab"/"点第二个按钮" become verified actions?                                                         | plan, actions, pre/post app state, verification                                                          | Meeting-visible cursor               |
| Live planner                 | Can the configured planner model produce a strict action plan within SLO?                                      | requested/actual model, schema validity/refusal, blocker, model latency, plan/actions                    | Local app execution                  |
| Cursor-visible               | Does the audience see pointer/click feedback, and does KWWK present a real foreground cursor?                  | native foreground overlay evidence, cursor events, coordinate metadata, rendered-frame marker            | Action semantic success              |
| Cold/warm latency            | Is simple CU fast enough after startup, and where is time spent?                                               | timing breakdown and percentiles                                                                         | Correct tool choice                  |
| Meet-free synthetic-Realtime | Does real synthetic-speaker audio drive real Realtime into the expected app/share tool without Meet admission? | generated WAV, Realtime input transcript, speech-start, model response, tool telemetry, no text fallback | Real-room admission                  |
| Real-room integrated         | Does all of it work in Meet with voice, sidecar, tool, app, cursor, and audio?                                 | single acceptance artifact with all correlated signals                                                   | Fast local regression loop           |

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
    | "kwwk_planner_live"
    | "cursor_visible"
    | "cold_warm_latency"
    | "meet_free_synthetic_realtime"
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

- every natural-language fixture case goes through the model-first planner
  contract and reports `modelUsed:true`;
- fixture instructions become bounded action plans without using local keyword
  execution as a hidden fallback;
- visual/AX target references resolve or block predictably;
- post-action verification catches false success.

This gate does not prove:

- Realtime chose the tool;
- cursor feedback appeared in Meet;
- cold-start latency is acceptable in a live room.
- the configured live planner provider/model is available or fast enough.

Model-first rewrite amendment:

- [x] Fixture/local planner-action cases require `modelUsed:true`.
- [x] Fixture/local planner-action reports distinguish
      `model_first_local_fixture` from a provider-specific live planner.
- [x] Fixture/local planner-action cases include schema-valid success,
      explicit blocker, timeout/bad-output, and action-budget coverage.
- [x] Live provider-specific planner gate requires the configured default
      provider/model to be available.
- [x] Live provider-specific planner gate records requested provider/model,
      actual response model, schema refusal, invalid-schema blocker,
      retry/blocker evidence, and model latency.
- [x] Live provider-specific planner gate fails if the model plan is missing,
      invalid, actionless for an executable task, over budget, timed out, or
      slower than the active provider-specific planner SLO.
- [x] Live provider-specific planner gate passes with the current default
      OpenRouter `google/gemini-3.5-flash`, not only with an override probe.

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

Live planner command:

```bash
npm run benchmark:realtime-kwwk-planner-live -- \
  --provider openrouter \
  --model google/gemini-3.5-flash \
  --json-out /tmp/oneesama-realtime-kwwk-planner-live-latest.json
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
- [x] Add strict provider-specific live planner benchmark script
      `scripts/realtime-kwwk-live-planner-benchmark.mjs`.
- [x] Wire `benchmark:realtime-kwwk-planner-live` to call `kwwk.cu.plan` with
      provider `openrouter` by default, while retaining OpenAI as a diagnostic
      provider path.
- [x] Load project live env/config so the gate does not accidentally use stale
      shell credentials or a wrong provider/model.
- [x] Fail the live gate on missing model, invalid/missing schema plan,
      actionless executable plan, timeout, bad JSON, action-budget violation,
      or planner latency above the active provider-specific SLO.
- [x] Close the live planner acceptance gate with the product-selected default:
      OpenRouter `google/gemini-3.5-flash`.

### Model-First Rewrite Benchmark Checklist

- [x] Update `benchmark:realtime-kwwk-planner-action` so fixture
      natural-language action cases require `modelUsed:true`.
- [x] Add `benchmark:realtime-kwwk-planner-live` as a provider-specific live
      planner gate that calls `kwwk.cu.plan` and fails on missing model,
      invalid schema, missing/actionless plan, timeout, bad JSON,
      action-budget violation, or planner latency above the active
      provider-specific SLO.
- [x] Keep deterministic fixture coverage for schema-valid success, explicit
      blockers, timeout/bad-output, and action-budget behavior.
- [x] Update `benchmark:realtime-kwwk-latency` to report model-first warm path
      timing and keep hidden cold startup out of warm runs.
- [x] Rerun `benchmark:realtime-kwwk-app-control` after the observation/state
      module is wired into the replacement helper build.
- [x] Rerun `benchmark:realtime-kwwk-planner-action` after the
      observe-plan-act-verify split is wired.
- [x] Rerun `benchmark:realtime-kwwk-planner-live` after the
      observe-plan-act-verify split and record the default-model blocker.
- [x] Require the default desired model to pass; current default is OpenRouter
      `google/gemini-3.5-flash`.
- [x] Rerun `benchmark:realtime-kwwk-cursor-visible` and
      `benchmark:realtime-kwwk-native-cursor` after the Cueboard cursor module
      is ported into the replacement helper path.
- [x] Rerun the default tool-surface, recall, and stale-service guard gates
      after positive legacy fixtures move to `kwwk_computer_use`.
- [x] Rerun the final tool-surface contract gate after legacy
      `control_shared_app_window` schema/handler branches and tests are deleted,
      not merely hidden from default config.
- [ ] Produce a real Meet sidecar artifact with Realtime connection, voice
      input, app share, `kwwk_computer_use`, model plan, verified action, cursor
      evidence, interruption pass, English response, and cold/warm timing
      breakdown.

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

- 2026-06-03: RFC updated to add the model-first rewrite overlay and rewrite
  benchmark checklist. This documentation-only update separates historical
  2026-06-02 green artifacts from final rewrite acceptance, which still
  requires rerunning backend, planner/action, live planner, cursor, latency,
  tool-surface, and real Meet gates after replacement helper modules are wired.
  No new benchmark was run for this documentation-only edit.
- 2026-06-03: after wiring
  `packages/core/src/meeting/kwwk-cu-observation.swift` into the helper build
  and moving observation/state helpers out of `app-control-helper.swift`,
  source-boundary and contract tests passed:
  `vp test run test/app-control-helper.test.mjs` (21/21) and
  `vp test run test/realtime-contract.test.mjs` (22/22).
- 2026-06-03: observation split gate reruns passed
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `1723ms`, warm p95 `1ms`), and
  `npm run benchmark:realtime-kwwk-app-control` (4/4, `51.109s`). The backend
  rerun first exposed that the 15s inner live-smoke timeout was too tight for a
  real macOS state/screenshot cold path; it is now 30s, while latency remains
  enforced by the dedicated latency gate.
- 2026-06-03: strict live planner gate after the observation split still fails
  by design for the unavailable default model, and this unavailable-model path
  also exceeded the planner SLO:
  `/tmp/oneesama-realtime-kwwk-planner-live-latest.json` recorded
  `modelUsed:true`, requested model `gpt-5.3-codex-spark`, model latency
  `1956ms`, round trip `1963ms`, `withinPlannerSlo:false`, no actions, and
  blocker `blocked_planner_model_model_not_found`.
- 2026-06-03: observation split regression checks passed `npm run typecheck`,
  `go test ./internal/meetingagent -run 'TestKWWKStdio|TestFallbackAppControl|TestRealtimeSharedAppControl|TestQueuedAppControl|TestAppControlResultMap' -count=1`,
  `vp fmt . --check`, and `git diff --check`.
- 2026-06-03: after wiring
  `packages/core/src/meeting/kwwk-cu-cursor.swift` into the helper build and
  moving native cursor/overlay helpers out of `app-control-helper.swift`,
  source-boundary and contract tests passed:
  `vp test run test/app-control-helper.test.mjs` (21/21) and
  `vp test run test/realtime-contract.test.mjs` (22/22).
- 2026-06-03: cursor module gate reruns passed
  `npm run benchmark:realtime-kwwk-cursor-visible` (all 9 cursor/HUD cases) and
  `npm run benchmark:realtime-kwwk-native-cursor` (all 7 native cursor cases).
  The reports include native foreground cursor materialization, drag
  materialization, Cueboard Bezier animation evidence, target ring, drag trail,
  shared-surface evidence split, rendered marker, coordinate metadata, and the
  low-value HUD negative case.
- 2026-06-03: cursor split regression gates also passed
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `1910ms`, warm p95 `1ms`), and
  `npm run benchmark:realtime-kwwk-app-control` (4/4, `50.728s`). The backend
  rerun first exposed missing top-level `timeoutMs` in HTTP live-smoke
  requests; after adding it, the gate passed.
- 2026-06-03: strict live planner gate after the cursor split still fails for
  the unavailable default model, not for cursor/helper compilation:
  `/tmp/oneesama-realtime-kwwk-planner-live-latest.json` recorded
  `modelUsed:true`, provider `model_first_openai`, requested model
  `gpt-5.3-codex-spark`, model latency `1226ms`, round trip `1232ms`,
  `withinPlannerSlo:false`, no actions, and blocker
  `blocked_planner_model_model_not_found`.
- 2026-06-03: cursor split final checks passed `npm run typecheck`,
  `go test ./internal/meetingagent -run 'TestKWWKStdio|TestFallbackAppControl|TestRealtimeSharedAppControl|TestQueuedAppControl|TestAppControlResultMap' -count=1`,
  `vp fmt . --check`, and `git diff --check`.
- 2026-06-03: after wiring
  `packages/core/src/meeting/kwwk-cu-verification.swift` into the helper build,
  the executor now emits `oneesama.kwwk-cu-verification.v1` evidence and
  returns `failed_verification` instead of false success when explicit
  post-state expectations fail. Source-boundary and contract tests passed:
  `vp test run test/app-control-helper.test.mjs` (23/23) and
  `vp test run test/realtime-contract.test.mjs` (22/22). The scoped Go backend
  test also passed and now covers preserving KWWK `failed_verification` raw
  evidence through `AppControlResult`.
- 2026-06-03: verification split gate reruns passed
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `2328ms`, warm p95 `2ms`), and
  `npm run benchmark:realtime-kwwk-app-control` (4/4, `53.815s`).
- 2026-06-03: strict live planner gate after the verification split still fails
  for the unavailable default model:
  `/tmp/oneesama-realtime-kwwk-planner-live-latest.json` recorded
  `modelUsed:true`, provider `model_first_openai`, requested model
  `gpt-5.3-codex-spark`, model latency `942ms`, round trip `952ms`,
  `withinPlannerSlo:true`, no actions, and blocker
  `blocked_planner_model_model_not_found`.
- 2026-06-03: verification split final checks passed `npm run typecheck`,
  `go test ./internal/meetingagent -run 'TestKWWKStdio|TestFallbackAppControl|TestRealtimeSharedAppControl|TestQueuedAppControl|TestAppControlResultMap' -count=1`,
  `vp fmt . --check`, and `git diff --check`.
- 2026-06-03: after wiring
  `packages/core/src/meeting/kwwk-cu-input.swift` into the helper build, the
  keyboard/text/scroll primitives live outside `app-control-helper.swift` and
  are covered by helper source-boundary tests. Gate reruns passed
  `vp test run test/app-control-helper.test.mjs` (23/23),
  `vp test run test/realtime-contract.test.mjs` (22/22),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `2423ms`, warm p95 `1ms`), and
  `npm run benchmark:realtime-kwwk-app-control` (4/4, `54.845s`).
- 2026-06-03: strict live planner gate after the input split still fails for
  the unavailable default model:
  `/tmp/oneesama-realtime-kwwk-planner-live-latest.json` recorded
  `modelUsed:true`, provider `model_first_openai`, requested model
  `gpt-5.3-codex-spark`, model latency `950ms`, round trip `957ms`,
  `withinPlannerSlo:true`, no actions, and blocker
  `blocked_planner_model_model_not_found`. Final checks passed
  `npm run typecheck`, scoped meetingagent `go test`, `vp fmt . --check`, and
  `git diff --check`.
- 2026-06-03: after wiring
  `packages/core/src/meeting/kwwk-cu-runtime.swift` and
  `packages/core/src/meeting/kwwk-cu-router.swift` into the helper build,
  `app-control-helper.swift` is only the `@main` launcher/shim. Gate reruns
  passed `vp test run test/app-control-helper.test.mjs` (23/23),
  `vp test run test/realtime-contract.test.mjs` (22/22),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `3221ms`, warm p95 `1ms`), and
  `npm run benchmark:realtime-kwwk-app-control` (4/4, `57.390s`).
- 2026-06-03: strict live planner gate after the runtime/router split still
  fails for the unavailable default model:
  `/tmp/oneesama-realtime-kwwk-planner-live-latest.json` recorded
  `modelUsed:true`, provider `model_first_openai`, requested model
  `gpt-5.3-codex-spark`, model latency `714ms`, round trip `720ms`,
  `withinPlannerSlo:true`, no actions, and blocker
  `blocked_planner_model_model_not_found`. Final checks passed
  `npm run typecheck`, scoped meetingagent `go test`, `vp fmt . --check`, and
  `git diff --check`.
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
- 2026-06-03: model-first rewrite follow-up added the historical strict live
  OpenAI planner diagnostic gate `npm run benchmark:realtime-kwwk-planner-live`,
  backed by
  `scripts/realtime-kwwk-live-planner-benchmark.mjs`. The gate calls
  `kwwk.cu.plan` with provider `openai`, requires `modelUsed:true`,
  schema-valid action-bearing output, actual model evidence, and planner
  latency within 1200ms. This was the initial Spark-era diagnostic gate and is
  superseded as the product default by the later OpenRouter/Gemini gate below.
- 2026-06-03: the first strict live planner diagnosis exposed an env-loading
  problem: the benchmark could see a stale shell `OPENAI_API_KEY` and miss the
  project's live meeting-agent OpenAI env files. After loading the live env, the
  current strict artifact `/tmp/oneesama-realtime-kwwk-planner-live-latest.json`
  failed as intended with requested model `gpt-5.3-codex-spark`,
  `modelUsed:true`, round trip `633ms`, and blocker
  `blocked_planner_model_model_not_found`. This records a real live-planner
  blocker for the then-open OpenAI/Spark gate rather than passing on local
  fixtures; the current accepted default is the later OpenRouter/Gemini gate.
- 2026-06-03: configured override probes including `gpt-5.3-codex` and
  repeated `gpt-5.1-codex-mini` runs produced schema-valid action-bearing plans,
  but remained above the 1200 ms planner SLO. These runs prove the action schema
  path can work with an available model, but they do not satisfy the live
  planner acceptance gate.
- 2026-06-03: the same follow-up updated helper/unit tests to the new
  `kwwk.cu.plan` / `model_first_local_fixture` contract and passed
  `vp test run test/app-control-helper.test.mjs test/realtime-kwwk-planner-action-benchmark.test.mjs`
  (23/23), `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-latency` (compile `2322ms`, warm p95 `1ms`),
  `npm run benchmark:realtime-kwwk-app-control` (4/4), `npm run typecheck`,
  `npm run lint:js`, `go test ./... -count=1`, and `vp fmt . --check`.
- 2026-06-03: the `kwwk.cu.action` protocol slice now validates a single
  operation or Cueboard-style action envelope before executor entry. Invalid
  actions return structured blockers instead of executing or surfacing as
  generic JSON-RPC errors. Verified with
  `vp test run test/app-control-helper.test.mjs` (19/19) and
  `npm run benchmark:realtime-kwwk-planner-action` (14/14).
- 2026-06-03: the historical strict live OpenAI planner diagnostic gate was
  rerun after the helper protocol slice. It still fails for the desired default
  model at that time, which is the correct hard gate result:
  `/tmp/oneesama-realtime-kwwk-planner-live-latest.json`
  recorded provider `model_first_openai`, `modelUsed:true`, requested model
  `gpt-5.3-codex-spark`, model latency `858ms`, no actions, and blocker
  `blocked_planner_model_model_not_found`.
- 2026-06-03: the `kwwk.cu.control` protocol slice now accepts Cueboard-style
  `control/session/mode` envelopes and records structured control evidence for
  ping, permission status, mode help, active session status, session start,
  duplicate-start blocker, and stop. Verified with
  `vp test run test/app-control-helper.test.mjs` (20/20),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14), and
  `npm run benchmark:realtime-kwwk-app-control` (4/4).
- 2026-06-03: the Phase 1 module-boundary slice extracted the initial CU
  protocol/session implementation into
  `packages/core/src/meeting/kwwk-cu-protocol.swift`, converted the old Swift
  helper entrypoint to `@main`, and updated the TS launcher to compile multiple
  Swift sources with correct cache invalidation. Verified with
  `vp test run test/app-control-helper.test.mjs` (21/21),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-app-control` (4/4), and
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `1706ms`, warm p95 `1ms`). The then-current OpenAI/Spark planner gate still
  failed only on the expected `blocked_planner_model_model_not_found` blocker.
- 2026-06-03: `vp test run test/realtime-contract.test.mjs` passed 22/22 after
  updating the static contract assertion to require `kwwk_computer_use` and
  require `control_shared_app_window` to stay absent from the default Realtime
  tool surface.
- 2026-06-03: the planner-module boundary slice extracted strict action schema,
  per-action validation, and action-budget checks into
  `packages/core/src/meeting/kwwk-cu-planner.swift`, then compiled it with the
  other Swift helper sources. Verified with
  `vp test run test/app-control-helper.test.mjs` (21/21),
  `vp test run test/realtime-contract.test.mjs` (22/22),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-app-control` (4/4), and
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `1886ms`, warm p95 `1ms`). The live planner gate still fails only on
  `blocked_planner_model_model_not_found`.
- 2026-06-03: the follow-up planner-client boundary slice moved local fixture
  parsing, OpenAI Responses API request/response handling, model/blocker
  taxonomy, and model latency reporting into
  `packages/core/src/meeting/kwwk-cu-planner.swift`. Source-boundary tests now
  assert those planner-client functions are absent from
  `app-control-helper.swift`. Verified with
  `vp test run test/app-control-helper.test.mjs` (21/21),
  `vp test run test/realtime-contract.test.mjs` (22/22),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-app-control` (4/4),
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `3133ms`, warm p95 `2ms`), `npm run typecheck`, and `vp fmt . --check`.
- 2026-06-03: strict live planner gate after that migration still fails by
  design for the unavailable default model rather than an implementation
  regression: `/tmp/oneesama-realtime-kwwk-planner-live-latest.json` recorded
  `modelUsed:true`, requested model `gpt-5.3-codex-spark`, model latency
  `852ms`, round trip `859ms`, `withinPlannerSlo:true`, and blocker
  `blocked_planner_model_model_not_found`.
- 2026-06-03: the next planner assembly slice moved `planInstruction` into
  `packages/core/src/meeting/kwwk-cu-planner.swift`; source-boundary tests now
  assert the old helper no longer defines it. Verified with
  `vp test run test/app-control-helper.test.mjs` (21/21),
  `vp test run test/realtime-contract.test.mjs` (22/22),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-app-control` (4/4), and
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `2247ms`, warm p95 `1ms`).
- 2026-06-03: strict live planner gate after planner assembly migration still
  fails by design for the unavailable default model:
  `/tmp/oneesama-realtime-kwwk-planner-live-latest.json` recorded
  `modelUsed:true`, requested model `gpt-5.3-codex-spark`, model latency
  `908ms`, round trip `915ms`, `withinPlannerSlo:true`, and blocker
  `blocked_planner_model_model_not_found`.
- 2026-06-03: the planner-hints boundary slice moved deterministic local hints,
  browser/search hinting, AX/screenshot element extraction, button target
  resolution, permission blockers, label parsing, and background-agent hints
  into `packages/core/src/meeting/kwwk-cu-planner.swift`. Source-boundary tests
  now assert `operationsFromInstruction`, `clickOperationsFromObservation`, and
  related target resolver helpers are absent from the old helper. Verified with
  `vp test run test/app-control-helper.test.mjs` (21/21),
  `vp test run test/realtime-contract.test.mjs` (22/22),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-app-control` (4/4), and
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `2131ms`, warm p95 `1ms`).
- 2026-06-03: strict live planner gate after the planner-hints migration still
  failed on the unavailable default model, and the failure path also exceeded
  the planner SLO: `/tmp/oneesama-realtime-kwwk-planner-live-latest.json`
  recorded `modelUsed:true`, requested model `gpt-5.3-codex-spark`, model
  latency `1970ms`, round trip `1979ms`, `withinPlannerSlo:false`, and blocker
  `blocked_planner_model_model_not_found`.
- 2026-06-03: the executor boundary slice added
  `packages/core/src/meeting/kwwk-cu-executor.swift` and moved action execution,
  `kwwk.cu.execute` app-control loop, action telemetry, and timing envelopes out
  of the old helper. Verified with
  `vp test run test/app-control-helper.test.mjs` (21/21),
  `vp test run test/realtime-contract.test.mjs` (22/22),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `1987ms`, warm p95 `1ms`), `npm run typecheck`, `vp fmt . --check`, and
  `git diff --check`.
- 2026-06-03: the same executor slice exposed that the backend execution gate's
  45s outer harness timeout could terminate a real macOS suite after three
  passing cases when Chrome/screenshot state was slow. The gate timeout is now
  90s. `npm run benchmark:realtime-kwwk-app-control` then passed all 4/4 cases
  in `50264ms`; the report recorded all backend acceptance booleans true,
  including `mixedObserveActionRejected:true`.
- 2026-06-03: strict live planner gate after the executor migration still fails
  by design for the unavailable default model:
  `/tmp/oneesama-realtime-kwwk-planner-live-latest.json` recorded
  `modelUsed:true`, requested model `gpt-5.3-codex-spark`, model latency
  `869ms`, round trip `905ms`, `withinPlannerSlo:true`, and blocker
  `blocked_planner_model_model_not_found`.
- 2026-06-03: the replacement-helper boundary work continued through
  observation, cursor, verification, input, runtime/router, and Phase 5 positive
  legacy fixture migration. The current positive Realtime app-control executor,
  bridge, sidecar, Agents SDK, compact-output, fake-execution, real-Meet
  benchmark, meet-live acceptance, HUD/debug preset, and Slack copilot trigger
  references now use `kwwk_computer_use`. Remaining
  `control_shared_app_window` references are negative default-surface guards or
  stale-service detection.
- 2026-06-03: Phase 5 tool-surface migration tests passed:
  `vp test run test/realtime-app-control-executor-loop.test.mjs test/realtime-app-control-bridge.test.mjs test/realtime-sidecar-tool-routing.test.mjs test/realtime-agents-sdk-adapter.test.mjs test/realtime-agents-sdk-app-control-policy.test.mjs test/realtime-agents-sdk-compact-output.test.mjs test/realtime-agents-sdk-fake-execution.test.mjs test/realtime-real-meet-app-control-benchmark.test.mjs`
  passed 81/81, and
  `vp test run test/meet-live-acceptance.test.mjs test/meeting-agent-realtime-placement-guard.test.mjs test/realtime-live-routing-smoke-plan.test.mjs test/realtime-tool-recall-benchmark.test.mjs test/google-meet-joiner-audio-safety.test.mjs test/realtime-contract.test.mjs`
  passed 89/89.
- 2026-06-03: default full-variant tool recall passed with
  `vp exec tsx scripts/realtime-tool-recall-benchmark.mjs --runtime sidecar-control --variants full --json-out /tmp/oneesama-realtime-tool-recall-full-kwwk-latest.json`.
  The report recorded recall 10/10, negatives 4/4, and bounded app-control
  cases calling `kwwk_computer_use`.
- 2026-06-03: current post-migration benchmark reruns passed
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `3847ms`, warm p95 `1ms`), and
  `npm run benchmark:realtime-kwwk-app-control` (4/4, `51.252s`).
- 2026-06-03: strict live planner gate after the Phase 5 tool-fixture migration
  still fails on the intended hard blocker rather than silently falling back:
  `/tmp/oneesama-realtime-kwwk-planner-live-latest.json` recorded
  `modelUsed:true`, provider `model_first_openai`, requested model
  `gpt-5.3-codex-spark`, model latency `1237ms`, round trip `1244ms`,
  `withinPlannerSlo:false`, no actions, and blocker
  `blocked_planner_model_model_not_found`.
- 2026-06-03: final checks for this migration slice passed `npm run typecheck`,
  `go test ./internal/meetingagent -run 'TestKWWKStdio|TestFallbackAppControl|TestRealtimeSharedAppControl|TestQueuedAppControl|TestAppControlResultMap|TestRealtimeContract|TestRealtimeJoin|TestHandleRealtime' -count=1`,
  `vp fmt . --check`, and `git diff --check`.
- 2026-06-03: final Phase 5 tool-surface cleanup removed `job_id` from the
  Realtime-visible `kwwk_computer_use` schema while keeping internal HTTP job
  polling intact. Go and TypeScript schema allow-list tests now prove the model
  only sees `instruction`, app/window target hints, and `session_id`, and never
  sees `job_id`, raw operations, coordinates, execution mode, wait, or timeout
  controls.
- 2026-06-03: the final tool-surface gate for legacy app-control deletion now
  has source evidence: `rg` finds no positive `control_shared_app_window`
  schema, handler branch, or `app_control.control_shared_app_window` JSON-RPC
  usage in `internal`, `packages/core/src`, `scripts`, or `test`; remaining
  exact-name references are negative default-surface guards or stale-service
  detection. The Go KWWK stdio backend uses `kwwk.cu.execute`, and the helper
  router exposes `kwwk.cu.execute` as the execution method.
- 2026-06-03: final tool-surface cleanup validation passed:
  `go test ./internal/meetingagent -run 'TestBuildRealtimeSessionDefaultsToLiveSafeToolSurface|TestRealtimeKWWKToolSchemaOnlyExposesGoalAndTargetHints|TestRealtimeToolSchemasMatchTypescriptSource|TestRealtimeToolSchemaStableHash|TestRealtimeToolSchemasAreStrictCompatible|TestRealtimeSharedAppControl|TestQueuedAppControl|TestAppControlResultMap|TestKWWKStdio|TestFallbackAppControl|TestRealtimeContract|TestRealtimeJoin|TestHandleRealtime' -count=1`,
  `vp test run test/realtime-contract.test.mjs test/realtime-app-control-executor-loop.test.mjs test/realtime-app-control-bridge.test.mjs test/realtime-sidecar-tool-routing.test.mjs`
  (53/53), `npm run typecheck`,
  `vp exec tsx scripts/realtime-tool-recall-benchmark.mjs --runtime sidecar-control --variants full --json-out /tmp/oneesama-realtime-tool-recall-full-kwwk-schema-latest.json`
  (recall 10/10, negatives 4/4),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-app-control` (4/4, `50.833s`),
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `3449ms`, warm p95 `1ms`), `vp fmt . --check`, and `git diff --check`.
- 2026-06-03: live service planner configuration was fixed so
  `scripts/oneesama-live-screen.sh --restart meeting-agent` loads the
  OpenRouter planner provider from the private Cueboard config and verifies the
  child process exposes the planner provider/model/key/base/header env names.
  The script-level contract is covered by
  `go test ./scripts -run 'OneesamaLive'`.
- 2026-06-03: provider-specific live planner gate now passes:
  `/tmp/oneesama-realtime-kwwk-planner-live-openrouter-service-wrapper-2026-06-03.json`
  recorded provider `model_first_openrouter`, requested model
  `google/gemini-3.5-flash`, actual model
  `google/gemini-3.5-flash-20260519`, `modelUsed:true`,
  `schemaValid:true`, model latency `2106ms`, round trip `2108ms`,
  `withinPlannerSlo:true`, and action kind `click`.
- 2026-06-03: current gate reruns passed `npm run typecheck`,
  `vp test run test/app-control-helper.test.mjs test/realtime-kwwk-latency-benchmark.test.mjs test/realtime-real-meet-app-control-benchmark.test.mjs`
  (56/56), `npm run benchmark:realtime-kwwk-app-control` (4/4),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-cursor-visible`,
  `npm run benchmark:realtime-kwwk-native-cursor`, and
  `npm run benchmark:realtime-kwwk-latency -- --warm-runs 2` (compile
  `2926ms`, warm p95 `57ms`).
- 2026-06-03: real Meet app-control suite now passes:
  `/tmp/oneesama-realtime-real-app-control-suite-yza-vjpx-qto-openrouter-live-2026-06-03.json`
  records `acceptanceSatisfied:true` for keyboard and pointer cases,
  `kwwk_computer_use` called, function output delivered, planner provider
  `model_first_openrouter`, actual model
  `google/gemini-3.5-flash-20260519`, verification `passed`, HUD noisy-status
  text absent, and pointer cursor event `cursor.click`.
- 2026-06-03: full real Meet sidecar acceptance still fails on an external
  room/admission blocker, not on KWWK CU. Artifact
  `/tmp/oneesama-realtime-live-sidecar-yza-vjpx-qto-openrouter-live-2026-06-03.json`
  records synthetic speaker `cannot_join_meeting` with Meet host-admission text,
  while the same artifact records bot Realtime readiness, Recappi input source,
  avatar-bus sender attachment, and app-control success with verified
  OpenRouter/Gemini plans.
- 2026-06-03: current post-profile-propagation gate reruns passed:
  `go test ./internal/meetingagent ./internal/meetrunner`, `npm run typecheck`,
  `vp test run test/realtime-real-meet-app-control-benchmark.test.mjs`
  (29/29), `npm run benchmark:realtime-kwwk-app-control` (4/4),
  `npm run benchmark:realtime-kwwk-planner-action` (14/14),
  `npm run benchmark:realtime-kwwk-cursor-visible`,
  `npm run benchmark:realtime-kwwk-native-cursor`,
  `npm run benchmark:realtime-kwwk-latency`, and
  `npm run benchmark:realtime-kwwk-planner-live -- --cueboard-config /Users/pengx17/Desktop/config.cueboard.staging.json --provider openrouter --model google/gemini-3.5-flash --planner-slo-ms 2500`.
  The live planner artifact
  `/tmp/oneesama-realtime-kwwk-planner-live-latest.json` recorded provider
  `model_first_openrouter`, requested model `google/gemini-3.5-flash`, actual
  model `google/gemini-3.5-flash-20260519`, `modelUsed:true`,
  `schemaValid:true`, model latency `1948ms`, round trip `1950ms`, and action
  kind `click`.
- 2026-06-03: real Meet app-control suite reran against
  `https://meet.google.com/yza-vjpx-qto` with persistent main-bot profile and
  passed:
  `/tmp/oneesama-realtime-real-app-control-suite-latest.json` records
  `ok:true` and `acceptanceSatisfied:true`; keyboard and pointer cases both
  completed, Realtime called `kwwk_computer_use`, KWWK planned with
  OpenRouter/Gemini, verification passed, the pointer case emitted a native
  foreground cursor plus shared-surface `cursor.click`, and HUD
  `noisySpeechOrConnectionVisible:false`.
- 2026-06-03: full live sidecar acceptance reran with persistent main-bot
  profile and guest synthetic speaker:
  `/tmp/oneesama-realtime-live-sidecar-yza-vjpx-qto-main-notetaker-speaker-guest-structured-failure-2026-06-03.json`.
  The app-control child passed with `acceptanceSatisfied:true` for both
  keyboard and pointer cases, including audience-visible click cursor evidence.
  The synthetic-speaker child failed with structured
  `failure.reason:"speaker_room_admission_required"`; the artifact preserves
  `mainBotProfile.profileMode:"persistent"`,
  `syntheticSpeakerProfile.profileMode:"guest"`, host-admission text ("No one
  can join a meeting unless invited or admitted by the host"), and bot-ready
  signals (`bridgeConnected:true`, `dataChannelOpen:true`,
  `currentRealtimeInputSource:"recappi_process_audio_tap"`). The full
  integrated gate therefore remains open on room/profile admission, not KWWK CU
  planning, execution, cursor, or HUD evidence.
- 2026-06-03: full sidecar acceptance output now lifts child-gate failures into
  top-level `blocker`, `blockerSource`, and `requiredFix` fields so
  `speaker_room_admission_required` cannot be misread as a KWWK CU failure.
  Focused validation passed:
  `vp test run test/realtime-real-meet-app-control-benchmark.test.mjs` (30/30)
  and `git diff --check`.
- 2026-06-03: synthetic-speaker smoke preflight now rejects reused persistent
  Chrome profiles with
  `failure.reason:"synthetic_speaker_profile_conflicts_with_main_bot"` before
  joining the room. This prevents the final live sidecar gate from accidentally
  launching the main bot and speaker against the same `MAB_BROWSER_USER_DATA_DIR`.
  Focused validation passed:
  `vp test run test/realtime-real-meet-app-control-benchmark.test.mjs` (32/32)
  and `git diff --check`.
- 2026-06-03: added
  `npm run acceptance:realtime-live-sidecar:preflight`, backed by
  `scripts/real-meet-sidecar-acceptance.mjs --preflight-only`, so the final
  live gate can validate URL/profile configuration without launching Meet child
  sessions. Formal acceptance remains the full
  `acceptance:realtime-live-sidecar` run; preflight only proves the configured
  room/profile inputs are not immediately invalid. Focused validation passed:
  `vp test run test/realtime-real-meet-app-control-benchmark.test.mjs` (34/34)
  and `git diff --check`.
- 2026-06-03: preflight-only was run against
  `https://meet.google.com/yza-vjpx-qto` with the persistent main-bot profile
  and wrote `/tmp/oneesama-realtime-live-sidecar-preflight-latest.json`. It
  returned `ok:true`, `preflightSatisfied:true`, main bot
  `profileMode:"persistent"`, synthetic speaker `profileMode:"guest"`, no
  blockers, and warning `synthetic_speaker_guest_profile`. This proves the
  remaining final-gate risk is guest admission in strict rooms, not a missing
  URL or reused persistent profile.
- 2026-06-03: prepared a separate authenticated synthetic-speaker Chrome
  profile by cloning the persistent main-bot profile to
  `/Users/pengx17/Library/Application Support/CueboardMeetBot/google-profile/speaker-clone-rfc-20260603-1319`.
  `npm run acceptance:realtime-live-sidecar:prepare-speaker-profile` wrote
  `/tmp/oneesama-realtime-live-sidecar-speaker-profile-latest.json` with
  `ok:true` and `reason:"speaker_profile_prepared"`, then
  `npm run acceptance:realtime-live-sidecar:preflight` wrote
  `/tmp/oneesama-realtime-live-sidecar-preflight-latest.json` with
  `ok:true`, `preflightSatisfied:true`, no blockers, no warnings, and both main
  and speaker `profileMode:"persistent"`.
- 2026-06-03: full `acceptance:realtime-live-sidecar` was rerun against
  `https://meet.google.com/yza-vjpx-qto` with the persistent main-bot profile
  and the cloned persistent speaker profile:
  `/tmp/oneesama-realtime-live-sidecar-yza-vjpx-qto-speaker-clone-rfc-20260603-1319.json`.
  The top-level result remains `ok:false`, `acceptanceSatisfied:false`,
  `blocker:"speaker_room_admission_required"`, `blockerSource:"synthetic_speaker"`.
  The synthetic speaker reached a Meet `cannot_join_meeting` screen rather than
  a local profile/isolation error; the artifact records
  `speakerCannotJoin:true`, `hostAdmissionRequired:true`, main and speaker
  `profileMode:"persistent"`, and bot-ready signals (`bridgeConnected:true`,
  `dataChannelOpen:true`, `currentRealtimeInputSource:"recappi_process_audio_tap"`).
  The app-control child in the same artifact passed with
  `acceptanceSatisfied:true` for both keyboard and pointer cases. It records
  Realtime SDK connected, `kwwk_computer_use` function output delivery,
  OpenRouter/Gemini model-first plans (`modelUsed:true`, actual model
  `google/gemini-3.5-flash-20260519`), verification `passed`, native foreground
  cursor evidence with Cueboard Bezier plan, shared-surface `cursor.click`, and
  HUD `noisySpeechOrConnectionVisible:false`. The final integrated gate remains
  open only because this Meet room/profile combination cannot admit the
  synthetic speaker, so voice input, interruption, and English spoken response
  cannot be proven in the real-room artifact.
- 2026-06-03: the same cloned persistent speaker profile was tried against the
  earlier user-provided Meet room `https://meet.google.com/ypw-fozb-anz`:
  `/tmp/oneesama-realtime-live-sidecar-ypw-fozb-anz-speaker-clone-rfc-20260603-1328.json`.
  It produced the same top-level
  `blocker:"speaker_room_admission_required"` and
  `blockerSource:"synthetic_speaker"` with `speakerCannotJoin:true`,
  `speakerSignInRequired:false`, and bot-ready signals present. Its app-control
  child also passed with `acceptanceSatisfied:true`, `kwwk_computer_use`
  function output delivery, OpenRouter/Gemini `modelUsed:true`, verification
  `passed`, native foreground cursor evidence, shared-surface `cursor.click`,
  and quiet HUD. This cross-check narrows the remaining final-gate issue to
  Meet room/profile admission rather than a specific `yza-vjpx-qto` room,
  KWWK CU, or local profile setup.
- 2026-06-03: `acceptance:realtime-live-sidecar:preflight` now writes an
  explicit `admissionPreconditions` object with
  `roomAdmissionVerified:false`, so a URL/profile preflight pass cannot be
  mistaken for proof that the Meet room will admit the synthetic speaker. A
  separate host-profile probe using the current persistent main-bot profile
  wrote `/tmp/oneesama-meet-host-profile-probe-2026-06-03.json` with
  `ok:false`, `blocker:"host_profile_sign_in_required"`,
  `signInRequired:true`, and `canCreateMeetRoom:false` after
  `https://meet.google.com/new` redirected to `accounts.google.com`. The final
  integrated sidecar gate therefore still needs either a host/invited
  authenticated profile or a room that admits the configured synthetic speaker.
  Focused validation passed:
  `vp test run test/realtime-real-meet-app-control-benchmark.test.mjs` (37/37),
  `npm run acceptance:realtime-live-sidecar:preflight` with the cloned
  persistent speaker profile, and `git diff --check`.
- 2026-06-03: the real Meet app-control suite was instrumented to preserve live
  model-first latency evidence. Future suite artifacts include per-case
  `final.appControl.timing` and a top-level `liveModelFirstLatency` summary
  with warm p95, SLO, measured sample count, missing timing count, and per-case
  samples. Focused validation passed:
  `vp test run test/realtime-real-meet-app-control-benchmark.test.mjs` (39/39),
  an ad-hoc module probe for null-safe timing extraction, and
  `git diff --check`. This closes the reporting gap; the live latency gate still
  needs a real suite rerun with measured samples before it can be checked off.
- 2026-06-03: the live latency gate was rerun and now passes after the KWWK
  executor pre-observes visual/pointer instructions before the first model call
  and avoids same-snapshot `observedReplan`. The same slice increased KWWK
  helper build prewarm to a 30s cold-start budget and removed the action-timeout
  cap from prewarm. Validation passed:
  `vp test run test/app-control-helper.test.mjs` (26/26),
  `go test ./internal/meetingagent -run 'TestKWWKStdioAppControlBackendPrewarm|TestJoinPrewarmsKWWKComputerUse|TestJoinKeepsKWWKComputerUseWarmDuringActiveRealtimeSession' -count=1`,
  `vp test run test/realtime-real-meet-app-control-benchmark.test.mjs` (39/39),
  `npm run typecheck`, `go build -o ./oneesama ./cmd/oneesama`, and
  `git diff --check`. After rebuilding/restarting meeting-agent, the real Meet
  suite wrote `/tmp/oneesama-realtime-real-app-control-suite-latest.json` with
  `ok:true`, `acceptanceSatisfied:true`, `liveModelFirstLatency.ok:true`,
  warm p95 `2440ms` <= `2500ms`, measured samples `2`, and no missing timing.
  The keyboard sample recorded `toolReceiveToVerifiedActionMs:2207` and model
  planner `2023ms`; the pointer sample recorded
  `toolReceiveToVerifiedActionMs:2440`, model planner `1672ms`, `observeMs:138`,
  `executeMs:536`, `verifyMs:91`, planner `preObservedBeforePlanning:true`,
  no `observedReplan`, native foreground cursor `evidenceMode:"native_ns_panel"`,
  Cueboard Bezier `turnBound.passed:true`, and shared-surface `cursor.click`.
- 2026-06-04: meet-free synthetic-Realtime share gate is now the first
  integration gate before real-room admission. The gate uses a local Meet
  fixture but still requires real synthetic-speaker WAV audio, real Realtime
  speech start/response, real share/app tool telemetry, and no text-turn
  fallback. Validation passed:
  `npm run benchmark:realtime-synthetic-share -- --timeout-ms 90000` with 3/3
  iterations, `acceptanceSatisfied:true`, `expectedToolCalled:true`, and real
  `share_existing_app_window` calls. The fixture loops the short default
  command so Realtime warm-up cannot consume the only spoken turn.
- 2026-06-04: strict sidecar acceptance gained an auto-room path:
  `npm run acceptance:realtime-live-sidecar:auto-room` creates a temporary
  Google Calendar Meet event and records cleanup evidence, while
  `:auto-room:preflight` validates Calendar OAuth and admission/profile wiring
  without creating an event. Validation passed for the new implementation with
  `vp test run test/real-meet-calendar-room.test.mjs test/real-meet-host-admission-helper.test.mjs test/realtime-real-meet-app-control-benchmark.test.mjs`
  (52/52) and `npm run typecheck`. With
  `MAB_WORKSPACE_TOOLS_ENV_FILE=/Users/pengx17/Documents/cueboard/agent-framework/deploy/docker/slack-agentd.env`,
  the stricter auto-room preflight now fails fast with
  `calendar_auto_room_admission_path_missing` when Calendar credentials are
  present but no authenticated main/speaker profile or host admission actor is
  configured. Before that stricter preflight was added, the full auto-room run
  created `https://meet.google.com/qcm-tukg-svi`, recorded
  `meetUrlSource:"google-calendar-auto-room"`, then deleted Calendar event
  `qu9ud8gv7muuepljratjs0ogag` with `calendarCleanup.ok:true`; both child gates
  still hit real Google Meet admission. This narrows the remaining blocker to
  authenticated profiles or host admission/invite automation, not KWWK CU,
  Realtime routing, Calendar room creation, or cleanup.

## Resolved Decisions

- Planner/action benchmarks should keep both browser and native macOS fixture
  coverage. Browser fixtures prove tab/window workflows; native macOS fixtures
  prove AX/foreground helper behavior.
- Warm model-first CU after tool receive must meet p95 <= 2500 ms from tool
  receive to verified action.
- Planner model latency is pass/fail for the model-first live gate, with the
  current OpenRouter/Gemini default using provider-specific p95 <= 2500 ms.
  The old 1200 ms target remains an optimization target, not the active hard
  gate.
- Fixture gates may run in ordinary local/CI loops. Provider-specific live
  planner, native macOS, cursor, and real Meet gates remain manual or release
  gates when they require credentials, permissions, or a real room.
