package slackagent

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestLearningSignalStorePersistsAndConvertsToDreamSignals(t *testing.T) {
	store := newSlackLearningSignalStore(appconfig.PersistenceConfig{Provider: "memory"}, learningSignalDiscardLogger())
	inserted, err := store.Insert(context.Background(), SlackLearningSignal{
		Source:         slackLearningSourceBenchmark,
		Surface:        "slack",
		Verdict:        "quality_regression",
		Refs:           []string{"benchmark:case-1"},
		ReasonCode:     "missing_reply",
		ProposedAction: "benchmark_case",
		Subject:        "case-1",
		SourceType:     "triage_replay",
		Content:        "Replay failed expected reply.",
		Timestamp:      "2026-05-22T10:00:00Z",
	})
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if inserted.ID == 0 {
		t.Fatalf("inserted = %#v, want id", inserted)
	}

	signals, err := store.List(context.Background(), 10, time.Time{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(signals) != 1 || signals[0].ReasonCode != "missing_reply" {
		t.Fatalf("signals = %#v, want stored signal", signals)
	}
	dreamSignals := SlackDreamSignalsFromLearningSignals(signals)
	if len(dreamSignals) != 1 || dreamSignals[0].ProposedAction != "benchmark_case" || dreamSignals[0].Refs[0] != "benchmark:case-1" {
		t.Fatalf("dream signals = %#v, want converted benchmark signal", dreamSignals)
	}
}

func learningSignalDiscardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestPendingActionInteractionRecordsLearningSignal(t *testing.T) {
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeThreadReply,
		Params: map[string]any{
			"source":            "slack-triage-visible-reply-approval",
			"triageRunId":       int64(99),
			"jobId":             "job_visible_reply",
			"cardId":            "pending_action:42",
			"proposedReplyText": "这条回复缺少来源，不应该发。",
			"message":           "这条回复缺少来源，不应该发。",
			"approvalDecision":  "pending",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:           record.ID,
		Status:       "dismissed",
		UserID:       "U_PENG",
		RejectReason: slackVisibleReplyRejectReasonNoCitation,
	})
	if !response.OK {
		t.Fatalf("response = %#v, want ok", response)
	}
	signals, err := service.learning.List(context.Background(), 10, time.Time{})
	if err != nil {
		t.Fatalf("List learning signals: %v", err)
	}
	if len(signals) != 1 {
		t.Fatalf("signals = %#v, want one approval learning signal", signals)
	}
	signal := signals[0]
	if signal.Source != slackLearningSourceApprovalCard ||
		signal.Verdict != "rejected" ||
		signal.ReasonCode != slackVisibleReplyRejectReasonNoCitation ||
		signal.ProposedAction != "gate_fixture" ||
		signal.Subject != "visible_reply_quality" {
		t.Fatalf("signal = %#v, want rejected approval-card gate fixture", signal)
	}
}

func TestLearningSignalHelpersCoverCanaryIncidentAndBenchmark(t *testing.T) {
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	canary := slackLearningSignalFromVisibleReplyCanaryCase(SlackVisibleReplyAllowListCanaryCase{
		Name:           "framework_protocol_leak_blocks",
		ExpectedAllow:  false,
		ActualAllow:    true,
		ExpectedReason: "internal_meta",
		ActualReason:   "allowed",
		Passed:         false,
	})
	if canary.Source != slackLearningSourceAllowCanary || canary.Verdict != "fail" || canary.ProposedAction != "gate_fixture" {
		t.Fatalf("canary signal = %#v", canary)
	}
	incident := SlackLearningSignalFromIncident("slack", "identity_scope", []string{"slack:C1/1"}, "codex identity leaked")
	if incident.Source != slackLearningSourceIncident || incident.Verdict != "quality_regression" {
		t.Fatalf("incident signal = %#v", incident)
	}
	benchmark := SlackLearningSignalFromBenchmark("case-1", "fail", "missing_reply", []string{"run:1"}, "judge failed")
	if benchmark.Source != slackLearningSourceBenchmark || benchmark.ProposedAction != "benchmark_case" || benchmark.Refs[0] != "benchmark_case:case-1" {
		t.Fatalf("benchmark signal = %#v", benchmark)
	}

	service.RecordVisibleReplyAllowListCanaryLearningSignals(context.Background(), SlackVisibleReplyAllowListCanarySummary{Cases: []SlackVisibleReplyAllowListCanaryCase{{
		Name:           "framework_protocol_leak_blocks",
		ExpectedAllow:  false,
		ActualAllow:    true,
		ExpectedReason: "internal_meta",
		ActualReason:   "allowed",
		Passed:         false,
	}, {
		Name:   "source_backed_hn_identity_lookup_allows",
		Passed: true,
	}}})
	service.RecordIncidentLearningSignal(context.Background(), "slack", "identity_scope", []string{"slack:C1/1"}, "codex identity leaked")
	service.RecordBenchmarkLearningSignal(context.Background(), "case-1", "fail", "missing_reply", []string{"run:1"}, "judge failed")
	signals, err := service.learning.List(context.Background(), 10, time.Time{})
	if err != nil {
		t.Fatalf("List learning signals: %v", err)
	}
	bySource := make(map[string]SlackLearningSignal, len(signals))
	for _, signal := range signals {
		bySource[signal.Source] = signal
	}
	if len(bySource) != 3 {
		t.Fatalf("signals by source = %#v, want canary, incident, and benchmark writes", bySource)
	}
	if bySource[slackLearningSourceAllowCanary].Verdict != "fail" {
		t.Fatalf("canary stored signal = %#v, want failed canary only", bySource[slackLearningSourceAllowCanary])
	}
	if bySource[slackLearningSourceIncident].ReasonCode != "identity_scope" {
		t.Fatalf("incident stored signal = %#v, want identity_scope", bySource[slackLearningSourceIncident])
	}
	if bySource[slackLearningSourceBenchmark].ReasonCode != "missing_reply" {
		t.Fatalf("benchmark stored signal = %#v, want missing_reply", bySource[slackLearningSourceBenchmark])
	}
}
