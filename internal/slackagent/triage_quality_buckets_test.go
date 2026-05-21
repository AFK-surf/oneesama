package slackagent

import (
	"testing"

	"github.com/AFK-surf/oneesama/internal/persona"
)

func TestTriageQualityRunDynamicContextIssue(t *testing.T) {
	mkRun := func(envelopes []map[string]any, extra map[string]any) SlackTriageContext {
		md := map[string]any{
			"persona_dynamic_context_expected": true,
			"persona_dynamic_context":          envelopes,
		}
		for key, value := range extra {
			md[key] = value
		}
		return SlackTriageContext{
			ID:        101,
			Timestamp: "2026-05-21T10:00:00Z",
			Summary:   "Pi foreground completed.",
			Metadata:  md,
		}
	}
	env := func(kind string, freshness string) map[string]any {
		return map[string]any{
			"kind":          kind,
			"source":        "test_source",
			"version":       "sha256:abc123",
			"freshness":     freshness,
			"cache_policy":  persona.DynamicContextCachePolicyNotStablePrefix,
			"content_chars": 12,
		}
	}
	cases := []struct {
		name           string
		run            SlackTriageContext
		wantOK         bool
		wantMissing    string
		wantIncomplete string
		wantStale      string
	}{
		{
			name: "legacy_without_expected_marker_is_ignored",
			run: SlackTriageContext{
				Timestamp: "2026-05-21T10:00:00Z",
				Metadata:  map[string]any{},
			},
			wantOK: false,
		},
		{
			name:   "valid_required_context_does_not_match",
			run:    mkRun([]map[string]any{env("current_time", "2026-05-21T10:00:01Z")}, nil),
			wantOK: false,
		},
		{
			name:        "missing_workspace_policy_when_configured",
			run:         mkRun([]map[string]any{env("current_time", "2026-05-21T10:00:01Z")}, map[string]any{"workspace_policy_configured": true}),
			wantOK:      true,
			wantMissing: "workspace_triage_policy",
		},
		{
			name:           "wrong_cache_policy_is_incomplete",
			run:            mkRun([]map[string]any{{"kind": "current_time", "source": "runtime", "version": "runtime_clock", "freshness": "2026-05-21T10:00:01Z", "cache_policy": "stable_prefix"}}, nil),
			wantOK:         true,
			wantIncomplete: "current_time",
		},
		{
			name:      "old_freshness_is_stale",
			run:       mkRun([]map[string]any{env("current_time", "2026-05-21T09:40:00Z")}, nil),
			wantOK:    true,
			wantStale: "current_time",
		},
		{
			name: "custom_emoji_required_when_snapshot_present",
			run: mkRun([]map[string]any{env("current_time", "2026-05-21T10:00:01Z")}, map[string]any{
				"workspace_custom_emoji": []any{"eyes_bridge"},
			}),
			wantOK:      true,
			wantMissing: "workspace_custom_emoji",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			issue, ok := triageQualityRunDynamicContextIssue(tc.run)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (issue=%#v)", ok, tc.wantOK, issue)
			}
			if tc.wantMissing != "" && !containsTriageQualityString(issue.MissingKinds, tc.wantMissing) {
				t.Fatalf("MissingKinds = %#v, want %q", issue.MissingKinds, tc.wantMissing)
			}
			if tc.wantIncomplete != "" && !containsTriageQualityString(issue.IncompleteKinds, tc.wantIncomplete) {
				t.Fatalf("IncompleteKinds = %#v, want %q", issue.IncompleteKinds, tc.wantIncomplete)
			}
			if tc.wantStale != "" && !containsTriageQualityString(issue.StaleKinds, tc.wantStale) {
				t.Fatalf("StaleKinds = %#v, want %q", issue.StaleKinds, tc.wantStale)
			}
		})
	}
}

