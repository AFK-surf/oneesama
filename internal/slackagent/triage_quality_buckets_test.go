package slackagent

import "testing"

// TestSlackTriageQualityBucketThresholdsMatrix pins the per-run quality
// bucket thresholds shared between the daily report's bucketing logic and
// the operational triage quality sweep script. Task #285. If a threshold
// changes intentionally, update the constant, this table, AND the matching
// jq default literal in scripts/oneesama-triage-quality-sweep.sh together;
// the script reads the live value from the audit endpoint but keeps the
// constant as a fallback for older servers.
func TestSlackTriageQualityBucketThresholdsMatrix(t *testing.T) {
	got := slackTriageQualityBucketThresholds()
	if got.HighContextInputChars != 7000 {
		t.Fatalf("HighContextInputChars = %d, want 7000", got.HighContextInputChars)
	}
	if got.LowConfidenceCeiling != 0.75 {
		t.Fatalf("LowConfidenceCeiling = %v, want 0.75", got.LowConfidenceCeiling)
	}
	if got.HighContextInputChars != triageQualityHighContextInputCharsThreshold {
		t.Fatalf("HighContextInputChars = %d, want triageQualityHighContextInputCharsThreshold (%d)", got.HighContextInputChars, triageQualityHighContextInputCharsThreshold)
	}
	if got.LowConfidenceCeiling != triageQualityLowConfidenceCeiling {
		t.Fatalf("LowConfidenceCeiling = %v, want triageQualityLowConfidenceCeiling (%v)", got.LowConfidenceCeiling, triageQualityLowConfidenceCeiling)
	}
}
