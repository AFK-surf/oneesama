# Oneesama Module Polish Punch List

Date: 2026-05-21

## Trigger

Peng asked for a full-code "精致优化" pass over Oneesama, split by module and
worked task by task instead of one large refactor.

This document is Phase 0: a punch list and ownership split. It is intentionally
implementation-ready: each item has a concrete acceptance shape and should be
claimed as a separate task before code changes.

## Current Shape

- Total Go surface scanned: about 97k lines across `internal/`, `cmd/`, `pkg/`,
  and `scripts/`.
- Largest package by far: `internal/slackagent` with 340 Go files.
- Second largest product surface: `internal/meetingagent` with 71 Go files.
- Boundary packages are smaller but high risk: `internal/persona`,
  `internal/agentrunner`, `pkg/config`, and `internal/persistence`.
- Current task map:
  - task #271: Slack triage / reaction / workspace-policy pipeline.
  - task #272: Slack Memory providers and evidence ranking.
  - task #273: Persona runtime contract and OpenClaw/Hermes Memory boundary.
  - task #274: Meeting recording / join / redelivery pipeline.
  - task #275: Agent runner worker/tool-loop and fail-closed boundaries.
  - task #276: Config / persistence / runtime status schemas.
  - task #277: CLI scripts, live deploy, monitor, and sweep tooling.
  - task #278: Docs, audit notes, and canary suite consolidation.

## Triage Rules For Polish Tasks

1. User-visible failure or wrong Slack output wins over aesthetics.
2. Runtime boundary bugs win over internal naming.
3. Refactors must preserve existing behavior with focused tests before broad
   cleanup.
4. Each task must leave either a regression test, canary fixture, monitor signal,
   or audit doc update.
5. No module task is done just because code moved; acceptance is behavior,
   observability, and reviewability.

## Phase 1: Immediate Risk Items

### 1. Worker Timeout Visible Text

Module: `internal/slackagent` + `internal/agentrunner`

Issue: A delegated worker timeout surfaced `job timed out` directly in Slack.

Acceptance:

- Timeout worker results use a user-safe fail-closed message.
- No `job timed out`, stack, provider debug, localhost, or internal gateway text
  can reach Slack-visible worker delivery.
- Add unit coverage around `slackWorkerResultText`.
- Add quality-sweep detection for worker timeout delivery if possible.

Owner: whoever owns the live incident thread. Do not duplicate work.

### 2. `service_triage.go` Decomposition

Module: `internal/slackagent`

Issue: `service_triage.go` is 1831 lines and mixes live routing, audit,
persona foreground, worker delegation, link context, and metadata construction.

Acceptance:

- Extract cohesive files without changing behavior:
  - `triage_audit_report.go`
  - `triage_persona_foreground.go`
  - `triage_worker_delegate.go`
  - `triage_fetch_metadata.go`
- Existing triage tests stay green.
- Add one smoke test or golden assertion that proves metadata keys did not drift
  through the move.

### 3. App-Mention Intent Keyword Externalization

Module: `internal/slackagent`

Issue: Routing keywords for canvas, fresh search, media, and workflow intent are
still hardcoded in Go in several files.

Acceptance:

- Move simple keyword lists into `templates/triage/*keywords*.{zh,en}.txt` or a
  small structured config format.
- Keep workflow conjunction logic readable; do not flatten it into unsafe
  single-keyword matching.
- Add reload/fallback behavior and tests.

### 4. Workspace Policy vs Universal Behavior Boundary

Module: `internal/slackagent`, `internal/persona`, config

Issue: We have already fixed several cases where workspace preference became
universal model behavior. This needs a structural guard.

Acceptance:

- Centralize policy injection and policy source metadata.
- Add grep/canary tests proving product-specific topic lists are not hardcoded
  into persona prompts.
- Runtime status shows the active policy source and version/hash.

### 5. Worker Delegation Scope Control

Module: `internal/slackagent`, `internal/agentrunner`

Issue: Pi can delegate broad live-product questions, but the worker may start
from the Oneesama repo even when the target is another repo or runtime surface.

Acceptance:

- Delegated worker prompt/context includes explicit target surface and evidence
  boundaries.
- For "staging app.cue.surf is slow" style tasks, worker must first request
  runtime or Slack evidence instead of blindly scanning Oneesama source.
- Add fixture for a non-Oneesama product issue.

## Phase 2: Slackagent Module Polish

### 6. Memory Provider Ownership Split

Module: `internal/slackagent`

Issue: lexical related memory, semantic provider, entity graph, multimodal
provider, turn extraction, and persona writes are all active; source labels and
ranking rules need one clear ownership model.

Acceptance:

- Add a short provider matrix in code docs or package comments.
- `memory/persona/writes/...` remains `persona_memory_write`.
- Evidence ranking tests cover legacy trace vs persona write vs person profile
  vs entity graph.
- Add quota/rotation follow-up for persona writes.

### 7. Daily Report / Quality Sweep Shared Buckets

Module: `internal/slackagent`, `scripts`

Issue: daily reports and `oneesama-triage-quality-sweep.sh` inspect overlapping
quality concepts with separate code paths.

Acceptance:

- Align bucket names and sanitization rules.
- Keep old daily-report visible shape unchanged.
- Add tests for redacted runtime errors and emoji/reaction quality counts.

### 8. Reaction Triage Polish

Module: `internal/slackagent`

Issue: custom emoji discovery, Pi `react` decisions, and reaction execution just
landed; they need stronger behavior shaping.

