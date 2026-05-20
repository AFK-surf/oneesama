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
//
// Markers are intentionally compound phrases. Bare single-word ZH markers
// like `回复` / `需要` / `应该` were too wide: they false-positive on
// historical / negated phrases such as `已被 ... 回复` / `没有需要回复`
// (driver false-positive report 2026-05-21 on the initial cut).
//
// Task #285 follow-up (driver 6h audit 2026-05-21 review proposal +
// false-positive tightening).
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
	// Chinese compound phrases. Avoid bare single-word markers so historical
	// / negated narration (`已被 X 回复` / `没有需要回复`) does not trip the
	// bucket; the negation guard below catches the remaining edge cases.
	"应该回复",
	"应该委托",
	"应该反应",
	"应该跟进",
	"需要回复",
	"需要委托",
	"需要跟进",
	"建议回复",
	"建议委托",
	"打算回复",
	"打算委托",
	"会回复",
	"会委托",
	"要回复",
	"要委托",
	"应当回复",
	"应当委托",
}

// triageQualityIntentActionMismatchNegations are substrings that, when
// present anywhere in the summary, suppress the mismatch bucket entirely.
// They flag "the run is describing historical / already-handled / negated
// state" rather than asserting an unrealised intent.
//
// Example trip the original cut: `没有明确问题或需要回复...无需介入`
// substring-matched `需要回复` even though the surrounding `没有 ... 或` /
// `无需` negates it. Rather than try to track negation scope statically,
// treat the whole summary as descriptive when any of these negation /
// historical markers appear.
var triageQualityIntentActionMismatchNegations = []string{
	"无需",
	"不需",
	"无须",
	"没有",
	"已被",
	"已由",
	"已经",
	"已回复",
	"已反应",
	"不再",
	"不必",
}

// triageQualityIntentActionMismatchMatch returns the first marker that
// triggered the bucket so callers can record it in the review sample for
// operator clarity. Returns empty string when no marker is present, the
// summary is empty, or any negation / historical marker appears anywhere in
// the summary.
func triageQualityIntentActionMismatchMatch(summary string) string {
	s := strings.TrimSpace(summary)
	if s == "" {
		return ""
	}
	for _, neg := range triageQualityIntentActionMismatchNegations {
		if strings.Contains(s, neg) {
			return ""
		}
	}
	lower := strings.ToLower(s)
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
