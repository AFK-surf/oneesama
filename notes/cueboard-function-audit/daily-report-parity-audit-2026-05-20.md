# Daily Report + Triage Quality Parity Audit — 2026-05-20

## Scope

Peng asked for new Oneesama to send a daily report like old cueboard slackd, and to compare daily overall triage quality against old slackd, including emoji usage.

This audit follows the read-old-first migration rule: old behavior is the baseline, new behavior must either port the contract or explicitly justify divergence.

**2026-05-20 correction after Peng review:** the first implementation invented a new "quality buckets" report vocabulary. Peng clarified the goal is to replicate the previous daily-audit reading shape so old/new reply quality can be compared in the same language. The report renderer now uses the old action-bucket form (`reply / like / repost / quote / pending / skipped / stale-aged / failed / discovered`) and keeps quality observations under `Self-iteration notes`, instead of creating a separate taxonomy.

## Cueboard source

- Old schedule engine: `agent-framework/internal/core/schedule/schedule.go`
- Old framework schedule dispatch: `agent-framework/internal/framework/framework.go`
- Old Slack usage/report tool: `agent-framework/internal/bridge/slack/usage_tool.go`
- Old triage source of truth: `slack.db` tables `triage_run`, `triage_action`, and `triage_tool_call`
- Old daily-audit shape reference: OpenClaw/Twitter daily audit builder `~/.openclaw/twitter-bot/twitter_reply_bot.py::build_daily_audit`, which reports action buckets and self-iteration notes, and later posts a short Slack summary while keeping details in Canvas.

## New Oneesama source

- Daily report implementation: `internal/slackagent/daily_report.go`
- Internal API routes: `internal/slackagent/handler.go`, `internal/slackagent/handler_daily_report.go`
- Config surface: `pkg/config/config.go`, `pkg/config/raw_config.go`, `pkg/config/raw_env.go`
- Tests: `internal/slackagent/daily_report_test.go`, `pkg/config/config_env_test.go`

## Behavior 1: daily dispatch is scheduled and durable enough for live operation

### Old does

- `schedule.Definition` stores name, prompt, cron expression, timezone, count/date limits, and run history (`schedule.go:29-38`, `schedule.go:82-120`).
- The scheduler arms a timer for the next cron time and dispatches at that time (`schedule.go:321-390`).
- Framework startup restores all schedules (`framework.go:183-209`).
- Scheduled dispatch creates a scheduled execution session and calls `SendScheduledMessage(...)` with the schedule name, prompt, timezone, and current time (`framework.go:363-392`).

### New does

- `SlackDailyReportConfig` adds explicit daily report config: enabled, channel, local time, timezone, window, legacy DB path, and legacy archive path (`pkg/config/config.go:31-49`).
- `Service.startDailyReportTicker` starts one owned ticker when enabled and channel is configured (`internal/slackagent/daily_report.go:196-208`).
- `nextSlackDailyReportRun` computes the next configured local wall-clock time in the requested timezone (`internal/slackagent/daily_report.go:747-760`).
- `SlackDailyReportRecord` persists one post per channel/date in the `slack_daily_reports` typed collection, and `RunDailyReport` dedupes repeated posts unless `force=true` (`internal/slackagent/daily_report.go:160-176`, `internal/slackagent/daily_report.go:260-320`).

### Diff

- New Oneesama does not port the generic user-managed schedule manager. It implements a narrow first-class daily report schedule for this product-owned report.
- This is a deliberate divergence: user-created arbitrary schedules are a separate product surface, while Peng asked for the product-owned daily Oneesama/slackd comparison report.

### Decision

Keep the narrow daily report scheduler now. Reuse the typed persistence dedupe record so live restarts do not duplicate the same date/channel report.

### Fixtures

- `TestNextSlackDailyReportRunUsesConfiguredTimezone`
- `TestSlackDailyReportRunPostsOncePerDateAndChannel`

## Behavior 2: report compares new Oneesama against old slackd triage, not just itself

### Old does

- Old slackd persists triage run history in `slack.db` tables `triage_run`, `triage_action`, and `triage_tool_call`.
- Tool/action rows contain user-visible mutations such as `post_thread_reply` and `add_reaction`, plus evidence/tooling such as `memory_get`, `person_memory`, `exa_search`, and `fetch_thread`.

### New does

- `BuildDailyReport` collects new Oneesama triage runs from the current typed triage store, filters the requested report window, and builds metrics (`internal/slackagent/daily_report.go:323-357`).
- It loads old slackd triage runs from `legacy_slack_db_path`, falling back to `legacy_triage_archive_dir` if configured (`internal/slackagent/daily_report.go:359-374`).
- SQLite loading maps old `triage_run`, `triage_action`, and `triage_tool_call` into the same `SlackTriageContext` shape used by new Oneesama (`internal/slackagent/daily_report.go:377-450`).

### Diff

- Old slackd did not need to compare against itself. New Oneesama intentionally introduces a comparison report because the migration risk is quality regression against old slackd.

### Decision

Port the old durable source of truth and extend it: new daily report includes `new_oneesama`, `legacy_slackd`, and deltas.

### Fixtures

- `TestSlackDailyReportComparesLegacyEmojiUse`

