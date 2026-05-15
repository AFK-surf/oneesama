# Task #147 Cueboard Slack Surface Inventory

Status: active audit after live `f3cdc7f`.

This inventory replaces the earlier narrow "prompt/runtime parity" gate. The acceptance bar is now full surface parity for user-visible Cueboard Slack Agent D behavior, with explicit product exclusions called out rather than silently dropped.

Legend:

- `ported` means behavior exists in oneesama and has either parity tests or live evidence.
- `partial` means oneesama has an equivalent surface but source behavior, coverage, or live evidence is incomplete.
- `drift` means oneesama does something different enough to explain user-visible mismatches.
- `missing` means no oneesama implementation found.
- `product-excluded` means old Cueboard had it, but Peng explicitly removed it from current scope.

## Current Findings

| Priority | Surface | Status | Why it matters | Action |
|---|---|---:|---|---|
| P0 | Exact bot mention identity | ported in `f3cdc7f` | Fixed "cannot tell whether it was @mentioned"; old fallback matched any `<@U...>` mention. | Keep live watch + regression tests. |
| P0 | Triage should be silent by default | partial | Prompt is 1:1, but scanner/gates/tool availability can still make it speak too often. | Add live cueboard-vs-oneesama shadow checks before marking done. |
| P0 | External link read-first behavior | partial | `f3cdc7f` prefetches external links with Jina and suppresses "是否读取" cards; tool-level `exa_search/exa_contents` is still missing. | Port or shim web/search tool surface; keep prefetch as guardrail. |
| P0 | Memory / dreaming / self-growth | partial/missing | Follow-up and local memory exist; Cueboard self-growth/dreaming improvement workflow is not fully present. | Port missing self-growth signal + lesson workflow, or explicitly exclude. |
| P0 | Tool registry parity except credentialed apps | partial | Prompt advertises tools not all exposed/implemented by capabilities; LLM may not know how to fetch or remember. | Align prompt, capabilities, and actual handlers. |
| P1 | Meet join from triage cards | partial | Join card exists and recent extra triage reply fixed; live "加会加不进来" still needs interaction evidence. | Reproduce interaction from Slack payload/logs. |

## HTTP Routes

| Cueboard source | Cueboard surface | Oneesama source | Status | Gap / action |
|---|---|---|---:|---|
| `meeting_webhook.go:108` | Starts webhook HTTP server. | `handler.go:59` | ported | Oneesama registers `/webhooks/meeting-result`. |
| `meeting_webhook.go:110` | `POST /webhooks/meeting-result`. | `handler.go:60`, `handler_meeting_webhook.go:18` | ported | HMAC/parity covered by meeting webhook tests. |
| `meeting_webhook.go:111` | `GET /health`. | `handler.go:15` (`/slack/status`) plus process `/healthz` | partial | Health path shape differs; product impact low, but runtime probes use `/healthz` fallback. |
| `admin.go:16`, `admin.go:20-29`, `admin_templates.go:76-80` | Admin dashboard + JSON routes (`/admin`, `/admin/api/*`). | no direct admin dashboard; internal status routes in `handler.go:45-57` | product-excluded | Peng previously said admin/debug not needed. Do not block task #147, but keep listed. |
| `slash_commands.go:16` | Socket Mode slash command dispatch (`/usage`, `/status`). | `handler.go:19-21` (`/slack/commands/avatar`) and `socketmode_dispatch.go:76` | drift | Oneesama exposes avatar slash command, not old usage/status command semantics. User-facing impact currently low because product uses natural mentions and join card. |
| old TS parity docs `docs/slack-tools-parity.md` | `GET /tools/parity`, `/slack/tools/parity`, `POST /tools/call`, `/slack/tools/call`. | no Go route in `handler.go:13-61` | missing | If Go stack replaces old tool parity/debug endpoint, add route or explicitly kill it. |
| `admin.go:106` | Admin memory file browser. | `handler.go:54` (`GET /memory`) | partial | Search endpoint exists; old file-browser behavior intentionally not public. |
| `heartbeat_followup.go` + admin routes | Follow-up status/surface endpoints via admin/store. | `handler.go:47-50` | partial | Oneesama has internal follow-up create/surface/status and heartbeat context, but not old admin UX. |
| `meeting_webhook.go:179-182` | `meeting.digest` webhook enqueues copilot digest. | `service_meeting_webhook.go:19-24` has joined/processing/result only | missing | In-meeting copilot digest parity not ported to Slack side; may matter for realtime/meeting-copilot behavior. |

