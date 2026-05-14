//go:build cueboardparity

package cueboardparity

import "testing"

type cueboardTestInventoryItem struct {
	SourceFile string
	Tests      int
	Area       string
	Status     string
	Action     string
}

const (
	statusEquivalent = "equivalent"
	statusMigrated   = "migrated"
	statusPartial    = "partial"
	statusMissing    = "missing"
	statusDecision   = "needs_decision"
	statusSkipped    = "skipped"
)

// TestCueboardBulkTestMigrationInventory is intentionally a parity gate, not a
// product behavior test. It keeps every Slack/Meet-related Cueboard test file
// visible until it is migrated, mapped to an equivalent Oneesama test, or
// explicitly skipped by product decision.
func TestCueboardBulkTestMigrationInventory(t *testing.T) {
	for _, item := range cueboardBulkTestInventory {
		item := item
		t.Run(item.SourceFile, func(t *testing.T) {
			switch item.Status {
			case statusMigrated, statusEquivalent:
				return
			case statusSkipped:
				t.Skip(item.Action)
			default:
				t.Fatalf("%s tests=%d area=%s action=%s", item.Status, item.Tests, item.Area, item.Action)
			}
		})
	}
}

var cueboardBulkTestInventory = []cueboardTestInventoryItem{
	// Meet / meeting runtime: default in-scope.
	{SourceFile: "internal/meeting/asr_test.go", Tests: 4, Area: "Meet ASR", Status: statusMigrated, Action: "Ported Whisper language normalization, whisper.cpp JSON output parsing, explicit model path, and missing binary error tests."},
	{SourceFile: "internal/meeting/audio_artifacts_test.go", Tests: 3, Area: "Meet audio artifacts", Status: statusMigrated, Action: "Ported audio artifact preference/transcode/retention tests."},
	{SourceFile: "internal/meeting/client_test.go", Tests: 8, Area: "Meet HTTP client", Status: statusMigrated, Action: "Mapped schedule/get/not-found/cancel/error/artifact/caption/chat client cases to current meeting-agent HTTP handler tests."},
	{SourceFile: "internal/meeting/httpapi_test.go", Tests: 11, Area: "MeetD HTTP API", Status: statusMigrated, Action: "Ported create/get/list/idempotency/validation/cancel/redeliver/resummarize/artifact/caption/chat HTTP API behavior to current handlers."},
	{SourceFile: "internal/meeting/joiner_test.go", Tests: 5, Area: "Meet joiner subprocess", Status: statusMigrated, Action: "Mapped old joiner subprocess tests to current persistent meet-runner command, process-group, nil-safe shutdown, and browser-island flag preservation."},
	{SourceFile: "internal/meeting/runtime_wakeup_test.go", Tests: 1, Area: "Meet watcher wakeup", Status: statusMigrated, Action: "Ported schedule wakeup behavior for current meetd runtime."},
	{SourceFile: "internal/meeting/store_test.go", Tests: 6, Area: "Meet store", Status: statusMigrated, Action: "Ported meeting state, caption alias/ordering, chat fail-closed, and stable summary upsert semantics to current meetd persistence collections."},
	{SourceFile: "internal/meeting/summary_test.go", Tests: 12, Area: "Meet summary", Status: statusMigrated, Action: "Response cleanup, JSON extraction/repair, fallback truncation, structured summary parsing, configured-model provider guard, and non-stream to streaming fallback covered."},
	{SourceFile: "internal/meeting/watcher_caption_test.go", Tests: 21, Area: "Meet captions", Status: statusMigrated, Action: "Ported live-caption merge/dedupe plus calibration transcript source, chunk window, ASR-only guard, and timestamp normalization helpers."},
	{SourceFile: "internal/meeting/webhook_test.go", Tests: 3, Area: "Meet webhook", Status: statusEquivalent, Action: "Covered by postmeeting webhook sender/signature tests."},
	{SourceFile: "cmd/meetd/main_test.go", Tests: 5, Area: "MeetD startup/config", Status: statusMigrated, Action: "Ported model/env precedence, watch interval, ASR env/config, and env-only model defaults to current oneesama config."},

	// Slack bridge: default in-scope unless explicitly de-prioritized by product
	// decision (admin/debug, third-party credentialed integrations, usage).
	{SourceFile: "cmd/slack-agentd/backend_auth_test.go", Tests: 3, Area: "Slack startup", Status: statusMigrated, Action: "Ported backend model-list auth probe path, bearer token, fatal 401/403, and non-fatal 5xx semantics."},
	{SourceFile: "cmd/slack-agentd/main_test.go", Tests: 8, Area: "Slack startup/tool gates", Status: statusMigrated, Action: "Ported Slack assistant/triage capability gates, safe bash guardrails, schedule-tool registration boundary, and process secret scrub tests."},
	{SourceFile: "cmd/slack-agentd/validate_only_test.go", Tests: 3, Area: "Slack startup validation", Status: statusEquivalent, Action: "Covered by current slackstartup validation tests; add meet health edge cases if missing."},
	{SourceFile: "internal/bridge/slack/admin_templates_test.go", Tests: 8, Area: "Slack admin/debug", Status: statusSkipped, Action: "Admin/debug was explicitly de-prioritized by task #107."},
	{SourceFile: "internal/bridge/slack/assistant_context_test.go", Tests: 6, Area: "Slack context", Status: statusMigrated, Action: "Ported durable ledger/channel brain/outstanding-request context tests into current rich mention runner context."},
	{SourceFile: "internal/bridge/slack/assistant_gates_test.go", Tests: 6, Area: "Slack assistant tool gates", Status: statusMigrated, Action: "Ported current Slack assistant schedule gate: current-thread list only, mutations blocked; credentialed third-party gates intentionally excluded."},
	{SourceFile: "internal/bridge/slack/assistant_history_test.go", Tests: 4, Area: "Slack assistant progress", Status: statusMigrated, Action: "Ported mention history buffering and disabled visible progress parity."},
	{SourceFile: "internal/bridge/slack/assistant_request_context_test.go", Tests: 3, Area: "Slack request context", Status: statusMigrated, Action: "Ported latest assistant request context parsing, explicit issue creation detection, and upload target fallback tests."},
	{SourceFile: "internal/bridge/slack/assistant_status_test.go", Tests: 1, Area: "Slack assistant status", Status: statusEquivalent, Action: "Covered by current assistant_status tests and live status dogfood."},
	{SourceFile: "internal/bridge/slack/audio_generation_tool_test.go", Tests: 4, Area: "Slack audio tool", Status: statusSkipped, Action: "Legacy ElevenLabs Slack audio tool is explicitly out-of-scope; meeting TTS uses the provider seam/fake-mic path instead."},
	{SourceFile: "internal/bridge/slack/bridge_session_test.go", Tests: 6, Area: "Slack session", Status: statusMigrated, Action: "Ported durable context cold-start, latest meeting context reuse, bounded command history, channel-type normalization, and repo clone refresh to current Slack session/runtime contracts."},
	{SourceFile: "internal/bridge/slack/config_test.go", Tests: 14, Area: "Slack config", Status: statusMigrated, Action: "Ported env/config/secrets-file, scanner aliases, run-mode-to-agent-runner, and Slack startup token validation to current config contracts."},
	{SourceFile: "internal/bridge/slack/defaults_test.go", Tests: 21, Area: "Slack prompts/defaults", Status: statusMigrated, Action: "Ported local memory adapter boundaries, triage policy rails, prompt compact/private-token guard, Slack event normalization, and scanner ignore/file-share behavior."},
	{SourceFile: "internal/bridge/slack/feedback_test.go", Tests: 3, Area: "Slack feedback", Status: statusMigrated, Action: "Ported read-only historical feedback access through local Slack memory seed summary/search/API; feedback mutation/improvement loops remain out-of-scope."},
	{SourceFile: "internal/bridge/slack/file_upload_resolve_test.go", Tests: 2, Area: "Slack file upload", Status: statusMigrated, Action: "Ported safe local upload path resolution and temp staging tests."},
	{SourceFile: "internal/bridge/slack/file_upload_test.go", Tests: 5, Area: "Slack file upload", Status: statusMigrated, Action: "Ported upload path aliases and workspace/symlink safety tests."},
	{SourceFile: "internal/bridge/slack/heartbeat_followup_test.go", Tests: 29, Area: "Slack heartbeat/followup", Status: statusMigrated, Action: "Ported followup creation/status/resolve, canonical thread commitment dedupe, delivery routing/blocking, heartbeat context/surface status, and current scoped runtime behavior."},
	{SourceFile: "internal/bridge/slack/heartbeat_log_tool_test.go", Tests: 4, Area: "Slack heartbeat logs", Status: statusMigrated, Action: "Ported heartbeat log path candidates, signal filtering, recent surfaces, missing-log error, and scoped raw-log hiding tests."},
	{SourceFile: "internal/bridge/slack/heartbeat_render_test.go", Tests: 4, Area: "Slack heartbeat render", Status: statusMigrated, Action: "Ported compact heartbeat context blocks, long-summary splitting, and supervisory completion normalization tests."},
	{SourceFile: "internal/bridge/slack/html_markdown_test.go", Tests: 1, Area: "Slack rendering", Status: statusMigrated, Action: "Ported HTML-to-markdown link conversion helper."},
	{SourceFile: "internal/bridge/slack/image_generation_tool_test.go", Tests: 3, Area: "Slack image tool", Status: statusSkipped, Action: "Image generation tool is not Slack/Meet meeting lifecycle and was not requested for this port."},
	{SourceFile: "internal/bridge/slack/interaction_feedback_test.go", Tests: 2, Area: "Slack interactions", Status: statusMigrated, Action: "Ported readable pending-action feedback summaries for create issue and create channel actions."},
	{SourceFile: "internal/bridge/slack/interaction_summary_test.go", Tests: 1, Area: "Slack interactions", Status: statusMigrated, Action: "Ported handled-thread action summary formatting."},
	{SourceFile: "internal/bridge/slack/linear_assignment_test.go", Tests: 2, Area: "Linear integration", Status: statusSkipped, Action: "Third-party credentialed Linear integration was de-prioritized by task #106."},
	{SourceFile: "internal/bridge/slack/linear_tools_test.go", Tests: 2, Area: "Linear integration", Status: statusSkipped, Action: "Third-party credentialed Linear integration was de-prioritized by task #106."},
	{SourceFile: "internal/bridge/slack/meet_publish_test.go", Tests: 3, Area: "Slack Canvas/meeting publish", Status: statusMigrated, Action: "Ported Canvas markdown/list normalization to current Canvas publisher tests."},
	{SourceFile: "internal/bridge/slack/meeting_handler_test.go", Tests: 5, Area: "Slack meeting approval", Status: statusMigrated, Action: "Ported approval channel normalization/lookup and meeting approval/join text formatting, with Onee Sama branding."},
	{SourceFile: "internal/bridge/slack/meeting_scanner_test.go", Tests: 2, Area: "Slack meeting scanner", Status: statusMigrated, Action: "Ported meeting scanner lookahead/suggestion timing helpers."},
	{SourceFile: "internal/bridge/slack/meeting_slack_notify_tool_test.go", Tests: 2, Area: "Slack meeting notify", Status: statusMigrated, Action: "Ported Slack user lookup/match tests for meeting notify resolution."},
	{SourceFile: "internal/bridge/slack/meeting_webhook_audio_test.go", Tests: 1, Area: "Slack meeting webhook/audio", Status: statusMigrated, Action: "Ported audio artifact extension sniffing to Slack webhook helpers."},
	{SourceFile: "internal/bridge/slack/meeting_webhook_test.go", Tests: 10, Area: "Slack meeting webhook", Status: statusMigrated, Action: "Ported incremental transcript, copilot summaries/hooks/follow-up detection, and artifact materialization/staging tests."},
	{SourceFile: "internal/bridge/slack/mention_test.go", Tests: 19, Area: "Slack mention", Status: statusMigrated, Action: "Ported mention text stripping, thread transcript/file/image/canvas formatting, outstanding request/compaction helpers, queued mention coalescing, reply footer/markdown/feedback summaries, failure/compaction replies, allowlist, and latest assistant fallback."},
	{SourceFile: "internal/bridge/slack/mrkdwn_blocks_test.go", Tests: 1, Area: "Slack rendering", Status: statusMigrated, Action: "Ported markdown-to-block splitting tests."},
	{SourceFile: "internal/bridge/slack/mrkdwn_test.go", Tests: 4, Area: "Slack rendering", Status: statusMigrated, Action: "Ported Markdown-to-Slack mrkdwn conversion tests."},
	{SourceFile: "internal/bridge/slack/msgbuffer_test.go", Tests: 10, Area: "Slack inbound buffer", Status: statusMigrated, Action: "Ported drain, cursor, triaged tracking, missed injection, retry scheduling, append, and Slack timestamp ordering tests."},
	{SourceFile: "internal/bridge/slack/repo_runtime_test.go", Tests: 1, Area: "Slack runtime repo", Status: statusMigrated, Action: "Ported committed-HEAD writable clone bootstrap so dirty host repo changes do not leak into agent worktrees."},
	{SourceFile: "internal/bridge/slack/run_command_tool_test.go", Tests: 1, Area: "Slack run command tool", Status: statusMigrated, Action: "Ported narrow allowlist validation for gh/curl/date commands and local/mutating command blocks."},
	{SourceFile: "internal/bridge/slack/runtime_status_tool_test.go", Tests: 8, Area: "Slack runtime status", Status: statusMigrated, Action: "Ported heartbeat, repo, meetings, overview, and scoped-thread runtime status formatting tests."},
	{SourceFile: "internal/bridge/slack/scanner_compact_test.go", Tests: 5, Area: "Slack scanner", Status: statusMigrated, Action: "Ported daily-note compaction threshold, hash, eligibility, and MEMORY.md prompt guard tests."},
	{SourceFile: "internal/bridge/slack/scanner_event_test.go", Tests: 2, Area: "Slack scanner", Status: statusMigrated, Action: "Ported cursor reconciliation and missed-history rebuffer tests."},
	{SourceFile: "internal/bridge/slack/scanner_test.go", Tests: 1, Area: "Slack scanner", Status: statusMigrated, Action: "Ported scanner message line formatting."},
	{SourceFile: "internal/bridge/slack/scanner_triage_test.go", Tests: 6, Area: "Slack scanner/triage", Status: statusMigrated, Action: "Ported assistant-history result hydration, empty no-mutation failure, recorder-based count reconciliation, and assistant trace tests."},
	{SourceFile: "internal/bridge/slack/slack_api_tool_fetch_test.go", Tests: 1, Area: "Slack API tool", Status: statusMigrated, Action: "Ported fetch thread parameter normalization."},
	{SourceFile: "internal/bridge/slack/slack_api_tool_messages_test.go", Tests: 2, Area: "Slack API tool", Status: statusMigrated, Action: "Ported assistant chat.postMessage / postThreadReply guardrails."},
	{SourceFile: "internal/bridge/slack/slash_commands_test.go", Tests: 2, Area: "Slack slash/status", Status: statusMigrated, Action: "Ported status dashboard meet-health probe, /health fallback, and config source rendering tests."},
	{SourceFile: "internal/bridge/slack/sqlite_protect_test.go", Tests: 2, Area: "Slack store", Status: statusMigrated, Action: "Ported corruption quarantine plus last-good snapshot restore semantics to current sqlite persistence provider."},
	{SourceFile: "internal/bridge/slack/store_test.go", Tests: 23, Area: "Slack store", Status: statusMigrated, Action: "Ported outbound action reservations, meeting result delivery reservations, thread ledger/channel brain lifecycle, triage run ordering, and cursor persistence to current Slack stores."},
	{SourceFile: "internal/bridge/slack/suggest_tool_test.go", Tests: 5, Area: "Slack suggest tool", Status: statusMigrated, Action: "Ported join-meeting suggestion normalization, validation failures, unknown action rejection, and explicit direct-create guardrail tests."},
	{SourceFile: "internal/bridge/slack/team_memory_test.go", Tests: 8, Area: "Slack team memory", Status: statusMigrated, Action: "Ported meeting summary projection, lesson candidates, people memory projection/lookup/correction tests."},
	{SourceFile: "internal/bridge/slack/tool_registration_test.go", Tests: 4, Area: "Slack tool registration", Status: statusMigrated, Action: "Ported current Slack assistant/planner/meeting-copilot/completion-only tool category parity while excluding de-prioritized credentialed/audio/image/usage tools."},
	{SourceFile: "internal/bridge/slack/triage_context_test.go", Tests: 5, Area: "Slack triage context", Status: statusMigrated, Action: "Ported triage prompt filtering, failure visibility, compact summary, and Slack method action recorder tests."},
	{SourceFile: "internal/bridge/slack/usage_tool_test.go", Tests: 3, Area: "Usage tool", Status: statusSkipped, Action: "Usage reporting is not Slack/Meet lifecycle and not requested for this port."},
}
