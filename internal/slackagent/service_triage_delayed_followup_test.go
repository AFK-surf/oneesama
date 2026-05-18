package slackagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestSlackTriageRecordsDelayedNoReplyFollowupForDeferredQuestion(t *testing.T) {
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_delayed_no_reply",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"这个问题先等其他人回复，暂时不用回。","actions":[]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack: appconfig.SlackConfig{
			Triage: appconfig.SlackTriageConfig{HeuristicFallback: true},
		},
		Runner: runner,
	})

	started, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "这个方案是不是应该继续做？没人有想法吗？",
		TS:        "1779076415.945449",
	}}, "#meeting-avatar: 这个方案是不是应该继续做？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Finalization == nil || started.Finalization.Run == nil {
		t.Fatalf("started = %#v, want finalized triage run", started)
	}

	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one delayed no-reply candidate", followups)
	}
	got := followups[0]
	if got.Kind != slackDelayedNoReplyFollowupKind || got.ChannelID != "C123" || got.ThreadTS != "1779076415.945449" {
		t.Fatalf("followup = %#v, want delayed thread followup", got)
	}
	if got.Metadata["classification"] != "stale_wait_for_human" || got.Metadata["one_shot"] != true {
		t.Fatalf("metadata = %#v, want stale_wait_for_human one-shot", got.Metadata)
	}
	if got.NextCheckAt == "" || !strings.Contains(got.Summary, "补一下") {
		t.Fatalf("followup = %#v, want delayed public summary", got)
	}
}

func TestSlackTriageUsesDeferredKeywordTemplateOverride(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "delayed_no_reply_deferred_keywords.en.tmpl"), []byte("owner should answer later\n"), 0o600); err != nil {
		t.Fatalf("write deferred keyword override: %v", err)
	}
	t.Setenv("ONEESAMA_TRIAGE_TEMPLATE_DIR", dir)

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_delayed_no_reply_override",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"owner should answer later; no action yet.","actions":[]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{Triage: appconfig.SlackTriageConfig{HeuristicFallback: true}},
		Runner:      runner,
	})

	if _, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "Should someone reply here?",
		TS:        "1779076415.945449",
	}}, "#meeting-avatar: Should someone reply here?"); err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one delayed no-reply candidate", followups)
	}
	if got := followups[0].Metadata["classification"]; got != "stale_wait_for_human" {
		t.Fatalf("classification = %v, want stale_wait_for_human", got)
	}
}

func TestSlackTriageDoesNotRecordDelayedNoReplyForLowSignalChatter(t *testing.T) {
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_low_signal_no_delay",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   `{"summary":"low signal acknowledgement; no action needed.","actions":[]}`,
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{Triage: appconfig.SlackTriageConfig{HeuristicFallback: true}},
		Runner:      runner,
	})

	if _, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "ok",
		TS:        "1779076415.945449",
	}}, "#meeting-avatar: ok"); err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 0 {
		t.Fatalf("followups = %#v, want none for low-signal chatter", followups)
	}
}

func TestSlackTriageRecordsTimeoutRetryFollowupForTimedOutJob(t *testing.T) {
	now := time.Date(2026, 5, 18, 16, 0, 0, 0, time.UTC)
	previousClock := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_timeout",
		Provider: "codex",
		Status:   agentrunner.StatusTimeout,
		Error:    "job timed out",
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{Triage: appconfig.SlackTriageConfig{HeuristicFallback: true}},
		Runner:      runner,
	})

	started, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "这条长线程有很多上下文，需要 oneesama 补一个判断。",
		TS:        "1779090000.000001",
	}}, "#meeting-avatar: 这条长线程有很多上下文，需要 oneesama 补一个判断。")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Finalization == nil || started.Finalization.Run == nil {
		t.Fatalf("started = %#v, want finalized timeout triage run", started)
	}
	run := started.Finalization.Run
	if run.Status != "failed" || run.Metadata["triage_timeout_needs_retry"] != true {
		t.Fatalf("run = %#v, want failed run marked triage_timeout_needs_retry", run)
	}

	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one timeout retry followup", followups)
	}
	got := followups[0]
	if got.Kind != slackTriageTimeoutFollowupKind || got.ChannelID != "C123" || got.ThreadTS != "1779090000.000001" {
		t.Fatalf("followup = %#v, want timeout retry thread followup", got)
	}
	if got.SourceRef != "triage_timeout_retry:C123:1779090000.000001" || got.Priority != heartbeatFollowupPriorityNormal {
		t.Fatalf("followup = %#v, want stable source ref and normal priority", got)
	}
	if got.NextCheckAt != now.Add(slackTriageTimeoutFollowupDelay).Format(time.RFC3339Nano) {
		t.Fatalf("NextCheckAt = %q, want 15m retry delay", got.NextCheckAt)
	}
	if got.Metadata["classification"] != "triage_timeout_needs_retry" || got.Metadata["job_status"] != string(agentrunner.StatusTimeout) || got.Metadata["one_shot"] != true {
		t.Fatalf("metadata = %#v, want timeout retry metadata", got.Metadata)
	}
	if got.Metadata["input_context_chars"] == nil || got.Metadata["error"] != "job timed out" {
		t.Fatalf("metadata = %#v, want audit context and timeout error", got.Metadata)
	}
	if !strings.Contains(got.Title, "补看") || !strings.Contains(got.Summary, "没有完整判断") {
		t.Fatalf("followup = %#v, want templated timeout retry copy", got)
	}
}

