//go:build cueboardparity

package slackagent

import (
	"context"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestCueboardParityHydrateTriageResultContentFallsBackToAssistantHistory(t *testing.T) {
	t.Parallel()

	history := []triageAssistantTurn{
		{Role: "assistant", Content: "No action needed right now."},
	}

	got := hydrateTriageResultContent("sess-1", "", history)
	if got != "No action needed right now." {
		t.Fatalf("content = %q, want fallback assistant text", got)
	}
}

func TestCueboardParityTriageDidSucceedRejectsEmptyNoMutationRun(t *testing.T) {
	t.Parallel()

	ok, reason := triageDidSucceed("sess-1", 0, 0, nil, "")
	if ok {
		t.Fatal("triageDidSucceed should reject empty no-mutation run")
	}
	if reason != "empty final response with no mutations" {
		t.Fatalf("reason = %q, want empty-response failure", reason)
	}
}

func TestCueboardParityTriageDidSucceedAllowsMutationsWithFailures(t *testing.T) {
	t.Parallel()

	ok, reason := triageDidSucceed("sess-1", 1, 2, nil, "")
	if !ok {
		t.Fatalf("triageDidSucceed rejected mutation-bearing run with failures: %s", reason)
	}
	if reason != "" {
		t.Fatalf("reason = %q, want empty", reason)
	}
}

func TestCueboardParityTriageDidSucceedAllowsNoOpRunWithSummary(t *testing.T) {
	t.Parallel()

	ok, reason := triageDidSucceed("sess-1", 0, 0, nil, "No action needed.")
	if !ok {
		t.Fatalf("triageDidSucceed rejected summarized no-op run: %s", reason)
	}
	if reason != "" {
		t.Fatalf("reason = %q, want empty", reason)
	}
}

func TestCueboardParityPersistTriageRunContextStoresDerivedFailureReason(t *testing.T) {
	t.Parallel()

	store := newSlackTriageStore(appconfig.PersistenceConfig{Provider: "memory"}, nil)
	ok, reason := triageDidSucceed("sess-1", 0, 0, nil, "")
	if ok {
		t.Fatal("expected empty triage run to fail")
	}
	if _, err := store.RecordRun(context.Background(), SlackTriageContext{
		SessionID: "sess-1",
		Status:    "failed",
		Error:     reason,
		Digest:    "digest",
	}); err != nil {
		t.Fatalf("RecordRun: %v", err)
	}

	contexts, err := store.ListRuns(context.Background(), 1)
	if err != nil {
		t.Fatalf("ListRuns: %v", err)
	}
	if len(contexts) != 1 {
		t.Fatalf("len(contexts) = %d, want 1", len(contexts))
	}
	if contexts[0].Status != "failed" {
		t.Fatalf("status = %q, want failed", contexts[0].Status)
	}
	if contexts[0].Error != "empty final response with no mutations" {
		t.Fatalf("error = %q, want derived failure reason", contexts[0].Error)
	}
}

func TestCueboardParityReconcileTriageCountsUsesRecorderObservations(t *testing.T) {
	t.Parallel()

	counters := &triageCounters{}
	recorder := &triageActionRecorder{
		actions: []SlackTriageAction{
			{Tool: "add_reaction", Channel: "watercooler", Brief: ":fast:"},
		},
		toolCalls: []SlackTriageToolCall{
			{Tool: "slack_api", Action: "add_reaction", Success: false},
			{Tool: "slack_api", Action: "add_reaction", Success: true},
		},
	}

	mutations, failures := reconcileTriageCounts(counters, recorder)
	if mutations != 1 {
		t.Fatalf("mutations = %d, want 1", mutations)
	}
	if failures != 1 {
		t.Fatalf("failures = %d, want 1", failures)
	}
}

func TestCueboardParityRecorderTracksOnlySuccessfulOutboundMutations(t *testing.T) {
	t.Parallel()

	var recorder triageActionRecorder
	recorder.record("slack_api", map[string]any{
		"method": "slack.postThreadReply",
		"params": map[string]any{
			"channel":   "C123",
			"thread_ts": "1778772007.043069",
			"text":      "shared a short synthesis",
		},
	}, slackAPIToolResult{Success: true, Text: "ok"})
	recorder.record("slack_api", map[string]any{
		"method": "slack.addReaction",
		"params": map[string]any{
			"channel": "C123",
			"emoji":   "eyes",
		},
	}, slackAPIToolResult{Success: false, Text: "nope"})

	if recorder.mutationCount() != 1 {
		t.Fatalf("mutationCount = %d, want only successful post_thread_reply", recorder.mutationCount())
	}
	if recorder.failureCount() != 1 {
		t.Fatalf("failureCount = %d, want failed reaction tracked", recorder.failureCount())
	}
	if len(recorder.actions) != 1 || recorder.actions[0].Tool != "post_thread_reply" || recorder.actions[0].Channel != "C123" {
		t.Fatalf("actions = %#v, want successful post_thread_reply action only", recorder.actions)
	}
	if len(recorder.toolCalls) != 2 || recorder.toolCalls[0].Args != "channel=C123 thread_ts=1778772007.043069" {
		t.Fatalf("toolCalls = %#v, want cueboard-style arg summaries", recorder.toolCalls)
	}
}

func TestCueboardParityRenderTriageAssistantTraceIncludesAllAssistantTurns(t *testing.T) {
	t.Parallel()

	trace := renderTriageAssistantTrace([]triageAssistantTurn{
		{Role: "assistant", Content: "Thinking out loud."},
		{
			Role:    "assistant",
			Content: "",
			ToolCalls: []triageAssistantToolCall{
				{
					Name: "slack_api",
					Arguments: map[string]any{
						"action":    "add_reaction",
						"channel":   "C123",
						"timestamp": "1774252623.509579",
						"emoji":     "fast",
					},
				},
			},
		},
		{Role: "assistant", Content: "No action."},
	}, "")

	for _, want := range []string{
		"Assistant turn 1",
		"Thinking out loud.",
		"Assistant turn 2",
		"Tool calls:",
		`"emoji":"fast"`,
		"Assistant turn 3",
		"No action.",
	} {
		if !strings.Contains(trace, want) {
			t.Fatalf("trace missing %q:\n%s", want, trace)
		}
	}
}
