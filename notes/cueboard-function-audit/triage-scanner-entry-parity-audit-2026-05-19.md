# Triage Scanner Entry Parity Audit — 2026-05-19

## Scope

This audit covers the non-`app_mention` automatic Slack scanner entry: ordinary channel messages found by history polling / buffer flush and sent to the triage planner. It is separate from the app-mention parity work in task #215 and from self-growth / auto-followup in task #227.

## Cueboard Source

- `agent-framework/internal/bridge/slack/scanner.go:15-25`
- `agent-framework/internal/bridge/slack/scanner.go:82-96`
- `agent-framework/internal/bridge/slack/scanner.go:106-170`
- `agent-framework/internal/bridge/slack/scanner.go:181-223`
- `agent-framework/internal/bridge/slack/scanner_triage.go:21-60`
- `agent-framework/internal/bridge/slack/scanner_triage.go:69-93`
- `agent-framework/internal/bridge/slack/scanner_triage.go:106-119`
- `agent-framework/internal/bridge/slack/defaults.go:266-303`
- `agent-framework/internal/bridge/slack/defaults.go:392-404`
- `agent-framework/internal/bridge/slack/slack_tools.go:20-43`
- `agent-framework/internal/bridge/slack/tool_registration_test.go:69-90`

## New Oneesama Source

- `internal/slackagent/service_scanner_poll.go:128-260`
- `internal/slackagent/service_triage.go:993-1059`
- `internal/slackagent/triage_decision.go:44-112`
- `internal/agentrunner/capabilities.go:47-72`
- `internal/slackagent/triage_scanner_entry_parity_test.go`

## Summary

| Behavior | Old Cueboard Agent D | New Oneesama after this audit | Decision |
|---|---|---|---|
| Automatic scanner digest | Polls joined channels, renders `=== Slack Activity ===`, assigns refs, and advances cursors only after triage success. | History scanner fetches joined channels, preserves refs in the digest, and flushes through `StartSlackTriage`. | Contract-equivalent; covered by existing scanner tests plus the new entry fixture. |
| Planner memory context | Builds a headless triage session with workspace memory hints, previous triage context, and message refs. | `StartSlackTriage` injects local workspace memory, previous triage context, related memory when credible, links/thread context, and the scanner digest. | Contract-equivalent for scanner entry; self-growth engine remains separate task #227. |
| Planner tool surface | Triage session gets planner tools such as `slack_api`, `suggest_action`, `followup_memory`, `person_memory`, `memory_search`, and `memory_get`, while assistant-only media/runtime tools are excluded. | Triage session kind maps to planner capabilities with the same core tools and excludes image/audio/runtime/heartbeat tools. | Contract-equivalent; pinned by capabilities tests and the new entry fixture. |

## Behavior 1: Scanner Activity Enters The Same Triage Entry Point

- Old does: `runScan` collects a digest and calls `runTriageForDigest`; cursors advance only when triage returns OK (`scanner.go:82-96`). Digest sections are channel-scoped, ref-tagged Slack activity (`scanner.go:106-170`, `181-223`).
- New does: `scanSlackHistoryOnce` fetches joined channels, converts history into a `SlackScannerSweepRequest`, and flushes through `SweepSlackScanner` / `StartSlackTriage` (`service_scanner_poll.go:128-260`).
- Diff:
  - New scanner also has app-mention compensation and mention-owned-thread suppression from task #215; that is an extension, not part of the old automatic triage contract.
  - New scanner commits cursor via deferred cursor write after history fetch. Existing tests already cover bootstrap vs non-bootstrap behavior and rate-limit/backoff cases.
- Decision: keep the current scanner path; add an entry-level fixture proving history poll reaches the planner with scanner refs.
- Fixture: `TestSlackHistoryScannerTriageCarriesMemoryAndPlannerContext`.

## Behavior 2: Scanner Triage Receives Workspace Memory And Previous Triage Context

- Old does: `buildTriagePrompt` starts from the triage system prompt, injects workspace memory / feedback / memory access hints, appends previous triage contexts, and then sends the digest as a headless planner message (`scanner_triage.go:69-93`, `106-119`; `defaults.go:266-303`, `392-404`).
- New does: `StartSlackTriage` loads channel brain, previous triage contexts, local Slack memory, related memory, external link context, and Slack thread context before building the planner prompt (`service_triage.go:993-1059`; `triage_decision.go:44-112`).
- Diff:
  - Cueboard's memory injection is a prompt prefix with hints; Oneesama has both local memory snippets and structured `localSlackMemory` / `relatedMemory` runner context.
  - Oneesama only surfaces "related memory evidence" when the stricter related-memory scorer considers it credible. Ordinary workspace memory still appears under "Relevant local memory", which matches the old scanner's workspace-memory injection role.
- Decision: scanner entry is contract-equivalent as long as local memory and previous triage reach the runner prompt/context.
- Fixture: `TestSlackHistoryScannerTriageCarriesMemoryAndPlannerContext` asserts local memory source, previous triage line, scanner message ref, and runner context.

## Behavior 3: Scanner Triage Uses Planner Capabilities, Not Assistant-Only Tools

- Old does: planner/triage tool registration includes `followup_memory`, `person_memory`, and Slack helper tools, while assistant-only image/audio/runtime tools are not available to the planner (`slack_tools.go:20-43`; `tool_registration_test.go:69-90`).
- New does: `SessionKindTriage` grants planner capabilities for `slack_api`, `read_doc`, `person_memory`, `suggest_action`, `usage_api`, `followup_memory`, `memory_search`, `memory_get`, `exa_search`, and `exa_contents`, while excluding assistant-only media/runtime/heartbeat tools (`capabilities.go:47-72`).
- Diff:
  - New triage has first-class `exa_search` / `exa_contents` available through the command-provider tool surface; old availability depended on the framework's registered integrations.
  - New triage still blocks `send_message`, matching the product contract that Slack mutations flow through triage actions / suggest_action rather than arbitrary channel sends.
- Decision: keep current capability mapping; it is the right planner-vs-assistant boundary for automatic scanner triage.
- Fixture: `TestSlackHistoryScannerTriageCarriesMemoryAndPlannerContext` checks core planner memory/slack tools and assistant-only media exclusions.

## Remaining Work

1. Delayed no-reply followup and backfill replay are separate entries; they still need their own read-old-first audit rather than inheriting this scanner result.
2. The self-growth / improvement-signal loop is not part of scanner triage. It has a dedicated task #227 because old Cueboard had an offline/scheduled learning loop beyond planner memory injection.
3. Class 2 routing keywords remain a #199 polish item; this audit did not touch routing heuristics.