func TestSlackTriageDoesNotRecordTimeoutRetryFollowupForGenericFailure(t *testing.T) {
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_generic_failure",
		Provider: "codex",
		Status:   agentrunner.StatusFailed,
		Error:    "invalid response",
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{Triage: appconfig.SlackTriageConfig{HeuristicFallback: true}},
		Runner:      runner,
	})

	started, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "这个问题需要讨论一下吗？",
		TS:        "1779090000.000002",
	}}, "#meeting-avatar: 这个问题需要讨论一下吗？")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Finalization == nil || started.Finalization.Run == nil {
		t.Fatalf("started = %#v, want finalized triage run", started)
	}
	if started.Finalization.Run.Metadata["triage_timeout_needs_retry"] != nil {
		t.Fatalf("metadata = %#v, want no timeout retry marker for generic failure", started.Finalization.Run.Metadata)
	}
	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 0 {
		t.Fatalf("followups = %#v, want no timeout retry followup for generic failure", followups)
	}
}

func TestSlackTriageRecordsEmptyFinalRetryFollowupForEmptyCompletedJob(t *testing.T) {
	now := time.Date(2026, 5, 19, 1, 40, 0, 0, time.UTC)
	previousClock := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_empty_final",
		Provider: "codex",
		Status:   agentrunner.StatusCompleted,
		Result:   "",
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{Triage: appconfig.SlackTriageConfig{HeuristicFallback: true}},
		Runner:      runner,
	})

	started, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "这条 thread 明明该有人补一个判断，但 runner 没吐最终答案。",
		TS:        "1779090000.000004",
	}}, "#meeting-avatar: 这条 thread 明明该有人补一个判断，但 runner 没吐最终答案。")
	if err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	if started.Finalization == nil || started.Finalization.Run == nil {
		t.Fatalf("started = %#v, want finalized triage run", started)
	}
	run := started.Finalization.Run
	if run.Status != "failed" || run.Metadata["triage_empty_final_needs_retry"] != true {
		t.Fatalf("run = %#v, want failed run marked triage_empty_final_needs_retry", run)
	}
	if run.Metadata["triage_timeout_needs_retry"] != nil {
		t.Fatalf("metadata = %#v, want empty-final retry without timeout marker", run.Metadata)
	}

	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one empty-final retry followup", followups)
	}
	got := followups[0]
	if got.Kind != slackTriageEmptyFinalFollowupKind || got.ChannelID != "C123" || got.ThreadTS != "1779090000.000004" {
		t.Fatalf("followup = %#v, want empty-final retry thread followup", got)
	}
	if got.SourceRef != "triage_empty_final_retry:C123:1779090000.000004" || got.Priority != heartbeatFollowupPriorityNormal {
		t.Fatalf("followup = %#v, want stable source ref and normal priority", got)
	}
	if got.NextCheckAt != now.Add(slackTriageEmptyFinalFollowupDelay).Format(time.RFC3339Nano) {
		t.Fatalf("NextCheckAt = %q, want 15m retry delay", got.NextCheckAt)
	}
	if got.Metadata["classification"] != "triage_empty_final_needs_retry" || got.Metadata["failure_source"] != "agent_runner" || got.Metadata["job_status"] != string(agentrunner.StatusCompleted) || got.Metadata["one_shot"] != true {
		t.Fatalf("metadata = %#v, want empty-final retry metadata", got.Metadata)
	}
	if got.Metadata["error"] != "empty final response with no mutations" {
		t.Fatalf("metadata = %#v, want empty final error", got.Metadata)
	}
	if !strings.Contains(got.Title, "未完成判断") || !strings.Contains(got.Summary, "没有产出可用判断") {
		t.Fatalf("followup = %#v, want templated empty-final retry copy", got)
	}
}

