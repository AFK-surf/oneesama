# Harness Stability Inventory

Anchor task: #319
RFC: `notes/rfc/oneesama-harness-cache-tool-stability-rfc-2026-05-21.md`

This inventory classifies Oneesama prompt/tool inputs as either stable prefix
material or dynamic evidence. Stable prefix material should be hashable and
should not change when time, workspace policy, emoji, memory, live status, or
thread context changes.

## Summary

| Surface              | Stable prefix                                                              | Dynamic evidence                                                                  | Immediate risk                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi foreground        | `oneesamaPISystemPrompt` universal role / decision JSON contract           | `persona.Request` user payload: context, evidence, memory, safety, metadata       | Medium: stable prompt is currently a function of `Request`, even though it does not read it. Hash tests must pin that it stays request-invariant.                           |
| Slack worker         | `cueboardDefaultSystemPromptForAgentRunner` and fixed worker adapter rules | `StartInput.Task`, `StartInput.Context`, related memory/tool evidence strings     | High: assistant context and evidence are mixed into prompt sections. This is worker-only, but it can still cause cache churn and evidence leakage if treated as foreground. |
| Demo surface worker  | fixed demo-surface worker prompt                                           | URL/session/task/context for browser observation                                  | Low: scope is bounded by `SessionKindDemoSurface`; host-side active writes remain policy-gated.                                                                             |
| Realtime tools       | `defaultRealtimeToolDefinitions` and optional demo-surface tool group      | runtime config decides whether demo-surface tools are exposed                     | High: many tool schemas live in one foreground realtime tool list; any schema churn changes the prefix.                                                                     |
| Slack triage context | no separate stable prompt yet; Pi request is typed                         | workspace policy, custom emoji, channel brain, related memory, file/link evidence | High: these must become typed dynamic envelopes instead of ad-hoc strings.                                                                                                  |

## Stable Prefix Sources

### Pi foreground

Code:

- `internal/persona/oneesama_pi_runtime.go`
  - `oneesamaPISystemPrompt(req Request)`
  - `oneesamaPIChatRequest.Messages[0]`

Stable content:

- Oneesama foreground role.
- Decision space: `reply`, `react`, `delegate_worker`, `stay_silent`,
  `memory_write`.
- No-hedge rule.
- Media/file self-limitation guard.
- Secretary delegation boundary.
- Link commentary quality rule.
- Negative-support-from-absence guard.
- JSON response contract.

Must not enter this stable prompt:

- current date/time;
- current model/provider;
- workspace policy text;
- workspace custom emoji list;
- memory snippets;
- channel brain summaries;
- live health/status;
- per-thread Slack context.

### Agent runner default worker

Code:

- `internal/agentrunner/prompt.go`
  - `buildPrompt`
  - `buildSlackAssistantPrompt`
  - `cueboardDefaultSystemPromptForAgentRunner`
  - `buildDemoSurfacePrompt`

Stable content:

- Worker role and safety policy.
- Slack dispatcher constraints.
- Demo-surface no-mutation worker prompt.

Dynamic content:

- `StartInput.Task`
- `StartInput.Context`
- `slackAssistantPrompt`
- `relatedMemoryEvidence`
- `slackToolEvidence`

Risk note:

- Slack worker prompts intentionally include dynamic evidence. This is acceptable
  only because the worker lane is bounded and disposable. It must not be copied
  back into Pi foreground history as raw scratch context.

### Realtime tool schemas

Code:

- `internal/meetingagent/realtime_tools.go`
  - `defaultRealtimeToolDefinitions`
  - `realtimeToolDefinitions(includeDemoSurface bool)`
  - `realtimeToolSchemasAsMaps`

Stable content:

- Foreground realtime tools and JSON parameter schemas.

Dynamic inputs:

- `includeDemoSurface` flag gates the demo-surface tool group.

Risk note:

- This is the largest stable-prefix surface. New tools should be treated as
  migrations, not casual feature additions.

## Dynamic Evidence Sources

These should converge on the RFC envelope shape:

| Dynamic source          | Current location                                          | Target envelope kind       |
| ----------------------- | --------------------------------------------------------- | -------------------------- |
| Workspace triage policy | Slack persona request context                             | `workspace_triage_policy`  |
| Custom emoji list       | Slack persona request context / tool evidence             | `workspace_custom_emoji`   |
| Related memory evidence | `service_avatar.go`, semantic/entity/multimodal providers | `related_memory_evidence`  |
| Channel brain summary   | slackagent channel-brain / triage context                 | `channel_brain_summary`    |
| Current time            | scattered prompt/tool helpers                             | `current_time`             |
| Live health/status      | monitor/status endpoints                                  | `live_service_status`      |
| Browser observations    | demo-surface observation bus                              | `browser_demo_observation` |
| Worker output           | worker job completion records                             | `worker_result_envelope`   |

## First Hash Contracts

Task #320 should establish:

- Pi stable prompt hash.
- Realtime tool schema hash with demo-surface disabled.
- Realtime tool schema hash with demo-surface enabled.

Task #321 should extend those into invariance tests:

- time changes do not affect Pi stable prompt hash;
- workspace policy changes do not affect Pi stable prompt hash;
- custom emoji changes do not affect Pi stable prompt hash;
- memory evidence changes do not affect Pi stable prompt hash;
- demo-surface flag is the only expected current realtime tool hash split.

## Audit Reflex

Before adding a prompt or tool change, ask:

1. Is this universal behavior, or dynamic evidence?
2. If dynamic, where is the envelope source/version/freshness?
3. Does this change a stable hash?
4. If yes, where is the migration note and acceptance fixture?
