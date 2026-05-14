//go:build cueboardparity

package slackagent

import (
	"context"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityFormatTriageContextsSkipsNoOpOKRuns(t *testing.T) {
	t.Parallel()

	contexts := []SlackTriageContext{
		{
			Timestamp: time.Date(2026, time.March, 20, 15, 40, 0, 0, time.UTC).Format(time.RFC3339),
			Status:    "ok",
			Channels:  []string{"general"},
		},
		{
			Timestamp: time.Date(2026, time.March, 20, 15, 45, 0, 0, time.UTC).Format(time.RFC3339),
			Status:    "ok",
			Channels:  []string{"watercooler"},
			Actions: []SlackTriageAction{
				{Tool: "post_thread_reply", Channel: "watercooler", Brief: "shared a short synthesis"},
			},
		},
	}

	got := formatTriageContexts(contexts)
	if strings.Contains(got, "#general:") {
		t.Fatalf("no-op OK runs should be omitted from prompt context:\n%s", got)
	}
	if !strings.Contains(got, "#watercooler: post_thread_reply") {
		t.Fatalf("action-bearing run should remain in prompt context:\n%s", got)
	}
}

func TestCueboardParityFormatTriageContextsKeepsFailures(t *testing.T) {
	t.Parallel()

	got := formatTriageContexts([]SlackTriageContext{{
		Timestamp: time.Date(2026, time.March, 20, 15, 15, 0, 0, time.UTC).Format(time.RFC3339),
		Status:    "failed",
		Channels:  []string{"general"},
	}})
	if !strings.Contains(got, "#general: FAILED") {
		t.Fatalf("failed runs should remain visible to the prompt:\n%s", got)
	}
}

func TestCueboardParityCompactTriageSummaryNoActionRun(t *testing.T) {
	t.Parallel()

	got := compactTriageSummary(SlackTriageContext{
		Status:  "ok",
		Summary: "Very long reasoning that still ended in skip.",
	})
	if got != "Very long reasoning that still ended in skip." {
		t.Fatalf("compactTriageSummary = %q, want summary text", got)
	}
	got = compactTriageSummary(SlackTriageContext{Status: "ok"})
	if got != "Scanned, no action taken." {
		t.Fatalf("compactTriageSummary (no summary) = %q, want fallback", got)
	}
}

func TestCueboardParityCompactTriageSummaryPrefersActions(t *testing.T) {
	t.Parallel()

	got := compactTriageSummary(SlackTriageContext{
		Status: "ok",
		Actions: []SlackTriageAction{
			{Tool: "post_thread_reply", Channel: "general", Brief: "shared a short synthesis"},
			{Tool: "add_reaction", Channel: "watercooler", Brief: "added eyes"},
		},
	})
	if !strings.Contains(got, "#general shared a short synthesis") {
		t.Fatalf("compactTriageSummary missing general action: %q", got)
	}
	if !strings.Contains(got, "#watercooler added eyes") {
		t.Fatalf("compactTriageSummary missing watercooler action: %q", got)
	}
}

func TestCueboardParityTriageActionRecorderSupportsSlackMethodCalls(t *testing.T) {
	t.Parallel()

	var recorder triageActionRecorder
	recorder.record("slack_api", map[string]any{
		"method": "slack.postThreadReply",
		"params": map[string]any{
			"channel": "general",
			"text":    "shared a short synthesis",
		},
	}, slackAPIToolResult{Success: true, Text: "ok"})

	if len(recorder.toolCalls) != 1 {
		t.Fatalf("toolCalls len = %d, want 1", len(recorder.toolCalls))
	}
	if recorder.toolCalls[0].Action != "post_thread_reply" {
		t.Fatalf("toolCalls[0].Action = %q, want post_thread_reply", recorder.toolCalls[0].Action)
	}

	ctxText := formatTriageContexts([]SlackTriageContext{{
		Timestamp: time.Date(2026, time.March, 20, 16, 0, 0, 0, time.UTC).Format(time.RFC3339),
		Status:    "ok",
		Channels:  []string{"general"},
		Actions:   recorder.actions,
	}})
	if !strings.Contains(ctxText, "#general: post_thread_reply") {
		t.Fatalf("previous triage context should include post_thread_reply action:\n%s", ctxText)
	}

	store := newSlackTriageStore(appconfig.PersistenceConfig{Provider: "memory"}, nil)
	run, err := store.RecordRun(context.Background(), SlackTriageContext{
		SessionID: "sess-method",
		Status:    "ok",
		Channels:  []string{"general"},
		ToolCalls: recorder.toolCalls,
		Actions:   recorder.actions,
	})
	if err != nil {
		t.Fatalf("RecordRun: %v", err)
	}
	if run.ID == 0 {
		t.Fatal("RecordRun should assign an id")
	}

	contexts, err := store.ListRuns(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListRuns: %v", err)
	}
	if len(contexts) != 1 || len(contexts[0].ToolCalls) != 1 {
		t.Fatalf("unexpected stored contexts: %+v", contexts)
	}
}
