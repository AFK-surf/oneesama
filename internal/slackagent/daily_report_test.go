package slackagent

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
	_ "modernc.org/sqlite"
)

func TestSlackDailyReportComparesLegacyEmojiUse(t *testing.T) {
	ctx := context.Background()
	legacyDB := writeLegacySlackdDailyReportDB(t, time.Date(2026, 5, 19, 12, 0, 0, 0, time.UTC))
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{DailyReport: appconfig.SlackDailyReportConfig{
			LegacySlackDBPath: legacyDB,
			Window:            24 * time.Hour,
		}},
		Poster: &recordingPoster{},
	})
	service.customEmoji = []string{"memo_bridge"}
	if _, err := service.triage.RecordRun(ctx, SlackTriageContext{
		Timestamp: time.Date(2026, 5, 19, 13, 0, 0, 0, time.UTC).Format(time.RFC3339Nano),
		Status:    "ok",
		Summary:   "posted workspace commentary and a custom reaction",
		Mutations: 2,
		Actions: []SlackTriageAction{
			{Tool: "post_thread_reply", Channel: "C09L0TAN31T", Brief: "replied with memory-backed commentary"},
			{Tool: "add_reaction", Channel: "C09L0TAN31T", Brief: "added :memo_bridge:"},
		},
		ToolCalls: []SlackTriageToolCall{
			{Tool: "memory_get", Success: true, Brief: "workspace memory"},
			{Tool: "exa_search", Success: true, Brief: "external source"},
			{Tool: "slack_api", Action: "fetch_thread", Success: true, Brief: "thread context"},
		},
		Metadata: map[string]any{
			"external_links_fetched":                1,
			"input_context_chars":                   8200,
			"context_budget_total_tokens":           1200,
			"context_budget_dynamic_tokens":         80,
			"context_budget_worker_result_tokens":   40,
			"context_budget_memory_evidence_tokens": 160,
			"delegate_worker_jobs_started":          1,
		},
	}); err != nil {
		t.Fatalf("record run: %v", err)
	}
	report, err := service.BuildDailyReport(
		ctx,
		time.Date(2026, 5, 19, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 5, 20, 0, 0, 0, 0, time.UTC),
		"2026-05-19",
	)
	if err != nil {
		t.Fatalf("BuildDailyReport() error = %v", err)
	}
	if report.New.Runs != 1 || report.New.ReplyRuns != 1 || report.New.ReactionRuns != 1 || report.New.CustomEmojiUses != 1 {
		t.Fatalf("new metrics = %#v, want reply + custom reaction", report.New)
	}
	if report.New.MemoryLookups != 1 || report.New.ExternalSearches != 1 || report.New.ThreadFetches != 1 || report.New.DelegateWorkerJobs != 1 {
		t.Fatalf("new tool metrics = %#v, want memory/search/thread/delegate", report.New)
	}
	if !report.Legacy.Available || report.Legacy.Runs != 1 || report.Legacy.ReactionRuns != 1 || report.Legacy.CustomEmojiUses != 1 {
		t.Fatalf("legacy metrics = %#v, want available reaction + custom emoji", report.Legacy)
	}
	for _, want := range []string{
		"*今日日记 · 2026-05-19*",
		"今天我观察到的主线集中在",
		"*我观察到的主线*",
		"*团队协作与 review*",
		"posted workspace commentary and a custom reaction",
		"legacy replied and reacted",
	} {
		if !strings.Contains(report.Text, want) {
			t.Fatalf("report text = %q, want %q", report.Text, want)
		}
	}
	for _, blocked := range []string{
		"*Oneesama Daily Audit*",
		"*New Oneesama summary*",
		"*Old slackd summary*",
		"*Old-vs-new delta*",
		"*Emoji audit*",
		"*Self-iteration notes*",
		"max_context_tokens",
		"invalid_json=",
	} {
		if strings.Contains(report.Text, blocked) {
			t.Fatalf("report text = %q, should not expose audit label %q", report.Text, blocked)
		}
	}
	if report.Diary.Sources.NewRuns != 1 || report.Diary.Sources.LegacyRuns != 1 || len(report.Diary.Themes) == 0 {
		t.Fatalf("diary = %#v, want source counts and themes", report.Diary)
	}
}