## Slack Event Handlers

| Cueboard source | Cueboard behavior | Oneesama source | Status | Gap / action |
|---|---|---|---:|---|
| `bridge.go:359-389` | Socket Mode acks `EventsAPI`, `Interactive`, `SlashCommand`. | `socketmode_dispatch.go:31-99` | ported | Shape equivalent; oneesama uses internal envelope structs. |
| `bridge.go:401-407` | `app_mention` -> `handleMention`. | `service_events.go:67-68` -> `handleEventAvatarCommand` | partial | Oneesama now strips exact bot ID, but does not fully port cueboard queued mention batching/status/history hooks. |
| `mention.go:26-54` | Mention auth, eyes reaction, queued thread lock, merge. | `service_events.go:145-230` | partial | No full `processQueuedMentions` queue/merge loop; oneesama has event dedupe and worker routing but not 1:1. |
| `mention.go:70-200` | Fetch full thread context, inject meeting context, status listener, history listener, run agent, suppress stale replies. | `app_mention_context.go`, `service_events.go:183-230`, `service_avatar.go` | partial | Full rich-thread context is mostly ported, but old history-forwarder/incremental delivery and queued merge behavior need live parity checks. |
| `bridge.go:407-411`, `mention_state.go:26` | `assistant_thread_started` sets suggested prompts. | `service_events.go:42-57` | ported | Suggested prompts cleaned in R31; parity should stay user-friendly. |
| `bridge.go:412-430` | DM message -> mention path; non-DM channel messages -> scanner buffer. | `service_events.go:69-106` | ported/partial | DM and channel buffer exist; `f3cdc7f` fixed bot mention filtering. Need live silence evidence. |
| `interaction.go:16-29` | Block action dispatch: dismiss, confirm, feedback. | `handler.go:27-30`, `service_interaction_dispatch.go`, `service_interactions.go` | partial | Join and pending-action paths exist; feedback/improvement tail is not fully old Cueboard. |
| `interaction.go:136-173` | Confirm/dismiss pending actions. | `service_pending_actions.go`, `triage_action_card.go` | partial | Join-meeting confirmation exists; third-party mutations excluded; action taxonomy should be compared for remaining non-credentialed actions. |
| `interaction.go:78` | Reply helpful/not-helpful feedback. | `pending_action_feedback.go`, `interaction_summary.go`; no full improvement loop | partial | Feedback can be stored/rendered, but self-growth learning loop is not complete. |
| `bridge.go:380-386`, `slash_commands.go:16-29` | Slash commands: usage/status. | `handler_avatar_command.go`, `avatar_command_parse.go` | drift | User-visible command vocabulary intentionally changed to `join/status/stop/help`; not a triage blocker unless Peng wants old slash commands. |

## Background Workers