## Behavior 3: report uses the old daily-audit action buckets

### Old does

- Old `usage_api` can generate Slack rich reports for usage dashboards and automatically post them for non-assistant roles (`usage_tool.go:74-80`, `usage_tool.go:103-125`, `usage_tool.go:371-430`).
- The prior daily-audit report shape groups outcome by action: `reply`, `like`, `repost`, `quote`, `pending`, `skipped`, `stale-aged`, `failed`, and `discovered`; it also includes `Reply category mix`, `Liked`, `Reposted`, `Quoted`, `Pending review`, `Skipped category mix`, `Failed`, and `Self-iteration notes` (`twitter_reply_bot.py:2844-2897`).
- Old triage logs preserve enough run/tool/action state to reconstruct equivalent action buckets from persisted history.

### New does

- `buildSlackDailyTriageMetrics` counts runs, failures, mutations, reply runs, reaction runs, no-action runs, parse fallbacks, placeholder summaries, invalid persona JSON, high-context no-action, link-context no-action, low-confidence no-action, memory lookups, external searches, thread fetches, persona failures, and delegate worker jobs (`internal/slackagent/daily_report.go:493-620`).
- `buildSlackDailyReportFlags` promotes red/yellow quality signals into the report (`internal/slackagent/daily_report.go:625-642`).
- `formatSlackDailyReportText` renders those metrics in the old daily-audit action-bucket vocabulary:
  - `New Oneesama summary` / `Old slackd summary`
  - `reply / like(reaction) / repost / quote / pending / skipped / stale-aged / failed / discovered`
  - `Reply category mix`, `Liked / emoji reactions`, `Skipped category mix`, `Failed`
  - `Emoji audit`
  - `Self-iteration notes`
  (`internal/slackagent/daily_report.go:645-730`).

### Diff

- New report maps Slack emoji reactions to the old `like` bucket because that is the closest Slack-side lightweight action. `repost` and `quote` stay present as zero-valued buckets to preserve the old daily-audit shape.
- New report is mrkdwn text through the existing poster seam, not Canvas-first yet. This is a temporary delivery divergence; the wording/measurement vocabulary is now old-format-compatible.

### Decision

Use old daily-audit action buckets now. Do not reintroduce `Quality buckets` / `invalid_json=` style headings in the visible report; those remain internal counters and become notes only when they affect the action-bucket comparison.

### Fixtures

- `TestSlackDailyReportComparesLegacyEmojiUse`
- `TestSlackDailyReportRunPostsOncePerDateAndChannel`

## Behavior 4: emoji use is a first-class quality dimension

### Old does

- Old slackd can use `slack_api/add_reaction` and persisted `triage_action` rows include `add_reaction`.
- Old cueboard also injected workspace custom emoji into cognition; that separate parity slice was fixed in the custom emoji reaction audit.

### New does

- Daily metrics parse `:emoji_name:` from both triage actions and Slack tool call result/brief text (`internal/slackagent/daily_report.go:543-589`, `internal/slackagent/daily_report.go:870-881`).
- Metrics separately count `reaction_runs`, `reaction_mutations`, `custom_emoji_runs`, `custom_emoji_uses`, `top_emoji`, and `top_custom_emoji` (`internal/slackagent/daily_report.go:77-108`).
- Custom emoji is matched against the current workspace custom emoji cache via `workspaceCustomEmojiSnapshot()` (`internal/slackagent/daily_report.go:335-336`, `internal/slackagent/daily_report.go:488-496`).
- Report flags highlight when old slackd used reactions but new Oneesama did not, or when new Oneesama reacted but did not use workspace custom emoji (`internal/slackagent/daily_report.go:633-638`).

### Diff

- Old slackd did not produce an explicit "emoji regression" report. New Oneesama adds it because Peng identified emoji/reaction behavior as a migration-quality dimension.

### Decision

Keep emoji as a daily quality dimension, not only a tool capability.

### Fixtures

- `TestSlackDailyReportComparesLegacyEmojiUse`

## Behavior 5: operator can run the report manually

### Old does

- Old slackd `usage_api` could be invoked as a tool and would post a report in the current Slack thread (`usage_tool.go:103-125`).

### New does

- Internal routes expose status and manual execution:
  - `GET /slack/daily-report/status`
  - `POST /slack/daily-report/run`
- Manual run supports `dry_run`, `force`, `channel/channel_id`, `window`, and `report_date` through JSON body or query parameters (`internal/slackagent/handler.go:49-50`, `internal/slackagent/handler_daily_report.go:11-60`).

### Diff

- New manual trigger is an internal operator API, not an agent tool exposed to workers. This keeps report posting under operator control.

### Decision

Use internal API now. A Slack command wrapper can be added later if humans want to request ad-hoc reports from Slack.

### Fixtures

- `TestSlackDailyReportRunPostsOncePerDateAndChannel`

## Open follow-ups

- Add Canvas-first delivery if #meeting-avatar wants to mirror the later Twitter daily-audit delivery path exactly: short Slack message + reusable Canvas detail.
- Add channel-level breakdown once daily report consumers want more than workspace-level quality.
- Add explicit old slackd custom emoji cache snapshot if historical comparison should judge old custom emoji usage against old custom emoji list rather than current workspace list.
