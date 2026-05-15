# Task #147 Cueboard Slack Surface Inventory

Status: active audit after live `cd31653`; tool-surface slice in progress.

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
| P0 | Exact bot mention identity | ported in `f3cdc7f` + shadow harness | Fixed "cannot tell whether it was @mentioned"; old fallback matched any `<@U...>` mention. `TestTask147ShadowHarnessRecognizesExplicitBotMention` locks exact mention handling through `/slack/events`. | Keep live watch. |
| P0 | Triage should be silent by default | ported/partial | Prompt is 1:1 and shadow harness now covers plain observation silence + assistant self-comment silence through the scanner path. Still needs real Slack screenshot/log evidence before final task acceptance. | Run live cueboard-vs-oneesama shadow checks before marking done. |
| P0 | External link read-first behavior | ported | `f3cdc7f` prefetches external links with Jina and suppresses "是否读取" cards; `TestTask147ShadowHarnessReadsExternalLinkWithoutConfirmation` locks direct source-thread answer. The tool gateway now exposes `exa_contents` via the same Jina reader and `exa_search` via Jina search compatibility. | Keep live watch. |
| P0 | Memory / dreaming / self-growth | partial | Follow-up and local memory exist; current slices port Cueboard-style self-growth signals into heartbeat follow-ups, lesson candidates, managed `MEMORY.md`, and visible heartbeat/dream delivery guards (6h rate limit, quiet hours, public rate limit, newer-activity block). Dedicated live shadow evidence still pending. | Live-shadow self-growth and visible heartbeat/dream behavior against old bridge. |
| P0 | Tool registry parity except credentialed apps | ported/partial | `/slack/tools/parity` now lists active local equivalents for `slack_api`, `read_doc`, memory, `exa_search`, `exa_contents`, runtime/follow-up helpers, and explicit product exclusions for Linear/Notion/Calendar/Figma. Image/audio and meeting-chat providers remain product/pending decisions. | Keep matrix updated as providers land. |
| P1 | Meet join from triage cards | ported | Evidence thread showed two separate paths: direct @ with Meet URL posted a join setup card correctly, while bare Meet-link triage created a `join_meeting` pending action. The real gap was pending-action confirm only marked `confirmed` and never executed the meeting join. | `TestHandleInteractionConfirmedJoinMeetingPendingActionExecutesMeetJoin` locks confirm -> `/join/google-meet` -> source-thread joined post. |

## HTTP Routes

| Cueboard source | Cueboard surface | Oneesama source | Status | Gap / action |
|---|---|---|---:|---|
| `meeting_webhook.go:108` | Starts webhook HTTP server. | `handler.go:59` | ported | Oneesama registers `/webhooks/meeting-result`. |
| `meeting_webhook.go:110` | `POST /webhooks/meeting-result`. | `handler.go:60`, `handler_meeting_webhook.go:18` | ported | HMAC/parity covered by meeting webhook tests. |
| `meeting_webhook.go:111` | `GET /health`. | `handler.go:15` (`/slack/status`) plus process `/healthz` | partial | Health path shape differs; product impact low, but runtime probes use `/healthz` fallback. |
| `admin.go:16`, `admin.go:20-29`, `admin_templates.go:76-80` | Admin dashboard + JSON routes (`/admin`, `/admin/api/*`). | no direct admin dashboard; internal status routes in `handler.go:45-57` | product-excluded | Peng previously said admin/debug not needed. Do not block task #147, but keep listed. |
| `slash_commands.go:16` | Socket Mode slash command dispatch (`/usage`, `/status`). | `handler.go:19-21` (`/slack/commands/avatar`) and `socketmode_dispatch.go:76` | drift | Oneesama exposes avatar slash command, not old usage/status command semantics. User-facing impact currently low because product uses natural mentions and join card. |
| old TS parity docs `docs/slack-tools-parity.md` | `GET /tools/parity`, `/slack/tools/parity`, `POST /tools/call`, `/slack/tools/call`. | `handler.go` + `handler_tools.go` | ported | Internal-auth guarded routes report the tool matrix and execute active local equivalents. |
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
| `interaction.go:136-173`, `interaction.go:425-458`, `interaction.go:684-733` | Confirm/dismiss pending actions and execute confirmed `join_meeting`. | `service_pending_actions.go`, `service_pending_join.go`, `triage_action_card.go` | ported/partial | `join_meeting` confirmation now executes the meeting-agent join and posts the joined/failure result back into the source thread. Third-party mutations remain excluded; action taxonomy should be compared for remaining non-credentialed actions. |
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
| `heartbeat.go:68-140` | Heartbeat delivery plan + notification surface. | `service_heartbeat_surface.go`, `heartbeat_store.go` | ported/partial | Visible follow-up surfacing now uses Cueboard-style delivery planning: auto thread/channel/DM selection, no-user target blocks, 6h repeat guard, 09:00-21:00 public hours, 12h public surface cap, newer thread activity block, surface records, and thread ledger outbound. Still needs real Slack shadow evidence and old heartbeat-result listener parity review. |
| `heartbeat_followup.go:23` | 30m supervisory commitment recheck interval and follow-up workflow. | `service_followups.go`, `heartbeat_store.go` | partial | Follow-up memory exists; recheck runner cadence and self-resolution need evidence. |
| `improvement_self_growth.go:14-31`, `improvement_self_growth.go:72-120` | Self-growth/dreaming signals from feedback, memory, proactivity, tool capability. | `improvement_self_growth.go`, `improvement_store.go`, `service_events.go`, `service_inbound.go`, `service_heartbeat_surface.go` | partial | Signal detection, cluster follow-ups, lesson candidates, managed self-growth memory block, and visible heartbeat/dream delivery guards are ported. Still need live shadow evidence. |

