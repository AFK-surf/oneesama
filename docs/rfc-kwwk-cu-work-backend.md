# RFC: kwwk-cu is the work executor (drop the CDP backend)

- Status: Draft (rev 2 — CDP dropped as a redundant reimplementation)
- Date: 2026-06-10
- Owner: Peng Xiao
- Supersedes: decision **D3** in
  [Operator realtime meeting loop RFC](rfc-operator-realtime-meeting-loop.md)
  ("V1 executor = CDP work browser"). D10 (backend-agnostic operation
  protocol) stands — it is exactly what makes this swap clean.
- Related: [ADR 0001](adr/0001-conversation-engine-port.md),
  [realtime implementation audit](realtime-implementation-audit.html)

## Summary

The operator work pipeline has two layers:

1. a **backend-agnostic harness** — typed job schema, intent compiler,
   stepwise planner, record/replay, eval gates (`packages/core/src/work/`
   minus the surface impl). This is the real deliverable (D10's frozen seam);
   it is not tied to any executor.
2. a **CDP work-browser backend** (`work-browser-surface.ts` +
   `lan-operator-work-runtime.ts`) — a reimplementation of computer-use over
   Chrome DevTools.

Layer 2 is **redundant**: `EYHN/kwwk-computer-use-core` already drives the
browser (web content via AX + Chromium activation), native macOS apps, and a
real on-screen cursor — and it is the production/real-screen path aligned
with the Mac-mini-in-Meet vision. So **this RFC drops the CDP backend and
makes kwwk-cu the single work executor**, kept behind the existing
`WorkSurfacePort` so the harness (layer 1) is preserved and simply re-points
onto kwwk-cu.

This reverses D3 (CDP for V1). CDP served its purpose — it stood the harness
up and produced the first green gates fast — but as a standing executor it
duplicates kwwk-cu, so it goes.

## Resolved: what `kwwk-computer-use-core` is (2026-06-10)

Checked the source (`github.com/EYHN/kwwk-computer-use-core`, public):

- **A macOS AX + background-input + screenshot runtime** (README: "driving
  native apps through Accessibility snapshots and background input delivery";
  "does not depend on kwwk, agent frameworks, or AI SDKs"). Element addressing
  is by AX node index (role/title) — the README's own example clicks Chrome's
  _Reload_ via `cu.state(app: "Google Chrome")`.
- **Drives the browser too**: `ChromiumAccessibilityActivation.swift` uses the
  private HIServices symbol `_AXObserverAddNotificationAndCheckRemote` to force
  Chromium to expose its **web** accessibility tree, so it acts on page
  content (not just the toolbar) via AX.
- **Drives the real, visible app**: `BackgroundInputDispatcher` +
  `BackgroundWindowCapture` target/capture a specific window in the background
  (useful against the mirror-trap — control + capture just the work window),
  and `CueboardCursor` + `CueboardColorfulBorder` render a real on-screen
  cursor + window highlight (the "bot's hand").

It is **not** CDP/DOM — web targeting is via AX (role/title), coarser than DOM
selectors, with per-site/activation quirks. That precision gap vs CDP is the
one real risk (see Risks) and must be measured, not assumed.

## What we keep vs drop

| Keep (backend-agnostic harness)                                    | Drop (CDP-specific)                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `work-job.ts`, `work-operations.ts` (verbs already = kwwk-cu's)    | `work-browser-surface.ts` (the CDP `WorkSurfacePort` impl)                 |
| `work-surface.ts` (the port; trim the `cdp_browser` kind)          | `lan-operator-work-runtime.ts` Playwright launch + CDP screencast          |
| `work-executor.ts` (stepwise loop)                                 | web fixture pages (`test/fixtures/work/*.html`) + `work-fixture-server.ts` |
| `work-openai-planner.ts`, `work-planner.ts` (record/replay)        | CDP-bound tests (`work-executor.test.mjs`, `work-scenario-replay` as-is)   |
| `work-intent-compiler.ts` (+ its eval, pure, no browser)           | CDP recordings under `test/fixtures/work/recordings/`                      |
| The Work tab UI (`lan-operator-work-panel-client.ts`) — re-pointed |                                                                            |

The duplication being removed is small (two files); the harness — the part
worth keeping — was never CDP-specific.

## Goals

- G1: kwwk-cu is the **single** work executor, behind `WorkSurfacePort`
  (`kind: "native_ax"`), driving its **low-level primitives** with the
  operator's stepwise planner on top (D-AX-1 below). No change to the job
  schema, executor loop, planner port, or intent compiler.
- G2: One planner, one harness. Record/replay and eval gates re-point onto
  kwwk-cu; the intent-compiler eval is unaffected (already backend-free).
- G3: Deterministic CI without a second real executor — via record/replay +
  a trivial in-memory fake surface (a stub, not a browser) + one live macOS
  fixture gate.
- G4: The Work tab shows kwwk-cu's **real screen capture + real cursor** (not
  a synthesized dot), which is what the meeting shared-screen needs.

## Non-goals

- Replacing the meeting stack's high-level `kwwk.cu.execute` path (stays for
  the Slack/meeting product).
