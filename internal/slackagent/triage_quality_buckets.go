package slackagent

import "strings"

// Thresholds shared between the daily report's per-run quality bucketing
// (`computeSlackDailyReportMetrics` in daily_report.go) and the operational
// `scripts/oneesama-triage-quality-sweep.sh` jq pipeline. Centralising them
// here keeps the two surfaces from silently disagreeing on what counts as a
// "high-context no-action" or a "low-confidence no-action" run.
//
// Task #285 anchor: align daily report and triage quality sweep buckets.
// If a threshold changes, update this file AND the matching jq literal in
// scripts/oneesama-triage-quality-sweep.sh in the same commit.

const (
	// triageQualityHighContextInputCharsThreshold flags a no-action run whose
	// persona request carried at least this many characters of input context.
	// A high-context no-action is a signal the persona had material to work
	// with but chose to stay silent; the daily report and the sweep both
	// surface these for human review.
	triageQualityHighContextInputCharsThreshold = 7000

	// triageQualityLowConfidenceCeiling defines the upper bound on
	// `persona_foreground.confidence` (exclusive) for a no-action run to be
	// classified as low-confidence-no-action. Below this confidence the
	// persona is hedging; the bucket exists to surface "Pi was unsure and
	// silently dropped" runs for human review.
	triageQualityLowConfidenceCeiling = 0.75
)

// triageQualityIntentActionMismatchMarkers are case-insensitive substrings
// indicating the run's `summary` text claims an intent to act
// (delegate / reply / react / etc.) even though the run ended with
// `actions=0` AND `mutations=0`. The bucket exists to surface "model said it
// would but actually did nothing" runs for human review without classifying
// them as red — many such runs are model self-narration of historical
// behaviour, but a recurring spike is a signal the action wiring is broken.
// Task #285 follow-up (driver 6h audit 2026-05-21 review proposal).
var triageQualityIntentActionMismatchMarkers = []string{
	// English action verbs the persona uses in summary narration.
	"delegate",
	"will reply",
	"will react",
	"will post",
	"should reply",
	"should react",
	"should delegate",
	"should post",
	"plan to",
	"going to",
	// Chinese counterparts. Triage summaries are written by the persona in
	// either language; the bucket misses the Chinese path if these are
	// omitted (driver review comment 2026-05-21).
	"应该",
	"需要",
	"建议",
	"委托",
	"回复",
	"反应",
	"打算",
}

// triageQualityIntentActionMismatchMatch returns the first marker that
// triggered the bucket so callers can record it in the review sample for
// operator clarity. Returns empty string when no marker is present.
func triageQualityIntentActionMismatchMatch(summary string) string {
	lower := strings.ToLower(strings.TrimSpace(summary))
	if lower == "" {
		return ""
	}
	for _, marker := range triageQualityIntentActionMismatchMarkers {
		needle := strings.ToLower(marker)
		if strings.Contains(lower, needle) {
			return marker
		}
	}
	return ""
}

// SlackTriageQualityBucketThresholds is the snapshot exposed via the triage
// audit endpoint so external tooling (sweep script, monitor, future
// dashboards) can read the live thresholds instead of hard-coding them.
type SlackTriageQualityBucketThresholds struct {
	HighContextInputChars              int      `json:"highContextInputChars"`
	LowConfidenceCeiling               float64  `json:"lowConfidenceCeiling"`
	IntentActionMismatchSummaryMarkers []string `json:"intentActionMismatchSummaryMarkers"`
}

func slackTriageQualityBucketThresholds() SlackTriageQualityBucketThresholds {
	markers := append([]string(nil), triageQualityIntentActionMismatchMarkers...)
	return SlackTriageQualityBucketThresholds{
		HighContextInputChars:              triageQualityHighContextInputCharsThreshold,
		LowConfidenceCeiling:               triageQualityLowConfidenceCeiling,
		IntentActionMismatchSummaryMarkers: markers,
	}
}
