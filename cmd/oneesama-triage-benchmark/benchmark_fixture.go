package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/AFK-surf/oneesama/internal/slackagent"
)

func expandFixturePaths(inputs []string) ([]string, error) {
	var out []string
	for _, input := range inputs {
		input = strings.TrimSpace(input)
		if input == "" {
			continue
		}
		matches, err := filepath.Glob(input)
		if err != nil {
			return nil, fmt.Errorf("fixture glob %q: %w", input, err)
		}
		if len(matches) == 0 {
			out = append(out, input)
			continue
		}
		sort.Strings(matches)
		out = append(out, matches...)
	}
	return uniqueStrings(out), nil
}

func readBenchmarkFixture(path string) (benchmarkFixture, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return benchmarkFixture{}, fmt.Errorf("read fixture %s: %w", path, err)
	}
	var fixture benchmarkFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		return benchmarkFixture{}, fmt.Errorf("decode fixture %s: %w", path, err)
	}
	fixture.CaseID = strings.TrimSpace(fixture.CaseID)
	if fixture.CaseID == "" {
		fixture.CaseID = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	fixture.Label = normalizeFixtureLabel(fixture.Label)
	if fixture.Label == "" {
		return benchmarkFixture{}, fmt.Errorf("fixture %s: label is required", path)
	}
	if len(fixture.Thread.Messages) == 0 {
		return benchmarkFixture{}, fmt.Errorf("fixture %s: thread messages are required", path)
	}
	fixture.Thread.ChannelID = firstNonEmpty(fixture.Thread.ChannelID, fixture.Thread.Messages[0].ChannelID)
	fixture.Thread.ThreadTS = firstNonEmpty(fixture.Thread.ThreadTS, fixture.Thread.RootTS)
	if fixture.Thread.ThreadTS == "" && len(fixture.Thread.Messages) > 0 {
		fixture.Thread.ThreadTS = firstNonEmpty(fixture.Thread.Messages[0].ThreadTS, fixture.Thread.Messages[0].TS)
	}
	if fixture.Thread.RootTS == "" {
		fixture.Thread.RootTS = fixture.Thread.ThreadTS
	}
	if fixture.Thread.ChannelID == "" || fixture.Thread.ThreadTS == "" || len(fixture.Thread.Messages) == 0 {
		return benchmarkFixture{}, fmt.Errorf("fixture %s: thread channelId, threadTs, and messages are required", path)
	}
	for i := range fixture.Thread.Messages {
		if strings.TrimSpace(fixture.Thread.Messages[i].ChannelID) == "" {
			fixture.Thread.Messages[i].ChannelID = fixture.Thread.ChannelID
		}
		if strings.TrimSpace(fixture.Thread.Messages[i].ThreadTS) == "" {
			fixture.Thread.Messages[i].ThreadTS = fixture.Thread.ThreadTS
		}
	}
	return fixture, nil
}

func applyFixtureResult(row *benchmarkRow, fixture benchmarkFixture) {
	row.CaseID = fixture.CaseID
	row.CaseDescription = strings.TrimSpace(fixture.Description)
	row.FixtureLabel = fixture.Label
	passed, reason := evaluateFixtureRow(*row, fixture)
	row.FixturePassed = &passed
	row.FixtureReason = reason
	if !passed {
		row.FixtureFailureLayer, row.FixtureFailureDetail = diagnoseFixtureFailure(*row, fixture, reason)
	}
}

func evaluateCandidateFixture(variantID string, fixture benchmarkFixture) benchmarkRow {
	verdict := slackagent.EvaluateSlackVisibleReplyCandidate(fixture.Candidate)
	reasons := []string{}
	if strings.TrimSpace(verdict.Reason) != "" {
		reasons = []string{verdict.Reason}
	}
	gateDecision := "visible_reply_blocked"
	if verdict.Allowed {
		gateDecision = "visible_reply_allowed_no_delivery"
	}
	return benchmarkRow{
		VariantID:           variantID,
		ChannelID:           fixture.Thread.ChannelID,
		ThreadTS:            fixture.Thread.ThreadTS,
		MessageCount:        len(fixture.Thread.Messages),
		PersonaDecision:     "fixture_candidate",
		FinalDecision:       "candidate_visible_reply_gate",
		GateDecision:        gateDecision,
		VisibleReplyAllowed: verdict.Allowed,
		VisibleReplyReasons: reasons,
	}
}

