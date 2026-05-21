# KWWK CU Demo Surface — Operator Runbook (POC)

Date: 2026-05-21
Owner: @喵喵 (task #312)
RFC: [kwwk-cu-demo-surface-poc-rfc-2026-05-21.md](kwwk-cu-demo-surface-poc-rfc-2026-05-21.md)

Companion to the POC RFC. Lives next to the RFC because it is the
operational mirror of those module boundaries, not a polish-era hub.

## What this covers

How an operator (Peng, on-call, or driver) starts / inspects / stops a
host-run Computer Use demo surface during the POC, where audit data
lives, and the gate criteria before the module graduates into the
mainline meeting runtime.

## What this does NOT cover

- KWWK adapter install / KWWK runtime topology — see task #306 thread.
- Realtime tool registration — see task #308 thread.
- Production rollout — POC stays host-run, no Docker; see RFC
  Non-Goals section.

## Module quick map

| Module | Code | Owner task |
|---|---|---|
| Workspace lifecycle (browser sandbox) | `internal/meetingagent/demo_workspace_lifecycle.go` | #305 |
| KWWK client contract + fake | `internal/meetingagent/demo_kwwk_client.go` | #306 |
| Controller (intent → observation loop) | `internal/meetingagent/demo_controller.go` (in flight) | #307 |
| Observation feedback renderer | `internal/meetingagent/demo_observation_feedback.go` | #310 |
| Allowlist + safety policy | `internal/meetingagent/demo_safety_policy.go` | #311 |
| Session state + audit | `internal/meetingagent/demo_session_audit.go` | #312 |

Realtime bridge (#308) and surface presenter (#309) land after the
controller stabilises so they do not bind to a phantom contract.

## Start / stop a demo session (POC, host-run)

The POC has no top-level CLI yet; sessions are driven through the
controller from the test harness or a thin operator helper. The audit
store mirrors every state change so the operator can always read what
happened from `DemoSessionStore.Snapshot(sessionID)` even when the
realtime bridge is not wired in.

Minimum trigger flow (Go pseudocode):

```go
store := meetingagent.NewDemoSessionStore()
policy := meetingagent.DemoSafetyPolicy{
    URLAllowlistPatterns: []string{
        "https://github.com/",
        "https://linear.app/",
    },
    ApprovedSessionURLs: []string{
        // URLs explicitly mentioned in the meeting/Slack thread
        // for this session.
    },
}
cancel := meetingagent.NewDemoCancelToken()

trigger, _ := store.RecordTrigger(meetingagent.DemoSessionTriggerRequest{
    SessionID: "demo_pr42",
    Actor:     "U_PENG",
    ThreadKey: meetingagent.DemoSessionThreadKey{
        Surface: "slack", ChannelID: "C_MEETING", ThreadTS: "1779.001",
    },
    URL: "https://github.com/anthropics/claude-code/pull/42",
})
verdict := policy.Decide(meetingagent.DemoActionRequest{
    Kind:   meetingagent.DemoActionOpenURL,
    URL:    trigger.URL,
    Cancel: cancel,
})
// caller routes verdict + observation feedback through the audit store.
```

Stop: `cancel.Cancel("user_said_stop")` short-circuits subsequent policy
calls, then `store.RecordClose(sessionID, DemoSessionResultStopped,
"user_said_stop")` closes the audit row. Driver #305's
`DemoWorkspaceLifecycle.Stop` cleans the runtime dir.

## Inspect a running session

```go
snap, ok := store.Snapshot("demo_pr42")
// snap.{StartedAt, EndedAt, LastAction, LastResult, LastReason,
//       ArtifactRefs, EntryCount, Closed}

entries, _ := store.Entries("demo_pr42")
for _, e := range entries {
    fmt.Println(meetingagent.FormatRunbookLine(e))
}

active := store.ActiveSessionIDs()  // sorted by StartedAt
```

`FormatRunbookLine` output (one entry per line, grep-friendly):

```
2026-05-21T04:30:00Z session=demo_pr42 seq=2 actor=U_PENG thread=slack|C_MEETING|1779.001 action=scroll url=https://github.com/anthropics/claude-code/pull/42 result=dry_run reason=dry_run_passive_mutation artifacts=2
```

Reason codes are snake_case across `#305`/`#306`/`#310`/`#311`/`#312`
so the same `grep reason=` works for every layer.

## Thread → session lookup

When a follow-up message lands in the same Slack/Meet thread, the
controller can find the existing session without keeping state outside
the store:

```go
sessionID, ok := store.SessionForThread(meetingagent.DemoSessionThreadKey{
    Surface: "slack", ChannelID: "C_MEETING", ThreadTS: "1779.001",
})
```

`DemoSessionThreadKey.IsZero()` is checked everywhere so a partially
empty key does not create a phantom mapping. Surface (`slack` /
`meeting`) is part of the normalized form, so two surfaces sharing the
same channel id stay isolated.

## Audit-only discipline

The audit store is the single source of truth for what the demo
actually did. Per the RFC `DemoSessionStateAndAudit` section:

- **Never post audit content directly to Slack/Meet.** The renderer
  layer (#310) decides what is voiced; everything else stays in
  `Entries(sessionID)`.
- The feedback renderer already drops tool-trace leaks (`tool_call_id=`,
  `panic:`, `goroutine `, `traceback`, `stack trace`, `fmt.Errorf(`,
  `errors.New(`, `DEBUG `, `file://`, `http://localhost`, `trace_id=`).
  If a new debug marker leaks, add it to `toolTraceLeakPatterns` in
  `demo_observation_feedback.go` and pin the case in
  `TestDemoFeedbackRendererStripsToolTraceLeak`.

## Mainline integration gate

Before any of the POC modules are wired behind the mainline meeting
runtime flag (RFC Phase 5), the following must all hold:

- [ ] Per-module tests run without joining Meet, starting realtime, or
      launching a real browser.
- [ ] `DemoSafetyPolicy` is exercised by every action the controller
      can request; no caller bypasses `Decide`.
- [ ] `DemoCancelToken` is wired into the controller loop so a stop
      utterance short-circuits in-flight steps within one tick.
- [ ] All audit rows go through `DemoSessionStore`; no module logs
      session detail straight to Slack/Meet.
- [ ] `FormatRunbookLine` output is stable enough that an existing
      grep recipe still matches after the change.
- [ ] `DemoWorkspaceLifecycle.CleanupStale` runs at startup so orphaned
      profiles from a crashed POC do not pile up.
- [ ] The realtime bridge (#308) only exposes `start_demo_surface` /
      `cancel_demo_surface`; raw `computer_use_step` stays off until
      the click/type approval gate lands.
- [ ] The integration flag defaults OFF and the runbook documents how
      a single operator can verify it locally without exercising the
      whole production stack.

When the box is empty, the matching task remains open.

## Reference

- RFC (this runbook's parent): `notes/rfc/kwwk-cu-demo-surface-poc-rfc-2026-05-21.md`
- Notes index: `notes/README.md`
- Module tests:
  - `internal/meetingagent/demo_workspace_lifecycle_test.go`
  - `internal/meetingagent/demo_kwwk_client_test.go`
  - `internal/meetingagent/demo_observation_feedback_test.go`
  - `internal/meetingagent/demo_safety_policy_test.go`
  - `internal/meetingagent/demo_session_audit_test.go`