func containsTriageQualityString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// TestTriageQualityRunDelegateNoVisibleActionMatch pins the bucket conditions
// for `delegate_no_visible_action` review samples. Driver 2h sweep
// 2026-05-21 15:00 observed 2 runs with persona_foreground.decision=
// delegate_worker + non-empty worker_requests but actions=[]/mutations=0
// being miscategorised as narrative `summary_intent_action_mismatch`. The
// split is conditional on metadata evidence (not summary text) so the
// classifier here is a pure shape test against synthetic SlackTriageContext
// values.
func TestTriageQualityRunDelegateNoVisibleActionMatch(t *testing.T) {
	mkRun := func(decision string, workerRequests any, toolCalls []SlackTriageToolCall, extra map[string]any) SlackTriageContext {
		md := map[string]any{
			"persona_foreground": map[string]any{
				"decision":        decision,
				"worker_requests": workerRequests,
			},
		}
		for k, v := range extra {
			md[k] = v
		}
		return SlackTriageContext{Metadata: md, ToolCalls: toolCalls}
	}
	cases := []struct {
		name        string
		run         SlackTriageContext
		wantOK      bool
		wantReqs    int
		wantJobID   string
		wantDeliver string
	}{
		{
			name: "delegate_worker_with_worker_requests_and_job_id_matches",
			run: mkRun("delegate_worker",
				[]any{"codex: read file F0B5A71MVSM and report"},
				[]SlackTriageToolCall{{Tool: "agent_runner", Action: "delegate_worker", Args: `{"jobId":"job_577ca8b2","parseOk":true,"provider":"codex"}`}},
				map[string]any{"delegate_worker_jobs_started": 1},
			),
			wantOK:      true,
			wantReqs:    1,
			wantJobID:   "job_577ca8b2",
			wantDeliver: "delegate_started_pending_worker_audit",
		},
		{
			name: "delegate_worker_with_failures_marks_failed_delivery",
			run: mkRun("delegate_worker",
				[]any{"codex: do thing"},
				[]SlackTriageToolCall{{Tool: "agent_runner", Action: "delegate_worker", Args: `{"jobId":"job_abc","provider":"codex"}`}},
				map[string]any{"delegate_worker_jobs_started": 1, "delegate_worker_failures": 1},
			),
			wantOK:      true,
			wantReqs:    1,
			wantJobID:   "job_abc",
			wantDeliver: "delegate_failed_in_run",
		},
		{
			name: "delegate_worker_extracts_job_id_from_pretty_json_args",
			run: mkRun("delegate_worker",
				[]any{"codex: do thing"},
				[]SlackTriageToolCall{{Tool: "agent_runner", Action: "delegate_worker", Args: `{"jobId": "job_pretty", "provider": "codex"}`}},
				map[string]any{"delegate_worker_jobs_started": 1},
			),
			wantOK:      true,
			wantReqs:    1,
			wantJobID:   "job_pretty",
			wantDeliver: "delegate_started_pending_worker_audit",
		},
		{
			name: "delegate_worker_extracts_job_id_from_snake_case_args",
			run: mkRun("delegate_worker",
				[]any{"codex: do thing"},
				[]SlackTriageToolCall{{Tool: "agent_runner", Action: "delegate_worker", Args: `{"job_id":"job_snake","provider":"codex"}`}},
				map[string]any{"delegate_worker_jobs_started": 1},
			),
			wantOK:      true,
			wantReqs:    1,
			wantJobID:   "job_snake",
			wantDeliver: "delegate_started_pending_worker_audit",
		},
		{
			name: "delegate_worker_without_visible_job_id_records_status",
			run: mkRun("delegate_worker",
				[]string{"codex: do thing"},
				nil,
				nil,
			),
			wantOK:      true,
			wantReqs:    1,
			wantJobID:   "",
			wantDeliver: "no_visible_job_id",
		},
		{
			name: "stay_silent_decision_does_not_match",
			run: mkRun("stay_silent",
				[]any{"would have asked codex"},
				nil,
				nil,
			),
			wantOK: false,
		},
		{
			name: "delegate_worker_with_empty_worker_requests_does_not_match",
			run: mkRun("delegate_worker",
				[]any{},
				nil,
				nil,
			),
			wantOK: false,
		},
		{
			name: "delegate_worker_with_whitespace_only_worker_request_does_not_match",
			run: mkRun("delegate_worker",
				[]any{"  "},
				nil,
				nil,
			),
			wantOK: false,
		},
		{
			name:   "run_without_persona_foreground_does_not_match",
			run:    SlackTriageContext{Metadata: map[string]any{}},
			wantOK: false,
		},
		{
			name: "delegate_worker_jobs_started_zero_marks_not_started",
			run: mkRun("delegate_worker",
				[]any{"codex: do thing"},
				[]SlackTriageToolCall{{Tool: "agent_runner", Action: "delegate_worker", Args: `{"jobId":"job_xyz"}`}},
				map[string]any{"delegate_worker_jobs_started": 0},
			),
			wantOK:      true,
			wantReqs:    1,
			wantJobID:   "job_xyz",
			wantDeliver: "delegate_not_started_in_run",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev, ok := triageQualityRunDelegateNoVisibleAction(tc.run)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if len(ev.WorkerRequests) != tc.wantReqs {
				t.Fatalf("WorkerRequests len = %d, want %d (%#v)", len(ev.WorkerRequests), tc.wantReqs, ev.WorkerRequests)
			}
			if ev.JobID != tc.wantJobID {
				t.Fatalf("JobID = %q, want %q", ev.JobID, tc.wantJobID)
			}
			if ev.DeliveryStatus != tc.wantDeliver {
				t.Fatalf("DeliveryStatus = %q, want %q", ev.DeliveryStatus, tc.wantDeliver)
			}
		})
	}
}

