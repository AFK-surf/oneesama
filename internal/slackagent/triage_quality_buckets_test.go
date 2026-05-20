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
	if len(got.IntentActionMismatchSummaryMarkers) == 0 {
		t.Fatalf("IntentActionMismatchSummaryMarkers must not be empty")
	}
}

// TestTriageQualityIntentActionMismatchMatch pins the EN+ZH summary markers
// that classify a no-action run as `summary_intent_action_mismatch`. The
// bucket lands as review, never red (driver review note 2026-05-21). If a
// marker is added or removed, update the constant AND this table together.
// Anchor: #285 follow-up, driver 6h audit review proposal.
func TestTriageQualityIntentActionMismatchMatch(t *testing.T) {
	cases := []struct {
		name     string
		summary  string
		wantHit  string
		wantNone bool
	}{
		{"empty_summary_no_hit", "", "", true},
		{"benign_descriptive_summary_no_hit", "讨论已完成，无需介入", "", true},
		{"en_delegate_marker", "Will delegate this to codex worker", "delegate", false},
		{"en_will_reply_marker", "Will reply with citation", "will reply", false},
		{"en_should_delegate_matches_first_marker", "should delegate to codex", "delegate", false},
		{"zh_delegate_marker", "应该委托给 codex 处理", "应该", false},
		{"zh_reply_marker", "建议回复用户", "建议", false},
		{"zh_react_marker", "需要反应一下", "需要", false},
		{"case_insensitive_en", "DELEGATE this", "delegate", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := triageQualityIntentActionMismatchMatch(tc.summary)
			if tc.wantNone {
				if got != "" {
					t.Fatalf("triageQualityIntentActionMismatchMatch(%q) = %q, want no marker", tc.summary, got)
				}
				return
			}
			if got != tc.wantHit {
				t.Fatalf("triageQualityIntentActionMismatchMatch(%q) = %q, want %q", tc.summary, got, tc.wantHit)
			}
		})
	}
}