func evaluateFixtureRow(row benchmarkRow, fixture benchmarkFixture) (bool, string) {
	if strings.TrimSpace(row.Error) != "" {
		return false, "dry_run_error"
	}
	if expected := strings.TrimSpace(fixture.Expected.FinalDecision); expected != "" && expected != row.FinalDecision {
		return false, "final_decision_mismatch"
	}
	if fixture.Expected.VisibleReplyAllowed != nil && *fixture.Expected.VisibleReplyAllowed != row.VisibleReplyAllowed {
		return false, "visible_reply_allowed_mismatch"
	}
	if expected := strings.TrimSpace(fixture.Expected.VisibleReplyReason); expected != "" && !containsAnyString(row.VisibleReplyReasons, []string{expected}) {
		return false, "visible_reply_reason_mismatch"
	}
	if fixture.Expected.MinWorkerRequests > 0 && row.WorkerRequests < fixture.Expected.MinWorkerRequests {
		return false, "worker_request_count_below_expected"
	}
	if len(fixture.Expected.AnyVisibleReplyReasons) > 0 && !containsAnyString(row.VisibleReplyReasons, fixture.Expected.AnyVisibleReplyReasons) {
		return false, "visible_reply_reason_missing"
	}
	if len(fixture.Expected.AnyPipelineSmellSignals) > 0 && !containsAnyString(row.PipelineSmellSignals, fixture.Expected.AnyPipelineSmellSignals) {
		return false, "pipeline_smell_missing"
	}
	switch fixture.Label {
	case "must_block":
		if row.VisibleReplyAllowed || row.FinalDecision == "would_request_reply_approval" || row.FinalDecision == "would_post_reply" {
			return false, "must_block_visible_reply"
		}
	case "must_allow":
		if !row.VisibleReplyAllowed {
			return false, "must_allow_blocked"
		}
	case "should_delegate":
		if row.WorkerRequests <= 0 && row.FinalDecision != "would_delegate_worker" {
			return false, "should_delegate_missing_worker"
		}
	case "freely_silent":
		if row.VisibleReplyAllowed || row.WorkerRequests > 0 {
			return false, "freely_silent_not_silent"
		}
	default:
		return false, "unknown_fixture_label"
	}
	return true, "ok"
}

func diagnoseFixtureFailure(row benchmarkRow, fixture benchmarkFixture, reason string) (string, string) {
	switch reason {
	case "dry_run_error":
		return "runtime", strings.TrimSpace(row.Error)
	case "visible_reply_allowed_mismatch", "must_allow_blocked":
		if row.WorkerRequests > 0 || row.FinalDecision == "would_delegate_worker" {
			return "delegation", "pipeline delegated instead of producing an allowed visible reply"
		}
		if !row.VisibleReplyAllowed && (row.FinalDecision == "would_stay_silent" || row.PersonaDecision == "stay_silent" || len(row.VisibleReplyReasons) == 0) {
			return "pi_decision", "pipeline stayed silent before producing a visible reply candidate"
		}
		if len(row.VisibleReplyReasons) > 0 {
			return "visible_reply_gate", "gate reasons: " + strings.Join(row.VisibleReplyReasons, ",")
		}
		return "pipeline_decision", "visible reply expectation did not match final decision"
	case "visible_reply_reason_mismatch", "visible_reply_reason_missing":
		return "visible_reply_gate", "expected gate reason " + firstNonEmpty(fixture.Expected.VisibleReplyReason, strings.Join(fixture.Expected.AnyVisibleReplyReasons, ",")) + "; got " + strings.Join(row.VisibleReplyReasons, ",")
	case "worker_request_count_below_expected", "should_delegate_missing_worker":
		return "delegation", fmt.Sprintf("expected worker_requests >= %d; got %d", fixture.Expected.MinWorkerRequests, row.WorkerRequests)
	case "final_decision_mismatch":
		return "pipeline_decision", fmt.Sprintf("expected final decision %s; got %s", fixture.Expected.FinalDecision, row.FinalDecision)
	case "must_block_visible_reply":
		return "visible_reply_gate", "must_block fixture produced a visible reply"
	case "freely_silent_not_silent":
		return "pipeline_decision", "freely_silent fixture produced visible reply or worker request"
	default:
		return "fixture", reason
	}
}

