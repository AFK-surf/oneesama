# Cueboard Function Audit Consolidation

Task: task #171

## Status as of 2026-05-18 (task #174 marathon)

The marathon directive `task #174 "你俩合作，直到所有问题修完"` has cleared most of Phases 0–5 and Phase 6 P2. Snapshot of remaining work by phase below; struck-through rows are landed. Latest resolved code SHA at this doc update: `cbadb08`.

- **Phase 0 quick fixes**: all 4 P0/P1 landed (`12e09b2`).
- **Phase 1 state foundations**: scanner cursors + slack_channels + slack_channel_membership + slack_thread_cases landed (`8c87d45` + `262c4a9`). `slack_thread_recommendations` is still open — driver picked it up via the suggest_action+followup loops (`ece0124`/`fc0ae2c`) and now considers it covered functionally even though there is no separate typed collection.
- **Phase 2 thread ownership**: P0 mention queue + thread case lifecycle + scanner suppression + activeThread guard landed (`78a0905`). Durable-context guard (`looksLikeHandledTaskSummary`) landed (`1539917`). Pending-action card update on confirm/dismiss landed via driver Phase 3 (`495bbd0`).
- **Phase 3 heartbeat loop**: pending-action loop closure (`ece0124`), heartbeat ticker (`495bbd0`), commitment/confirmed-action/meeting-action follow-up hooks (`fc0ae2c`), and startup heartbeat normalization (`cbadb08`) landed.
- **Phase 4 Calendar approval scanner**: Google Calendar scan loop + OAuth refresh + real Slack root-message approval card + thread-case dedupe landed (`6d3f601`).
- **Phase 5 context tools**: Canvas fetch (`1240484`), image fetch (`94cd49b`), Canvas sanitize+retry (`a353b79`), safe Block Kit blocks (`3dbdc9a`), DM/debug fallback Stage A (`9a27ca3`), Stage B event-post fallback wiring (`c6fd0d0`), centralized post ledger (`c550bb0`), Cueboard-formatted `runtime_status` / `heartbeat_log` views (`66d269b`), and `slack_api(add_reaction)` digest target resolution (`a3913d5`) landed. Canvas create/edit decision remains open.
- **Phase 6 ops**: processutil consolidation landed (`75a3802`). Feedback markdown trim landed (`438104e`). JSON unknown-field policy and workspace-template embeds remain open as docs/decisions.

Sources:

- task #162 framework: `README.md`, `module-template.md`
- task #163 Slack scanner / triage / context: `slack-scanner-triage-context.md`
- task #164 Slack mention / interaction / assistant: `slack-mention-interaction-assistant.md`
- task #165 Slack tool surface / proxy tools: `slack-tool-surface-proxy.md`
- task #166 Slack memory / feedback / heartbeat / self-growth: `slack-memory-feedback-heartbeat-self-growth.md`
- task #167 Slack rendering / Canvas / mrkdwn / files: `slack-rendering-canvas-mrkdwn-files.md`
- task #168 Slack persistence / admin / config / DM: `slack-persistence-admin-config-dm.md`
- task #169 Meeting / ASR / summary / joiner: `meeting-asr-summary-joiner.md`
- task #170 Shared runtime / integrations / entrypoints: `shared-runtime-integrations-entrypoints.md`

## Executive Summary

The replacement is now much stronger than the first parity inventory suggested: triage, Slack context fetch, Realtime meeting join, captions, post-meeting artifacts, feedback memory, audit health, and process-level observability all have working Oneesama implementations.

The remaining risky gaps cluster into five themes:

1. **State durability:** scanner cursors, channel membership, thread ownership, and recommendation reservations are not persisted like Cueboard.
2. **Duplicate/unsafe Slack behavior:** mention-thread ownership, active-thread tool guards, and generic Slack upload safety are incomplete.
3. **Pending-action and heartbeat loops:** card/reservation/follow-up side effects, heartbeat ticker, follow-up hooks, and startup normalization now exist. Remaining heartbeat work is quality/observability: richer candidate ranking, upcoming-deadline context, and admin views.
4. **Meeting automation:** direct/manual Meet join and Calendar-driven Slack approval scanner are now covered. Official Meet API fallback and ASR chunk production remain open product decisions.
5. **Capability surfaces:** Canvas create/edit, official Meet API fallback, and ASR chunk production are either missing or intentionally deferred.

Do **not** try to port Cueboard wholesale. The large Cueboard agent-framework, envhost/VM stack, credentialed integrations, and HTML admin cockpit are intentionally replaced or excluded. The backlog below only covers behavior that still matters for Oneesama's current product.

