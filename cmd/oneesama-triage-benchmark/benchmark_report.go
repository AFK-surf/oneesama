package main

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

func renderMarkdownReport(report benchmarkReport) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Oneesama Triage Benchmark\n\n")
	fmt.Fprintf(&b, "| Field | Value |\n|---|---|\n")
	fmt.Fprintf(&b, "| Generated | `%s` |\n", escapeMarkdownCell(report.GeneratedAt))
	fmt.Fprintf(&b, "| Variant | `%s` |\n", escapeMarkdownCell(report.VariantID))
	fmt.Fprintf(&b, "| Mode | `%s` |\n", escapeMarkdownCell(report.Mode))
	fmt.Fprintf(&b, "| Window | `%s` |\n", escapeMarkdownCell(report.Since))
	if len(report.Channels) > 0 {
		fmt.Fprintf(&b, "| Channels | `%s` |\n", escapeMarkdownCell(strings.Join(report.Channels, ",")))
	}
	if len(report.Fixtures) > 0 {
		fmt.Fprintf(&b, "| Fixtures | %d |\n", len(report.Fixtures))
	}
	if len(report.Variants) > 0 {
		fmt.Fprintf(&b, "| Variants | %d |\n", len(report.Variants))
	}
	if report.Judge.Enabled {
		fmt.Fprintf(&b, "| Judge | `%s` max_rows=%d |\n", escapeMarkdownCell(report.Judge.Model), report.Judge.MaxRows)
	}
	if report.MaxThreads > 0 {
		fmt.Fprintf(&b, "| Max threads | %d |\n", report.MaxThreads)
	}
	fmt.Fprintf(&b, "| Truncated | %v |\n", report.Truncated)
	fmt.Fprintf(&b, "| Threads seen | %d |\n", report.ThreadsSeen)
	fmt.Fprintf(&b, "| Threads replayed | %d |\n", report.ThreadsReplayed)
	fmt.Fprintf(&b, "| Errors | %d |\n\n", report.Summary.Errors)
	if len(report.Summary.ByFixtureOutcome) > 0 {
		fmt.Fprintf(&b, "| Fixture passes | %d |\n", report.Summary.FixturePasses)
		fmt.Fprintf(&b, "| Fixture failures | %d |\n\n", report.Summary.FixtureFailures)
	}
	if report.Summary.GoldRows > 0 {
		fmt.Fprintf(&b, "| Gold pass/fail/unrated | %d / %d / %d |\n\n", report.Summary.GoldPasses, report.Summary.GoldFailures, report.Summary.GoldUnrated)
	}

	appendCountTable(&b, "Fixture Labels", report.Summary.ByFixtureLabel)
	appendCountTable(&b, "Fixture Outcomes", report.Summary.ByFixtureOutcome)
	appendCountTable(&b, "Gold Outcomes", report.Summary.ByGoldStatus)
	appendCountTable(&b, "Final Decisions", report.Summary.ByFinalDecision)
	appendCountTable(&b, "Persona Decisions", report.Summary.ByPersonaDecision)
	appendCountTable(&b, "Visible Reply Gate Reasons", report.Summary.ByVisibleReplyReason)
	appendCountTable(&b, "Pipeline Smells", report.Summary.ByPipelineSmell)
	if report.Summary.JudgeRows > 0 || report.Summary.JudgeErrors > 0 || report.Summary.JudgeSkipped > 0 {
		fmt.Fprintf(&b, "## LLM Judge\n\n")
		fmt.Fprintf(&b, "| Judged | Errors | Skipped | Average score |\n")
		fmt.Fprintf(&b, "|---:|---:|---:|---:|\n")
		fmt.Fprintf(&b, "| %d | %d | %d | %.2f |\n\n", report.Summary.JudgeRows, report.Summary.JudgeErrors, report.Summary.JudgeSkipped, report.Summary.JudgeAverageScore)
		appendCountTable(&b, "Judge Verdicts", report.Summary.ByJudgeVerdict)
		appendCountTable(&b, "Judge Flags", report.Summary.ByJudgeFlag)
	}
	if len(report.VariantSummaries) > 1 {
		fmt.Fprintf(&b, "## Variant Summaries\n\n")
		fmt.Fprintf(&b, "| Variant | Fixture passes | Fixture failures | Errors | Judge score | Decisions |\n")
		fmt.Fprintf(&b, "|---|---:|---:|---:|---:|---|\n")
		for _, variant := range report.VariantSummaries {
			fmt.Fprintf(&b, "| `%s` | %d | %d | %d | %.2f | %s |\n",
				escapeMarkdownCell(variant.VariantID),
				variant.Summary.FixturePasses,
				variant.Summary.FixtureFailures,
				variant.Summary.Errors,
				variant.Summary.JudgeAverageScore,
				escapeMarkdownCell(formatCountMap(variant.Summary.ByFinalDecision)),
			)
		}
		fmt.Fprintf(&b, "\n")
	}

	if len(report.Stats) > 0 {
		fmt.Fprintf(&b, "## Slack Scan Coverage\n\n")
		fmt.Fprintf(&b, "| Channel | Scanned | Replies fetched | Threads | Truncated | Warnings |\n")
		fmt.Fprintf(&b, "|---|---:|---:|---:|---|---|\n")
		for _, stat := range report.Stats {
			warnings := "—"
			if len(stat.Warnings) > 0 {
				warnings = strings.Join(stat.Warnings, "; ")
			}
			fmt.Fprintf(&b, "| `%s` | %d | %d | %d | %v | %s |\n",
				escapeMarkdownCell(stat.ChannelID),
				stat.MessagesScanned,
				stat.RepliesFetched,
				stat.CandidatesFound,
				stat.Truncated,
				escapeMarkdownCell(warnings),
			)
		}
		fmt.Fprintf(&b, "\n")
	}

	fmt.Fprintf(&b, "## Replay Rows\n\n")
	fmt.Fprintf(&b, "| Variant | Case | Channel | Thread | Msgs | Label | Result | Failure layer | Persona | Final | Gate | Gate reasons | Workers | Judge | Smells | Error | Gold |\n")
	fmt.Fprintf(&b, "|---|---|---|---|---:|---|---|---|---|---|---|---|---:|---|---|---|---|\n")
	for _, row := range report.Rows {
		errText := "—"
		if strings.TrimSpace(row.Error) != "" {
			errText = row.Error
		}
		reasons := "—"
		if len(row.VisibleReplyReasons) > 0 {
			reasons = strings.Join(row.VisibleReplyReasons, ", ")
		}
		goldCell := "—"
		if row.GoldStatus != "" {
			goldCell = row.GoldStatus
			if row.GoldExpected != "" || row.GoldActual != "" {
				goldCell += ":" + firstNonEmpty(row.GoldExpected, "?") + "→" + firstNonEmpty(row.GoldActual, "?")
			}
			if row.GoldReason != "" && row.GoldStatus != "pass" {
				goldCell += " (" + row.GoldReason + ")"
			}
		}
		smells := "—"
		if len(row.PipelineSmellSignals) > 0 {
			smells = strings.Join(row.PipelineSmellSignals, ", ")
		}
		fmt.Fprintf(&b, "| `%s` | `%s` | `%s` | `%s` | %d | `%s` | `%s` | `%s` | `%s` | `%s` | `%s` | %s | %d | `%s` | %s | %s | `%s` |\n",
			escapeMarkdownCell(firstNonEmpty(row.VariantID, "current")),
			escapeMarkdownCell(firstNonEmpty(row.CaseID, "—")),
			escapeMarkdownCell(row.ChannelID),
			escapeMarkdownCell(row.ThreadTS),
			row.MessageCount,
			escapeMarkdownCell(firstNonEmpty(row.FixtureLabel, "—")),
			escapeMarkdownCell(formatFixtureResultCell(row)),
			escapeMarkdownCell(formatFixtureFailureLayerCell(row)),
			escapeMarkdownCell(firstNonEmpty(row.PersonaDecision, "unknown")),
			escapeMarkdownCell(firstNonEmpty(row.FinalDecision, "unknown")),
			escapeMarkdownCell(firstNonEmpty(row.GateDecision, "unknown")),
			escapeMarkdownCell(reasons),
			row.WorkerRequests,
			escapeMarkdownCell(formatJudgeCell(row)),
			escapeMarkdownCell(smells),
			escapeMarkdownCell(errText),
			escapeMarkdownCell(goldCell),
		)
	}
	return b.String()
}