- Cross-platform native control (macOS only; AppKit/AX).
- Keeping CDP as a parallel "test backend" — rejected (the user's call: it
  reads as duplicate implementation). Determinism comes from record/replay +
  an in-memory fake, not a second real engine.

## Design

### The frozen seam (unchanged)

`WorkSurfacePort` stays the contract: `observe()` → `WorkSurfaceObservation`,
`perform(op)` → `WorkOperationResult`, `checkPostCondition(c)`, `close()`.
The CDP impl is deleted; the AX impl is added. Everything above the port is
untouched.

### D-AX-1 — drive primitives, not the high-level instruction (recommended)

Use kwwk-cu's **low-level primitives** (`get-app-state`, `click`,
`type-text`, `set-value`, `press-key`, `scroll`, `drag`) with the operator's
stepwise planner on top — NOT the high-level `kwwk.cu.execute { instruction }`
(which runs kwwk-cu's own internal planner).

- **Why:** one planner, one harness, per-step record/replay and eval. kwwk-cu
  is a true `WorkSurfacePort` executor symmetric with the (now-removed) CDP
  one. Its verb set already matches D10 exactly.
- **Cost:** kwwk-cu's internal planner/verification is bypassed (we keep its
  primitives + real cursor, drop its planner). Acceptable for harness unity;
  the high-level path can return later as an opt-in fast-path gated on its own
  eval (cf. RFC P1.5).

### The adapter: `lan-operator-work-ax-surface.ts`

`createWorkAxSurface(): WorkSurfacePort` that:

1. **Lifecycle.** Spawns the kwwk-cu helper **persistently**
   (`ensureAppControlHelperBinary()`, `--stdio`), `start`s a session, keeps
   stdin open for many newline-framed request/response round-trips, `stop`s on
   `close()`. (Today the meeting path spawns one process per execute and
   closes stdin — persistent multi-request is an M0 spike.)
2. **observe()** → `get-app-state` → map the AX snapshot (focused app, element
   list with indices, role/title/frame) into `WorkSurfaceObservation`: ref id
   = stringified AX element index; outline lists `role "name" [ref=N]` like
   the old CDP snapshot. Screenshot attached when the AX tree is thin.
3. **perform(op)** → map verb (1:1) + `op.target.ref` (AX element index).
   Coordinate ops (drag/scroll) pass through. Result carries kwwk-cu's real
   cursor event(s).
4. **checkPostCondition()** → re-observe + match outline / focused-app text
   (`text_present`, `element_present`; `url_includes` is N/A for native,
   validate at job-build time).

Ref-space difference (AX index vs the old DOM `eN`) is invisible to the
planner — it only references refs from the current observation.

### Deterministic testing without CDP

- **Record/replay** (was D9 gate 1) is backend-agnostic and survives: recorded
  primitive plans replay with no executor at all.
- **Unit determinism**: a ~tens-of-lines **in-memory fake `WorkSurfacePort`**
  (canned observations + scripted results) unit-tests the executor/planner
  loop. This is a test double of the port, not a second computer-use engine —
  not the duplication being removed.
- **One live macOS gate**: run a real kwwk-cu scenario against a committed
  fixture target (open question: tiny in-repo SwiftUI app vs scripted
  TextEdit/Notes vs real Chrome + fixture page via AX). macOS-only runner.

### Work tab

The Work tab stays; its frame source changes from CDP screencast to kwwk-cu's
screen/window capture, and the cursor is kwwk-cu's real cursor (drop the
drawn-dot overlay). `work_run` / `work_event` / `work_frame` wire-protocol is
unchanged.

## M0 findings (2026-06-10, partial — probed the built helper live)

Probed the already-built helper binary
(`/tmp/oneesama-app-control-helper-swiftpm/release/OneesamaAppControlHelper`,
Swift 6.3.2) on this machine. Concrete results:

- **Builds + runs**: control/`ping` and `list_apps`/`state` (overview) respond.
  No build wall.
