# R31 User-Facing Logic Audit

Peng's product rule: users should ask naturally, and the agent should decide how to answer or route work internally. Implementation mechanism names must not become product commands.

| Area | Current state after R31 | Cueboard-style behavior | Gap action |
|---|---|---|---|
| User help text | `join`, `status`, `stop`, `help`, plus "mention me with what you need." No `delegate`, `jobs`, or provider names. | Help exposes only human workflow verbs. Background work is not a command users must remember. | Fixed in `avatarCommandUsage`, README, RFC, and cutover docs. |
| App mentions | Unknown/non-control mention text becomes an internal `work` action. | Users mention the bot with a normal request; the agent decides whether to answer inline or use a worker. | Fixed in `eventTextToAvatarCommand` / `service_events`. |
| Worker debug commands | `delegate` and `jobs` are hidden from `RunAvatarCommand`; tests assert they return unknown-command help with no implementation words. | Debug/worker controls stay operator-side, not user-facing product verbs. | Fixed and covered by `TestHandleAvatarCommandHidesWorkerDebugCommands`. |
| Assistant suggested prompts | Suggested prompts say "处理任务" and do not mention Codex/provider choice. | Prompts describe outcomes, not implementation. | Fixed in `assistant_client.go` and manifest prompt metadata. |
| Assistant status | Running background work status is generic: "Working on it..." | Status should reassure without surfacing backend/provider details. | Fixed in worker progress and status tests. |
| Triage low-risk URL/link handling | Read-only direct replies use `post_thread_reply` without confirmation; bare Slack permalinks are ignored unless explicitly requested. | Cueboard generally answered or stayed silent; confirmation cards were for mutations. | Fixed in R29 (`bcf2eef`) and retained here. |
| Triage action schema | Prompt no longer advertises `delegate`; legacy `delegate` model output normalizes to `create_task` for backward compatibility. | Triage talks about actions/outcomes, not worker mechanics. | Fixed in `triage_decision.go`. |
| Status surface | Visible meeting status says "Active background tasks" instead of "Worker jobs". Internal JSON fields remain for compatibility. | User-visible status should be product-level. | Fixed in `service_avatar_meeting.go`; internal API names left stable. |
| Remaining internal names | Some code/test names still contain `Delegate` or `Worker` for historical/internal package meaning. | Internal names can remain if not exposed to Slack users. | No product blocker; future refactor can rename internals mechanically if desired. |