func TestTriageTimeoutRetryFollowupUsesTemplateOverride(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "triage_timeout_title.zh.tmpl"), []byte("自定义 timeout 标题：{{.ThreadTS}}\n"), 0o644); err != nil {
		t.Fatalf("write title template override: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "triage_timeout_summary.zh.tmpl"), []byte("自定义 timeout 摘要：{{.Snippet}}\n"), 0o644); err != nil {
		t.Fatalf("write summary template override: %v", err)
	}
	t.Setenv("ONEESAMA_TRIAGE_TEMPLATE_DIR", dir)
	runner := &fakeRunner{job: agentrunner.Job{
		ID:       "job_triage_timeout_template",
		Provider: "codex",
		Status:   agentrunner.StatusTimeout,
		Error:    "timeout",
	}}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Runner:      runner,
	})

	if _, err := service.StartSlackTriage(context.Background(), "C123", []SlackInboundMessage{{
		TeamID:    "T123",
		ChannelID: "C123",
		UserID:    "U123",
		Text:      "这条中文长讨论需要补看。",
		TS:        "1779090000.000003",
	}}, "#meeting-avatar: 这条中文长讨论需要补看。"); err != nil {
		t.Fatalf("StartSlackTriage: %v", err)
	}
	followups, err := service.followups.ListFollowups(context.Background(), "open", 10)
	if err != nil {
		t.Fatalf("ListFollowups: %v", err)
	}
	if len(followups) != 1 {
		t.Fatalf("followups = %#v, want one timeout retry followup", followups)
	}
	if followups[0].Title != "自定义 timeout 标题：1779090000.000003" || !strings.Contains(followups[0].Summary, "自定义 timeout 摘要") {
		t.Fatalf("followup = %#v, want timeout template overrides", followups[0])
	}
}

func TestDelayedNoReplyTitleUsesTemplateOverride(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "delayed_no_reply_title.zh.tmpl"), []byte("自定义 followup 标题：{{.Classification}}\n"), 0o644); err != nil {
		t.Fatalf("write template override: %v", err)
	}
	t.Setenv("ONEESAMA_TRIAGE_TEMPLATE_DIR", dir)

	candidate, ok := slackDelayedNoReplyCandidateFor(
		SlackTriageDecision{},
		[]SlackInboundMessage{{Text: "这个架构问题是不是应该让 Pi persona 接住？"}},
	)
	if !ok {
		t.Fatal("slackDelayedNoReplyCandidateFor returned false, want candidate")
	}
	if candidate.Title != "自定义 followup 标题：unanswered_question" {
		t.Fatalf("candidate.Title = %q, want template override", candidate.Title)
	}
}

func TestDelayedNoReplyFollowupSurfacesOnceAndCloses(t *testing.T) {
	now := time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC)
	previousClock := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Kind:        slackDelayedNoReplyFollowupKind,
		Title:       "补一下这个开放问题",
		Summary:     "补一下这条：我的初步判断是先列选项。",
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   "C123",
		ThreadTS:    "123.456",
		SourceRef:   "delayed_no_reply:C123:123.456",
		Priority:    heartbeatFollowupPriorityUrgent,
		NextCheckAt: now.Add(-time.Minute).Format(time.RFC3339Nano),
		Metadata:    map[string]any{"one_shot": true},
	})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}

	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if len(response.Posted) != 1 || len(poster.Calls()) != 1 {
		t.Fatalf("response=%#v calls=%#v, want one post", response, poster.Calls())
	}
	updated, err := service.followups.GetFollowup(context.Background(), record.ID)
	if err != nil {
		t.Fatalf("GetFollowup: %v", err)
	}
	if updated == nil || updated.Status != "done" || updated.LastSurfacedAt == "" || updated.Metadata["resolution"] != "surfaced_once" {
		t.Fatalf("updated = %#v, want one-shot done followup", updated)
	}
}