| Cueboard source | Cueboard worker | Oneesama source | Status | Gap / action |
|---|---|---|---:|---|
| `bridge.go:302-306` | Starts scanners, webhook server, meeting scanner, socket loop. | `service.go`, `service_socketmode.go`, `service_scanner_poll.go:51` | partial | Services start, but exact scanner modes and meeting digest worker differ. |
| `scanner.go:53-96` | Legacy poll-mode scanner: cleanup stale reservations, collect digest, run triage, commit cursors only on success. | `service_scanner_poll.go:102-207`, `service_inbound.go:123-179` | partial | Oneesama uses Slack Web API scanner + inbound buffer; success/cursor semantics are close but not line-for-line. Needs live shadow. |
| `scanner_event.go:22-59` | Event-driven buffer with debounce/maxBatch, ignores active mention threads. | `service_events.go:74-85`, `inbound_buffer.go`, `service_inbound.go:16-24` | ported/partial | `f3cdc7f` ignores bot mentions; active mention thread filtering still needs exact parity audit. |
| `scanner_event.go:83-133` | Flush buffered channel, retry failed triage, cap retry messages. | `service_inbound.go:58-120` | partial | Oneesama flushes but retry/reinject behavior is not obviously equivalent. |
| `scanner_triage.go:21-60` | Serialized triage session, timeout, action recorder, persist, daily compact. | `service_triage.go:108-204`, `triage_action_recorder.go` | ported/partial | Prompt/action recorder parity improved; actual tools and model behavior still need live proof. |
| `scanner_triage.go:106-118` | Builds triage prompt with workspace memory, prior triage contexts, custom emoji. | `cueboard_prompts.go:39`, `triage_decision.go`; custom emoji not found | partial | Prompt is identical, but custom emoji injection and full workspace memory injection need explicit audit. |
| `scanner_compact.go:55-92` | Daily note compaction session. | `scanner_compact.go:15-68` | ported/partial | Exists; prompt/path thresholds need parity lock beyond current tests. |
| `meeting_scanner.go` | Scheduled meeting scanner from meetd. | `meeting_scanner.go`, `service_meeting_webhook.go` | partial | Meeting webhook result path ported; `meeting.digest` copilot and some scheduled watcher details missing. |
| `heartbeat.go:68-140` | Heartbeat delivery plan + notification surface. | `service_followups.go:10-96`, `heartbeat_store.go` | partial | Follow-up store/routes exist; heartbeat result listener/dream delivery is not a single old-equivalent loop. |
| `heartbeat_followup.go:23` | 30m supervisory commitment recheck interval and follow-up workflow. | `service_followups.go`, `heartbeat_store.go` | partial | Follow-up memory exists; recheck runner cadence and self-resolution need evidence. |
| `improvement_self_growth.go:14-31`, `improvement_self_growth.go:72-120` | Self-growth/dreaming signals from feedback, memory, proactivity, tool capability. | no direct equivalent; some local memory/lesson files | missing | This explains "记忆记录和做梦" gap. Port or create explicit current-design equivalent. |

## Tool Registrations

Peng scope for task #147: do not port credentialed external app integrations (`linear_api`, `notion_api`, `google_calendar_api`, `figma_api`). Other non-credentialed / local / workspace tools should be present or explicitly replaced.

