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
// bucket lands as review, never red (driver review note 2026-05-21). The
// matcher must skip historical/negated narration so a "model is describing
// past behaviour" summary does not trip the bucket — driver caught two
// false positives during the first ship that are now pinned as negative
// cases here. If a marker is added or removed, update the constant AND this
// table together. Anchor: #285 follow-up.
func TestTriageQualityIntentActionMismatchMatch(t *testing.T) {
	cases := []struct {
		name     string
		summary  string
		wantHit  string
		wantNone bool
	}{
		{"empty_summary_no_hit", "", "", true},
		{"benign_descriptive_summary_no_hit", "讨论已完成，无需介入", "", true},
		// Driver false-positive samples 2026-05-21: these matched bare-word
		// markers in the first cut and must NOT trip the bucket after the
		// compound-marker + negation-guard tightening.
		{
			name:     "negated_zh_already_replied",
			summary:  "已被 codex-3720 执行并回复，所以无需重复回复或反应",
			wantHit:  "",
			wantNone: true,
		},
		{
			name:     "negated_zh_no_need_to_reply",
			summary:  "没有明确问题或需要回复，无需介入",
			wantHit:  "",
			wantNone: true,
		},
		// English compound markers still hit (no negation guard for EN side
		// today since the model's English narration has been less prone to
		// confusing historical phrasing). Add EN negation guard if a
		// false-positive samples surfaces there.
		{"en_delegate_marker", "Will delegate this to codex worker", "delegate", false},
		{"en_will_reply_marker", "Will reply with citation", "will reply", false},
		{"en_should_delegate_matches_first_marker", "should delegate to codex", "delegate", false},
		{"case_insensitive_en", "DELEGATE this", "delegate", false},
		// Chinese compound markers hit when no negation is present.
		{"zh_compound_should_delegate", "应该委托给 codex 处理", "应该委托", false},
		{"zh_compound_recommend_reply", "建议回复用户问题", "建议回复", false},
		{"zh_compound_will_reply", "会回复这个 PR 评论", "会回复", false},
		{"zh_compound_need_delegate", "需要委托给负责人跟进", "需要委托", false},
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
