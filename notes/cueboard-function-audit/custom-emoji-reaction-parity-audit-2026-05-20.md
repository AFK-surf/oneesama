# Custom Emoji Reaction Parity Audit

Date: 2026-05-20

## Context

Peng asked whether new Oneesama had migrated the old Cueboard
slackd behavior where the bot reacts to some Slock/Slack messages
with workspace-specific custom emoji. The first superficial answer
was "partly yes" because new Oneesama already had `add_reaction`
and `list_emoji` tool surfaces.

That answer was wrong at the capability-contract level. The old
behavior was not only "Slack can add emoji." The old behavior was:

1. discover workspace custom emoji,
2. make those emoji visible to cognition before the model decides,
3. let triage choose reaction as a first-class lightweight response,
4. execute `reactions.add` without requiring a full text reply.

## Old Cueboard Does

Source:
`~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/`

- `bridge.go:76-77` stores `customEmoji []string` plus a mutex on
  the Slack bridge.
- `bridge.go:668-685` calls Slack `emoji.list`, filters aliases,
  sorts names, caches them, and logs the loaded count.
- `bridge.go:478-482` appends `## Workspace custom emoji` to the
  assistant system prompt when custom emoji are available.
- `scanner_triage.go:112-116` appends the same custom emoji section
  to scanner triage prompts.
- `slack_api_tool.go:20,37,190-191,306` exposes `add_reaction` and
  `list_emoji`.
- `slack_api_tool_messages.go:450-484` executes `reactions.add`
  and returns cached custom emoji names for `list_emoji`.

Behavioral contract:

- The model does not need to guess custom emoji names.
- The model does not need to call `list_emoji` just to know that
  workspace custom emoji exist.
- Emoji reaction is a low-noise triage response, not only an
  imperative tool available after a text answer has already been
  planned.

## New Oneesama Before This Patch

New Oneesama already had:

- `slack_api/add_reaction` execution.
- `slack_api/list_emoji` mapped to Slack `emoji.list`.
- action recorders that knew how to record `add_reaction`.

But it did not have:

- startup custom emoji discovery/cache,
- `## Workspace custom emoji` prompt/context injection,
- Pi persona `react` decision shape,
- direct triage execution for a model-selected reaction.

So the tool matrix looked green while the user-visible behavior was
red: Oneesama could technically react, but its foreground cognition
did not naturally know when or how to use workspace-uploaded emoji.

## Shipped Alignment

Files:

- `internal/slackagent/custom_emoji.go`
- `internal/slackagent/service_socketmode.go`
- `internal/slackagent/service_runtime.go`
- `internal/slackagent/triage_decision.go`
- `internal/slackagent/service_triage.go`
- `internal/slackagent/persona_shadow.go`
- `internal/persona/types.go`
- Pi sidecar `src/persona/persona-contract.ts`
- Pi sidecar `src/persona/persona-decision.ts`
- Pi sidecar `templates/prompts/oneesama-persona-shadow-decision.md`

New behavior:

- Slack service startup refreshes workspace custom emoji via
  `emoji.list`, filters aliases, sorts names, caches the catalog,
  and exposes count / last refresh / last error in `/slack/status`.
- Triage and Pi persona requests receive `## Workspace custom emoji`
  / `workspace_custom_emoji` context.
- Pi persona contract now supports `decision=react` plus
  `reactions[]`, gated by `safety.allow_reactions`.
- `react` decisions and reaction intents are converted into direct
  `add_reaction` triage actions.
- Direct triage execution calls `reactions.add` against the requested
  message timestamp, or the latest digest/snapshot message when the
  model leaves the target implicit.
- `list_emoji` first returns the cached workspace catalog when
  available, and falls back to Slack `emoji.list` otherwise.

## Regression Coverage

Oneesama tests:

- `TestFetchWorkspaceCustomEmojiFiltersAliasesAndSorts`
- `TestBuildSlackTriagePromptIncludesWorkspaceCustomEmoji`
- `TestBuildSlackTriagePersonaRequestIncludesWorkspaceCustomEmoji`
- `TestPersonaReactDecisionBecomesDirectReactionAction`
- `TestSlackAPIToolListEmojiUsesWorkspaceCache`
- `TestTriageDirectReactionAddsEmojiToLatestSnapshotMessage`

Pi sidecar tests:

- safety blocks emoji reactions when request disallows reactions,
- react decisions normalize custom emoji intents,
- prompt treats `workspace_custom_emoji` as a reaction triage surface.

## Drift Class

Name: **tool surface without cognition affordance**

Pattern:

- The migrated system has the raw tool/API operation.
- Audit checks the tool matrix and marks parity green.
- The old system also made the capability visible to cognition at
  decision time through prompt/context/policy/catalog injection.
- The new system lacks that affordance, so the tool is technically
  callable but not naturally used in production.

Why it happened here:

- I looked at `add_reaction` / `list_emoji` and treated them as the
  emoji capability.
- I failed to ask: "How did the old model know which workspace emoji
  exist, and at what point in triage did it decide to use one?"
- The missing piece was upstream of the tool call: custom emoji
  catalog injection plus reaction as an allowed triage decision.

Audit rule:

- For every migrated tool, audit three layers:
  1. **Tool execution**: can the system call the backend operation?
  2. **Cognition affordance**: does the model see the right catalog,
     policy, and examples before deciding?
  3. **Output action path**: can the decision become user-visible
     without an unrelated text reply or manual confirmation?

Tool execution alone is not parity.