| Cueboard source | Tool | Oneesama source | Status | Gap / action |
|---|---|---|---:|---|
| `slack_tools.go:20-24`, `tool_registration_test.go:48-63` | Full assistant registry: `audio_generation`, `figma_api`, `followup_memory`, `google_calendar_api`, `heartbeat_log`, `image_generation`, `linear_api`, `notion_api`, `person_memory`, `read_doc`, `runtime_status`, `slack_api`, `suggest_action`, `usage_api`. | `agentrunner/capabilities.go:73-87` | partial | Oneesama allows `slack_api/read_doc/person_memory/suggest_action/followup_memory/runtime_status/heartbeat_log/manage_schedule` but not `usage_api`, image/audio, or web search; credentialed apps excluded. |
| `tool_registration_test.go:69-90` | Planner/triage includes `followup_memory`, `person_memory`, excludes image/audio/runtime. | `agentrunner/capabilities.go:57-69` | partial | Triage includes `usage` not `usage_api`; no web/search tools. |
| `slack_api_tool_fetch.go`, `slack_api_tool_messages.go`, `slack_api_tool_canvas.go` | Slack fetch/reply/file/reaction/canvas/message actions. | `slack_api_tool_fetch.go`, `slack_api_tool_messages.go`, `canvas_api.go` | partial | Message posting shim currently supports only subset; planner-only restrictions exist. Need method matrix. |
| `suggest_tool.go` | `suggest_action` cards including join meeting, issue, event, channel. | `suggest_tool.go`, `meeting_approval.go` | partial | Join-meeting card exists; credentialed mutations excluded; channel/event scope should be marked or removed. |
| `people_memory_tool.go` | `person_memory`. | `people_memory_tool.go` | ported/partial | Exists; live behavior needs proof. |
| `heartbeat_log_tool.go`, `runtime_status_tool.go` | `heartbeat_log`, `runtime_status`. | `heartbeat_log_view.go`, `runtime_status.go` | ported/partial | Exists and tested; verify current live logs/status when asked. |
| `usage_tool.go` | `usage_api`. | prompt mentions `usage_api`; capabilities use `usage`; no handler found | drift | Rename/alias to `usage_api` or remove prompt advertisement. |
| `assistant_schedule_tool.go` | Schedule tool with assistant mutation gates. | `schedule_tool.go`, `schedule_filter.go` | partial | Registered as `manage_schedule`; mutation gate blocks creation by default. Need confirm intended product behavior. |
| `read_doc` legacy utility in `slack_tools.go:52-57` | Workspace doc read. | capability only; no direct Go tool executor found outside runner host tools | partial | If Codex/App Server provides `read_doc`, document source; otherwise implement local read-doc adapter. |
| old framework web tools shown in prompt/tests | `exa_search`, `exa_contents`. | `external_link_context.go` prefetch; no capability/tool executor | missing | User explicitly expects bot to fetch Twitter/web itself. Add explicit web search/content tool or map to runner provider. |
| `DefaultSystemPromptTemplate` | `memory_write`, `memory_search`, `memory_get`. | compact session capabilities in `agentrunner/capabilities.go:41-45`; local memory handlers | partial | Slack assistant/triage capabilities do not expose generic memory tools, despite prompt advertising them. |
| `image_generation_tool.go`, `audio_generation_tool.go` | Image/audio generation. | no oneesama tool executor | product-question | Peng did not confirm; not blocking triage unless requested. |
| `linear_tools.go`, `notion_tool.go`, `gcal_tools.go`, `figma_tools.go` | Credentialed app proxies. | deliberately blocked/excluded | product-excluded | Do not spend task #147 time unless Peng reopens scope. |

## Prompts / System Messages

| Cueboard source | Prompt/message | Oneesama source | Status | Gap / action |
|---|---|---|---:|---|
| `defaults.go:34-68` | `MeetingCopilotSystemPrompt`. | `cueboard_prompts.go:3-37` | ported | Byte parity passed in task #147 first slice. |
| `defaults.go:70-121` | `TriageSystemPrompt`. | `cueboard_prompts.go:39-90` | ported | Byte parity passed. |
| `defaults.go:123+` | `DefaultSystemPromptTemplate`. | `cueboard_prompts.go:92+`, `agentrunner/prompt.go:49-140` | ported/partial | Go const exists; agentrunner duplicates with delivery adapter and "date unavailable". Need single source to avoid drift. |
| `scanner_compact.go:55` | Daily-note compact prompt. | `scanner_compact_prompt.go`, `scanner_compact.go:70-104` | partial | Exists, but inventory should verify byte-level rules. |
| `mention_state.go:27-34` | Assistant suggested prompts: schedule/unread/Linear. | `assistant_client.go` + manifest prompt metadata | drift/product-excluded | R31 cleaned user-facing prompts; old Linear prompt not desired. |
| `assistant_status.go:15-29` | Tool-specific status labels, including `exa_search` / `exa_contents`. | `assistant_status.go`, `service_worker_jobs.go` | partial | If web tools are missing, status labels do not matter; once web tools added, ensure status parity. |
| `mention.go:215-220`, `mentionCompactionReply` | Queue ack and compaction message. | no exact queue ack; status "Thinking..." | partial | Missing queued mention merge ack can affect multiple rapid mentions. |

## Webhooks / Integrations

