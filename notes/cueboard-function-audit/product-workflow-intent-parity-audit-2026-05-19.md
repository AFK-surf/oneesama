# Product Workflow Intent Parity Audit — 2026-05-19

## Scope

Production regression class: Slack messages that contain GitHub PRs/issues, assignees, and workflow verbs such as "review", "approve", "merge", or "deploy" are operational work requests, not reading-material links. The bad symptom observed in backfill/app_mention quality review was a PR review request being treated as "补读这条分享" / generic link commentary.

## Cueboard Source

- `agent-framework/internal/bridge/slack/defaults.go:144-164`
- `agent-framework/internal/bridge/slack/mention.go:100-118`
- `agent-framework/internal/bridge/slack/heartbeat_context.go:120-125`
- `agent-framework/internal/bridge/slack/heartbeat_followup.go:510-521`

## New Oneesama Source

- `internal/slackagent/backfill_replay.go:607-655`
- `internal/slackagent/app_mention_workflow_evidence.go:10-118`
- `internal/slackagent/app_mention_tool_evidence.go:16-24`

## Behavior 1: PR/Code Questions Are Source/Workflow Tasks

- Old does: the assistant prompt says code/PR/implementation questions should inspect the available source repo first (`defaults.go:152`, `162-164`), and app mentions send full thread context through the assistant path (`mention.go:100-118`).
- New before this patch: backfill had an operational GitHub skip gate, but app_mention workers only saw raw prompt/link context and could treat a PR link as reading material.
- New after this patch: app_mention requests matching operational GitHub/workflow signals get a first-class `slack_workflow_context` evidence block.
- Decision: port the operational interpretation into app_mention evidence, without pretending we have already inspected the PR.
- Fixture: `TestAppMentionOperationalPRAddsWorkflowEvidence`.

## Behavior 2: Follow-Up / Review Work Is A Workflow Surface

- Old does: heartbeat context tags repo PR followups (`repo_pr_eligible`) and tests cover "Review PR request" / "Ping this thread later if nobody reviews the PR" as workflow records (`heartbeat_context.go:120-125`, `heartbeat_followup.go:510-521`).
- New after this patch: the workflow evidence names requested owners/actions/status, preserves addressed Slack users, and tells the worker not to summarize the PR as an article.
- Diff: this is a bounded app_mention quality fix, not full GitHub/Linear interactive workflow automation.
- Decision: fail closed. If safe PR/repo evidence is missing, say what is missing instead of inventing review/merge status.
- Fixture: `TestAppMentionOperationalPRAddsWorkflowEvidence`.

## Remaining Work

- The workflow intent keyword list is still a Class 2 routing heuristic in Go; externalize it with the other triage intent keyword templates during #199 polish.
- Full PR/issue status inspection belongs to task #221 interactive tool-loop parity / command-provider bridge work.