## Implementation Order

### 0. Safety And Truth-In-Advertising Quick Fixes

These are small, high-confidence fixes that reduce immediate risk before larger state work.

| Priority | Work                                                                                                                         | Source audits | Why first                                                                                                 | Acceptance                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Route `slack.uploadFile` through `slackWorkspaceFileResolver.resolveLocalUploadPath` before upload.                          | #167          | Current active tool can read arbitrary local paths. This is a safety boundary bug, not just parity drift. | Tool upload from workspace/temp-staged file succeeds; upload from unrelated readable path is rejected; regression test covers both. |
| P0       | Wire `slackstartup.probeBackendAuth` into normal Slack-agent startup validation.                                             | #170          | The auth probe is already ported but dead; bad BYOK keys should fail fast.                                | Bad provider key fails startup/preflight with clear operator error; transient probe failure follows Cueboard fatal/non-fatal split. |
| P0       | Either implement real `suggest_action` side effects or mark it `validation_only` in `/slack/tools/parity` until implemented. | #165          | The tool is advertised active but currently only normalizes. This misleads Realtime/agent behavior.       | Parity endpoint truthfully reports capability; tests assert the reported status matches runtime behavior.                           |
| P1       | Demote or clearly label active stubs (`usage_api`, unavailable Canvas/DM/image methods) in parity reports.                   | #165/#167     | Reduces future "green surface, missing behavior" confusion.                                               | `/slack/tools/parity` distinguishes `active`, `validation_only`, `registered_unavailable`, and `product_excluded`.                  |

### 1. Persist Slack Workspace And Thread State

This is the foundation for scanner restart safety, mention-thread ownership, recommendation dedupe, and meeting thread lookups.

| Priority | Work                                                                        | Source audits  | Notes                                                                                                          | Acceptance                                                                                                    |
| -------- | --------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| P0       | Add `slack_scanner_cursors` persistence for inbound scanner cursors.        | #168/#163      | Replace in-memory `s.inbound.Cursor` restart loss.                                                             | Restart preserves per-channel cursor; scanner does not replay beyond configured recovery window.              |
| P0       | Add typed collections for `slack_channels` and `slack_channel_membership`.  | #168/#163      | Replaces Cueboard `channel` / `channel_membership`; supports future membership-aware scans and operator stats. | Startup/sweep upserts channel list and membership snapshots; status endpoint logs channel/member counts.      |
| P0       | Add `slack_thread_cases` for durable thread ownership.                      | #168/#164/#163 | Required by mention queue, scanner suppression, and active-thread guard.                                       | A thread claimed by mention handling remains known across restart until closed/expired.                       |
| P0       | Add `slack_thread_recommendations` for duplicate-protected recommendations. | #168/#165/#166 | Required by real `suggest_action` side effects and stale recommendation cleanup.                               | Duplicate recommendation in same thread is rejected or updates existing card; stale reservations are cleaned. |
| P1       | Add meeting-thread lookup helpers by dedupe key and by `(channel, thread)`. | #168/#169      | Needed for linked meeting notification and Slack-side meeting follow-ups.                                      | `GetMeetingThreadBySlack` supports notification routing from Slack thread context.                            |
| P2       | Decide legacy `slack.db` import/migration story.                            | #168/#170      | Oneesama does not need SQLite ABI parity, but operators need clarity.                                          | Either a one-off importer exists, or docs explicitly state fresh-state cutover.                               |

### 2. Restore Thread Ownership And Duplicate-Reply Guards

This package closes the biggest "bot talks twice" class of issues.

| Priority | Work                                                                            | Source audits | Notes                                                                     | Acceptance                                                                                                                             |
| -------- | ------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Wire `slackMentionQueue` into the live app-mention handler.                     | #164          | Helpers/tests exist; live path bypasses them.                             | Two mentions in same thread merge into one running job; stale replies are suppressed; merged mention receives concise acknowledgement. |
| P0       | Register active mention threads while a mention job is running.                 | #164/#165     | The existing `slackAPITool.activeThread` callback must become live.       | A Slack API tool call cannot post into the same active thread and create a duplicate answer.                                           |
| P0       | Suppress scanner triage for mention-owned threads.                              | #163/#168     | Use `slack_thread_cases` or equivalent active ownership state.            | Follow-up non-mention replies inside an active mention thread are not swept into scanner triage.                                       |
| P1       | Update or strip pending-action card blocks after confirm/dismiss/feedback.      | #164/#166     | Prevents old cards from looking clickable.                                | Confirm/dismiss updates the original card state or removes interactive blocks; idempotent repeat clicks are harmless.                  |
| P1       | Add durable-context guard equivalent to Cueboard `looksLikeHandledTaskSummary`. | #164          | Avoids treating SKIP/no-action ledger summaries as "recent handled task". | Durable context injects only real handled-work summaries; SKIP/no-action entries remain available but not mislabeled.                  |