- **Accessibility is granted** (`accessibilityTrusted: true`) — the TCC
  Accessibility wall I expected is already cleared here (from the 6/6 meeting
  work).
- **But `state` cannot resolve the target window** even with
  `target.process_id` of a live, focused Chrome (`window found: false`,
  no `accessibility` payload). `findWindow` uses ScreenCaptureKit; this points
  to **Screen Recording TCC not granted** (distinct from Accessibility) — the
  observation/screenshot path needs it and it is missing.
- **Two observation paths, and the low-level one is the weak one.** The
  low-level `state` JSON-RPC method (`kwwk-cu-observation.swift`) is a raw
  `AXUIElementCreateApplication` walk that does **not** invoke
  `ChromiumAccessibilityActivation` — so it would not expose Chrome **web**
  content even with the window resolved. The rich web-AX path
  (with Chromium activation) lives in the external `KWWKComputerUseCore`
  `ComputerUseClient.state(app:)`, reached via the core operation path
  (`kwwk-cu-core.swift` `seed`/`executeKWWKCUCoreOperation`), **not** the
  low-level `state` method.

**Two design consequences for this RFC:**

1. The AX adapter's `observe()` must route through the **core client path**
   (`client.state(app:)`, which activates Chromium AX), not the low-level
   `state` method — otherwise web content is invisible. This refines D-AX-1:
   we drive low-level primitives for _actions_, but observation goes through
   the core client.
2. **Screen Recording TCC must be granted** to the helper's launch context
   (in addition to Accessibility) before any observation works. This is a
   hard, user-granted prerequisite — added to M0.

The remaining M0 measurement (family-A web-AX precision) needs Screen
Recording granted **and** live input on the real desktop (synthetic
clicks/typing move the real cursor) — a deliberate, supervised run, not a
headless one.

## Migration sequence (and the honest cost)

The current green gates (live fixture 50/50, replay 100%) are **CDP-derived**;
they do **not** transfer. The plan re-establishes them on kwwk-cu before
deleting CDP, so we are never left with nothing green:

| Order | Step                                                                                                                                 | Note                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 1     | **M0** spikes: persistent stdio; `get-app-state` ref shape; build/codesign + TCC perms; **measure AX browser precision** on family A | the precision spike gates everything  |
| 2     | **AX1** `createWorkAxSurface` + in-memory fake surface; re-green executor/replay unit gates                                          | no real machine needed for unit gates |
| 3     | **AX2** one live macOS fixture scenario green; record baseline                                                                       | re-establishes a live gate            |
| 4     | **AX3** re-point Work tab + eval scripts onto kwwk-cu; remove the OpenAI-planner→CDP wiring                                          |                                       |
| 5     | **AX4** delete `work-browser-surface.ts`, `lan-operator-work-runtime.ts`, web fixtures/recordings; trim `cdp_browser` from the port  | the actual CDP removal, last          |

Until step 5, CDP code stays on disk but is no longer the plan or the product
path. If you prefer, step 5 can move to the front (delete now, go dark on
gates until AX1–3 land) — I recommend last so the harness stays demonstrably
green throughout.

## Risks

- **AX browser precision unproven** — web targeting via AX (role/title) is
  coarser than CDP DOM and varies by site/activation. M0 must measure family A
  through kwwk-cu before we commit; if precision is poor, we revisit (e.g.
  keep a headless fixture path strictly for CI, or invest in kwwk-cu's web AX).
- **macOS-only CI** — the live AX gate runs only on macOS runners; the
  always-on cross-platform floor shrinks to record/replay + the in-memory fake
  (both OS-agnostic).
- **TCC permissions** — Accessibility + Screen Recording must be granted to
  the helper's launch context (signed bundle vs bare binary); headless/CI
  needs pre-granted TCC or it silently no-ops.
- **External dep on the hot path** — `kwwk-computer-use-core` build/codesign
  now sits in the operator loop (already handled by `app-control-helper.ts`).
- **Capability loss (D-AX-1)** — driving primitives bypasses kwwk-cu's own
  planner/verification; revisit β (high-level instruction) as an opt-in if its
  internal loop proves materially better on native apps.

## Open questions

1. AX browser precision on family A vs CDP — the deciding measurement (M0).
2. Live AX gate fixture: in-repo SwiftUI app, scripted TextEdit/Notes, or real
   Chrome + committed fixture page?
3. macOS TCC for the operator (Node) launch context — bare binary or signed
   bundle?
4. Delete CDP now or after AX1–3 (recommend after).