func TestSlackDailyReportRunPostsOncePerDateAndChannel(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 20, 10, 0, 0, 0, time.UTC)
	previousClock := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	poster := &recordingPoster{}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{DailyReport: appconfig.SlackDailyReportConfig{
			ChannelID: "C_REPORT",
			Window:    24 * time.Hour,
		}},
		Poster: poster,
	})
	if _, err := service.triage.RecordRun(ctx, SlackTriageContext{
		Timestamp: now.Add(-time.Hour).Format(time.RFC3339Nano),
		Status:    "ok",
		Summary:   "no action sample",
		Metadata:  map[string]any{"input_context_chars": 100},
	}); err != nil {
		t.Fatalf("record run: %v", err)
	}
	first, err := service.RunDailyReport(ctx, SlackDailyReportRunRequest{})
	if err != nil {
		t.Fatalf("first RunDailyReport() error = %v", err)
	}
	if first.Post == nil || !first.Post.OK || first.Record == nil {
		t.Fatalf("first response = %#v, want posted record", first)
	}
	second, err := service.RunDailyReport(ctx, SlackDailyReportRunRequest{})
	if err != nil {
		t.Fatalf("second RunDailyReport() error = %v", err)
	}
	if !second.Skipped || second.Reason != "already_posted" {
		t.Fatalf("second response = %#v, want already_posted skip", second)
	}
	if calls := poster.Calls(); len(calls) != 1 || calls[0].Channel != "C_REPORT" || !strings.HasPrefix(calls[0].DedupKey, "daily-report:C_REPORT:") {
		t.Fatalf("poster calls = %#v, want one daily report post", calls)
	}
}

func TestNextSlackDailyReportRunUsesConfiguredTimezone(t *testing.T) {
	next, err := nextSlackDailyReportRun(
		time.Date(2026, 5, 20, 9, 30, 0, 0, time.UTC),
		appconfig.SlackDailyReportConfig{TimeOfDay: "18:00", Timezone: "Asia/Shanghai"},
	)
	if err != nil {
		t.Fatalf("nextSlackDailyReportRun() error = %v", err)
	}
	want := time.Date(2026, 5, 20, 10, 0, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Fatalf("next = %s, want %s", next, want)
	}
}

func TestSlackDailyReportRunSampleTruncatesUTF8Safely(t *testing.T) {
	run := SlackTriageContext{
		Timestamp: time.Date(2026, 5, 20, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano),
		Channels:  []string{"C09L0TAN31T"},
	}
	sample := slackDailyReportRunSample(run, strings.Repeat("中文", 120))
	if !utf8.ValidString(sample) {
		t.Fatalf("sample = %q, want valid UTF-8", sample)
	}
	if !strings.HasSuffix(sample, "...") {
		t.Fatalf("sample = %q, want truncated marker", sample)
	}
}

func TestSlackDailyReportRunSampleScrubsInternalRuntimeDetails(t *testing.T) {
	run := SlackTriageContext{
		Timestamp: time.Date(2026, 5, 20, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano),
		Channels:  []string{"C09L0TAN31T"},
	}
	sample := slackDailyReportRunSample(run, "Post \"http://127.0.0.1:8799/persona/decide\": context deadline exceeded")
	for _, blocked := range []string{"127.0.0.1", "localhost", "persona/decide"} {
		if strings.Contains(sample, blocked) {
			t.Fatalf("sample = %q, should scrub %q", sample, blocked)
		}
	}
	if !strings.Contains(sample, "persona runtime request") {
		t.Fatalf("sample = %q, want user-safe runtime wording", sample)
	}
}

