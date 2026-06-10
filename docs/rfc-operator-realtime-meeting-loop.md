# RFC: Operator-Driven Realtime Meeting Loop

- Status: In implementation (rev 5 — M0 + MW shipped with all four D9 gates
  green; meeting-loop milestones M1/M3/M2/M4 remain)
- Date: 2026-06-10
- Owner: Peng Xiao
- Related: [ADR 0001 (conversation engine port)](adr/0001-conversation-engine-port.md),
  [ADR 0002 (operator-side visual composition)](adr/0002-operator-side-visual-composition.md),
  [Meet contract matrix](meet-contract-matrix.md), [OSS RFC](oss-rfc.md)

## Summary

Connect the **Local Operator Surface** (the fast-iteration web cockpit:
realtime conversation engine, kwwk computer-use visualization, operator-side
canvas composition) to the **existing Google Meet runtime** (Playwright joiner,
fake mic/cam injection, participant-audio seam), so that one operator can run
a real meeting where the bot:

1. performs precise, verified kwwk computer-use actions on the shared
   surface — the actual job of the realtime stack,
2. shows the operator-composed picture (host app + avatar + kwwk cursor) as
   its Meet camera, so the work is witnessed,
3. speaks short acks/status into the meeting with the assistant's realtime
   audio,
4. hears meeting participants through the realtime engine, so the room can
   direct the work.

**Product positioning (decided 2026-06-10): realtime exists to make the bot
do work, as precisely as possible.** Voice is the command-and-status
channel; conversational presence is secondary. The design therefore routes
every action through typed, verified jobs (see the precision section)
instead of trusting the voice model to decide to act — and the first
deliverable of the work pipeline is the **iteration harness** (P0), not a
prompt: getting the prompt right is not the project; being able to iterate
in a measurably right direction is.

The operator surface stays the single iteration cockpit; the Meet page becomes
a thin media endpoint with **no model connection of its own**.

**Before implementing anything, read the two sections below**: the verified
hazards (each one was confirmed against the code, several invalidate the
"obvious" implementation), and the precision-first section on tool recall
and computer-use success rate (the two problems that actually hurt in
practice).

## Vision: the Mac mini entity

The end state (stated 2026-06-10): **oneesama is a physical colleague — a
dedicated Mac mini** that joins Google Meet as a participant. Its camera is
its avatar; its shared screen is its own working surface; its Cueboard
cursor is its hand; its voice is realtime audio; its ears are the room. The
web operator surface is NOT the product — it is the fast-iteration cockpit
for developing this entity. In the end state the room directs the work; the
cockpit directs it during development (so M2's late sequencing is about
iteration order, not product priority).

Appliance-level risks to design around (vision-level, not code-verified):

- **Mirror trap.** The mini's desktop hosts the Meet browser, the cockpit,
  and the work surface. Sharing the whole desktop captures Meet itself
  (infinite mirror) and leaks infrastructure. The shared surface must be a
  dedicated work display/Space or a composed canvas — never the raw main
  desktop.
- **CU workspace isolation.** The executor operates the same machine that
  runs the meeting. Hard rule, enforced in the executor (not the prompt):
  it may only act inside its work surface (V1: the work browser); Meet
  windows, the cockpit, and system UI are out of bounds. One stray click on
  the Meet window is public self-harm.
- **Appliance compositor (end state).** On the mini, the compositor runs in
  a managed browser we launch (Playwright, with
  `--disable-background-timer-throttling --disable-renderer-backgrounding`),
  which structurally resolves H5; the cockpit becomes a remote
  viewer/controller. During MW/M1 development the cockpit page remains the
  compositor (fastest iteration).

## Decisions (2026-06-10 grill)

| #   | Decision                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Vision: Mac mini physical entity operated through Google Meet; web surface = iteration cockpit.                                                                                                           |
| D2  | Demo content lives in a browser; readable content goes out via Meet screen share (camera stays avatar — the repo already rejected text-in-camera).                                                        |
| D3  | V1 executor backend = CDP-driven work browser; kwwk-cu's native AX backend benched for V1 (returns for native apps).                                                                                      |
| D4  | LLM planner in the execute path from day 1; mandatory record/replay at the LLM boundary (replay = deterministic CI gate; live = prompt/model eval).                                                       |
| D5  | Stepwise planner loop (observe → decide → execute → verify per step); per-step latency is a tracked harness number.                                                                                       |
| D6  | Flagship scenario family A: research + open + highlight + verbal summary (read-only). Intent Card is display-only for read-only tasks; blocking confirm reserved for write actions (family B later).      |
| D7  | OpenAI primary (realtime voice, planner, compiler fallback); Gemini kept as harness A/B. H2 verification targets OpenAI first.                                                                            |
| D8  | Hybrid content sourcing: evals run on committed local fixture pages only; live demos use DuckDuckGo/site-specific search; real Google excluded from V1.                                                   |
| D9  | MW done-bar: replay-CI 100 %; intent-compile ≥95 % exact-match with zero distractor false-triggers; fixture execution ≥90 % over 10 runs/scenario with step-latency p50 ≤2.5 s recorded; e2e voice ≥8/10. |
| D10 | Operation protocol is backend-agnostic — kwwk-cu's verb set is the shared contract (CDP backend #1, AX backend #2); five technical defaults recorded in Detailed design → MW.                             |

## Implementation status (2026-06-10)

**M0 — DONE.** Snapshot-merge fix (inspector test green), access-token gating
on all WS upgrades + HTTP routes (H9; `MAB_LAN_OPERATOR_TOKEN`), Meet CSP
spike recorded in H6 (ws://localhost works from the Meet page — same-machine
appliance can skip the CDP relay), provider sample rates verified (H2
refuted), and the H11 connect-thrash fix landed the same day. The realtime
session now declares `audio/pcm@24000` in/out, enables input transcription
(`gpt-4o-mini-transcribe` — feeds the intent compiler), and the voice client
captures at 24 kHz: H2 hygiene closed.