func TestDelayedNoReplyFollowupSurfacesWithFreshRelatedMemoryEvidence(t *testing.T) {
	now := time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC)
	previousClock := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock })

	workspaceDir := t.TempDir()
	writeRelatedMemoryFile(t, workspaceDir, "memory/team/questions/bridge-memory.md", strings.Join([]string{
		"# Bridge memory Aha",
		"",
		"Bridge memory Aha Moment replies should cite related-topic recall evidence before speaking.",
		"The avatar should separate memory evidence from worker implementation details.",
	}, "\n"))
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Slack:       appconfig.SlackConfig{WorkspaceDir: workspaceDir},
		Poster:      poster,
	})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Kind:        slackDelayedNoReplyFollowupKind,
		Title:       "补一下这个开放问题",
		Summary:     "补一下这条：bridge memory Aha Moment 没人接时应该引用记忆证据。",
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   "C123",
		ThreadTS:    "123.456",
		SourceRef:   "delayed_no_reply:C123:123.456",
		Priority:    heartbeatFollowupPriorityUrgent,
		NextCheckAt: now.Add(-time.Minute).Format(time.RFC3339Nano),
		Metadata:    map[string]any{"one_shot": true, "classification": "unanswered_question"},
	})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}

	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	calls := poster.Calls()
	if len(response.Posted) != 1 || len(calls) != 1 {
		t.Fatalf("response=%#v calls=%#v, want one post", response, calls)
	}
	if !strings.Contains(calls[0].Text, "相关记忆证据") || !strings.Contains(calls[0].Text, "memory/team/questions/bridge-memory.md:1-4") {
		t.Fatalf("posted text missing related memory citation:\n%s", calls[0].Text)
	}
	updated, err := service.followups.GetFollowup(context.Background(), record.ID)
	if err != nil {
		t.Fatalf("GetFollowup: %v", err)
	}
	if updated == nil || intFromAny(updated.Metadata["related_memory_count"]) != 1 {
		t.Fatalf("updated = %#v, want related memory metadata", updated)
	}
}

func TestDelayedNoReplyFollowupSkipsWhenThreadHasNewerActivity(t *testing.T) {
	createdAt := time.Date(2026, 5, 18, 10, 0, 0, 0, time.UTC)
	current := createdAt
	previousClock := timeNow
	timeNow = func() time.Time { return current }
	t.Cleanup(func() { timeNow = previousClock })

	poster := &recordingPoster{}
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}, Poster: poster})
	record, err := service.followups.CreateFollowup(context.Background(), SlackHeartbeatFollowup{
		Kind:        slackDelayedNoReplyFollowupKind,
		Title:       "补一下这个开放问题",
		Summary:     "补一下这条：我的初步判断是先列选项。",
		SourceKind:  heartbeatSourceKindThread,
		ChannelID:   "C123",
		ThreadTS:    "123.456",
		SourceRef:   "delayed_no_reply:C123:123.456",
		Priority:    heartbeatFollowupPriorityUrgent,
		NextCheckAt: createdAt.Add(-time.Minute).Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatalf("CreateFollowup: %v", err)
	}

	current = createdAt.Add(2 * time.Hour)
	if err := service.cognition.RecordInbound(context.Background(), "workspace", SlackInboundMessage{
		ChannelID: "C123",
		ThreadTS:  "123.456",
		UserID:    "U456",
		TS:        current.Add(-5 * time.Minute).Format(time.RFC3339Nano),
		Text:      "我来接一下这个问题。",
	}); err != nil {
		t.Fatalf("RecordInbound: %v", err)
	}
	response, err := service.SurfaceSlackFollowups(context.Background(), SlackFollowupSurfaceRequest{FollowupID: record.ID})
	if err != nil {
		t.Fatalf("SurfaceSlackFollowups: %v", err)
	}
	if len(poster.Calls()) != 0 {
		t.Fatalf("poster calls = %#v, want none after newer activity", poster.Calls())
	}
	if len(response.Skipped) != 1 || response.Skipped[0].BlockReason != "thread_has_newer_activity" {
		t.Fatalf("response = %#v, want thread_has_newer_activity skip", response)
	}
	updated, err := service.followups.GetFollowup(context.Background(), record.ID)
	if err != nil {
		t.Fatalf("GetFollowup: %v", err)
	}
	if updated == nil || updated.Status != "done" || updated.Metadata["resolution"] != "thread_has_newer_activity" {
		t.Fatalf("updated = %#v, want obsolete delayed followup closed", updated)
	}
}