func TestSlackDailyDiaryFiltersNoActionAndToolIntrospection(t *testing.T) {
	for _, text := range []string{
		"用户未明确请求 Oneesama 介入调查或做可见回复，自行跟进的动作表明不需要额外介入。",
		"Let me look at these threads more carefully before deciding. Tool calls: slack_api conversations.replies",
		"Casual banter reacting to a product pivot link share. No question or request. No reply needed.",
		"Repeat '/deploy' commands not directed at Oneesama; deployment operations are out of scope per secretary policy. Staying silent.",
		"simplified approval card live 998150f is active",
		"The question was directly answered by the tagged teammate; thread is handled and no further action is needed",
		"从之前的讨论看，local VM 文件变更检测原本有一个确认面板，现在可能被「直接完成」取代了。要不要看看最近的 release note 或代码变更？",
		`{"query":"studyouwei twitter status 2057767798752112906","count":10,"results":[{`,
		`[ { "file_path": "memory/2026-03-20.md", "start_line": 1, "end_line": 2 } ]`,
		"reactions.add",
		"No direct evidence about evaluation case capabilities in current context; delegating to worker to search memory, which is bounded secretary work",
		"Persona reply",
		"delegate_worker",
		"Reply posted to thread (ts: 1779438652.245549, 2 blocks)",
		"Persona delegate_worker suppressed for ambient/non-addressed triage",
		"codex-3720 is already actively handling this cueboard bug report and is now working on the fix.",
		"@codex-3720 review & merge cueboard#2022, patch if have problem",
		"<https://x.com/studyouwei/status/2057767798752112906?s=20>",
		"pending_dm_card_posted",
		"1779446254.721159",
		"Buffered 2 Slack message(s); latest from <@U09KY0GE28K>",
		"## Pass 1: Classification | Ref | Summary | Classification | Reasoning |",
		"Successfully wrote to memory/2026-05-22.md (mode: append)",
		"mentioned_other_user_without_bot",
		"这感觉怕是有点难哦\" [reactions: :吃瓜: ×1]",
		"AgentRunner triage completed",
		"**** just codex-3720 logging its own automated cleanup and download progress. No human ask, no coordination needed, nothing for me to add",
		"SKIP — internal technical debugging thread about screen lock/sleep behavior. The team is working through the issue themselves.",
	} {
		if !slackDailyDiaryLowSignal(text) {
			t.Fatalf("slackDailyDiaryLowSignal(%q) = false, want true", text)
		}
	}
	if slackDailyDiaryLowSignal("修复 Join with realtime 按钮回到默认卡片的问题，root cause 是重复 Socket Mode listener 抢走 interaction。") {
		t.Fatal("slackDailyDiaryLowSignal() filtered a concrete engineering update")
	}
}

func TestSlackDailyReportPlaceholderSummaryDoesNotFlagTodoProductText(t *testing.T) {
	run := SlackTriageContext{
		Summary: "The thread is an internal product discussion about removing the todo tool and future multi-agent UI decisions.",
	}
	if slackDailyReportPlaceholderSummary(run) {
		t.Fatalf("lowercase product text containing todo should not count as placeholder")
	}
	if !slackDailyReportPlaceholderSummary(SlackTriageContext{Summary: "TODO: replace this summary"}) {
		t.Fatal("uppercase TODO marker should count as placeholder")
	}
}

func writeLegacySlackdDailyReportDB(t *testing.T, occurredAt time.Time) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "slackd.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	schema := []string{
		`create table triage_run (id integer primary key, session_id text, occurred_at text, status text, summary text, error text, digest text, steps integer, duration_seconds real, mutations integer, failures integer, tokens_used integer, channels_json text, raw_output text)`,
		`create table triage_action (id integer primary key, run_id integer, position integer, tool text, channel text, brief text, created_at text)`,
		`create table triage_tool_call (id integer primary key, run_id integer, position integer, tool text, action text, args text, success integer, brief text, created_at text, result text)`,
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("exec schema %q: %v", stmt, err)
		}
	}
	if _, err := db.Exec(
		`insert into triage_run (id, session_id, occurred_at, status, summary, error, digest, steps, duration_seconds, mutations, failures, tokens_used, channels_json, raw_output) values (1, 'legacy-session', ?, 'ok', 'legacy replied and reacted', '', '', 3, 1.2, 2, 0, 120, '["C09L0TAN31T"]', '')`,
		occurredAt.UTC().Format(time.RFC3339Nano),
	); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	if _, err := db.Exec(`insert into triage_action (run_id, position, tool, channel, brief, created_at) values (1, 1, 'post_thread_reply', 'C09L0TAN31T', 'posted reply', ?), (1, 2, 'add_reaction', 'C09L0TAN31T', 'added :memo_bridge:', ?)`, occurredAt.Format(time.RFC3339Nano), occurredAt.Format(time.RFC3339Nano)); err != nil {
		t.Fatalf("insert actions: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stat db: %v", err)
	}
	return path
}