### 3. Make Pending Actions And Heartbeat Actually Close The Loop

This is the memory/self-growth loop Peng expected from Cueboard.

| Priority | Work                                                                                                                                                         | Source audits  | Notes                                                                                                                                                          | Acceptance                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Implement side-effecting `suggest_action`: reserve recommendation, insert pending action, post card, record `card_ts`, ledger entry, and decision follow-up. | #165/#168/#166 | Unlocks meeting approval cards and assistant-suggested actions.                                                                                                | A tool call produces a Slack confirmation card, persists it, dedupes repeats, and is visible in pending-action/follow-up stores. |
| P0       | Add pending-action heartbeat follow-ups.                                                                                                                     | #166           | Port `ensurePendingActionDecisionFollowup`, `syncPendingActionHeartbeatFollowups`, and stale cleanup.                                                          | New pending action creates/updates an open follow-up; stale pending action clears associated follow-up.                          |
| P0       | Add assistant-commitment follow-ups.                                                                                                                         | #166           | If the bot says "I will follow up", Cueboard records that promise.                                                                                             | Assistant replies with commitment phrases create `thread_commitment:*` follow-ups with dedupe.                                   |
| P0       | Add confirmed-action and meeting-action heartbeat enqueue hooks.                                                                                             | #166/#169      | Confirmed actions and meeting action items should re-surface later.                                                                                            | Confirming an action and receiving meeting action items creates follow-ups with correct source refs.                             |
| P0       | Add `Service.Start` heartbeat ticker for `SurfaceSlackFollowups`.                                                                                            | #166           | Delivery primitives exist but require manual/API trigger.                                                                                                      | Follow-ups surface without manual endpoint calls; ticker cadence is configurable and observable.                                 |
| P1       | ~~Add self-growth normalization / re-sync on startup and cadence.~~                                                                                          | #166           | **RESOLVED** (`cbadb08`): startup prime normalizes follow-ups, closes duplicate canonical thread commitments, and re-syncs open/absorbed improvement clusters. | `PrimeHeartbeatState`-equivalent call dedupes and re-rolls open improvement signals.                                             |
| P1       | Port feedback context trimming by whole-day blocks.                                                                                                          | #166           | Prevents feedback markdown from growing unbounded in prompt context.                                                                                           | Recent feedback context stays under configured byte budget without splitting day blocks.                                         |

### 4. Bring Calendar-Driven Meeting Automation Back, If Still In Scope

Manual and direct Meet join are solid. This package is only needed if Oneesama should proactively suggest scheduled meetings like Cueboard.

| Priority | Work                                                                          | Source audits  | Notes                                                                                                                                                                                                                                                                                                                 | Acceptance                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | ~~Implement Slack-agent Calendar meeting scanner loop.~~                      | #169/#170      | **RESOLVED** (`6d3f601`): scanner fetches Google Calendar events, filters upcoming Meet links, posts a real Slack root-message approval anchor, then posts a deduped `suggest_action(join_meeting)` card in that thread.                                                                                              | `/slack/status.meeting_scanner` exposes disabled/configured/running/tick state; no `google_calendar_api` assistant tool is exposed.                                   |
| P1       | ~~Add config/migration story for Calendar credentials and approval channel.~~ | #168/#170      | **RESOLVED** (`6d3f601`): config/env keys cover enable flag, interval, approval channel, calendar ID, access token, refresh token/client credentials, API base URL, and token URL.                                                                                                                                    | Missing config fails closed with `disabled_reason`; live default is disabled and observable.                                                                          |
| P1       | Add linked meeting thread lookup in notifications.                            | #168/#169/#165 | `notify_meeting_slack` should find the right thread and mention humans safely.                                                                                                                                                                                                                                        | Meeting notification resolves linked Slack thread and user IDs without raw channel/thread text from model.                                                            |
| P2       | Decide official Google Meet API fallback.                                     | #169           | DOM/captions are product-primary. Official conference records/transcripts can improve post-meeting reliability but add credentials/scope.                                                                                                                                                                             | Decision recorded: implement fallback or mark product-excluded with rationale.                                                                                        |
| P2       | ~~Decide ASR chunk production.~~                                              | #169/#175      | **RESOLVED for hosted-ASR production path** (task #175 implementation): meet-runner emits `audio_chunk_*` recording files and postmeeting now discovers/transcribes those chunks with OpenAI/Gemini/hosted providers, writes `asr_chunk_*.txt`, merges transcript output, and records `audio_chunks` in the manifest. | Long recording uses recorder-produced chunks for hosted ASR. Remaining non-goal: Go-side splitting of an arbitrary single audio file when recorder chunks are absent. |