**MW — DONE; all four D9 gates green (numbers from 2026-06-10):**

| Gate                      | Required             | Achieved                            |
| ------------------------- | -------------------- | ----------------------------------- |
| 1. Replay CI (plumbing)   | 100 %                | 100 % (`test/work-scenario-replay`) |
| 2. Intent compile         | ≥95 %, 0 false-trig. | 100 % recall, 0/20 false-triggers   |
| 3. Live fixture execution | ≥90 % over 10 runs   | **100 % (50/50)**, step p50 2284 ms |
| 4. End-to-end voice       | ≥8/10                | **10/10**, ~15–19 s per task        |

The work pipeline lives in `packages/core/src/work/` (typed job → stepwise
OpenAI planner with record/replay → executor backend with workspace
isolation → verified post-conditions). The executor backend was since
switched from the CDP work browser to **kwwk-cu native AX** — see
[the kwwk-cu work-backend RFC](rfc-kwwk-cu-work-backend.md); evals are now
`vp run eval:work-intent | eval:work-e2e-voice | work:ax-live`. Gate 4 exercises the full loop —
spoken command → realtime transcription → intent compiler → live planner
in the work browser → verified done → extracted passage spoken back as
assistant audio — via the harness (synthetic 24 kHz utterances), without
the cockpit UI.

**MW-UI — DONE (web-UI acceptance).** The `/operator` surface has a **Work**
tab: type a command → the operator server compiles intent, runs the stepwise
planner in a server-side headless work browser (self-contained committed
fixture site by default; `MAB_LAN_OPERATOR_WORK_BASE_URL` to point
elsewhere), and streams the browser screencast + Intent Card + per-step log +
verified result back into the page over the events WS (`work_run` →
`work_event`/`work_frame`). Verified end-to-end by driving `/operator` with
Playwright: typed command → 6 steps → frames rendered → status `done`,
post-condition `text_present:Fixture` met, spoken-summary text shown.
`window.MAB_LAN_OPERATOR_SURFACE.runWork(command)` is the test hook.

**Remaining:** voice→Work wiring in the page (today the transcript→intent
path is proven in the e2e harness; the Work tab takes typed input — add the
mic-transcript feed), work frames onto the main composition canvas (vs the
Work-tab preview) as the future Meet shared screen, and the meeting-loop
milestones M1 (video out, needs H7 link addressing), M3 (audio out), M2
(audio in), M4 (meet-loop acceptance).

## Read this first: verified hazards

Each item: what breaks, the code evidence, and the required change. These are
not hypotheticals — H1–H4 and H6–H9 were verified by reading the current
code, and H2/H11 were tested against the live OpenAI endpoint on 2026-06-10
(H2 refuted, H11 confirmed and fixed).

### H1 — The operator stack registers NO tools with either provider

`createDefaultConversationEngine()` constructs both transports with zero
options (`lan-operator-surface.ts:170-180`):
`createOpenAIRealtimeWebSocketTransport()` /
`createGeminiLiveWebSocketTransport()`. The OpenAI `session.update` carries
only `type: "realtime"` + instructions (`defaultSessionUpdate`,
`lan-operator-openai-realtime-adapter.ts:617-631`); the Gemini setup only
includes tools when `options.tools` is passed
(`lan-operator-gemini-live-adapter.ts:613`) — and nothing ever passes it.

**Consequence:** the model cannot call `kwwk_computer_use` in this stack at
all. The instructions even say "use tools" — there are none. All the
tool-routing/canonical plumbing downstream is exercised only by fixtures.
Any plan that says "the model will drive kwwk in the meeting" silently
no-ops until tool registration is plumbed through engine construction
(`options.session.tools` for OpenAI — the `...session` spread is the hook;
`options.tools` for Gemini), AND paired with an executor presence check
(register tools only when a kwwk executor is actually connected, otherwise
the model calls into a void and the turn hangs until timeout). With the
intent-compiler path (P1) as primary, this hazard stops blocking the work
pipeline — it gates only the optional model-initiated fast path.

### H2 — The audio sample-rate convention is undeclared and likely wrong

The voice client captures at the device rate — `new AudioContextImpl()` with
no `sampleRate` option (`lan-operator-voice-client.ts:144`), i.e. 48 kHz or
44.1 kHz — and ships raw PCM16. The OpenAI adapter appends it verbatim
(`input_audio_buffer.append`) and the session declares **no audio format**;
OpenAI's documented pcm16 format is **24 kHz** mono. The Gemini adapter
declares `audio/pcm;rate=<deviceRate>` while Gemini Live documents **16 kHz**
input.

**Consequence:** with a real OpenAI key, mic audio is most likely interpreted
time-stretched (~2× slow); Gemini behavior depends on whether the declared
rate is honored. Everything to date has effectively been validated on the
diagnostic/mock engine. **Do not build the meeting audio path on top of this
convention before verifying it against real provider keys** (one short
recorded utterance + check the transcript). Fix at one place: capture at
`new AudioContext({ sampleRate: 24000 })` (Chromium resamples internally) or
resample in the client worklet, and declare the format explicitly in the
session config.

**M0 verification result (2026-06-10): REFUTED for OpenAI.** Streaming a
known utterance as 24 kHz and as raw 48 kHz PCM16 both transcribed exactly
("purple elephant seventy-seven" / "green tiger 42") on `gpt-realtime-2`
over a warm connection — the endpoint tolerates undeclared device rates.
Downgraded from blocker to hygiene: still declare the format (the 48 kHz
run double-triggered server VAD, `speech_started`×2), and keep
`eval:transcription` as the permanent guard. The real voice blocker was
H11.

