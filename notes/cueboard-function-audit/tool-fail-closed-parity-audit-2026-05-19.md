# Tool Fail-Closed Parity Audit — 2026-05-19

## Scope

- Cueboard registry: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/slack_tools.go`
- Cueboard mention delivery: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/mention.go`
- New Oneesama: `internal/agentrunner/prompt.go`, `internal/slackagent/service_worker_jobs.go`

This audit was triggered by Peng's app-mention quality comparison: the new worker tried to call the Slack tool gateway through `curl http://127.0.0.1:8780/slack/tools/call`, failed, and exposed that internal failure to the Slack thread.

## Summary

| Behavior                    | Old Cueboard Agent D                                                             | New Oneesama after this audit                                                                                    | Decision                                                                 |
| --------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Tool surface                | Tools are registered as native `agent.Tool` values through `RegisterSlackTools`. | The worker prompt no longer tells Codex to curl a local gateway; it must use injected evidence or fail closed.   | Stop prompt-as-implementation drift.                                     |
| Internal gateway failures   | No loopback gateway URL is part of the assistant-facing prompt.                  | Worker final text is sanitized before Slack delivery when it contains loopback/gateway/curl connection failures. | Add delivery-layer safety net.                                           |
| Fresh unknown entity search | Old Agent D could call native search/content tools.                              | Still not a native Codex worker tool bridge in this Go command-provider path.                                    | Keep as explicit follow-up; do not hide behind unsafe curl instructions. |

## Behavior 1: Tool Dispatch Is Native, Not Prompt-Curl

- Old does: `RegisterSlackTools` registers `slack_api`, `read_doc`, `person_memory`, `suggest_action`, `usage_api`, `followup_memory`, and credentialed proxy tools directly into the framework `ToolRegistry` (`slack_tools.go:20-86`).
- Previous new state: `buildSlackAssistantPrompt` told Codex workers to `POST JSON to http://127.0.0.1:8780/slack/tools/call` for Slack, memory, and web tools. That made the gateway URL part of product behavior even though the worker runtime may not be able to reach it.
- New does now: the Slack assistant prompt says to use injected Slack thread context, related-memory evidence, and explicit tool/evidence blocks. It explicitly says not to reach localhost, loopback URLs, or internal gateways, and to say it cannot safely verify a fact when required evidence is absent (`internal/agentrunner/prompt.go`).
- Diff:
  - Old Agent D had native tools. New Oneesama still does not expose native function tools to the Codex command provider.
  - The unsafe prompt-curl bridge is removed from the user-entry path until a first-class bridge exists.
- Decision: fail closed instead of pretending prompt text is tool integration.
- Fixtures: `TestBuildPromptDoesNotTellSlackWorkerToCurlLocalGateway`.

## Behavior 2: Worker Final Output Must Not Expose Internal Gateway Failures

- Old does: successful mention replies post the final assistant response to the thread (`mention.go:306-348`). Old runtime-level mention failures can post a warning with a bounded error string (`mention.go:286-303`), but the old assistant was not instructed to surface a localhost gateway workaround as part of normal answers.
- Previous new state: `postSlackWorkerResult` took `slackWorkerResultText(job)` and delivered it directly to Slack or Canvas. If the worker final answer included `curl http://127.0.0.1:8780/slack/tools/call` and `connection refused`, the delivery layer posted that internal detail verbatim.
- New does now: `slackWorkerResultText` runs final worker text through `failClosedSlackWorkerVisibleText`; if it detects loopback gateway markers, internal auth header names, or curl-to-localhost connection failures, it replaces the text with a short user-safe fail-closed message (`internal/slackagent/service_worker_jobs.go`).
- Diff:
  - This is a new safety net rather than an old-code port. It compensates for the Go rewrite's command-provider architecture.
  - Normal worker answers remain unchanged.
- Decision: add delivery-layer fail-closed protection for internal tool bridge leaks.
- Fixtures: `TestSlackWorkerResultTextFailClosesInternalGatewayLeak`, `TestSlackWorkerResultTextKeepsNormalWorkerAnswer`.

## Open Follow-Ups

1. Implement a first-class worker tool bridge for the Codex/Claude command-provider path, or route app-mention tool needs through the Pi persona / delegated-reader path. The bridge must be tested as an entry-level behavior, not by prompt wording.
2. Add a production-style app-mention canary for an unknown fresh entity: no existing memory hit, requires search/content evidence, and must either cite fresh evidence or fail closed without leaking internals.
3. Audit other user-visible worker surfaces for raw internal errors: slash command ephemeral start errors, Canvas publish fallback notifications, and meeting-worker result delivery.
