# Post-Cutover Bridge Validation Sweep - 2026-05-19

## Scope

Peng asked to inspect the past week of Slack messages where people addressed Bridge and compare that with the new Oneesama/Pi handling path.

This sweep looked at:

- Old Slack Agent D SQLite triage log: `slack.db`.
- Old Slack Agent D triage archive / workspace traces.
- New Oneesama live state: `runtime/live-state/slack_triage_runs.json`.
- New Oneesama scanner / workspace contexts: `runtime/live-state/slack_workspace_contexts.json`.

## Counts

Old Slack Agent D, since `2026-05-12`:

| Query | Count |
|---|---:|
| All triage runs | 1824 |
| Bridge-related runs (`Bridge` / `bridge` / `<@U09SF0MQZ5M>`) | 343 |
| Bridge-related mutating runs | 17 |

New Oneesama live state, post-cutover window:

| Signal | Finding |
|---|---|
| `slack_triage_runs.json` Bridge-related hits | Present, but mostly scanner-level triage summaries |
| `slack_workspace_contexts.json` old Bridge mention hits | 3 item-level contexts |
| Old Bridge bot user ID still used by humans | `<@U09SF0MQZ5M>` |
| Current Oneesama bot user ID | `<@U0AP5UFU0FR>` |

## Representative Cases

| Case | Old/new signal | Result |
|---|---|---|
| `C09KVPBMLJ3:1779155610.872839` / `C0ALMF2AD70:1779155697.253139` | User asked old Bridge about Jc's five Case Study videos. | Earlier fixed by app-mention related-memory injection and entity attribution import. |
| `C09L0TAN31T:1779165686.034869` / reply `1779165695.173579` | User shared `agency-agents` and asked old Bridge whether it had been discussed. | Earlier fixed by deriving related-memory queries from fetched link context (#218). |
| `C09SSC9Q5HS:1779166071.849179` | User asked old Bridge to inspect channel videos and organize usable素材. | Not a clean app-mention parity case; it needs media/file reasoning and probably worker delegation. Keep as watchlist. |
| `C0AN9NDQUPN:1779156913.102829` | User asked old Bridge for the dashboard location. | Current sweep exposed the root routing gap: new Oneesama did not treat old Bridge mention ID as a mention alias. |

## Concrete Failure Found

People still address the old Bridge bot user ID:

```text
<@U09SF0MQZ5M>
```

The new Oneesama runtime only treated the current bot user ID as mention-equivalent:

```text
<@U0AP5UFU0FR>
```

That means:

- Socket `app_mention` does not fire for old Bridge mentions.
- Scanner reconciliation only compensated current Oneesama mentions.
- Message-mention fallback only accepted current Oneesama mentions.
- Old Bridge mentions could remain visible in scanner context while never entering the app-mention worker path.

This is an entry-level parity gap, not a model quality issue.

## Fix

Added configurable Slack bot mention aliases:

- Config field: `slack.bot_mention_user_ids`.
- Env vars:
  - `ONEESAMA_SLACK_BOT_MENTION_USER_IDS`
  - `ONEESAMA_SLACK_MENTION_USER_IDS`
  - `MAB_SLACK_BOT_MENTION_USER_IDS`

The runtime now combines:

```text
primary bot user ID + mention alias user IDs
```

and uses the combined list for:

- Slack event command mention stripping.
- Message-mention fallback.
- Scanner missed-mention reconciliation.
- Scanner ignore logic.
- Bot reply freshness / bot-authored reply filtering.
- Runtime status visibility.

The old Bridge ID should be configured live as:

```text
ONEESAMA_SLACK_BOT_MENTION_USER_IDS=U09SF0MQZ5M
```

## Verification Fixtures

New regressions cover:

- `eventTextToAvatarCommandForBotIDs` strips a legacy Bridge alias while preserving other user mentions.
- Scanner reconciles a missed `<@ULEGACY>` mention into the same app-mention worker path.
- Message-event mention fallback accepts `<@ULEGACY>` and strips it from the worker task text.
- Config file and env parsing both preserve bot mention alias IDs.

## Remaining Watchlist

1. Media-heavy old Bridge requests still need a separate media/file worker parity sweep.
2. Full interactive worker tool loop is not complete; #216 shipped bounded first-class fresh search, not every old Agent D tool.
3. Hardcoded Class 2 routing keywords should still be externalized during #199 polish.
4. After live alias deploy, watch the next 24h for old `<@U09SF0MQZ5M>` mentions and confirm they enter app-mention worker jobs instead of only scanner summaries.