### 5. Complete Slack Context And Content Tools

These are useful but should follow the state/duplicate-safety work so tool calls do not produce noisy side effects.

| Priority | Work                                                                                          | Source audits  | Notes                                                                                                                                                                                                                                                                                                                                                                        | Acceptance                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Implement Canvas fetch/download into mention context and `slack_api`.                         | #164/#165/#167 | `htmlToMarkdown` exists but lacks fetch caller.                                                                                                                                                                                                                                                                                                                              | Mention on thread with Canvas file gets Canvas text snippet; `slack_api(fetch_canvas)` returns markdown snippet with size guards. |
| P1       | ~~Expose Canvas create/edit or label them internal-only.~~                                    | #165/#167      | **RESOLVED** (`b81fdfa`, `c381045`): Canvas create/edit exposed to assistant via `suggest_action` confirmation flow only; direct `slack_api(create_canvas/edit_canvas)` remain `registered_unavailable`. Guardrails: edit_canvas REQUIRES file_id (no blind edits), op restricted to insert_at_end/insert_at_start/replace, dedup key, cognition outbound ledger on success. | Canvas authoring works through confirmation card with dedupe + audit ledger; parity matrix flags direct calls unavailable.        |
| P1       | ~~Add Canvas sanitize/plain-markdown retry for arbitrary `SummaryMarkdown` / `SummaryPath`.~~ | #167           | **RESOLVED** (`a353b79`): `canvas_markdown_sanitize.go::sanitizeMarkdownForSlackCanvas` + `publishSlackCanvas` retries once with sanitized markdown on validation-class errors; auth/rate-limit bypass retry; result.Detail tagged `sanitized_markdown_retry_after:<orig>` for audit. 7 sub-tests.                                                                           | Simulated Slack Canvas validation failure retries sanitized/plain markdown once and records fallback.                             |
| P1       | ~~Implement Slack image fetch for file/context reading.~~                                     | #165           | **RESOLVED** (`94cd49b`): `slack_image_fetch.go::actionFetchImage` files.info → image type guard → GET url_private_download → optional base64 inline. 8 MiB hard download cap; returns base64 + mime_data_url ready for multimodal models. 6 sub-tests.                                                                                                                      | Slack image file can be fetched as model-readable image content with auth/size checks.                                            |
| P1       | ~~Add safe Block Kit support for `chat.postMessage`.~~                                        | #165           | **RESOLVED** (`3dbdc9a`): `slack_safe_blocks.go::encodeSafeBlocks` validates Block Kit allow-list; top-level interactive types (actions/input/call/workflow) rejected; section accessory + context elements walked for embedded interactive elements. 9 sub-tests.                                                                                                           | Tool post accepts safe blocks, rejects interactive blocks, and records mutation/failure counters.                                 |
| P1       | ~~Centralize Slack post ledger side effects.~~                                                | #165/#167      | **RESOLVED** (`c550bb0`): app-mention/DM worker replies and worker-result fallback posts now use durable ledger helpers; status/noisy posts remain excluded.                                                                                                                                                                                                                 | Every durable public thread reply records outbound ledger exactly once; status/noisy posts remain excluded.                       |
| P2       | Add DM/debug-channel posting fallback.                                                        | #168/#165      | Useful for heartbeat/operator errors but requires `PilotUserID` / `DebugChannelID`.                                                                                                                                                                                                                                                                                          | Public post failure can fall back to pilot DM when configured; debug-channel posts are deduped and traceable.                     |

### 6. Ops, Config, And Code Quality Follow-Ups

These are lower risk but make production operation less surprising.

