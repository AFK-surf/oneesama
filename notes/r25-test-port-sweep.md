# R25 Cueboard Test Port Sweep

Date: 2026-05-13

Purpose: migrate the relevant Cueboard tests before more feature work, then run them to expose missing behavior instead of finding gaps one live click at a time.

Status: the first parity run exposed five gaps; commit `c21f113` fixes those five.
Peng then clarified the test migration scope: all Slack / Meet / meeting-related Cueboard tests should be accounted for, not only the P0 sample.
This note now tracks both the original red behavior tests and the broader bulk migration inventory.

## Test Strategy

- Default CI remains `go test ./...`.
- Source-port parity gaps are added under the `cueboardparity` build tag so they can fail loudly without making every normal branch push permanently red.
- Run gap tests explicitly with:

```bash
OPENAI_API_KEY=ambient-test go test -tags cueboardparity ./internal/meetingagent ./internal/postmeeting
```

Bulk migration inventory is enforced by:

```bash
OPENAI_API_KEY=ambient-test go test -tags cueboardparity ./internal/cueboardparity
OPENAI_API_KEY=ambient-test go test -tags cueboardparity ./...
```

The inventory gate fails while any relevant Cueboard test file is not migrated, mapped to an equivalent Oneesama test, or explicitly skipped by product decision.

## Ported In This Sweep

| New test | Cueboard source | Behavior |
|---|---|---|
| `internal/meetingagent/cueboard_lifecycle_parity_test.go` | `meeting-joiner/src/meet-session/ui.ts::waitForMeetingEnd` | `participantCount <= 1` is an empty-room signal |
| `internal/meetingagent/cueboard_lifecycle_parity_test.go` | `internal/meeting/watcher_finalize.go` / current product decision | empty transcript on scheduled meetd end still emits a failed `meeting.result` |
| `internal/postmeeting/cueboard_summary_parity_test.go` | `internal/meeting/summary_test.go::TestBuildFallbackSummary_*` | fallback summary must avoid raw JSON blobs and truncate long text |
| `internal/postmeeting/cueboard_summary_parity_test.go` | `internal/meeting/watcher_caption_test.go::TestDeduplicateTranscriptDropsExactDuplicates` | exact duplicate captions collapse before summary |

## Source Test Inventory

Canonical Cueboard source used for this sweep:

```text
/Users/pengx17/Documents/cueboard/agent-framework/deploy/docker/data/slack-agent/runtime/repos/cueboard-main/agent-framework
```

Source scope found:

| Area | Files | Test funcs | Scope rule |
|---|---:|---:|---|
| `internal/meeting/*_test.go` | 10 | 83 | all in-scope |
| `cmd/meetd/*_test.go` | 1 | 5 | in-scope startup/config |
| `internal/bridge/slack/*_test.go` | 49 | 321 | default in-scope unless explicitly admin/debug/third-party/out-of-product |
| `cmd/slack-agentd/*_test.go` | 3 | 14 | in-scope startup/config/tool-gate audit |
| **Total** | **63** | **423** | broad Slack/Meet/meeting coverage |

Bulk inventory status after `internal/cueboardparity/inventory_test.go`:

| Status | Files | Test funcs | Meaning |
|---|---:|---:|---|
| `equivalent` | 3 | 7 | already covered by current Oneesama tests |
| `migrated` | 54 | 320 | Cueboard source test file has been ported into current Oneesama tests |
| `partial` | 0 | 0 | no remaining partial files |
| `missing` | 0 | 0 | no current equivalent test/implementation |
| `needs_decision` | 0 | 0 | mixed Slack/Meet relevance or product-scope decision needed |
| `skipped` | 6 | 22 | explicitly out-of-scope by prior product decisions |

