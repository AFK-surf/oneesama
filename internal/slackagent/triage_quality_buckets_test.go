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
	if len(got.HandledByOtherSummaryMarkers) == 0 {
		t.Fatalf("HandledByOtherSummaryMarkers must not be empty")
	}
}

// TestTriageQualityRunIsHandledByOtherMatch pins the EN+ZH summary markers
// that classify a no-action run as info-tier "handled by another agent /
// teammate". Driver pulled 5 dispose samples from the 2026-05-21 11:52 SHA
// 6h live sweep; all 5 are pinned as positive cases here so they cannot
// drift back into the review tier. Task #285 follow-up #3.
func TestTriageQualityRunIsHandledByOtherMatch(t *testing.T) {
	cases := []struct {
		name     string
		summary  string
		wantHit  string
		wantNone bool
	}{
		{"empty_no_hit", "", "", true},
		{"plain_no_action_no_hit", "Casual banter, no action needed.", "", true},
		// 5 live dispose samples from driver's 2026-05-21 11:52 SHA audit.
		{
			name:    "live_sample_high_context_already_answered_by_codex",
			summary: "The question about workerConversationFallbackStatus was already answered by @U0ALY77RMJL in the thread (msg_ts:1779324667.063799). No further action needed.",
			wantHit: "already answered",
		},
		{
			name:    "live_sample_high_context_actively_handled",
			summary: "The coding agent @U0ALY77RMJL has already responded to both messages, acknowledging the sidebar icon shadow issue and confirming the sidebar is native SwiftUI. The conversation is being actively handled.",
			wantHit: "already responded",
		},
		{
			name:    "live_sample_high_context_zh_handled",
			summary: "zanwei.guo 问新素材自带 shadow 是否不需要额外 shadow，@U0ALY77RMJL 已在 msg_ts:1779330164.445819 确认并移除了额外 shadow。问题已被直接回复处理，无需 Oneesama 介入。",
			// Marker list contains both `已被直接回复` and `已在 msg_ts`; the matcher
			// returns whichever appears first in the list (compound discipline).
			wantHit: "已被直接回复",
		},
		{
			name:    "live_sample_link_context_already_answered_in_thread",
			summary: "Casual remark about scraping trending page; the Twitter API question was already answered in thread by @U09SF0MQZ5M. No need for Oneesama to reply or react.",
			wantHit: "already answered",
		},
		{
			name:    "live_sample_link_context_already_resolved",
			summary: "This is a multi-message conversation decompression event where U09KNU8QD1V shared trends24.in link, noted Bridge's default no-at-no-reply behavior, and received a dismissive response from U09LXSCDWDT. Conversation already resolved: U09LXSCD...",
			wantHit: "already resolved",
		},
		// Edge cases / additional EN+ZH coverage.
		{"en_actively_handled", "Being actively handled by Claude.", "actively handled", false},
		{"zh_already_processed", "已经处理掉了，跳过", "已经处理", false},
		{"zh_being_handled_now", "正在处理这个 PR", "正在处理", false},
		// "already" alone WITHOUT a compound — should NOT match (compound discipline).
		{"already_alone_no_hit", "User already left the channel", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := triageQualityRunIsHandledByOther(tc.summary)
			if tc.wantNone {
				if got != "" {
					t.Fatalf("triageQualityRunIsHandledByOther(%q) = %q, want no marker", tc.summary, got)
				}
				return
			}
			if got != tc.wantHit {
				t.Fatalf("triageQualityRunIsHandledByOther(%q) = %q, want %q", tc.summary, got, tc.wantHit)
			}
		})
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