## Tool Registrations

Peng scope for task #147: do not port credentialed external app integrations (`linear_api`, `notion_api`, `google_calendar_api`, `figma_api`). Other non-credentialed / local / workspace tools should be present or explicitly replaced.

| Cueboard source | Tool | Oneesama source | Status | Gap / action |
|---|---|---|---:|---|
| `slack_tools.go:20-24`, `tool_registration_test.go:48-63` | Full assistant registry: `audio_generation`, `figma_api`, `followup_memory`, `google_calendar_api`, `heartbeat_log`, `image_generation`, `linear_api`, `notion_api`, `person_memory`, `read_doc`, `runtime_status`, `slack_api`, `suggest_action`, `usage_api`. | `agentrunner/capabilities.go:73-87`, `slack_tool_registry.go` | ported/partial | Local gateway exposes active equivalents plus a `usage_api` status stub; credentialed apps are product-excluded; image/audio remain product-question. |
| `tool_registration_test.go:69-90` | Planner/triage includes `followup_memory`, `person_memory`, excludes image/audio/runtime. | `agentrunner/capabilities.go:57-69`, `/slack/tools/call` | ported/partial | Runner capabilities still use legacy compact names, but the loopback gateway exposes cueboard names for Slack assistant/triage prompts. |
| `slack_api_tool_fetch.go`, `slack_api_tool_messages.go`, `slack_api_tool_canvas.go` | Slack fetch/reply/file/reaction/canvas/message actions. | `slack_api_tool_fetch.go`, `slack_api_tool_messages.go`, `canvas_api.go`, `slack_tool_registry.go` | ported/partial | Matrix now covers thread/history fetch, upload, post/reply, reactions, delete/update, emoji, pins, topic/purpose, bookmarks, and invite. Canvas/image/DM actions are registered unavailable until providers land. |
| `suggest_tool.go`, `interaction.go:684-733` | `suggest_action` cards including join meeting, issue, event, channel. | `suggest_tool.go`, `service_pending_join.go`, `meeting_approval.go` | ported/partial | `join_meeting` pending cards now execute on Confirm, infer `meet_url` from params/message/thread transcript, call `/join/google-meet`, and post result back into the source thread. Credentialed mutations excluded; channel/event scope should be marked or removed. |
| `people_memory_tool.go` | `person_memory`. | `people_memory_tool.go` | ported/partial | Exists; live behavior needs proof. |
| `heartbeat_log_tool.go`, `runtime_status_tool.go` | `heartbeat_log`, `runtime_status`. | `heartbeat_log_view.go`, `runtime_status.go` | ported/partial | Exists and tested; verify current live logs/status when asked. |
| `usage_tool.go` | `usage_api`. | `slack_tool_registry.go` | ported/partial | Exposed as `active_stub` so prompt/tool matrix no longer lies; returns explicit local-backend-not-configured until a real usage provider is wired. |
| `assistant_schedule_tool.go` | Schedule tool with assistant mutation gates. | `schedule_tool.go`, `schedule_filter.go` | partial | Registered as `manage_schedule`; mutation gate blocks creation by default. Need confirm intended product behavior. |
| `read_doc` legacy utility in `slack_tools.go:52-57` | Workspace doc read. | `slack_tool_registry.go` | ported | Local adapter reads workspace `README.md` and `docs/*.md` only; hidden files and unrelated paths are blocked. |
| old framework web tools shown in prompt/tests | `exa_search`, `exa_contents`. | `external_link_context.go`, `slack_tool_registry.go` | ported | `exa_contents` uses Jina reader compatibility; `exa_search` uses Jina search compatibility. The cueboard tool names remain stable for model behavior. |
| `DefaultSystemPromptTemplate` | `memory_write`, `memory_search`, `memory_get`. | `local_memory.go`, `service_memory.go`, `slack_tool_registry.go` | ported | Loopback gateway exposes generic memory search/get/write with memory-path guards. |
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
| external web search/content | Exa through framework tools/status. | `external_link_context.go`, `slack_tool_registry.go` | ported | Explicit `exa_search` and `exa_contents` tool calls preserve the old names while using Jina-compatible public fetchers. |