| Cueboard test file | Relevant cases | Oneesama status | Action |
|---|---:|---|---|
| `internal/meeting/asr_test.go` | 4 | ✅ migrated | Whisper helper normalization/output/model/binary parity covered; configured Gemini ASR provider remains in R25 provider work |
| `internal/meeting/summary_test.go` | 21 | ✅ migrated | Response cleanup, JSON repair, fallback hardening, structured summary parsing, configured provider guard, and streaming fallback covered; model IDs remain env/config-only |
| `internal/meeting/watcher_caption_test.go` | 21 | ✅ migrated | Live-caption merge/dedupe, transcript windows, speaker normalization, calibration source selection, chunk windows, ASR-only guard, and timestamp normalization covered |
| `internal/meeting/webhook_test.go` | 3 | ✅ equivalent sender/signature tests exist in `internal/postmeeting/webhook_test.go` | keep current tests; add retry-attempt parity if behavior diverges |
| `internal/meeting/joiner_test.go` | 5 | ✅ migrated | Old joiner subprocess coverage mapped to current persistent meet-runner command/process-group/shutdown/flag-preservation contracts |
| `internal/meeting/httpapi_test.go` | 11 | ✅ migrated | create/get/list/idempotency/validation/cancel/redeliver/resummarize/artifact/caption/chat HTTP API behavior covered in current meeting-agent handlers |
| `internal/meeting/store_test.go` | 6 | ✅ migrated | meeting state, caption alias/ordering, chat fail-closed, and stable summary upsert covered in current meetd persistence collections |
| `internal/meeting/audio_artifacts_test.go` | 3 | ✅ migrated | audio artifact preference/transcode/retention parity covered |
| `internal/meeting/runtime_wakeup_test.go` | 1 | ✅ migrated | scheduled meetd runtime wakeup parity covered |
| `internal/bridge/slack/mention_test.go` | 19 | ✅ migrated | mention strip, thread transcript/file/image/canvas formatting, outstanding request/compaction, queued mention coalescing, reply footer/markdown/feedback summary, failure/compaction reply, allowlist, and latest assistant fallback covered |
| `internal/bridge/slack/assistant_context_test.go` | 6 | ✅ migrated | durable ledger/channel brain/outstanding-request prompt parity covered |
| `internal/bridge/slack/bridge_session_test.go` | 6 | ✅ migrated | durable context cold-start, latest meeting context reuse, bounded recent commands, channel-type normalization, and repo clone refresh covered |
| `internal/bridge/slack/config_test.go` | 14 | ✅ migrated | secrets-file loading, legacy config path, scanner env aliases, run-mode-to-agent-runner mapping, and Slack startup token validation covered |
| `internal/bridge/slack/defaults_test.go` | 21 | ✅ migrated | local memory adapter boundaries, triage policy rails, prompt compact/private-token guard, Slack event normalization, and scanner ignore/file-share behavior covered |
| `internal/bridge/slack/heartbeat_followup_test.go` | 29 | ✅ migrated | followup creation/status/resolve, canonical thread commitment dedupe, delivery routing/blocking, heartbeat context/surface status, and current scoped runtime behavior covered |
| `internal/bridge/slack/store_test.go` | 23 | ✅ migrated | outbound action, meeting result delivery, thread ledger/channel brain, triage run, feedback seed, and cursor store parity covered |
| `internal/bridge/slack/meeting_webhook_test.go` | 10 | ✅ migrated | incremental transcript, copilot side-effect summaries/follow-up detection, and artifact materialization/staging parity covered |
| `internal/bridge/slack/meeting_webhook_audio_test.go` | 1 | ✅ migrated | audio artifact extension sniffing now covered by `cueboardparity` |
| `internal/bridge/slack/meeting_handler_test.go` | 5 | ✅ migrated | approval-channel normalization/lookup and meeting approval/join text formatting covered with Onee Sama branding |
| `internal/bridge/slack/mrkdwn_test.go` + `mrkdwn_blocks_test.go` | 7 | ⚠️ current Slack cards avoid most markdown conversion; renderer parity not complete | non-blocking Slack renderer backlog |
| `cmd/meetd/main_test.go` | 5 | ✅ migrated | MeetD model/env precedence, watch interval, ASR env/config, and env-only model defaults covered in current config |
| `cmd/slack-agentd/main_test.go` | 8 | ✅ migrated | Slack assistant/triage capability gates, safe bash guardrails, schedule-tool registration boundary, and process secret scrub covered |
| `cmd/slack-agentd/validate_only_test.go` + `backend_auth_test.go` | 6 | ✅ migrated | validation/backend auth covered in `cmd/oneesama` + `internal/slackstartup` |
| `internal/bridge/slack/run_command_tool_test.go` | 1 | ✅ migrated | narrow gh/curl/date allowlist and local/mutating command blocks covered |