Acceptance:

- Add canary cases for "react only", "reply only", "reply + react", and
  "stay_silent".
- Ensure workspace custom emoji names are injected but not hallucinated.
- Runtime status exposes emoji cache freshness and failure reason.

### 9. Thread Context Fetch Budgeting

Module: `internal/slackagent`

Issue: thread/link context fetch, context summarization, and worker delegation
share context budgets but are spread across files.

Acceptance:

- One helper owns context char budget decisions.
- Audit metadata clearly records raw chars, summarized chars, and fetch errors.
- Add regression for large-thread summary not blocking foreground forever.

## Phase 3: Persona / Memory Boundary Polish

### 10. Persona Contract Typed Context

Module: `internal/persona`

Issue: persona request/response has several flexible `map[string]any` fields.
That is useful at boundaries but weak for in-repo invariants.

Acceptance:

- Keep wire-compatible JSON, but add typed builders for Slack foreground
  requests.
- Tests assert required fields for reply, react, delegate_worker, memory_write.
- Prompt tests verify no private markers and no old-sidecar framing.

### 11. OpenClaw/Hermes Memory Roadmap Split

Module: `internal/persona`, `internal/slackagent`

Issue: OpenClaw-style durable workspace memory is partially implemented; Hermes
style trust, staleness, consolidation, and entity history are still follow-ups.

Acceptance:

- Split roadmap into explicit task-sized slices:
  - persona-write quota/rotation
  - trust/staleness score
  - episodic consolidation
  - entity relationship persistence
- Add one canary per slice before implementation.

## Phase 4: Meetingagent Polish

### 12. Recording Artifact Pipeline Contract

Module: `internal/meetingagent`

Issue: recent recording bugs came from capture/finalize/redeliver/upload being
treated as separate patches.

Acceptance:

- One contract doc/test enumerates states:
  captured, finalized, redelivered, compressed upload, webhook delivered.
- Raw `.wav` is never uploaded to Slack when compressed artifact exists.
- Redelivery skips ASR when captions/artifacts already exist.

### 13. Join Lifecycle State Machine

Module: `internal/meetingagent`, `internal/meetrunner`

Issue: join monitor, stale recovery, session store, redelivery, and UI card
state need one readable lifecycle.

Acceptance:

- State transition table in tests or docs.
- Focused tests for stale recovery, duplicate join suppression, and final
  user-visible card state.

### 14. Realtime Tool Schema Extraction

Module: `internal/meetingagent`

Issue: `realtime_tools.go` embeds a huge JSON string.

Acceptance:

- Move schemas into generated or structured Go declarations.
- Keep parity test against existing JSON shape.
- Add comments for high-risk tools: screen share, identity, worker delegation.

## Phase 5: Agentrunner / Config / Scripts Polish

### 15. Agentrunner Failure Taxonomy

Module: `internal/agentrunner`

Issue: user-visible delivery needs to distinguish timeout, provider auth,
cancel, unsafe tool request, and process failure.

Acceptance:

- Add typed failure reason or normalized error code.
- Slack delivery maps codes to safe text.
- Monitor/sweep can count each code separately.

### 16. Config Surface Audit

Module: `pkg/config`, `scripts/oneesama-live.sh`

Issue: live env source order and stale env snapshot already caused drift.

Acceptance:

- Add generated/printed effective config summary for high-risk fields.
- Preflight fails if stale persona runtime fields conflict with active
  `oneesama-pi`.
- Tests cover source-order precedence.

### 17. Monitor And Sweep CLI Unification

Module: `scripts`

Issue: monitor and quality sweep are useful but still shell-heavy and partly
duplicated.

Acceptance:

- Either extract shared jq snippets or add a Go CLI for triage quality.
- Default window stays 3h.
- Red output always distinguishes current red from historical-window red.

## Phase 6: Docs And Canary Consolidation

### 18. Canary Fixture Index

Module: `internal/slackagent/testdata`, `notes/cueboard-function-audit`

Issue: bridge quality fixtures, memory quality fixtures, audit docs, and live
monitor scripts all exist but need a single index.

Acceptance:

- Add a fixture index listing every case, contract item, owner task, and whether
  it is active or pending.
- Pending fixtures must have a linked task.

### 19. Drift-Class Index

Module: `notes/cueboard-function-audit`

Issue: drift classes are valuable but spread through a long audit-method doc.

Acceptance:

- Add a compact top-level drift-class table with anchor commit/task.
- Keep worked examples below it.

## Suggested Ownership

- @劲霸仁波切: implementation-heavy slices, especially #271, #273, #274, #275,
  #276, #277.
- @喵喵: audit/canary/doc slices, especially #272, #278, and independent review
  on #271/#275 high-risk changes.
- Either owner can take live incidents, but only one agent should claim a live
  incident task at a time.

## First Execution Order

1. Finish current live incident: worker timeout visible text.
2. task #271: split and harden Slack triage pipeline, starting with timeout
   delivery and delegation scope.
3. task #272: Memory provider/ranking ownership and canary index.
4. task #273: persona contract typed builders and OpenClaw/Hermes roadmap.
5. task #274: meeting recording artifact contract.
6. task #276 + task #277: config/preflight/monitor cleanup.
7. task #278: docs/canary consolidation.

## Phase 0 Acceptance

- Module map exists.
- Fine-grained polish backlog exists.
- First execution order is explicit.
- Existing repo is untouched except this planning note and task/thread updates.