| Priority | Work                                                                              | Source audits | Notes                                                                                                                                                                                                                                                                                                                                                                                           | Acceptance                                                                                           |
| -------- | --------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| P1       | ~~Decide JSON unknown-field behavior and `MEETD_CONFIG_FILE` YAML migration.~~    | #170          | **RESOLVED** (`eb2b763`): `pkg/config.Load()` now uses `json.Decoder.DisallowUnknownFields`; YAML-shaped input emits parse error decorated with hint to run `oneesama-config-migrate` CLI. New `cmd/oneesama-config-migrate` one-shot tool reads YAML and emits strict-JSON, failing loudly on dead cueboard-era keys. `docs/config-migrate.md` is the operator-facing migration doc. 13 tests. | Config load rejects unknown JSON fields with field name; migration CLI converts YAML to strict-JSON. |
| P2       | Reintroduce a typed runtime path layout only if sessions/skills/schedules return. | #170          | Current product intentionally dropped agent-framework filesystem. Peng 5/18 decision: stays excluded (no infra return).                                                                                                                                                                                                                                                                         | No action unless product scope needs persistent session/skill metadata.                              |
| P2       | ~~Consolidate duplicated process-cancellation helpers.~~                          | #170          | **RESOLVED** (`75a3802`): new `internal/processutil` package with `PrepareGroup` + `KillGroup(label, cmd)`, unix/non-unix build tag split. `agentrunner` + `meetrunner` `process_unix.go` / `process_other.go` delegate to shared helper. 6 sub-tests.                                                                                                                                          | Shared helper has tests for TERM/KILL grace behavior.                                                |
| P2       | Reintroduce workspace templates as `go:embed` only if ops customization matters.  | #170          | Current Go string templates are easier to audit but less customizable.                                                                                                                                                                                                                                                                                                                          | Product decision recorded; no hidden drift.                                                          |

## Suggested Next Tasks

These are implementation slices in dependency order. Each slice should include code, tests, live/audit evidence where applicable, and a short update to this audit index.

1. **Fix Slack tool safety and startup preflight.**
   - Upload path resolver.
   - Backend auth startup probe.
   - Truthful parity labels for validation-only/stub tools.
2. **Add persistent Slack state foundations.**
   - Scanner cursors.
   - Channels and memberships.
   - Thread cases.
   - Thread recommendations.
   - Startup stats endpoint/log.
3. **Wire mention ownership and scanner suppression.**
   - Live mention queue.
   - Active-thread registry.
   - Tool active-thread guard.
   - Scanner skips mention-owned threads.
4. **Implement real pending-action recommendation flow.**
   - Side-effecting `suggest_action`.
   - Card update after decisions.
   - Recommendation cleanup.
   - Mutation/failure counters.
5. **Restore heartbeat follow-up production.**
   - Pending action, assistant commitment, confirmed action, and meeting action hooks.
   - Periodic follow-up surfacing ticker.
   - Startup normalization/dedupe.
6. **Ship Calendar meeting approval automation, if product still wants it.**
   - ~~Calendar scan loop.~~ (`6d3f601`)
   - ~~Slack approval card via real pending-action path.~~ (`6d3f601`)
   - Meeting thread lookup and notification routing.
7. **Fill high-value Slack context tools.**
   - Canvas fetch.
   - Slack image fetch.
   - Safe Block Kit posts.
   - Centralized thread-ledger recording.
8. **Decide optional capability fallbacks.**
   - Official Google Meet API fallback.
   - ~~Long-recording ASR chunk production.~~ Resolved for recorder-produced chunks in task #175; arbitrary single-file Go splitting remains out of scope unless product asks.
   - DM/debug fallback.
   - YAML-to-JSON migration/import.

## What Should Stay Excluded

The audit found many Cueboard functions that should **not** become Oneesama work items unless the product direction changes:

- Cueboard's `core/` and `framework/` agent brain. Oneesama uses external Codex/Claude/Ollama providers.
- `envhost/`, Apple Virtualization VM driver, remote VM transport, websocket/vsock runtime bridge.
- Credentialed Notion/Linear/Figma/backend proxy tools.
- Cueboard's HTML admin cockpit. Oneesama should continue exposing small JSON/audit endpoints instead.
- Legacy Slack-side meeting copilot loop if Realtime remains the primary in-meeting copilot.
- Direct image/audio generation tools unless product explicitly reopens generation scope.
- Local Whisper/Apple ASR if hosted OpenAI/Gemini ASR plus captions remain accepted.

## Open Product Decisions

1. Should Oneesama scan only channels it has joined, or auto-join public channels on `not_in_channel` like Cueboard?
2. Should the scanner bootstrap window remain the quieter 10 minutes, or restore Cueboard's 24 hour first sweep?
3. Should Calendar-driven meeting auto-approval be enabled in live config, or should it remain shipped but fail-closed until operators provide an approval channel and Google credentials?
4. Do operators need import/migration from legacy Cueboard `slack.db`, or is fresh state acceptable for cutover?
5. Should official Google Meet API data be added as a reliability fallback, or should DOM/captions remain the only meeting awareness source?
6. Should generic Slack Canvas create/edit be assistant-visible, or should Canvas authoring stay internal to meeting/worker publication?