// TestBuildSlackTriageReviewBucketsBucketPrecedence pins the dispatch
// order: no-action delegate_worker runs never fall through to the narrative
// intent_action_mismatch bucket. If the worker visibly started, the sample is
// no longer review-tier; if the worker did not start / has no visible job id,
// it remains in delegate_no_visible_action for operator review.
func TestBuildSlackTriageReviewBucketsBucketPrecedence(t *testing.T) {
	dynamicIssueRun := SlackTriageContext{
		ID:        4,
		Timestamp: "2026-05-21T07:03:00Z",
		Channels:  []string{"C_D"},
		Summary:   "I should delegate this to codex and reply later",
		Metadata: map[string]any{
			"persona_dynamic_context_expected": true,
			"persona_dynamic_context":          []any{},
		},
	}
	delegateStartedRun := SlackTriageContext{
		ID:        1,
		Timestamp: "2026-05-21T07:00:00Z",
		Channels:  []string{"C_A"},
		Summary:   "I should delegate this to codex and reply later", // contains the en intent markers too
		Metadata: map[string]any{
			"persona_foreground": map[string]any{
				"decision":        "delegate_worker",
				"worker_requests": []any{"codex: do thing"},
			},
			"delegate_worker_jobs_started": 1,
		},
		ToolCalls: []SlackTriageToolCall{{Tool: "agent_runner", Action: "delegate_worker", Args: `{"jobId":"job_dual"}`}},
	}
	delegateNotStartedRun := SlackTriageContext{
		ID:        3,
		Timestamp: "2026-05-21T07:02:00Z",
		Channels:  []string{"C_C"},
		Summary:   "I should delegate this to codex and reply later",
		Metadata: map[string]any{
			"persona_foreground": map[string]any{
				"decision":        "delegate_worker",
				"worker_requests": []any{"codex: do thing"},
			},
			"delegate_worker_jobs_started": 0,
		},
		ToolCalls: []SlackTriageToolCall{{Tool: "agent_runner", Action: "delegate_worker", Args: `{"jobId":"job_missing"}`}},
	}
	pureMismatchRun := SlackTriageContext{
		ID:        2,
		Timestamp: "2026-05-21T07:01:00Z",
		Channels:  []string{"C_B"},
		Summary:   "Should delegate to codex but did nothing",
		Metadata:  map[string]any{},
	}
	buckets := buildSlackTriageReviewBuckets([]SlackTriageContext{delegateStartedRun, delegateNotStartedRun, pureMismatchRun, dynamicIssueRun}, 8)
	if buckets.DynamicContextIssueCount != 1 {
		t.Fatalf("DynamicContextIssueCount = %d, want 1", buckets.DynamicContextIssueCount)
	}
	if len(buckets.DynamicContextIssueSamples) != 1 || buckets.DynamicContextIssueSamples[0].RunID != 4 {
		t.Fatalf("DynamicContextIssueSamples = %#v, want one row for run 4", buckets.DynamicContextIssueSamples)
	}
	if buckets.DelegateNoVisibleActionCount != 1 {
		t.Fatalf("DelegateNoVisibleActionCount = %d, want 1", buckets.DelegateNoVisibleActionCount)
	}
	if buckets.IntentActionMismatchCount != 1 {
		t.Fatalf("IntentActionMismatchCount = %d, want 1 (only pureMismatchRun)", buckets.IntentActionMismatchCount)
	}
	if len(buckets.DelegateNoVisibleActionSamples) != 1 || buckets.DelegateNoVisibleActionSamples[0].RunID != 3 {
		t.Fatalf("DelegateNoVisibleActionSamples = %#v, want one row for run 3", buckets.DelegateNoVisibleActionSamples)
	}
	if buckets.DelegateNoVisibleActionSamples[0].JobID != "job_missing" {
		t.Fatalf("delegate sample JobID = %q, want job_missing", buckets.DelegateNoVisibleActionSamples[0].JobID)
	}
	if len(buckets.IntentActionMismatchSamples) != 1 || buckets.IntentActionMismatchSamples[0].RunID != 2 {
		t.Fatalf("IntentActionMismatchSamples = %#v, want one row for run 2", buckets.IntentActionMismatchSamples)
	}
}

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
	if got.DynamicContextFreshnessSkewSeconds != int64(triageQualityDynamicContextFreshnessSkew.Seconds()) {
		t.Fatalf("DynamicContextFreshnessSkewSeconds = %d, want %d", got.DynamicContextFreshnessSkewSeconds, int64(triageQualityDynamicContextFreshnessSkew.Seconds()))
	}
	if len(got.IntentActionMismatchSummaryMarkers) == 0 {
		t.Fatalf("IntentActionMismatchSummaryMarkers must not be empty")
	}
	if len(got.HandledByOtherSummaryMarkers) == 0 {
		t.Fatalf("HandledByOtherSummaryMarkers must not be empty")
	}
	if len(got.HandledByOtherSummaryNegations) == 0 {
		t.Fatalf("HandledByOtherSummaryNegations must not be empty")
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
		{"en_already_being_handled", "Already being handled by U0ALY77RMJL and U0AMN6TKVJ8 in the thread.", "already being handled", false},
		{"en_already_been_answered", "The question about 3s complexity has already been answered by Heyang in the thread; no need for Oneesama to reply.", "already been answered", false},
		{"en_being_handled_by", "The deployment question is being handled by codex-3720.", "being handled by", false},
		{"en_fully_handled", "This has already been fully handled by codex-3720 in the same thread.", "already been fully handled", false},
		{"en_being_investigated", "The admin 404 issue is already being investigated and resolved by the developer in the thread; no further action needed.", "being investigated and resolved", false},
		{"en_assistant_complied", "The assistant has already complied and closed the PR; the situation is fully handled.", "already complied", false},
		{"en_active_agent", "The thread already has an active agent investigating the session slowness.", "active agent", false},
		{"en_already_handles", "codex-3720 consistently acknowledges and already handles these deploy commands.", "already handles", false},
		{"en_already_active", "U0ALY77RMJL is already active and has opened a session to handle it.", "already active", false},
		{"zh_already_investigated", "codex-3720 已经查了 CI 失败原因并给出后续步骤。", "已经查了", false},
		{"zh_fully_analyzed", "问题已经被充分分析和处理了，不需要我额外介入。", "已经被充分分析", false},
		{"zh_already_processed", "已经处理掉了，跳过", "已经处理", false},
		{"zh_being_handled_now", "正在处理这个 PR", "正在处理", false},
		// "already" alone WITHOUT a compound — should NOT match (compound discipline).
		{"already_alone_no_hit", "User already left the channel", "", true},
		{
			name:     "negative_resolution_no_hit",
			summary:  "Vincent replied that he does not know who Johnson8053 is; the identity question is not actually handled.",
			wantHit:  "",
			wantNone: true,
		},
		{
			name:     "zh_negative_resolution_no_hit",
			summary:  "有人说不认识这个 HN 账号，这不是已被处理的结论，需要继续查证。",
			wantHit:  "",
			wantNone: true,
		},
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
		// Driver 2026-05-21 17:00 false-positive: English summaries can also
		// describe negated routing ("should not be delegated"). These must not
		// trip the narrative mismatch bucket.
		{
			name:     "negated_en_should_not_delegate",
			summary:  "This falls under delegation_scope_policy and should not be delegated. Reply would be intrusive; stay silent.",
			wantHit:  "",
			wantNone: true,
		},
		{
			name:     "negated_en_no_further_action",
			summary:  "Already handled by another agent; no further action is needed.",
			wantHit:  "",
			wantNone: true,
		},
		// English compound markers still hit when no negation is present.
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
