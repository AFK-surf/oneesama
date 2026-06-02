# Worker Tool Bridge Parity Audit — 2026-05-19

## Scope

- Cueboard registry: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/slack_tools.go`
- Cueboard Slack API tool: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/slack_api_tool.go`
- Cueboard mention result path: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/mention.go`
- New Oneesama: `internal/slackagent/service_avatar.go`, `internal/slackagent/app_mention_tool_evidence.go`, `internal/agentrunner/prompt.go`

This follows the fail-closed audit. `51bd3ca` removed the unsafe prompt-curl bridge; this audit adds a first-class app-mention evidence dispatch path for fresh unknown entities.

## Summary

| Behavior                    | Old Cueboard Agent D                                              | New Oneesama after this audit                                                                                                                                        | Decision                                                             |
| --------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tool registration           | Slack sessions receive native tools through `RegisterSlackTools`. | The app-mention entry can run selected Go-side tools before starting the Codex worker and inject the result as `slackToolEvidence`.                                  | Port the entry-level behavior as evidence plumbing, not prompt-curl. |
| Fresh unknown entity search | Old assistant could call web/search tools at runtime.             | When an app mention asks about an unknown entity and related memory has no hit, Oneesama dispatches `exa_search` via `Service.ExecuteSlackTool` before worker start. | Provide first-class search evidence for the common quality gap.      |
| Worker prompt               | Old assistant saw native tool results through the agent loop.     | The prompt receives "Slack tool evidence" blocks and still forbids localhost/internal gateway access.                                                                | Keep the worker evidence-driven and fail-closed.                     |

## Behavior 1: Tool Evidence Is Dispatched By Go, Not Curl In Prompt

- Old does: `Bridge.RegisterSlackTools` registers `slack_api`, `read_doc`, `person_memory`, `suggest_action`, `usage_api`, `followup_memory`, credentialed proxies, and assistant-only helpers as native `agent.Tool` values (`slack_tools.go:20-86`).
- Previous new state: Codex worker prompt described a loopback gateway, then `51bd3ca` removed that unsafe prompt bridge and made missing evidence fail closed.
- New does now: `buildAgentRunnerContext` calls `collectAppMentionToolEvidence` while building the app-mention context. The collector invokes `Service.ExecuteSlackTool` directly and stores normalized results under `slackToolEvidence` and `SlackAppMentionContext.ToolEvidence`.
- Diff:
  - This is not a full interactive tool-call loop for Codex CLI.
  - It restores the critical entry behavior for fresh entity questions by pre-dispatching the relevant evidence in Go.
- Decision: port the practical app-mention search behavior now; keep full interactive worker tool loop as future infrastructure if needed.
- Fixtures: `TestAppMentionContextIncludesFirstClassFreshSearchEvidence`.

## Behavior 2: Fresh Entity Questions Get Search Evidence When Memory Has No Hit

- Old does: the assistant can call search/content tools after `person_memory` or local memory misses. The Cumora/yetone incident proved old runtime traces included `person_memory -> exa_search -> public evidence`.
- Previous new state: known entities could be recovered from migrated trace memory after `555feac`, but truly new entities still had no first-class fresh search path.
- New does now: if the app mention asks a fact/entity question, has no related-memory hit, and is not already covered by fetched links / linked Slack threads / Meet context, Oneesama runs `exa_search` through the Go Slack tool dispatcher and injects the excerpt.
- Diff:
  - The trigger is intentionally narrow to avoid searching for every casual mention.
  - External links still use the existing `fetchSlackExternalLinkContexts` reader path instead of a generic search.
- Decision: bounded first-class fresh search for the quality-critical unknown-entity path.
- Fixtures: `TestAppMentionContextIncludesFirstClassFreshSearchEvidence`, `TestBuildPromptSurfacesFirstClassSlackToolEvidence`.

## Remaining Follow-Ups

1. If Codex CLI later needs multi-step interactive tool calls, build a real command-provider tool loop instead of expanding heuristics.
2. Add a production canary where a brand-new person/project appears after cutover and the worker must cite `slackToolEvidence`.
3. Keep Class 2 routing keywords externalization on the #199 polish list; the fresh-search trigger is routing, not synthesis, but should still become template/config driven if workspaces diverge.
