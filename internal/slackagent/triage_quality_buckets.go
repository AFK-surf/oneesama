package slackagent

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

// SlackTriageQualityBucketThresholds is the snapshot exposed via the triage
// audit endpoint so external tooling (sweep script, monitor, future
// dashboards) can read the live thresholds instead of hard-coding them.
type SlackTriageQualityBucketThresholds struct {
	HighContextInputChars int     `json:"highContextInputChars"`
	LowConfidenceCeiling  float64 `json:"lowConfidenceCeiling"`
}

func slackTriageQualityBucketThresholds() SlackTriageQualityBucketThresholds {
	return SlackTriageQualityBucketThresholds{
		HighContextInputChars: triageQualityHighContextInputCharsThreshold,
		LowConfidenceCeiling:  triageQualityLowConfidenceCeiling,
	}
}