func normalizeFixtureLabel(label string) string {
	label = strings.ToLower(strings.TrimSpace(label))
	label = strings.ReplaceAll(label, "-", "_")
	label = strings.ReplaceAll(label, " ", "_")
	return label
}

func recordRow(summary *benchmarkSummary, row benchmarkRow) {
	if strings.TrimSpace(row.Error) != "" {
		summary.Errors++
	}
	recordGoldSummary(summary, row)
	recordJudgeSummary(summary, row)
	if row.FixtureLabel != "" {
		summary.ByFixtureLabel[row.FixtureLabel]++
		outcome := "unknown"
		if row.FixturePassed != nil {
			if *row.FixturePassed {
				outcome = "pass"
				summary.FixturePasses++
			} else {
				outcome = "fail"
				summary.FixtureFailures++
			}
		}
		summary.ByFixtureOutcome[row.FixtureLabel+"_"+outcome]++
	}
	if strings.TrimSpace(row.Error) != "" {
		return
	}
	summary.ByFinalDecision[firstNonEmpty(row.FinalDecision, "unknown")]++
	summary.ByPersonaDecision[firstNonEmpty(row.PersonaDecision, "unknown")]++
	for _, reason := range row.VisibleReplyReasons {
		summary.ByVisibleReplyReason[firstNonEmpty(reason, "unknown")]++
	}
	for _, smell := range row.PipelineSmellSignals {
		summary.ByPipelineSmell[firstNonEmpty(smell, "unknown")]++
	}
}

func recordGoldSummary(summary *benchmarkSummary, row benchmarkRow) {
	status := strings.TrimSpace(row.GoldStatus)
	if status == "" {
		return
	}
	summary.ByGoldStatus[status]++
	summary.GoldRows++
	switch status {
	case "pass":
		summary.GoldPasses++
	case "fail":
		summary.GoldFailures++
	case "unrated":
		summary.GoldUnrated++
	}
}

func recordJudgeSummary(summary *benchmarkSummary, row benchmarkRow) {
	if row.JudgeSkipped {
		summary.JudgeSkipped++
		return
	}
	if strings.TrimSpace(row.JudgeError) != "" {
		summary.JudgeErrors++
		return
	}
	if row.Judge == nil {
		return
	}
	summary.ByJudgeVerdict[firstNonEmpty(row.Judge.Verdict, "uncertain")]++
	for _, flag := range row.Judge.Flags {
		summary.ByJudgeFlag[firstNonEmpty(flag, "unknown")]++
	}
	summary.JudgeAverageScore = ((summary.JudgeAverageScore * float64(summary.JudgeRows)) + row.Judge.Score) / float64(summary.JudgeRows+1)
	summary.JudgeRows++
}

func buildVariantSummaries(variants []benchmarkVariant, rows []benchmarkRow) []benchmarkVariantSummary {
	summaries := make(map[string]benchmarkSummary, len(variants))
	meta := make(map[string]benchmarkVariant, len(variants))
	order := make([]string, 0, len(variants))
	for _, variant := range variants {
		id := firstNonEmpty(variant.VariantID, "current")
		if _, ok := summaries[id]; !ok {
			summaries[id] = newBenchmarkSummary()
			order = append(order, id)
		}
		meta[id] = variant
	}
	for _, row := range rows {
		id := firstNonEmpty(row.VariantID, "current")
		if _, ok := summaries[id]; !ok {
			summaries[id] = newBenchmarkSummary()
			order = append(order, id)
		}
		summary := summaries[id]
		recordRow(&summary, row)
		summaries[id] = summary
	}
	out := make([]benchmarkVariantSummary, 0, len(order))
	for _, id := range order {
		variant := meta[id]
		out = append(out, benchmarkVariantSummary{
			VariantID:   id,
			Description: variant.Description,
			Knobs:       variant.Knobs,
			Summary:     summaries[id],
		})
	}
	return out
}
