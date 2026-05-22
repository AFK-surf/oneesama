package slackagent

import (
	"strings"
	"testing"
	"time"
)

func TestVisibleReplyAllowListCanarySummaryPassesAllFixtures(t *testing.T) {
	t.Parallel()

	summary := buildSlackVisibleReplyAllowListCanarySummary()
	if summary.Total == 0 {
		t.Fatal("canary summary must include fixtures")
	}
	if summary.Failed != 0 || summary.Passed != summary.Total {
		t.Fatalf("summary = %#v, want all canaries passing", summary)
	}
	byName := make(map[string]SlackVisibleReplyAllowListCanaryCase, len(summary.Cases))
	for _, item := range summary.Cases {
		byName[item.Name] = item
	}
	for _, name := range []string{
		"source_backed_hn_identity_lookup_allows",
		"source_backed_product_link_comment_allows",
		"no_anchor_polite_reply_blocks",
		"framework_protocol_leak_blocks",
	} {
		if !byName[name].Passed {
			t.Fatalf("canary %q = %#v, want pass", name, byName[name])
		}
	}
	if got := byName["framework_protocol_leak_blocks"].ActualReason; got != slackVisibleReplyAllowReasonInternalMeta {
		t.Fatalf("framework protocol canary reason = %q", got)
	}
}

func TestVisibleReplyAllowListShadowComparesSamples(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	samples := slackVisibleReplyQualitySamples([]SlackPendingAction{{
		ID:         1,
		ChannelID:  "C123",
		ThreadTS:   "177.000",
		ActionType: slackActionTypeThreadReply,
		Params: map[string]any{
			"proposedReplyText": "这篇文章主要在讲 Agent harness 的 cache locality。",
			"approvalDecision":  "pending",
			"evidenceAnchors": []any{map[string]any{
				"kind":       slackVisibleEvidenceKindFetchedLink,
				"source_ref": "https://www.openclacky.com/benchmark",
				"quote":      "Cache locality",
			}},
		},
		Status:    PendingActionStatusPending,
		CreatedAt: now.Format(time.RFC3339Nano),
		UpdatedAt: now.Format(time.RFC3339Nano),
	}, {
		ID:         2,
		ChannelID:  "C123",
		ThreadTS:   "177.001",
		ActionType: slackActionTypeThreadReply,
		Params: map[string]any{
			"proposedReplyText": "我看了一下，这里应该可以继续按原计划推进。",
			"approvalDecision":  "pending",
		},
		Status:    PendingActionStatusPending,
		CreatedAt: now.Format(time.RFC3339Nano),
		UpdatedAt: now.Format(time.RFC3339Nano),
	}}, nil, time.Hour)

	shadow := buildSlackVisibleReplyAllowListShadowSummary(samples, 10)
	if shadow.Total != 2 || shadow.AllowListWouldAllow != 1 || shadow.AllowListWouldBlock != 1 || shadow.AllowListBlocksDenyListWouldPass != 1 {
		t.Fatalf("shadow = %#v", shadow)
	}
	if len(shadow.Samples) != 1 || shadow.Samples[0].AllowListReason != slackVisibleReplyAllowReasonMissingEvidenceAnchor {
		t.Fatalf("shadow samples = %#v", shadow.Samples)
	}
}

func TestTriageAuditReportIncludesVisibleReplyCanaryAndShadow(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	report := buildSlackTriageAuditReport(nil, time.Hour, []SlackPendingAction{{
		ID:         1,
		ChannelID:  "C123",
		ThreadTS:   "177.000",
		ActionType: slackActionTypeThreadReply,
		Params: map[string]any{
			"proposedReplyText": "这篇文章主要在讲 Agent harness 的 cache locality。",
			"evidenceAnchors": []any{map[string]any{
				"kind":       slackVisibleEvidenceKindFetchedLink,
				"source_ref": "https://www.openclacky.com/benchmark",
				"quote":      "Cache locality",
			}},
		},
		Status:    PendingActionStatusPending,
		CreatedAt: now.Format(time.RFC3339Nano),
		UpdatedAt: now.Format(time.RFC3339Nano),
	}})
	if report.VisibleReplyCanary.Total == 0 || report.VisibleReplyCanary.Failed != 0 {
		t.Fatalf("visible reply canary = %#v", report.VisibleReplyCanary)
	}
	if report.VisibleReplyShadow.Total != 1 || report.VisibleReplyShadow.AllowListWouldAllow != 1 {
		t.Fatalf("visible reply shadow = %#v", report.VisibleReplyShadow)
	}
}

func TestTriageQualityIntentMismatchSkipsUserRequestNarration(t *testing.T) {
	t.Parallel()

	summary := "消息是给 Oneesama 的测试请求，要求测试上传附件、生音频、图片、网站等权限相关 task，并将其固化为 agent 自动测试。这属于外部项目的具体功能测试/固化工作，不是 Oneesama 的 bounded secretary 工作。根据 delegation scope policy，此类外部项目功能测试调查应 stay_silent。"
	if got := triageQualityIntentActionMismatchMatch(summary); got != "" {
		t.Fatalf("triageQualityIntentActionMismatchMatch = %q, want no hit for user-request narration", got)
	}
	if !strings.Contains(summary, "要求测试") || !strings.Contains(summary, "delegation scope policy") {
		t.Fatalf("fixture no longer captures live false positive: %q", summary)
	}
}
