package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func loadBenchmarkGoldInputs(inputs []string) (benchmarkGoldStore, error) {
	store := benchmarkGoldStore{
		enabled:  len(inputs) > 0,
		byThread: map[string]benchmarkGoldCase{},
		byCase:   map[string]benchmarkGoldCase{},
	}
	paths, err := expandGoldPaths(inputs)
	if err != nil {
		return store, err
	}
	store.paths = paths
	for _, path := range paths {
		cases, err := readBenchmarkGoldCases(path)
		if err != nil {
			return store, err
		}
		for _, gold := range cases {
			gold = normalizeBenchmarkGoldCase(gold)
			if gold.ChannelID != "" && gold.ThreadTS != "" {
				store.byThread[benchmarkGoldThreadKey(gold.ChannelID, gold.ThreadTS, gold.VariantID)] = gold
			}
			if gold.CaseID != "" {
				store.byCase[benchmarkGoldCaseKey(gold.CaseID, gold.VariantID)] = gold
			}
		}
	}
	return store, nil
}

func newBenchmarkGoldStoreFromCases(cases []benchmarkGoldCase) benchmarkGoldStore {
	store := benchmarkGoldStore{
		enabled:  len(cases) > 0,
		byThread: map[string]benchmarkGoldCase{},
		byCase:   map[string]benchmarkGoldCase{},
	}
	for _, gold := range cases {
		gold = normalizeBenchmarkGoldCase(gold)
		if gold.ChannelID != "" && gold.ThreadTS != "" {
			store.byThread[benchmarkGoldThreadKey(gold.ChannelID, gold.ThreadTS, gold.VariantID)] = gold
		}
		if gold.CaseID != "" {
			store.byCase[benchmarkGoldCaseKey(gold.CaseID, gold.VariantID)] = gold
		}
	}
	return store
}