### H3 — The server assumes exactly ONE active voice stream

`handleVoiceMessage` keeps a single global `debug.voice.activeStreamId` and
rejects any chunk whose `voiceStreamId` differs as stale
(`lan-operator-surface.ts:1394-1408`), and keeps one global
`lastSequence`/drop counter.

**Consequence:** a second uplink (meeting participant audio) on the voice WS
gets all of its chunks rejected — or, if it wins the stream slot, kills the
operator mic. M2 requires a per-source stream registry (keyed by `source`)
or a separate channel. Telemetry must also become per-source or it reports
garbage.

### H4 — There is no mixer; two PCM sources cannot both feed the engine

`receiveVoiceChunk` appends each chunk serially into the provider's single
input buffer (OpenAI `input_audio_buffer.append` / Gemini `realtimeInput`).
Interleaving chunks from two independent streams (operator mic + meeting
audio) does not mix them — it corrupts the audio timeline.

**Consequence:** `meet_input_mode: "both"` requires a real server-side mixer
(align rates, sum samples, clip) that does not exist. The MVP must be
**switch-based** (`participants_only` ⇄ `operator_only`, exclusive); the
mixer is explicitly post-MVP.

### H5 — Browser background throttling freezes the composed camera

The composition is driven by `requestAnimationFrame` in the operator tab and
`canvas.captureStream(30)` only emits frames when the canvas repaints. Chrome
**pauses rAF entirely** when the tab is hidden or the window is fully
occluded, and clamps background timers to ≥1 Hz (the page's open WebRTC
connections only exempt it from the harsher 1/min tier). AudioWorklet/
AudioContext processing is NOT throttled.

**Consequence:** the moment the operator switches tabs or fully covers the
window, the bot's Meet camera freezes on the last frame (audio keeps
working). Fixture tests will pass (tab visible) and real meetings will break.
Mitigations, in order of cost: (a) operational — keep the cockpit visible
(own window, second display); (b) detect-and-surface — a freshness watchdog
(compare `compositionLastFrameEpochMs` against wall clock) that shows a
"composition stalled" banner and pushes a placeholder slate; (c) structural —
move composition to a Worker (`OffscreenCanvas` + WebCodecs `VideoFrame` →
`MediaStreamTrackGenerator`, Chromium-only, which this stack already is).
Ship (b) with M1; consider (c) only if (a) proves operationally annoying.

### H6 — The Meet page cannot WebSocket back to the operator server

`meet.google.com` is HTTPS: a `ws://<lan-ip>:18913` connection from page
context is blocked as mixed content (only `localhost` is exempt), and Meet's
CSP `connect-src` would likely block even a secure cross-origin socket.
This is presumably why the existing realtime bridge has a **sidecar**
placement: a separate Playwright page plus Node-side CDP relays —
`page.exposeFunction("MAB_HOST_ENQUEUE_REALTIME_PCM", ...)` →
`meetPage.evaluate(...)` → `MAB_AVATAR_AUDIO_BUS.enqueuePcmFrames(chunk)`
(`google-meet-joiner-realtime-sidecar.ts:23-78`), and
`MAB_HOST_RUN_SURFACE_TOOL` for tool execution.

**Consequence:** the meet media bridge must split planes: **control,
signaling, and audio ride CDP through the meeting-agent Node process**
(which talks to the operator server over normal WS — Node has no CSP);
**video rides RTCPeerConnection created inside the Meet page**, which CSP's
`connect-src` does not govern (WebRTC has a separate, rarely-used directive).
Verify Meet's actual CSP behavior empirically in the M0 spike before
committing to in-page WebRTC; the fallback is relaying video frames through
the sidecar, which is expensive and should be a last resort.

**M0 spike result (2026-06-10).** Header inspection of `meet.google.com`:
CSP enforces `require-trusted-types-for 'script'` + nonce/strict-dynamic
`script-src`, but declares **no `connect-src` and no `webrtc` directive** —
WS/fetch targets and RTCPeerConnection are CSP-unrestricted. Live page
probe (headless Chromium; unauthenticated, so it landed on the
workspace.google.com marketing page — in-meeting CSP still needs a
logged-in confirmation): `new RTCPeerConnection()` + offer ✅;
`ws://127.0.0.1:<port>/operator/events/ws` **connected successfully to a
real operator server** ✅; `ws://<LAN-IP>` throws `SecurityError` (mixed
content, browser-level and page-independent) ❌; external `wss://` ✅.
Net effect: **on the appliance (meeting agent and operator server on the
same machine) the Meet page can talk to the operator server directly over
`ws://localhost` — the CDP relay plane is only required for cross-machine
deployments.** Trusted Types remains a real constraint for injected code
touching DOM sinks (use textContent/element building, or a TT policy).

### H7 — `relayVisualSignal` routing is a hardcoded two-kind broadcast

The relay computes the target as the _other_ kind of a fixed pair:
`client.kind === "visual_host" ? "visual_operator" : "visual_host"` and
broadcasts to **all** clients of that kind
(`lan-operator-surface.ts:1521-1526`).

**Consequence:** adding a `visual_meet` kind naively cross-wires it with the
avatar loopback (the avatar publisher iframe is a `visual_host` client; its
offers would also land on the meet bridge, and vice versa). The relay needs
explicit link addressing first — e.g. `linkId`/`targetKind` in the signal
payload, or per-link channels — before any new peer kind is added.

### H8 — You cannot `replaceTrack` on Meet's senders

Meet's page owns its `RTCRtpSender`s; injected code has no sane handle on
them. The working pattern (already used by the avatar inject) is a
**bridge-owned relay track installed at init-script time**: create the fake
camera track (relay canvas or `MediaStreamTrackGenerator`) before Meet ever
calls `getUserMedia` (`installMediaDeviceOverride`,
`hiyori-avatar-inject.ts:954`), then switch what is _drawn/written into it_
(placeholder slate → operator frames) when the WebRTC track arrives.

