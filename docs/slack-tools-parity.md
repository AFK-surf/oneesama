# Slack Tool Compatibility

This repo keeps a Slack compatibility layer so existing tool names and request
shapes stay stable while the implementation lives in this codebase. Private
memory and tokens stay in local ignored paths.

## Runtime Adapter

The new Slack Agent exposes a compatibility registry:

- `GET /tools/parity`
- `GET /slack/tools/parity`
- `POST /tools/call`
- `POST /slack/tools/call`

The registry lives in:

`packages/core/src/slack/legacy-slack-tool-registry.js`

Local smoke:

```bash
vp run smoke:slack-tool-registry
```

The smoke exercises the generic `slack_api` proxy against a mock Slack Web API
for the Slack-native surface we need before live cutover: channel fetch
(`conversations.history`), thread fetch (`conversations.replies`), file lookup
(`files.info`), reaction, pin, update, and delete calls. Third-party
credentialed tools such as Linear, Calendar, Figma, Notion, and usage remain
explicit fail-closed adapter slots.

## Port Map

| Legacy tool            | Old source                     | New adapter status                                                                                                                       |
| ---------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `slack_api`            | `slack_api_tool*.go`           | Active via Slack Web API adapter when `SLACK_BOT_TOKEN` is present; smoke covers fetch/thread/file/reaction/pin/update/delete forwarding |
| `read_doc`             | `slack_tools.go`               | Active local workspace doc reader                                                                                                        |
| `person_memory`        | `people_memory_tool.go`        | Active via local private memory seed                                                                                                     |
| `followup_memory`      | `heartbeat_followup.go`        | Active via local private memory seed                                                                                                     |
| `suggest_action`       | `suggest_tool.go`              | Active confirmation-envelope stub; UI execution remains separate                                                                         |
| `runtime_status`       | `runtime_status_tool.go`       | Active local service/socket/memory status                                                                                                |
| `heartbeat_log`        | `heartbeat_log_tool.go`        | Active local status-log envelope                                                                                                         |
| `notify_meeting_slack` | `meeting_slack_notify_tool.go` | Active via Slack Web API `chat.postMessage`                                                                                              |
| `run_command`          | `run_command_tool.go`          | Fail-closed by default; opt-in only with `MAB_ENABLE_RUN_COMMAND_TOOL=1` and allowlist                                                   |
| `linear_api`           | `linear_tools.go`              | Adapter slot present; requires Linear provider or agent-runner MCP                                                                       |
| `google_calendar_api`  | `gcal_tools.go`                | Adapter slot present; requires calendar provider credentials                                                                             |
| `notion_api`           | `notion_tool.go`               | Adapter slot present; requires Notion token/provider                                                                                     |
| `figma_api`            | `figma_tools.go`               | Adapter slot present; requires Figma provider credentials                                                                                |
| `usage_api`            | `usage_tool.go`                | Adapter slot present; requires old usage backend or replacement                                                                          |
| `image_generation`     | `image_generation_tool.go`     | Adapter slot present; requires image provider                                                                                            |
| `audio_generation`     | `audio_generation_tool.go`     | Adapter slot present; requires audio provider                                                                                            |
| `send_meeting_chat`    | `copilot_tools.go`             | Adapter slot present; requires meeting chat provider                                                                                     |
| `manage_schedule`      | `assistant_schedule_tool.go`   | Adapter slot present; requires scheduler provider                                                                                        |

The first port keeps historical tool names stable and makes unavailable tools
fail closed instead of silently pretending to work. Follow-up slices can replace
each external-required slot with a real provider without changing the registry
surface.

## Domain Store Backbone

Tool execution is only one layer of the old Slack Agent. The compatibility
layer also keeps a
workspace domain store for channel cache, thread ledgers, channel brain,
pending actions, heartbeat followups/surfaces, and triage runs. The new Slack
Agent now creates that table family through `MAB_SLACK_DOMAIN_STORE=1` and
`MAB_SLACK_DOMAIN_DB_PATH`.

Smoke:

```bash
vp run smoke:slack-domain-store
```

Runtime inspection:

```bash
curl http://127.0.0.1:8780/slack/domain/status
curl "http://127.0.0.1:8780/slack/domain/context?workspace=T123&channel=C123&thread=1710000000.000000"
```

Channel/member cache refresh:

```bash
curl -X POST http://127.0.0.1:8780/slack/domain/refresh \
  -H 'content-type: application/json' \
  -d '{"workspace":"T123"}'
```

When `channels` are supplied in the request body, the route refreshes from that
fixture payload. Without `channels`, it uses the configured Slack bot token to
page `conversations.list` and `conversations.members`.

This is the P0 foundation for porting `heartbeat.go`, `mention.go`, and
`scanner_triage.go`; those flows can now write to compatibility-shaped tables
instead of inventing new storage.

## Scanner Triage Flow

The Slack Agent now ports the first real `scanner_triage.go` slice:

1. Socket Mode / Events API message events enter the per-channel debounce
   buffer.
2. Optional scanner sweeps can call `POST /slack/scanner/sweep` to reconcile
   `event_cursor`, backfill `conversations.history`, and feed only unseen
   messages into the same buffer.
3. `flushSlackMessageBuffer()` renders the compatibility digest.
4. `startSlackTriage()` sends the digest, channel brain, and local memory
   context to the selected `AgentRunner`.
5. Completed triage jobs are parsed as JSON decisions. If a local dry-run
   provider returns no JSON, a small fail-safe heuristic can still surface an
   obvious follow-up for local smoke testing.
6. The result updates `triage_run`, `triage_action`, `triage_tool_call`,
   `channel_brain`, `pending_action`, and `thread_ledger`.
7. Pending actions can be posted as Slack action cards with Confirm, Dismiss,
   Snooze, Open thread, and Assign controls; each interaction updates the same
   local domain store and thread ledger.

Env:

```bash
MAB_SLACK_EVENT_TRIAGE=1
MAB_SLACK_TRIAGE_POST_ACTIONS=1
MAB_SLACK_TRIAGE_HEURISTIC_FALLBACK=1
```

Smoke:

```bash
vp run smoke:slack-triage-flow
```

Runtime inspection:

```bash
curl http://127.0.0.1:8780/slack/triage/status
curl -X POST http://127.0.0.1:8780/slack/inbound/flush \
  -H 'content-type: application/json' \
  -d '{"channel":"C123"}'
curl -X POST http://127.0.0.1:8780/slack/scanner/sweep \
  -H 'content-type: application/json' \
  -d '{"workspace":"T123","channel":"C123"}'
```

This intentionally does not port credentialed Linear/Notion/Figma tool bodies:
those can route through the chosen Codex/MCP/AgentRunner provider.
The owned product logic here is the Slack Agent's channel sensing, triage
decision, pending-action ledger, and confirmation loop.

Pending-action taxonomy:

- Action types accepted from triage/suggest-action style output:
  `post_thread_reply`, `follow_up`, `create_task`, `ask_user`, `create_issue`,
  `add_comment`, `create_event`, `join_meeting`, `create_channel`, `none`.
- Interaction outcomes persisted by Slack actions: `confirmed`, `dismissed`,
  `snoozed`, `assigned`, `opened`.
- Credentialed bodies for Linear/Calendar/third-party mutations are outside the
  OSS migration scope; confirmation cards still preserve the typed envelope so a
  Codex-backed worker or later provider can execute the approved action.