func expandGoldPaths(inputs []string) ([]string, error) {
	var out []string
	for _, input := range inputs {
		input = strings.TrimSpace(input)
		if input == "" {
			continue
		}
		matches, err := filepath.Glob(input)
		if err != nil {
			return nil, fmt.Errorf("gold-input glob %q: %w", input, err)
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

func readBenchmarkGoldCases(path string) ([]benchmarkGoldCase, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read gold-input %s: %w", path, err)
	}
	cases, err := decodeBenchmarkGoldCases(data)
	if err != nil {
		return nil, fmt.Errorf("decode gold-input %s: %w", path, err)
	}
	return cases, nil
}

func decodeBenchmarkGoldCases(data []byte) ([]benchmarkGoldCase, error) {
	var direct []benchmarkGoldCase
	if err := json.Unmarshal(data, &direct); err == nil && len(direct) > 0 {
		return direct, nil
	}
	var wrapper benchmarkGoldInput
	if err := json.Unmarshal(data, &wrapper); err != nil {
		return nil, err
	}
	out := append([]benchmarkGoldCase{}, wrapper.Cases...)
	out = append(out, wrapper.Items...)
	out = append(out, wrapper.Reviews...)
	return out, nil
}

func normalizeBenchmarkGoldCase(gold benchmarkGoldCase) benchmarkGoldCase {
	gold.CaseID = strings.TrimSpace(gold.CaseID)
	gold.ChannelID = strings.TrimSpace(gold.ChannelID)
	gold.ThreadTS = strings.TrimSpace(gold.ThreadTS)
	gold.VariantID = strings.TrimSpace(gold.VariantID)
	if gold.DedupKey != "" && (gold.ChannelID == "" || gold.ThreadTS == "" || gold.VariantID == "") {
		parts := strings.Split(gold.DedupKey, "+")
		if len(parts) >= 1 && gold.ChannelID == "" {
			gold.ChannelID = strings.TrimSpace(parts[0])
		}
		if len(parts) >= 2 && gold.ThreadTS == "" {
			gold.ThreadTS = strings.TrimSpace(parts[1])
		}
		if len(parts) >= 3 && gold.VariantID == "" {
			gold.VariantID = strings.TrimSpace(parts[2])
		}
	}
	gold.HumanVerdict = normalizeGoldToken(firstNonEmpty(gold.HumanVerdict, gold.Verdict, gold.Vote))
	gold.Notes = firstNonEmpty(gold.Notes, gold.HumanNotes)
	return gold
}

func applyBenchmarkGold(row *benchmarkRow, store benchmarkGoldStore) {
	if !store.enabled {
		return
	}
	gold, ok := lookupBenchmarkGold(row, store)
	if !ok {
		row.GoldStatus = "unrated"
		row.GoldActual = benchmarkGoldActualDecision(*row)
		row.GoldReason = "no_gold_label"
		return
	}
	expected, ok := benchmarkGoldExpectedBehavior(gold)
	row.GoldHumanVerdict = gold.HumanVerdict
	row.GoldNotes = gold.Notes
	row.GoldActual = benchmarkGoldActualDecision(*row)
	if !ok {
		row.GoldStatus = "unrated"
		row.GoldReason = "gold_label_missing_comparable_expected"
		return
	}
	row.GoldExpected = benchmarkGoldExpectedLabel(expected)
	status, reason := evaluateBenchmarkGold(*row, expected)
	row.GoldStatus = status
	row.GoldReason = reason
}

func lookupBenchmarkGold(row *benchmarkRow, store benchmarkGoldStore) (benchmarkGoldCase, bool) {
	variants := []string{strings.TrimSpace(row.VariantID), "current", ""}
	variants = uniqueStrings(variants)
	if row.ChannelID != "" && row.ThreadTS != "" {
		for _, variant := range variants {
			if gold, ok := store.byThread[benchmarkGoldThreadKey(row.ChannelID, row.ThreadTS, variant)]; ok {
				return gold, true
			}
		}
	}
	if row.CaseID != "" {
		for _, variant := range variants {
			if gold, ok := store.byCase[benchmarkGoldCaseKey(row.CaseID, variant)]; ok {
				return gold, true
			}
		}
	}
	return benchmarkGoldCase{}, false
}

func benchmarkGoldExpectedBehavior(gold benchmarkGoldCase) (benchmarkGoldExpectation, bool) {
	expected := gold.Expected
	expected.Kind = firstNonEmpty(expected.Kind, gold.ExpectedKind, gold.ExpectedDecision, expected.FinalDecision, expected.Decision)
	if benchmarkGoldExpectationHasSignal(expected) {
		return expected, true
	}
	if gold.ExpectedDecision != "" || gold.ExpectedKind != "" {
		return benchmarkGoldExpectation{Kind: firstNonEmpty(gold.ExpectedKind, gold.ExpectedDecision)}, true
	}
	if !goldHumanVerdictIsPositive(gold.HumanVerdict) {
		return benchmarkGoldExpectation{}, false
	}
	for _, candidate := range []benchmarkGoldExpectation{gold.Actual, gold.Observed, gold.Row, gold.Machine, {
		FinalDecision:       gold.FinalDecision,
		VisibleReplyAllowed: gold.VisibleReplyAllowed,
		MinWorkerRequests:   gold.WorkerRequests,
	}} {
		candidate.Kind = firstNonEmpty(candidate.Kind, candidate.FinalDecision, candidate.Decision)
		if benchmarkGoldExpectationHasSignal(candidate) {
			return candidate, true
		}
	}
	return benchmarkGoldExpectation{}, false
}

func benchmarkGoldExpectationHasSignal(expected benchmarkGoldExpectation) bool {
	return firstNonEmpty(expected.Kind, expected.FinalDecision, expected.Decision, expected.Freeform) != "" ||
		expected.VisibleReplyAllowed != nil ||
		expected.MinWorkerRequests > 0
}

func evaluateBenchmarkGold(row benchmarkRow, expected benchmarkGoldExpectation) (string, string) {
	if strings.TrimSpace(row.Error) != "" {
		return "fail", "dry_run_error:" + row.Error
	}
	kind := normalizeGoldExpectedKind(firstNonEmpty(expected.Kind, expected.FinalDecision, expected.Decision))
	if kind == "other" || kind == "freeform" {
		return "unrated", "freeform_expected_requires_human_review:" + strings.TrimSpace(expected.Freeform)
	}
	if expected.VisibleReplyAllowed != nil && *expected.VisibleReplyAllowed != row.VisibleReplyAllowed {
		return "fail", fmt.Sprintf("expected visible_reply_allowed=%v; got %v", *expected.VisibleReplyAllowed, row.VisibleReplyAllowed)
	}
	if expected.MinWorkerRequests > 0 && row.WorkerRequests < expected.MinWorkerRequests {
		return "fail", fmt.Sprintf("expected worker_requests >= %d; got %d", expected.MinWorkerRequests, row.WorkerRequests)
	}
	if kind == "" {
		if expected.VisibleReplyAllowed != nil || expected.MinWorkerRequests > 0 {
			return "pass", "ok"
		}
		return "unrated", "gold_label_missing_comparable_expected"
	}
	actual := benchmarkGoldActualDecision(row)
	if kind == actual {
		return "pass", "ok"
	}
	return "fail", fmt.Sprintf("expected %s; got %s", kind, actual)
}

func benchmarkGoldExpectedLabel(expected benchmarkGoldExpectation) string {
	kind := normalizeGoldExpectedKind(firstNonEmpty(expected.Kind, expected.FinalDecision, expected.Decision))
	if kind == "other" || kind == "freeform" {
		if freeform := strings.TrimSpace(expected.Freeform); freeform != "" {
			return "other:" + freeform
		}
		return "other"
	}
	parts := []string{}
	if kind != "" {
		parts = append(parts, kind)
	}
	if expected.VisibleReplyAllowed != nil {
		parts = append(parts, fmt.Sprintf("visible_reply_allowed=%v", *expected.VisibleReplyAllowed))
	}
	if expected.MinWorkerRequests > 0 {
		parts = append(parts, fmt.Sprintf("worker_requests>=%d", expected.MinWorkerRequests))
	}
	return strings.Join(parts, ",")
}

func benchmarkGoldActualDecision(row benchmarkRow) string {
	if strings.TrimSpace(row.Error) != "" {
		return "error"
	}
	switch {
	case row.VisibleReplyAllowed || row.FinalDecision == "would_request_reply_approval" || row.FinalDecision == "would_post_reply":
		return "visible_reply"
	case row.WorkerRequests > 0 || row.FinalDecision == "would_delegate_worker":
		return "would_delegate_worker"
	case row.FinalDecision == "would_react" || row.FinalDecision == "would_add_reaction":
		return "would_react"
	case row.FinalDecision == "would_stay_silent" || row.FinalDecision == "stay_silent":
		return "would_stay_silent"
	default:
		return firstNonEmpty(row.FinalDecision, "unknown")
	}
}

func normalizeGoldExpectedKind(value string) string {
	value = normalizeGoldToken(value)
	switch value {
	case "", "unknown":
		return ""
	case "stay_silent", "silent", "no_action", "would_stay_silent":
		return "would_stay_silent"
	case "delegate", "delegate_worker", "worker", "start_worker", "would_delegate_worker":
		return "would_delegate_worker"
	case "visible_reply", "reply", "thread_reply", "post_thread_reply", "would_reply", "would_post_reply", "would_request_reply_approval":
		return "visible_reply"
	case "react", "reaction", "emoji", "would_react", "would_add_reaction":
		return "would_react"
	case "other", "freeform":
		return "other"
	default:
		return value
	}
}

func goldHumanVerdictIsPositive(value string) bool {
	switch normalizeGoldToken(value) {
	case "correct", "ok", "good", "pass", "right", "yes", "对", "yes_correct":
		return true
	default:
		return false
	}
}

func normalizeGoldToken(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "-", "_")
	value = strings.ReplaceAll(value, " ", "_")
	return value
}

func benchmarkGoldThreadKey(channelID string, threadTS string, variantID string) string {
	return strings.TrimSpace(channelID) + "\x00" + strings.TrimSpace(threadTS) + "\x00" + strings.TrimSpace(variantID)
}

func benchmarkGoldCaseKey(caseID string, variantID string) string {
	return strings.TrimSpace(caseID) + "\x00" + strings.TrimSpace(variantID)
}