**Consequence:** track identity stays stable across operator
connect/disconnect/reconnect for free; no renegotiation; no sender access
needed. Any design that says "swap the track later" is wrong in this
codebase.

### H9 — The operator server is an unauthenticated LAN control plane

There is no token/auth anywhere in `lan-operator-surface.ts`, and the
default bind is `0.0.0.0:18913`. Today that is a local debug surface; once
M1–M3 land it is **remote control of a meeting participant**: anyone on the
LAN can send `engine_control`/`operator_text_input` (make the bot speak in
the meeting), or register as a visual publisher (hijack the camera).

**Consequence:** a join-scoped bearer token (issued by the meeting agent,
checked on every WS upgrade and control HTTP route) is a **hard requirement
before any real-meeting use**, not an open question. Fixture-only work may
proceed without it.

### H10 — Canonical-event broadcast ships a full debug clone per event

Every `canonical_conversation_event` (including each ~50 ms
`assistant_audio_chunk`) is broadcast to every events client with a complete
`cloneDebugState(debug)` attached (`lan-operator-surface.ts:679-687`).

**Consequence:** adding the meeting agent as one more subscriber multiplies
an already heavy serialization path; at audio-chunk rate this is the main
server CPU driver. Add a **lean subscription mode** (e.g.
`/operator/events/ws?lean=1`: events only, no debug payload) and use it for
the meet bridge; consider it for the cockpit too.

### H11 — Concurrent auto-connect thrash killed every live voice session (FOUND + FIXED 2026-06-10)

