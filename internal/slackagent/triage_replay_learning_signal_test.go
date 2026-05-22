package slackagent

import (
	"context"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestTriageReplayBenchmarkVerdictFailureBecomesLearningSignal(t *testing.T) {
	signals := SlackLearningSignalsFromTriageReplayBenchmarkVerdicts([]SlackTriageReplayBenchmarkVerdict{
		{
			CaseID:     "case-under-response",
			Verdict:    "failed",
			ReasonCode: "missing_visible_reply",
			Summary:    "Oneesama stayed silent on a source-backed identity lookup.",
			ChannelID:  "C1",
			ThreadTS:   "1779450000.000",
			Expected:   "reply",
			Actual:     "stay_silent",
		},
		{
			CaseID:  "case-clean",
			Verdict: "passed",
			Summary: "correct silence",
		},
	})

	if len(signals) != 1 {
		t.Fatalf("signals = %#v, want one failed benchmark signal", signals)
	}
	signal := signals[0]
	if signal.Source != slackLearningSourceBenchmark || signal.Subject != "case-under-response" {
		t.Fatalf("signal identity = %#v", signal)
	}
	if signal.ReasonCode != "missing_visible_reply" || signal.ProposedAction != "benchmark_case" || signal.Target != "benchmark_case" {
		t.Fatalf("signal routing = %#v", signal)
	}
	if !stringSliceContains(signal.Refs, "benchmark_case:case-under-response") ||
		!stringSliceContains(signal.Refs, "slack:C1/1779450000.000") {
		t.Fatalf("refs = %#v, want benchmark and Slack source refs", signal.Refs)
	}
	if signal.Metadata["expected"] != "reply" || signal.Metadata["actual"] != "stay_silent" {
		t.Fatalf("metadata = %#v, want expected/actual fields", signal.Metadata)
	}
}

func TestPersonaShadowFailureBecomesLearningSignal(t *testing.T) {
	signal, ok := SlackLearningSignalFromPersonaShadowResult(SlackPersonaShadowResult{
		RequestID:      "req-1",
		Source:         "backfill:case-1",
		ChannelID:      "C2",
		ThreadTS:       "1779451111.000",
		Classification: "link_no_reply",
		Runtime:        "pi",
		Decision:       "delegate_worker",
		Success:        false,
		Error:          "runtime returned 500",
		LatencyMS:      42,
	})
	if !ok {
		t.Fatal("expected failed shadow result to produce a learning signal")
	}
	if signal.Subject != "req-1" || signal.ReasonCode != "persona_shadow_replay_failure" {
		t.Fatalf("signal = %#v", signal)
	}
	if signal.Target != "persona_shadow_replay" || signal.SourceType != "persona_shadow_replay" {
		t.Fatalf("signal target/source_type = %#v", signal)
	}
	if !strings.Contains(signal.Content, "runtime returned 500") {
		t.Fatalf("content = %q, want runtime error", signal.Content)
	}
	if !stringSliceContains(signal.Refs, "slack:C2/1779451111.000") {
		t.Fatalf("refs = %#v, want Slack ref", signal.Refs)
	}
}

func TestReadTriageReplayBenchmarkVerdictsAcceptsCamelAliases(t *testing.T) {
	verdicts, err := ReadSlackTriageReplayBenchmarkVerdictsNDJSON(strings.NewReader(
		`{"caseId":"case-camel","verdict":"false_negative","reasonCode":"under_response","channelId":"C3","threadTs":"1779452222.000","sourceRefs":["run:1"]}`,
	))
	if err != nil {
		t.Fatalf("ReadSlackTriageReplayBenchmarkVerdictsNDJSON: %v", err)
	}
	if len(verdicts) != 1 {
		t.Fatalf("verdicts = %#v, want one", verdicts)
	}
	got := verdicts[0]
	if got.CaseID != "case-camel" || got.ReasonCode != "under_response" || got.ChannelID != "C3" || got.ThreadTS != "1779452222.000" {
		t.Fatalf("verdict aliases not normalized: %#v", got)
	}
	if !stringSliceContains(got.Refs, "run:1") {
		t.Fatalf("refs = %#v, want sourceRefs alias", got.Refs)
	}
}

func TestPersistSlackLearningSignalsUsesRuntimeStore(t *testing.T) {
	cfg := appconfig.PersistenceConfig{Provider: "json-file", DataDir: t.TempDir()}
	written, err := PersistSlackLearningSignals(context.Background(), cfg, []SlackLearningSignal{
		SlackLearningSignalFromBenchmark("case-1", "fail", "judge_failed", []string{"slack:C1/1"}, "benchmark failed"),
	})
	if err != nil {
		t.Fatalf("PersistSlackLearningSignals: %v", err)
	}
	if written != 1 {
		t.Fatalf("written = %d, want 1", written)
	}
	signals, err := ListSlackLearningSignals(context.Background(), cfg, 10)
	if err != nil {
		t.Fatalf("ListSlackLearningSignals: %v", err)
	}
	if len(signals) != 1 || signals[0].Subject != "case-1" {
		t.Fatalf("signals = %#v, want persisted benchmark signal", signals)
	}
}