## State / Persistence

| Cueboard source | State | Oneesama source | Status | Gap / action |
|---|---|---|---:|---|
| `store.go:112-141` | SQLite `NewStore` with WAL and migration. | generic persistence provider + SQLite collections | partial | oneesama stores typed collections, not exact old schema. Product may accept if behavior parity holds. |
| `store.go:160+` | Old schema: channel, membership, thread_case, channel_brain, thread_ledger, pending action, triage, heartbeat, feedback, meetings. | `cognition_store.go`, `triage_store.go`, `heartbeat_store.go`, meeting stores | partial | Many concepts ported; exact schema/table names differ. |
| `store_triage.go:28-99` | Atomic triage run + actions + tool calls in SQLite. | `triage_store.go:57-154`, `store_triage.go:5-18` | partial | Typed collection version, behavior tests exist. Need export/inspection parity. |
| `store_heartbeat.go:46-88` | Follow-up kinds/status/surface records. | `heartbeat_store.go`, `service_followups.go`, `service_heartbeat_surface.go` | ported/partial | Concepts and delivery guards ported with typed-collection schema rather than exact old SQLite tables. |
| `store_improvement.go`, `improvement_self_growth.go` | Improvement signals and lesson candidates. | `improvement_store.go`, `improvement_self_growth.go`, `lesson_memory.go` | partial | Typed-collection equivalent now records signals and writes lesson candidates / self-growth memory; schema names differ by current persistence architecture. |
| `team_memory.go`, `people_memory.go` | Team and people memory files. | `team_memory.go`, `people_memory.go`, `local_memory.go` | ported/partial | Parity tests exist; live memory recall/write needs proof. |
| `triage_context.go:61`, `triage_context.go:154` | Previous triage contexts and archive path. | `triage_context.go`, archive helpers | ported/partial | Runtime parity slice covered ring buffer/archive; live prompt injection needs proof. |

## Immediate Work Queue

1. P0 live shadow test:
   - Source-controlled harness now exists as `internal/slackagent/cueboard_shadow_harness_test.go`.
   - Covered stimuli: plain channel observation stays silent; explicit bot mention is handled; X/Twitter link is read before answering; assistant self-comment stays silent.
   - Still required before final task #147 acceptance: capture real Slack old-bridge vs imoutochan screenshots/logs for the same four stimuli.
2. P0 tool surface correction:
   - `/slack/tools/parity` / `/tools/parity` report active, pending, and product-excluded tools.
   - `/slack/tools/call` / `/tools/call` execute active local equivalents for `exa_search`, `exa_contents`, `read_doc`, `memory_search`, `memory_get`, `memory_write`, `person_memory`, `followup_memory`, `suggest_action`, `runtime_status`, `heartbeat_log`, `usage_api`, `manage_schedule`, `notify_meeting_slack`, and `slack_api`.
   - Remaining product questions: image/audio generation and meeting-chat provider.
3. P0 memory/dreaming/self-growth live evidence:
   - Verify a real feedback message creates a self-improvement heartbeat follow-up plus lesson candidate without noisy thread spam.
   - Verify visible heartbeat/dream delivery surfaces exactly when Cueboard would: not inside quiet hours, not more than 3 public surfaces/12h, not more than once/6h per follow-up, and not if the thread already has newer activity.