The engine auto-connects on every voice chunk, and the server forwards up to
32 chunks concurrently. `connect()` had no single-flight guard: it only
short-circuited on an OPEN socket and otherwise closed the CONNECTING one
(`closeSocket("operator_reconnect")`) — so under streaming, every chunk's
connect attempt killed the previous pending handshake and the connection
**never** established ("WebSocket was closed before the connection was
established" per chunk). **This — not sample rate — is why realtime voice
never worked outside mock.**

Verified by the M0 experiment: 274 errors while streaming; the connection
succeeded the instant streaming stopped. Fixed with a shared in-flight
connect promise in both adapters (`lan-operator-openai-realtime-adapter.ts`,
`lan-operator-gemini-live-adapter.ts`); post-fix the auto-connect path runs
0 errors with exact transcription, both direct and through `https_proxy`
(the suspected proxy-tunnel failure was this same bug). Residual minor
issues: the queued waiters each emit a cosmetic duplicate `engine_connected`
(×32), and audio arriving during the connect window can exceed the
32-in-flight forward limit and get dropped — the real mic flow avoids the
loss because arming the mic triggers connect before speech starts.

## Precision first: tool recall and computer-use success rate

**The product decision: realtime exists to make the bot do work, as
precisely as possible.** Field experience (prior sessions on the
realtime-bridge stack) says the two things that actually hurt are: **(P1)
the realtime model often fails to call the control tool when it should**
("tool recall"), and **(P2) when computer use does run, its success rate is
poor**. The meeting loop multiplies both (an audience is watching). The
architecture answer, borrowed from the HeyCodex spike (private repo,
`docs/koupen-programming.html` there): **a deliberately thin realtime voice
layer in front of a strong explicit state machine** — the voice model is
not trusted to remember to act; the system compiles intent into typed jobs.

And the way to get there is **not prompt-craft**. Prompts, grammars, and
even providers are consumables; what guarantees iteration moves in the
right direction is the harness around them (P0). Build the harness first;
then every prompt/model/grammar change is a measured step instead of a
vibe.

### P0 — The iteration harness is the deliverable; prompts are consumables

1. **A frozen seam in the middle.** The typed kwwk job schema (P1.3) is the
   stable contract; everything upstream (transcription, compiler) and
   downstream (executor, verifier) iterates independently against it.
   Version it like the existing `oneesama.*.v1` schemas.
2. **Every layer gets a dataset and a number.**
   - transcription: recorded utterances → transcript accuracy, per provider
     (this is also the H2 verification, kept as a permanent eval);
   - compilation: transcript + surface context → expected typed job;
     exact-match precision/recall, distractors included (a false action is
     worse than a miss for a precision product);
   - execution: typed job → verified outcome; success % over N runs per
     fixture scenario, with phase timings;
   - end-to-end: utterance audio → verified outcome.
3. **Live failures become test cases mechanically.** The surface already
   exports debug reports/artifacts with transcripts, tool routing, kwwk
   phase evidence; add "save this turn as a case" (one cockpit click / one
   CLI command over a report JSON) that appends utterance + context +
   expected job to the corpus. The corpus grows from reality, not
   imagination — this flywheel is what points iteration in the right
   direction.
4. **Replay offline.** Recorded utterances replay against a new compiler
   without re-speaking; recorded jobs replay against fixture apps without a
   model. The mock engine and `sendSyntheticVoiceChunk` plumbing already
   exist; extend them to full trace replay.
5. **Numbers over time, gated.** Every eval run writes a JSON artifact
   (same `/tmp/*-latest.json` convention as today's acceptance evidence)
   plus an append-only history file; CI gates on no-regression exactly like
   the existing smoke/contract gates. A change that moves no number is a
   refactor; a change that moves one down does not land.

This extends the philosophy the repo already applies to Meet (contract
matrix + smoke evidence) into the model-quality loop.

### P1 — Tool recall: compile intent into jobs; don't bet on the model

The primary action path does not depend on realtime tool-calling at all.

1. **Deterministic operator paths.** Cockpit buttons and slash-style text
   commands (`/kwwk click …`) go straight to the kwwk job queue — model
   discretion is never in the loop for operator-initiated actions. (HeyCodex
   lesson: explicit command grammar — `new/steer/interrupt/approve/...` —
   mapped to tool routes, not re-derived per utterance.)
2. **Intent compiler on final transcripts.** The server watches
   `transcript_completed` canonical events. A grammar/keyword pass catches
   the common command verbs; anything ambiguous goes to a **non-realtime
   reasoning model** (one ordinary completion call — OpenAI fast tier per
   D7 — with transcript + surface context) whose only allowed output is a
   typed kwwk job or `not_a_command`. The realtime model keeps doing what it is good at —
   low-latency transcription and short verbal acks — and the compilation
   step is deterministic enough to test offline.
3. **Typed jobs, not free-form arguments.** A kwwk job schema with validated
   fields: target app/source, action primitive, element descriptor, payload
   text, post-conditions. If a field cannot be filled unambiguously from the
   utterance, the system **asks back instead of guessing** — for this
   product, precision beats latency.
4. **Intent Card + target preview before execution** (HeyCodex pattern):
   the cockpit shows "I understood: click _Save_ in _App X_" with one-tap
   confirm/cancel, and the composed canvas highlights the resolved target
   using the cursor's existing `target` kind (purple ring) — everyone in
   the meeting sees what is about to be acted on. Auto-confirm whitelisted
   low-risk actions; require confirm for destructive ones.
5. **Realtime tool-calling demotes to an optional accelerator.** With the
   compiler as the primary path, H1 stops blocking the work pipeline; tool
   registration is only needed for a model-initiated fast path, and only
   ships if `eval:tool-recall` proves it adds value over the compiler.
6. **Measure compilation in the harness (P0.2).** `eval:intent-compile` —
   seed corpus of scripted phrasings + harvested real failures (P0.3) →
   expected typed job; exact-match precision/recall. No prompt, grammar, or
   provider change lands without it. Numbers survive handoffs; prompt
   anecdotes do not.

### P2 — CU success rate: grounding + verify-retry, not model heroics

1. **The contract is "exactly what was asked, verified — or a clean
   blocker".** Every typed job carries post-conditions derived from its own
   fields ("dialog closed", "text present in field X"); `done` is reported
   only after verification passes. Anything else surfaces a blocker with
   evidence (element state, frame grab, cursor trail). A silent best-effort
   click is the worst outcome and is designed out.
2. **Structural grounding, two backends, one protocol (D3/D10).** The V1
   executor is a CDP-driven work browser (Playwright — already in-repo
   infrastructure): operations target elements via stable refs from the
   page's accessibility snapshot, never raw pixels. The operation verbs
   reuse kwwk-cu's existing protocol (`click`, `type-text`, `set-value`,
   `press-key`, `scroll`, `drag`, `get-app-state` —
   `kwwk-cu-protocol.swift:19-35`), so the fully built native AX backend
   (`packages/core/src/meeting/kwwk-cu-*.swift`: planner, observation,
   cursor, verification) slots back in as backend #2 for native apps
   without touching the job schema, planner, or harness.
3. **Stepwise planner loop with record/replay (D4/D5).** Each step:
   observe (accessibility snapshot of the work surface) → LLM decides one
   operation → execute → verify the step's post-condition → re-observe.
   One-shot whole-task plans are rejected (stale-page failure mode). Every
   LLM call is recorded; scenarios re-run in **replay mode** as the
   deterministic CI gate and in **live mode** to score prompts/models.
   Verification is mandatory per step with one bounded retry, then a
   blocker instead of flailing (`lan-operator-kwwk-debug.ts` already models
   phase evidence). Per-step latency is a tracked number (target p50
   ≤2.5 s).
4. **Shrink the action vocabulary.** A handful of reliable primitives
   (click, type, scroll, drag, wait-for) beats a wide flaky surface; plans
   compose primitives that each verify.
5. **Success-rate matrix in the harness (P0.2).** Extend
   `acceptance:realtime-local-kwwk-action` into a scenario matrix (fixture
   apps, scripted goals) and report success % over N runs per scenario,
   with phase timings — flakiness must be visible as a number, not an
   anecdote.
6. **Operator stays in the loop.** Cancel exists (`tool_cancel`); the
   Intent-Card gate (P1.4) fronts destructive actions. In-meeting, a failed
   action with a clean blocker + cursor trail is recoverable theater; a
   silent wrong click is not.

## Context

Two realtime stacks exist today and do not touch:

|           | Local Operator Surface (`packages/core/src/operator/`)                                                 | Meeting runtime (`packages/core/src/meeting/`, `src/realtime/`, `apps/meeting-agent/`)                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brain     | `ConversationEnginePort` + canonical events; OpenAI Realtime / Gemini Live adapters; kwwk tool routing | `realtime-browser-bridge` (OpenAI protocol in-page; mock / webrtc-mock / agents-sdk modes)                                                                                              |
| Video out | 1280×720 composed canvas → `captureStream(30)` → `state.localComposedTrack` — **consumed by nothing**  | Avatar canvas track injected into `getUserMedia` via `installMediaDeviceOverride()` (`avatar/hiyori-avatar-inject.ts:954`)                                                              |
| Audio in  | Operator mic only (PCM16 over `/operator/voice/ws`)                                                    | Participant audio seam: DOM discovery + `meeting-avatar-participant-audio-stream` event → routing gate (`realtime/realtime-browser-bridge-meeting-input.ts:29`, `-audio-routing.ts:12`) |
| Audio out | Assistant PCM16 played locally via WebAudio (`lan-operator-output-client.ts`)                          | Avatar fake mic bus (`hiyori-avatar-audio-bus.ts`); sidecar relays PCM via CDP (`google-meet-joiner-realtime-sidecar.ts`)                                                               |
| kwwk cu   | Tool routing + job state + Cueboard cursor on the composed canvas (fixture-driven today, see H1)       | `MAB_HOST_RUN_SURFACE_TOOL` CDP relay                                                                                                                                                   |

The composed track and the canonical-event engine are stranded in the operator
browser; the Meet runtime has all the media plumbing but its own separate
realtime logic. Closing the loop is mostly **wiring existing seams together**
— but the hazards above show the obvious wiring is wrong in five places, so
the seam inventory matters more than the diagram.

## Goals (work first, meeting presence second)

- G1: Operator intent — voice or text — compiles into a precise, verified
  kwwk action (typed job → target preview → execute → post-condition check).
  This loop must work in the cockpit alone, with no Meet dependency, so it
  can be iterated daily.
- G2: The operator-composed video track is the bot's Meet camera, so the
  work (host app + kwwk cursor) is witnessed live in the meeting.
- G3: Assistant audio reaches the meeting (verbal acks/status for the work);
  participant audio reaches the engine (the room can direct work).
- G4: Every action is cancellable from the cockpit; failures land as clean
  blockers with evidence, never silent wrong clicks.
- G5: The loop is testable against the local Meet fixture without a Google
  account, in line with the existing meet-contract philosophy.

## Non-goals

- A chatty meeting persona: free-form conversation may happen, but it is
  never the optimization target — precise work execution is.
- Replacing or migrating `realtime-browser-bridge`'s agents-sdk mode; it stays
  for the Slack-driven product path.
- Multi-bot or multi-operator scenarios.
- Mixing operator mic and meeting audio into one model input (post-MVP; H4).
- Recording/export of the composed track (future work; the track produced here
  is the natural input for it).
- Zoom/Teams providers.

## Design principles

1. **One brain.** Only the operator server holds a model connection
   (OpenAI Realtime / Gemini Live via the conversation engine). The Meet page
   does media plumbing only. This avoids two concurrent realtime sessions,
   double billing, and split tool-routing state.
2. **Voice compiles to jobs.** The realtime model transcribes and acks;
   intent compilation, tool dispatch, approvals, and verification live in
   explicit server-side state (P1/P2). Precision comes from typed jobs plus
   verification, never from the model "remembering" to act.
3. **Operator-side composition stands** (ADR 0002). The Meet camera shows
   exactly what the operator cockpit composes; layout edits never touch the
   Meet page's track identity.
4. **Reuse existing seams; do not fork them.** Every integration point below
   is an existing function/event with a substitutable track or payload — and
   where the seam resists (H3, H7), fix the seam rather than tunneling around
   it.

## Architecture

Two planes (H6): **CDP plane** for control/signaling/audio (meeting-agent
Node process ↔ Meet page via `exposeFunction`/`evaluate`; meeting-agent ↔
operator server via plain WS), and a **WebRTC plane** for video only
(operator browser → Meet page, P2P on the LAN, CSP-exempt).

```
Operator browser (cockpit)      Operator server (Node)        Meeting agent (Node + Playwright)
┌────────────────────────┐    ┌───────────────────────┐    ┌──────────────────────────────────┐
│ mic ──PCM16────────────┼───▶│ /operator/voice/ws    │    │ meet media bridge (Node side)    │
│ composed canvas        │    │  └ conversation engine│◀───┼─ voice WS: participant PCM up    │
│  └ captureStream(30)   │    │    (OpenAI/Gemini)    │────┼─▶ events WS (lean): assistant    │
│     │                  │    │                       │    │   audio down, kwwk job/cursor    │
│     │ publish (WebRTC) │    │ /operator/visual/ws   │    │        │ CDP (exposeFunction/    │
│     ▼  signaling ──────┼───▶│  (relay, explicit     │◀───┼────────┤      evaluate)          │
│ assistant audio        │    │   links, H7) ─────────┼────┼──▶ Meet page (https)             │
│  (monitor, mutable)    │◀───┼─ canonical events     │    │   ├ RTCPeerConnection ◀═════════╪══ video P2P from cockpit
│ ledger/kwwk/controls   │    │                       │    │   ├ relay fake-cam track (H8)   │
└────────────────────────┘    └───────────────────────┘    │   ├ audio bus ◀ enqueuePcmFrames│
                                                           │   └ participant audio → worklet │
                                                           │       → PCM16 → CDP → Node ─────┘
                                                           └──────────────────────────────────┘
```

The meet media bridge is therefore **two halves**: a Node module inside the
meeting agent (WS client to the operator server; CDP relays into the page —
same shape as `startRealtimeSidecarPage`), and an init script inside the Meet
page (relay fake-cam track, RTCPeerConnection, participant-audio worklet,
audio-bus feeder).

## Detailed design

### MW — the work pipeline (cockpit-only)

The first build: the whole work loop inside cockpit + operator server, zero
Meet coupling. Encodes decisions D3–D10.

- **Work browser.** The operator server spawns a dedicated Playwright
  Chromium (own profile) as the work surface. Its frames reach the
  composition via CDP screencast → operator WS → canvas; the Cueboard
  cursor is drawn over them (CDP actions do not move the OS pointer, so the
  overlay is the only honest visualization). The executor enforces
  workspace isolation: it can only act inside this browser.
- **Observation.** Accessibility-tree snapshot with stable element refs;
  a screenshot is attached only when the snapshot is ambiguous.
- **Typed job (backend-agnostic, D10).** Work-surface id + task intent +
  constraints + post-conditions; the stepwise planner resolves concrete
  operations against the current snapshot.
- **Voice summary.** The executor extracts the highlighted passage; the
  server injects it into the realtime session as context with a
  "summarize in 2–3 spoken sentences" instruction — the realtime model
  only talks.
- **Scenario family A (D6/D8).** "Research X → open the right page →
  highlight the key passage → summarize verbally." Evals run on committed
  local fixture pages (mini search engine + content pages); live demos use
  DuckDuckGo or site-specific search; real Google is out of scope for V1.
- **Harness assets.** Corpus/scenarios/expected jobs as JSONL + fixture
  pages committed in-repo; `vp run eval:*` writes `/tmp/*-latest.json`
  plus a committed baseline history; CI compares against baseline.
- **Done-bar (D9).** Four gates: replay-CI 100 %; intent-compile ≥95 %
  exact-match with zero distractor false-triggers; fixture execution ≥90 %
  over 10 runs/scenario (step-latency p50 ≤2.5 s recorded); end-to-end
  voice run (mic → search → highlight → spoken summary) ≥8/10.

### M1 — Video out: composed track → Meet camera

- Producer: the cockpit already exposes `getComposedVideoTrack()`
  (`lan-operator-surface-html.ts`); add a publisher path mirroring
  `lan-operator-host-visual-publisher.ts` (reusable nearly verbatim).
- Signaling: extend the visual relay with **explicit link addressing first**
  (H7), then register the meeting agent as the `visual_meet` peer; it shuttles
  offer/answer/ICE into the Meet page over CDP, and the RTCPeerConnection
  lives in the page (H6).
- Consumer: the init script installs `installMediaDeviceOverride()` with a
  **bridge-owned relay track from time zero** (H8): a slate ("operator
  connecting…") until WebRTC frames arrive, then draw/write received frames
  into the relay. Track identity never changes.
- Freshness watchdog (H5): bridge monitors frame arrival; on stall >2 s it
  swaps the relay content to a "cockpit stalled" slate and emits a runtime
  event so the cockpit shows a banner.

Notes: 1280×720@30 matches avatar capture defaults; no renegotiation on
layout edits (ADR 0002). Encoding the publish leg adds ~one VP8/VP9 720p30
encode to the operator tab — see the CPU note in prerequisites.

### M2 — Audio in: participants → conversation engine

- Discovery: reuse `registerParticipantAudioStream()` / the
  `meeting-avatar-participant-audio-stream` event
  (`realtime-browser-bridge-meeting-input.ts:29,121`).
- In-page worklet captures participant audio → PCM16 at the **verified**
  provider rate (H2 fix first) → CDP binding → meeting-agent Node → operator
  voice WS with `source: "meet_participant_pcm16"` + participant label in
  `surfaceContext`.
- Server: add a **per-source voice stream registry** (H3) — `activeStreamId`,
  generation, sequence, and telemetry keyed by `source`. The engine input
  selector consumes exactly one source at a time:
  `meet_input_mode = participants_only | operator_only` (exclusive switch,
  H4; default `participants_only` in a meeting — the operator barges in via
  PTT, which flips the switch for the press duration, or via text).
- Echo: participant elements carry only remote audio (the bot's fake mic is
  not a remote element), and Meet clients run AEC on their side; expected
  clean. Keep a half-duplex gate (drop uplink while assistant audio plays)
  as an **opt-in fallback only** — it kills voice barge-in, so do not make it
  default.

### M3 — Audio out: assistant audio → Meet fake mic

- The meeting-agent Node subscribes to the operator events WS in **lean
  mode** (H10) filtered to `assistant_audio_chunk` (+ kwwk events), decodes,
  and feeds the page bus via the existing CDP relay shape
  (`MAB_HOST_ENQUEUE_REALTIME_PCM` → `enqueuePcmFrames`,
  `google-meet-joiner-realtime-sidecar.ts:23`).
- Bus exclusivity: join-time validation rejects `installOperatorBridge`
  combined with `installRealtimeBridge` or the local dialog bridge — exactly
  one writer per fake mic bus.
- Operator surface keeps playing assistant audio as a monitor; add a
  `monitor_muted` toggle (mandatory once the operator also sits in the
  meeting on the same machine, or feedback ensues).

### M4 — kwwk cu in-meeting

Visualization is free: the Cueboard cursor is drawn onto the composed canvas
(`lan-operator-kwwk-cursor-client.ts`), so M1 makes kwwk actions visible to
all participants.

Model-initiated control is **not** free (H1), and per the product
positioning it is not even the primary path: the work pipeline (MW) runs on
deterministic commands (P1.1) and the intent compiler (P1.2), neither of
which needs the realtime model's cooperation. Treat M4 as: fixture cursor +
operator/compiler-triggered jobs first; model-initiated calls only behind
`eval:tool-recall` (P1.5), with tool registration gated on executor
presence.

### Join API

Extend `POST /join/google-meet` (`apps/meeting-agent/src/index.ts:721`):

```jsonc
{
  "installOperatorBridge": true,
  "operatorServerUrl": "http://<lan-host>:18913",
  "operatorBridgeToken": "<join-scoped bearer, H9>",
  "operatorMeetInput": "participants_only", // | "operator_only"
}
```

`installOperatorBridge` is mutually exclusive with `installRealtimeBridge`
and the local dialog bridge (one brain, one bus writer).

## Prerequisite fixes (ordered; most block a milestone)

1. **Provider sample-rate verification (H2)** — DONE 2026-06-10: refuted
   for OpenAI (both 24 kHz and 48 kHz transcribe exactly); remaining work is
   hygiene (declare format, fix the 48 kHz VAD double-trigger) plus the
   permanent `eval:transcription` guard. The actual voice blocker was H11
   (connect thrash), found and fixed the same day.
2. **Tool registration plumbing (H1)** — optional after the P1 reframe:
   only the model-initiated fast path (P1.5) needs it. The `...session`
   spread in `defaultSessionUpdate` and Gemini `options.tools` are the
   hooks; add executor-presence gating when it ships.
3. **Join-scoped token on WS upgrades + control routes (H9)** — blocks any
   real-meeting use.
4. **Visual relay link addressing (H7)** — blocks M1.
5. **Per-source voice streams (H3)** — blocks M2.
6. **Lean events subscription (H10)** — blocks M3 at acceptable cost.
7. **`mergeRuntimeDebugSnapshot` clobber** — server snapshot spread wipes
   client-held `canonicalEvents` (`lan-operator-surface-html.ts:958`); known
   failing `test/lan-operator-inspector.test.mjs`. Fix: merge, never replace.
8. **ScriptProcessor → AudioWorklet** for operator mic
   (`lan-operator-voice-client.ts`): deprecated API, main-thread contention
   with the 30 fps composition; the meet bridge starts on AudioWorklet from
   day one, operator path follows.
9. **Avatar loopback CPU** (optimization, not a blocker): the embedded avatar
   publisher iframe encodes+decodes 720p locally (~30 % of a core). Once M1
   lands, render the avatar directly into the composition when publisher and
   cockpit share a browser — this offsets the new publish-encode cost from
   M1.

## Alternatives considered

- **Virtual camera (OBS / OS-level)**: ships the composed picture to any
  meeting app, but adds an OS-specific native dependency, breaks the
  pure-web fast-iteration loop, and bypasses the existing tested
  `installMediaDeviceOverride` seam. Rejected for V1; remains a future export
  target.
- **Run the model in the Meet page (`realtime-browser-bridge` agents-sdk
  mode)**: duplicates the brain, loses kwwk tool routing and the canonical
  ledger, and couples model lifecycle to the Meet tab's lifetime. Rejected
  for the operator path (the mode itself stays for the Slack product spine).
- **Host-side composition**: already rejected by ADR 0002.
- **Send composed frames over the events WS (no WebRTC)**: simpler but
  re-encodes as images; bandwidth and latency are strictly worse than the
  already-working WebRTC relay. Falls back into consideration only if Meet's
  CSP unexpectedly blocks in-page RTCPeerConnection (H6 spike).

## Testing & acceptance

Follow the meet-contract philosophy (strict local CI, no Google account):

- `smoke:operator-meet-camera` — fixture join with
  `installOperatorBridge=true`; assert the fixture's `getUserMedia` track is
  the bridge relay track, that operator frames appear in it, that a layout
  edit does **not** change track identity, and that a simulated cockpit stall
  swaps in the stalled slate (H5 watchdog).
- `smoke:operator-meet-audio-in` — fixture emits a synthetic participant
  stream; assert PCM16 chunks with `source=meet_participant_pcm16` reach
  `engine.receiveVoiceChunk` (mock engine records them) while the operator
  mic stream stays accepted (H3 regression guard).
- `smoke:operator-meet-audio-out` — mock engine emits `assistant_audio_chunk`;
  assert the fixture's fake mic bus receives scheduled buffers via the CDP
  relay.
- `acceptance:realtime-meet-loop` — end-to-end against the fixture: synthetic
  participant speech → canonical transcript → assistant audio out → operator
  triggers a kwwk job → cursor visible in a frame grab of the injected
  camera track.
- The P0 harness evals — `eval:transcription`, `eval:intent-compile`, the
  kwwk scenario success matrix, end-to-end — run against real provider keys
  where applicable; each writes a JSON artifact plus append-only history,
  and CI gates on no-regression. Required before any prompt/grammar/
  provider change. `eval:tool-recall` exists only if/when the optional
  model-initiated fast path (P1.5) is enabled.
- Existing gates stay green: `smoke:meet-contract`,
  `acceptance:realtime-local-kwwk-action`, operator surface/dock tests.

## Milestones (priority order)

The work pipeline outranks the meeting plumbing: it is the product (precise
work execution) and it iterates fastest because it has zero Meet coupling.
Audio out (acks) lands before audio in — hearing the bot acknowledge and
report its work matters more for directed work than the room speaking to
it, and it is lower risk. (Sequencing only: in the end state the room
directing the work is core — see Vision.)

| Order | Milestone                                                                                                                                                                   | Risk                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1     | **M0** spike + unblock: provider sample rates (H2 — transcription precision), Meet CSP (H6), token (H9), snapshot fix                                                       | medium: two empirical unknowns front-loaded                              |
| 2     | **MW** work pipeline + harness, cockpit-only (see Detailed design → MW): CDP work browser, stepwise planner with record/replay, family-A scenarios, four-gate done-bar (D9) | high value; harness de-risks the model-quality bound; no Meet dependency |
| 3     | **M1** video out: composed track is the Meet camera (relay track + watchdog, fixture-verified)                                                                              | medium: publisher path + link addressing                                 |
| 4     | **M3** audio out: assistant acks/status → fake mic bus (lean subscription) + monitor toggle + bus exclusivity                                                               | low                                                                      |
| 5     | **M2** audio in: participant audio → engine (per-source streams + input switch) — the room directs work                                                                     | medium: echo behavior needs fixture evidence                             |
| 6     | **M4** kwwk in-meeting + meet-loop acceptance + docs (`local-demo.md`)                                                                                                      | low once MW exists                                                       |

## Open questions

1. Mirror-trap implementation on the mini: dedicated virtual display vs
   macOS Space vs composed-canvas-only sharing — needs a spike on the
   actual appliance (interacts with macOS Screen Recording permissions).
2. Family-B auth: how does the work browser hold login state (GitHub etc.)
   on the appliance, and what is the blast-radius policy for logged-in
   write actions?
3. Cross-machine ICE: LAN host candidates (mDNS) should suffice operator↔meet;
   do we need a TURN escape hatch in `webrtcIceServers` for exotic networks,
   or document "same L2 segment" as a requirement?