| Cueboard source | Integration | Oneesama source | Status | Gap / action |
|---|---|---|---:|---|
| `meeting_webhook.go:137-185` | Meet webhook events: joined, processing, result, digest. | `service_meeting_webhook.go:19-24` | partial | `meeting.digest` missing. |
| `bridge.go:164-167` | meetd client configured by URL. | `service_avatar_meeting.go`, config meeting agent endpoint | ported | Join/status/stop use meeting-agent. |
| `bridge.go:123-162` | GCal/Notion/Figma/Linear integrations initialized. | none / blocked | product-excluded | Peng excluded these credentialed app integrations. |
| `slack_api_tool_fetch.go` | Slack Web API thread/file/canvas fetch. | `slack_thread_fetch.go`, `slack_api_tool_fetch.go`, `canvas_api.go` | partial | Need method matrix for `conversations.replies`, file/image, canvas. |
| `file_upload.go`, `slack_api_tool_messages.go:141` | Slack file upload. | `slack_file_upload.go` | ported/partial | Meeting transcript/audio uploads pass; generic upload tool matrix still needs proof. |
| external web search/content | Exa through framework tools/status. | `external_link_context.go` via Jina reader only | drift | Use explicit tool registration, not only hidden prefetch. |

## State / Persistence

| Cueboard source | State | Oneesama source | Status | Gap / action |
|---|---|---|---:|---|
| `store.go:112-141` | SQLite `NewStore` with WAL and migration. | generic persistence provider + SQLite collections | partial | oneesama stores typed collections, not exact old schema. Product may accept if behavior parity holds. |
| `store.go:160+` | Old schema: channel, membership, thread_case, channel_brain, thread_ledger, pending action, triage, heartbeat, feedback, meetings. | `cognition_store.go`, `triage_store.go`, `heartbeat_store.go`, meeting stores | partial | Many concepts ported; exact schema/table names differ. |
| `store_triage.go:28-99` | Atomic triage run + actions + tool calls in SQLite. | `triage_store.go:57-154`, `store_triage.go:5-18` | partial | Typed collection version, behavior tests exist. Need export/inspection parity. |
| `store_heartbeat.go:46-88` | Follow-up kinds/status/surface records. | `heartbeat_store.go:17-57`, `service_followups.go` | partial | Concepts ported; delivery loop/self-growth incomplete. |
| `store_improvement.go`, `improvement_self_growth.go` | Improvement signals and lesson candidates. | no direct store found | missing | Port self-growth/dreaming memory flow or declare excluded. |
| `team_memory.go`, `people_memory.go` | Team and people memory files. | `team_memory.go`, `people_memory.go`, `local_memory.go` | ported/partial | Parity tests exist; live memory recall/write needs proof. |
| `triage_context.go:61`, `triage_context.go:154` | Previous triage contexts and archive path. | `triage_context.go`, archive helpers | ported/partial | Runtime parity slice covered ring buffer/archive; live prompt injection needs proof. |

## Immediate Work Queue

1. P0 live shadow test: replay the three evidence links against cueboard behavior and oneesama behavior, capture screenshots/logs, and do not call task #147 pass without that evidence.
2. P0 tool surface correction:
   - Add/alias `usage_api` or remove/replace prompt mention.
   - Add explicit web content/search capability (`exa_contents`/`exa_search` equivalent) or document that Jina prefetch is the product replacement.
   - Expose generic memory tools where the prompt tells the assistant to call them, or stop advertising them for Slack sessions.
3. P0 memory/dreaming/self-growth:
   - Port `improvement_self_growth.go` + `store_improvement.go` equivalent, or record explicit product exclusion.
4. P0 scanner silence:
   - Compare active mention thread filtering, retry/reinject, cursor commit, and direct reply thresholds against cueboard with live examples.
5. P1 Meet join interaction:
   - Trace the Slack Join button path for the evidence permalink and confirm whether interaction payload, meeting-agent call, or Meet runner failed.
6. P1 method matrices:
   - Slack API tool action matrix.
   - HTTP route matrix.
   - Persistence concept/table matrix.

## Non-Blocking Product Exclusions

- Credentialed app integrations: `linear_api`, `notion_api`, `google_calendar_api`, `figma_api`.
- Admin/debug dashboard routes unless Peng reopens admin UX.
- Image/audio generation until Peng confirms they should be in oneesama Slack assistant scope.