## First Run Results

Baseline:

```bash
OPENAI_API_KEY=ambient-test go test ./...
```

Result before parity tag: PASS.

Parity gaps:

```bash
OPENAI_API_KEY=ambient-test go test -tags cueboardparity ./internal/meetingagent ./internal/postmeeting
```

First result: FAIL on the P0/P1 parity gaps below.

Actual current result:

```text
FAIL internal/meetingagent
- TestCueboardParityParticipantCountOneMeansEmptyRoom:
  runtimeJoinState reason = "", want empty_room for participant_count=1
- TestCueboardParityMeetdEmptyTranscriptSendsFailedResult:
  timed out waiting for webhook meeting.result

FAIL internal/postmeeting
- TestCueboardParityFallbackSummaryAvoidsRawJSONBlob:
  summary highlights exposed raw JSON blob
- TestCueboardParityFallbackSummaryTruncatesLongText:
  highlight len = 2500 suffix=false, want 2003 runes ending with ellipsis
- TestCueboardParityTranscriptDropsExactDuplicateCaptions:
  exact duplicate captions remained as two normalized segments
```

## Failure Queue

| Failing parity test | Gap | Fix slice | Current status |
|---|---|---|
| `TestCueboardParityParticipantCountOneMeansEmptyRoom` | current runtime status treats `inMeeting + participantCount=1` as plain joined, so bot stays alone | R24.11 | ✅ fixed |
| `TestCueboardParityMeetdEmptyTranscriptSendsFailedResult` | scheduled meetd empty transcript marks done but emits no failed result webhook | R25.4 | ✅ fixed |
| `TestCueboardParityFallbackSummaryAvoidsRawJSONBlob` | fallback-only summary can expose structured JSON as user-facing highlight | R25.2 | ✅ fixed |
| `TestCueboardParityFallbackSummaryTruncatesLongText` | fallback highlights are unbounded compared with cueboard truncation | R25.2 | ✅ fixed |
| `TestCueboardParityTranscriptDropsExactDuplicateCaptions` | exact duplicate caption segments are not collapsed | R25.1/R25.2 | ✅ fixed |

## Fixed Run Results

```bash
OPENAI_API_KEY=ambient-test go test -tags cueboardparity ./internal/meetingagent ./internal/postmeeting
OPENAI_API_KEY=ambient-test go test -race -tags cueboardparity ./internal/meetingagent ./internal/postmeeting -count=20
```

Both pass after the bundled fix.

## Bulk Inventory Run Results

Default suite remains green:

```bash
OPENAI_API_KEY=ambient-test go test ./...
```

Bulk parity suite is now green:

```bash
OPENAI_API_KEY=ambient-test go test -tags cueboardparity ./...
```

Current failing package: none.

Failure categories:

- `missing`: 0 files / 0 tests
- `partial`: 0 files / 0 tests
- `needs_decision`: 0 files / 0 tests

Newly migrated:

- `internal/bridge/slack/meet_publish_test.go` — Canvas list normalization, numbered list parsing, and no duplicate Canvas document title.
- `internal/bridge/slack/meeting_webhook_audio_test.go` — WAV/MP3 audio artifact extension sniffing.
- `internal/bridge/slack/html_markdown_test.go` — Slack Canvas HTML link conversion to markdown.
- `internal/bridge/slack/meeting_scanner_test.go` — meeting scanner lookahead and approval suggestion timing.
- `internal/bridge/slack/slack_api_tool_fetch_test.go` — Slack fetch-thread parameter normalization.
- `internal/bridge/slack/mrkdwn_test.go` — Markdown-to-Slack mrkdwn conversion, fallback text, Linear issue linkification.
- `internal/bridge/slack/mrkdwn_blocks_test.go` — Markdown-to-Block Kit splitting.
- `internal/bridge/slack/scanner_test.go` — Slack scanner message line formatting.
- `internal/bridge/slack/file_upload_test.go` — upload path aliases and workspace/symlink safety.
- `internal/bridge/slack/file_upload_resolve_test.go` — safe local upload path resolution and `/tmp` staging.
- `internal/bridge/slack/interaction_summary_test.go` — handled thread action summary formatting.
- `internal/bridge/slack/meeting_slack_notify_tool_test.go` — meeting notify Slack user lookup and ambiguity handling.
- `internal/bridge/slack/assistant_history_test.go` — mention history buffering and visible-progress suppression.
- `internal/bridge/slack/slack_api_tool_messages_test.go` — assistant chat.postMessage / postThreadReply guardrails.
- `internal/meeting/audio_artifacts_test.go` — audio artifact preference, transcode finalization, and raw retention.
- `internal/meeting/runtime_wakeup_test.go` — scheduled meetd runtime wakeup after meeting creation.
- `internal/meeting/asr_test.go` — Whisper language normalization, whisper.cpp JSON output parsing, explicit model path, and missing binary error.
- `internal/bridge/slack/interaction_feedback_test.go` — readable pending-action feedback summaries for create issue and create channel.
- `internal/bridge/slack/suggest_tool_test.go` — join-meeting suggestion normalization, validation failures, unknown action rejection, and explicit direct-create guardrail.
- `internal/bridge/slack/scanner_compact_test.go` — daily-note compaction thresholds, hash, eligibility, and MEMORY.md prompt guard.
- `internal/bridge/slack/assistant_request_context_test.go` — latest request context parsing, explicit issue-creation detection, and upload target fallback.
- `internal/bridge/slack/assistant_context_test.go` — durable ledger/channel brain prompt context, duplicate summary suppression, outstanding requests, persisted cold-start state, and confirmed-action fallback.
- `internal/bridge/slack/team_memory_test.go` — meeting summary team-memory projection, lesson candidates, people memory projection/lookup/list/correction.
- `internal/bridge/slack/triage_context_test.go` — triage prompt filtering, failure visibility, compact summaries, and Slack method action recorder context persistence.
- `internal/bridge/slack/msgbuffer_test.go` — inbound buffer drain/cursor, triaged tracking, missed injection/retry scheduling, append behavior, and Slack timestamp ordering.
- `internal/bridge/slack/scanner_event_test.go` — scanner cursor reconciliation, triaged history pruning, and missed-history rebuffer behavior.
- `internal/bridge/slack/scanner_triage_test.go` — assistant-history fallback content, empty no-mutation failure, recorder-based mutation/failure counts, and assistant trace rendering.
- `internal/bridge/slack/slash_commands_test.go` — status dashboard meet-health probe, `/health` fallback, and config source rendering.
- `cmd/slack-agentd/backend_auth_test.go` — backend model-list auth probe path, bearer token, fatal unauthorized handling, and non-fatal server errors.
- `internal/bridge/slack/runtime_status_tool_test.go` — heartbeat/repo/meeting runtime status overview formatting plus scoped-thread heartbeat visibility.
- `internal/bridge/slack/heartbeat_log_tool_test.go` — heartbeat log path candidates, heartbeat-only signal filtering, recent surfaces, missing-log errors, and scoped raw-log hiding.
- `internal/bridge/slack/heartbeat_render_test.go` — compact heartbeat context blocks, long-summary splitting, and supervisory completion normalization/suppression.
- `internal/bridge/slack/tool_registration_test.go` — current Slack assistant/planner/meeting-copilot/completion-only tool category parity, excluding de-prioritized credentialed/audio/image/usage tools.
- `internal/bridge/slack/repo_runtime_test.go` — committed-HEAD writable clone bootstrap, guarding agent worktrees from dirty mounted source changes.
- `internal/bridge/slack/assistant_gates_test.go` — current Slack assistant schedule gate: current-thread list only, mutations blocked; credentialed third-party gates excluded by product scope.
- `internal/bridge/slack/sqlite_protect_test.go` — sqlite state corruption quarantine plus last-good snapshot restore semantics ported to the current persistence provider.
- `internal/bridge/slack/feedback_test.go` — historical feedback read path ported as local Slack memory seed summary/search/API; feedback mutation/improvement loops remain out-of-scope.
- `internal/meeting/client_test.go` + `internal/meeting/httpapi_test.go` — MeetD HTTP create/get/list/idempotency/validation/cancel/redeliver/resummarize/artifact/caption/chat behavior mapped to current meeting-agent handler tests.
- `internal/meeting/store_test.go` — current meetd persistence covers meeting state, caption aliases/ordering, chat fail-closed, and stable summary upsert semantics.
- `internal/meeting/watcher_caption_test.go` — live-caption stream merge/reuse, exact duplicate/punctuation dedupe, same-speaker long-gap separation, concurrent streams, transcript range filtering/dedupe, aggregate speaker label normalization, calibration source selection, chunk-window calibration fallback, ASR-only chunk guard, and timestamp normalization.
- `internal/meeting/summary_test.go` — LLM response cleanup, JSON candidate extraction, malformed quote repair, fallback truncation/structured-payload guard, structured summary-text parsing, configured provider guard, and non-stream to streaming fallback.
- `cmd/meetd/main_test.go` — MeetD model/env precedence, watch interval, ASR provider/language/API key/model config, and env-only model defaults mapped to current oneesama config without hard-coded private provider IDs.
- `internal/meeting/joiner_test.go` — old subprocess/Xvfb-era coverage mapped to current persistent meet-runner command resolution, Unix process group isolation, nil-safe termination, and browser-island join flag preservation.
- `internal/bridge/slack/config_test.go` — secrets-file loading, legacy config path, scanner env aliases, run-mode-to-agent-runner mapping, and Slack startup token validation ported to current config contracts.
- `internal/bridge/slack/bridge_session_test.go` — durable Slack context cold-start, latest meeting context reuse, bounded command history, channel-type normalization, and writable repo clone refresh mapped to current session/runtime contracts.
- `internal/bridge/slack/store_test.go` — outbound action reservation lifecycle/cleanup, meeting result delivery reservation retry/confirm/reset/cleanup, thread ledger/channel brain lifecycle/versioning, triage run field preservation/absolute-time ordering, and event cursor roundtrip mapped to current stores.
- `internal/bridge/slack/defaults_test.go` — local memory adapter boundaries, triage prompt policy rails/compactness, private example scrub, Slack event-to-inbound normalization, bot/subtype filtering, and file-share scanner retention covered.
- `internal/bridge/slack/heartbeat_followup_test.go` — followup create/status/resolve lifecycle, canonical thread commitment dedupe, distinct meeting commitments, delivery target routing/blocking, heartbeat context/surface status, and scoped runtime visibility covered in the current Onee Sama heartbeat seam.
- `internal/bridge/slack/mention_test.go` — mention text stripping, thread transcript/file/image/canvas formatting, outstanding request/compaction helpers, queued mention coalescing, reply footer/markdown/feedback summaries, failure/compaction replies, allowlist, and latest assistant fallback.

Explicit skips:

- `internal/bridge/slack/admin_templates_test.go` — admin/debug de-prioritized by task #107
- `internal/bridge/slack/audio_generation_tool_test.go` — legacy ElevenLabs Slack audio tool out-of-scope; meeting TTS uses provider seam / fake-mic path
- `internal/bridge/slack/image_generation_tool_test.go` — not part of Slack/Meet meeting lifecycle
- `internal/bridge/slack/linear_assignment_test.go` — third-party Linear integration de-prioritized by task #106
- `internal/bridge/slack/linear_tools_test.go` — third-party Linear integration de-prioritized by task #106
- `internal/bridge/slack/usage_tool_test.go` — usage reporting not part of Slack/Meet meeting lifecycle