4. P0 scanner silence:
   - Compare active mention thread filtering, retry/reinject, cursor commit, and direct reply thresholds against cueboard with live examples.
5. P1 method matrices:
   - Slack API tool action matrix.
   - HTTP route matrix.
   - Persistence concept/table matrix.

## Shadow Harness Evidence

Run:

```bash
go test ./internal/slackagent -run 'TestTask147ShadowHarness' -count=1 -v
```

Current result:

| Stimulus | Cueboard expectation | Oneesama proof |
|---|---|---|
| Plain channel observation: `这个onboarding-bot-hourly刷屏了` | Scanner may record, but no casual public reply/action card. | `TestTask147ShadowHarnessSilencesPlainChannelObservation` goes through Slack history scanner + triage finalization and asserts zero `PostMessage` calls + zero pending actions. |
| Explicit `<@UBOT> 你在吗` | Treat as direct bot mention and route to assistant/worker. | `TestTask147ShadowHarnessRecognizesExplicitBotMention` goes through `/slack/events` and asserts handled `app_mention` with the mention stripped to `你在吗`. |
| Bare public X/Twitter link | Read first, then answer directly; do not ask whether to read. | `TestTask147ShadowHarnessReadsExternalLinkWithoutConfirmation` injects Jina reader content, asserts prompt includes fetched context, posts one direct source-thread reply, and creates no pending action. |
| Assistant self-comment: `转生后的oneesama味道有点不对` | Stay silent unless explicitly asked/mentioned. | `TestTask147ShadowHarnessSilencesAssistantSelfComment` goes through scanner + triage finalization and asserts zero public replies. |

## Live Slack Log Evidence

Fetched with Slack Web API `conversations.replies` using the live bot token. These are not new test posts; they are the user-reported threads that motivated the harness.

| Evidence thread | Observed drift before fixes | Guard now locked |
|---|---|---|
| `C09LNPCGU3E/1778767510.917049` | New `imoutochan` (`B0APMC75QNN`) saw a bare X link and posted a pending "是否读取..." card. | `TestTask147ShadowHarnessReadsExternalLinkWithoutConfirmation`; external link prefetch + read-confirmation suppression. |
| `C09KVPBMLJ3/1778779797.697749` | New `imoutochan` casually replied to plain bot-noise observation, later replied when another user was addressed, and then answered a self-comment thread. | `TestTask147ShadowHarnessSilencesPlainChannelObservation`, `TestCueboardParityTriageSuppressesRepliesWhenAnotherUserIsMentioned`, `TestTask147ShadowHarnessSilencesAssistantSelfComment`. |
| `C0ALMF2AD70/1778810550.773349` | New `imoutochan` posted a direct join setup card with `oneesama_join_without_realtime` / `oneesama_join_with_realtime`; log search found no Socket Mode interaction or `/join/google-meet` call for that card. The unrelated friendly reply is covered by scanner self-comment/mention guards. | Join setup card path was already structurally correct; no evidence of a delivered button click for this card. |
| `C0ALMF2AD70/1778810546.196809` | Bare Meet link produced pending action `1778810610947008` (`join_meeting`), and Slack state shows Peng confirmed it. Before this slice, confirmation only changed status/result to `interaction:confirmed`; it did not execute `join_meeting`, so no meeting-agent record for `yuf-wnes-yqt` existed in `meetd_meetings.json`. | Fixed by `service_pending_join.go`: Confirm on `join_meeting` pending action infers the Meet URL, calls meeting-agent `/join/google-meet`, carries Slack channel/thread context, posts joined/failure result to the thread, and updates pending-action result. |
| `C0AQ0C0KVMH/1778772007.043069` | Old `bridge_bot` (`B09SQ28BZ2P`) used concise Canvas revision replies; new `imoutochan` had already drifted into inline long-form/repo-worker framing. | Covered by prior bridge surface parity slice; not part of this shadow harness slice. |

## Non-Blocking Product Exclusions

- Credentialed app integrations: `linear_api`, `notion_api`, `google_calendar_api`, `figma_api`.
- Admin/debug dashboard routes unless Peng reopens admin UX.
- Image/audio generation until Peng confirms they should be in oneesama Slack assistant scope.
