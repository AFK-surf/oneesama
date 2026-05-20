package slackagent

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
			"external_links_fetched":       1,
			"input_context_chars":          8200,
			"delegate_worker_jobs_started": 1,
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
		"*Oneesama Daily Audit*",
		"*New Oneesama summary* · reply 1 / like(reaction) 1",
		"*Old slackd summary* · reply 1 / like(reaction) 1",
		"*Liked / emoji reactions*",
		"*Self-iteration notes*",
		"custom_emoji +0",
		":memo_bridge:",
	} {
		if !strings.Contains(report.Text, want) {
			t.Fatalf("report text = %q, want %q", report.Text, want)
		}
	}
	if strings.Contains(report.Text, "*Quality buckets*") || strings.Contains(report.Text, "invalid_json=") {
		t.Fatalf("report text = %q, should keep old daily-audit action buckets instead of invented quality bucket labels", report.Text)
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