func formatFixtureResultCell(row benchmarkRow) string {
	if row.FixturePassed == nil {
		return "—"
	}
	result := "fail"
	if *row.FixturePassed {
		result = "pass"
	}
	if row.FixtureReason != "" {
		result += ":" + row.FixtureReason
	}
	return result
}

func formatFixtureFailureLayerCell(row benchmarkRow) string {
	layer := firstNonEmpty(row.FixtureFailureLayer, "—")
	if row.FixtureFailureDetail != "" && layer != "—" {
		layer += ":" + row.FixtureFailureDetail
	}
	return layer
}

func formatJudgeCell(row benchmarkRow) string {
	if row.Judge != nil {
		cell := fmt.Sprintf("%s %.2f", row.Judge.Verdict, row.Judge.Score)
		if len(row.Judge.Flags) > 0 {
			cell += " " + strings.Join(row.Judge.Flags, ",")
		}
		return cell
	}
	if row.JudgeSkipped {
		return "skipped"
	}
	if row.JudgeError != "" {
		return "error:" + row.JudgeError
	}
	return "—"
}

func appendCountTable(b *strings.Builder, title string, counts map[string]int) {
	if len(counts) == 0 {
		return
	}
	fmt.Fprintf(b, "## %s\n\n", title)
	fmt.Fprintf(b, "| Value | Count |\n|---|---:|\n")
	for _, key := range sortedCountKeys(counts) {
		fmt.Fprintf(b, "| `%s` | %d |\n", escapeMarkdownCell(key), counts[key])
	}
	fmt.Fprintf(b, "\n")
}

func sortedCountKeys(counts map[string]int) []string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func formatCountMap(counts map[string]int) string {
	if len(counts) == 0 {
		return "—"
	}
	var parts []string
	for _, key := range sortedCountKeys(counts) {
		parts = append(parts, fmt.Sprintf("%s=%d", key, counts[key]))
	}
	return strings.Join(parts, ", ")
}

func writeOutput(path string, stdout io.Writer, data []byte) error {
	if strings.TrimSpace(path) == "" || strings.TrimSpace(path) == "-" {
		_, err := stdout.Write(append(data, '\n'))
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func containsAnyString(values []string, needles []string) bool {
	normalized := map[string]struct{}{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			normalized[value] = struct{}{}
		}
	}
	for _, needle := range needles {
		if _, ok := normalized[strings.TrimSpace(needle)]; ok {
			return true
		}
	}
	return false
}

type stringListFlag []string

func (v *stringListFlag) String() string {
	return strings.Join(*v, ",")
}

func (v *stringListFlag) Set(value string) error {
	value = strings.TrimSpace(value)
	if value != "" {
		*v = append(*v, value)
	}
	return nil
}

func escapeMarkdownCell(value string) string {
	value = strings.ReplaceAll(value, "|", "\\|")
	value = strings.ReplaceAll(value, "\n", " ")
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
