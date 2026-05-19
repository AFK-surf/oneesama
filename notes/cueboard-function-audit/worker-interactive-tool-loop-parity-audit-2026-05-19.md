# Worker Interactive Tool Loop Parity Audit — 2026-05-19

## Scope

- Cueboard Slack tool registration: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/slack_tools.go`
- Cueboard app mention session path: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/mention.go`
- Cueboard tool execution hooks: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/core/session/session.go`, `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/core/agent/agent.go`
- Cueboard Slack API tool surface: `~/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework/internal/bridge/slack/slack_api_tool.go`
- New Oneesama: `internal/agentrunner/prompt.go`, `internal/slackagent/worker_tool_bridge.go`, `internal/slackagent/service_worker_jobs.go`, `internal/slackagent/slack_tool_registry.go`

This follows the bounded pre-dispatch bridge in `worker-tool-bridge-parity-audit-2026-05-19.md`. That audit added first-class evidence before starting an app-mention worker. This audit closes the next parity gap: when the worker itself realizes it still needs evidence, the system must not rely on a prompt-only local curl fantasy.

## Summary

| Behavior | Old Cueboard Agent D | New Oneesama after this audit | Decision |
|---|---|---|---|
| Tool loop exists inside the assistant run | Native `agent.ToolRegistry` tools are attached to the Slack session and tool start/end hooks are forwarded. | A Slack worker can output a structured dispatcher request; the Go service intercepts it before Slack delivery, executes allowed tools, then starts a continuation job with injected evidence. | Port the user-visible contract with a bounded command-provider dispatcher loop. |
| Prompt does not pretend direct Slack tools exist | Old prompt names native tools because the runtime can execute them. | New prompt names a `<oneesama_tool_request>` protocol and explicitly says the command-provider worker does not call Slack-native tools directly. | Replace prompt-only tool assumptions with an explicit protocol. |
| Unsafe Slack mutations do not leak or duplicate | Old `slack_api` has role-aware guards and active-thread duplicate protections. | The dispatcher bridge rejects direct Slack posting/upload/delete/reaction calls and raw request blocks are never posted to Slack. | Fail closed; leave Slack delivery to the existing worker result pipeline. |
| Tool result affects the final answer | Old LLM sees tool results in the same session loop. | Continuation job receives `slackToolEvidence` containing normalized tool responses and the original task. | Use one continuation pass per tool batch; cap loops at 2. |

## Behavior 1: Native Tool Loop vs Bounded Dispatcher Continuation

- Old does: `Bridge.RegisterSlackTools` registers Slack proxy/helper/credentialed tools into an `agent.ToolRegistry` (`slack_tools.go:20-86`).
- Old does: app mentions call `SendMessageAndWait(..., b.newMentionHooks(...))` so a single assistant session can call tools while answering the mention (`mention.go:161-168`).
- Old does: session hooks forward tool starts/results/status into assistant state and external hooks (`session.go:2414-2442`, `agent.go:1022-1035`).
- Previous new state: command-provider Codex saw a prompt that listed tools, but the prompt did not give it a real runtime-native tool channel. Earlier fixes removed unsafe loopback curl and added pre-dispatch evidence, but a worker could still discover mid-answer that one more tool result was necessary.
- New does now: `handleAgentRunnerUpdate` calls `handleSlackWorkerToolRequest` before posting a terminal worker result. If the worker output contains exactly one `<oneesama_tool_request>` JSON block, the service executes allowed calls through `Service.ExecuteSlackTool`, stores formatted results in `slackToolEvidence`, and starts a continuation AgentRunner job.
- Diff:
  - This is not as general as old Agent D's model-native function calling.
  - It is enough for app-mention worker parity because the user-visible contract is "ask for needed workspace evidence, then answer", not "expose an unbounded internal tool loop".
- Decision: port a bounded dispatcher continuation now; leave a full command-provider function-calling runtime for a later architecture task if the bounded bridge proves insufficient.
- Fixtures: `TestSlackWorkerToolRequestStartsContinuationWithDispatcherEvidence`.

## Behavior 2: Prompt Contract Is Explicit, Not Implied By Tool Names

- Old does: `slackAPITool.Description` can list canonical Slack methods because `slack_api` is a native registered tool in the runtime (`slack_api_tool.go:172-199`).
- Previous new state: `cueboardDefaultSystemPromptForAgentRunner` copied Cueboard's "Available tools" / "Tool-first defaults" wording, which made the prompt look integrated even when the command-provider worker could not directly call those Slack tools.
- New does now: the Slack worker prompt has a `Dispatcher tool bridge` section. It tells the worker to use injected evidence first and to output only a `<oneesama_tool_request>` block when one more supported result is essential.
- Diff:
  - Prompt-listed tools are no longer counted as integration.
  - Unsupported credentialed third-party tools are explicitly out of scope unless injected evidence proves a result exists.
- Decision: prompt describes the actual protocol, not the old runtime's native tool surface.
- Fixtures: `TestSlackAssistantPromptUsesCueboardToolFirstDefaults`, `TestBuildPromptDoesNotTellSlackWorkerToCurlLocalGateway`.

## Behavior 3: Slack Mutations Are Rejected Unless The Bridge Can Execute Them Safely

- Old does: `slack_api` contains role-aware and active-thread guards before posting/mutating Slack (`slack_api_tool.go:224-252` plus message helpers).
- New does now: `slackWorkerToolBridgeRequestRejection` allows read/evidence tools plus bounded Slack API reads and Canvas create/edit, but rejects `chat.postMessage`, `slack.postThreadReply`, upload/delete/edit/reaction calls from app-mention worker requests.
- Diff:
  - Old Agent D can do broader native Slack mutations in some roles.
  - New Oneesama keeps app-mention worker delivery centralized to avoid duplicate replies and internal error leaks.
  - Canvas create/edit remains allowed because Canvas parity already established it as an explicit old-Agent-D behavior for app-mention work.
- Decision: support evidence + Canvas parity; reject direct Slack message/file/reaction side effects from the worker bridge.
- Fixtures: `TestSlackWorkerToolRequestRejectsUnsafeSlackPost`, `TestSlackWorkerResultTextFailClosesInternalGatewayLeak`.

## Behavior 4: Tool Evidence Is Fed Back Into The Same User Task

- Old does: tool results land in the same assistant session as subsequent messages.
- New does now: the continuation task says to continue the original Slack thread reply with the newly injected dispatcher evidence; `slackToolEvidence` accumulates per-pass results and `slack_worker_tool_loop_count` caps recursive loops.
- Diff:
  - The command-provider worker sees a continuation job rather than an in-process tool result message.
  - The user-visible Slack thread still receives only the final answer or a safe failure message.
- Decision: continuation is the least invasive bridge that keeps Codex CLI and Go orchestration separated while restoring the missing loop.
- Fixtures: `TestSlackWorkerToolRequestStartsContinuationWithDispatcherEvidence`.

## Remaining Follow-Ups

1. If workers frequently hit the two-pass loop cap, replace this protocol with a native command-provider tool-call API instead of raising the cap.
2. Add production validation cases where the worker asks for `slack_api conversations.replies`, `slack.fetchCanvas`, and `person_memory`, not only `memory_search`.
3. Externalize Class 2 routing keywords separately; this audit only changes the worker-loop contract.
