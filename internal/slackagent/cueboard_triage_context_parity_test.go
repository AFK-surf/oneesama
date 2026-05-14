//go:build cueboardparity

package slackagent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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
			{Tool: "delete_message", Channel: "random", Brief: "deleted msg"},
			{Tool: "edit_message", Channel: "ops", Brief: "edited msg"},
		},
	})
	if !strings.Contains(got, "#general shared a short synthesis") {
		t.Fatalf("compactTriageSummary missing general action: %q", got)
	}
	if !strings.Contains(got, "#watercooler added eyes") {
		t.Fatalf("compactTriageSummary missing watercooler action: %q", got)
	}
	if strings.Contains(got, "edited msg") {
		t.Fatalf("compactTriageSummary should keep cueboard's first-three action cap, got %q", got)
	}
	if strings.Contains(got, ";") {
		t.Fatalf("compactTriageSummary should use cueboard pipe separators, got %q", got)
	}
}

func TestCueboardParityCompactTriageSummaryIncludesFailureReason(t *testing.T) {
	t.Parallel()

	got := compactTriageSummary(SlackTriageContext{
		Status: "failed",
		Error:  "empty final response with no mutations",
	})
	if got != "FAILED: empty final response with no mutations" {
		t.Fatalf("compactTriageSummary failed run = %q", got)
	}
}

func TestCueboardParityTriageProjectionRingBufferArchivesEvictions(t *testing.T) {
	workspace := t.TempDir()
	for i := 0; i < triageContextMaxSize+2; i++ {
		persistTriageContext(workspace, SlackTriageContext{
			SessionID: "sess-" + string(rune('a'+i)),
			Timestamp: time.Date(2026, 3, 20, 12, i, 0, 0, time.UTC).
				Format(time.RFC3339Nano),
			Status:   "ok",
			Channels: []string{"general"},
			Summary:  "summary",
		})
	}

	contexts := loadTriageContextsFromProjection(workspace)
	if len(contexts) != triageContextMaxSize {
		t.Fatalf("projection len = %d, want ring buffer size %d", len(contexts), triageContextMaxSize)
	}
	if contexts[0].SessionID != "sess-c" {
		t.Fatalf("first retained context = %q, want oldest two archived", contexts[0].SessionID)
	}
	archivePath := filepath.Join(workspace, "memory", "triage-archive", "2026-03-20.json")
	raw, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatalf("read archive: %v", err)
	}
	var archived []SlackTriageContext
	if err := json.Unmarshal(raw, &archived); err != nil {
		t.Fatalf("parse archive: %v", err)
	}
	if len(archived) != 2 || archived[0].SessionID != "sess-a" || archived[1].SessionID != "sess-b" {
		t.Fatalf("archived = %#v, want first two evicted contexts", archived)
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
