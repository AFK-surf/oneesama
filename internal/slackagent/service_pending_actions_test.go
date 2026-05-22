package slackagent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestPendingActionDismissedReplacesOriginalCard(t *testing.T) {
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeCreateIssue,
		Params: map[string]any{
			"title": "Create issue for flaky selection",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:        record.ID,
		Status:    "dismissed",
		UserID:    "U123",
		ChannelID: "C123",
		ThreadTS:  "123.456",
	})
	if !response.OK || !response.ReplaceOriginal {
		t.Fatalf("response = %#v, want replace_original resolved card", response)
	}
	encoded, _ := json.Marshal(response.Blocks)
	body := string(encoded)
	for _, want := range []string{"dismissed", "create_issue", "Create issue for flaky selection", "U123"} {
		if !strings.Contains(body, want) {
			t.Fatalf("blocks = %s, missing %q", body, want)
		}
	}
	if strings.Contains(body, "mab_pending_action_confirm") || strings.Contains(body, "mab_pending_action_dismiss") {
		t.Fatalf("blocks = %s, want resolved card without action buttons", body)
	}
}

func TestPendingActionOpenThreadKeepsOriginalCard(t *testing.T) {
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: "follow_up",
		Status:     PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:     record.ID,
		Status: "opened",
		UserID: "U123",
	})
	if !response.OK {
		t.Fatalf("response = %#v, want ok", response)
	}
	if response.ReplaceOriginal {
		t.Fatalf("response = %#v, open-thread helper should not replace original card", response)
	}
}

func TestPendingActionConfirmedPostThreadReplyPublishesOriginalThread(t *testing.T) {
	poster := &recordingPoster{callCh: make(chan struct{}, 1)}
	service := NewService(Config{
		Persistence: appconfig.PersistenceConfig{Provider: "memory"},
		Poster:      poster,
	})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeThreadReply,
		Params: map[string]any{
			"title":   "Review triage reply",
			"message": "这条可以发，但必须先由 Peng 确认。",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:        record.ID,
		Status:    "confirmed",
		UserID:    "U_PENG",
		ChannelID: "D_PENG",
	})
	if !response.OK || !response.ReplaceOriginal || !strings.Contains(response.Text, "posted thread reply") {
		t.Fatalf("response = %#v, want posted thread reply confirmation", response)
	}
	poster.WaitForCalls(t, 1)
	calls := poster.Calls()
	if len(calls) != 1 || calls[0].Channel != "C123" || calls[0].ThreadTS != "123.456" || !strings.Contains(calls[0].Text, "必须先由 Peng 确认") {
		t.Fatalf("poster calls = %#v, want confirmed reply posted to original thread", calls)
	}
	updated, err := service.triage.ListPendingActions(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListPendingActions: %v", err)
	}
	if len(updated) != 1 || !strings.HasPrefix(updated[0].Result, "posted:") {
		t.Fatalf("pending action = %#v, want posted result", updated)
	}
	encoded, _ := json.Marshal(response.Blocks)
	body := string(encoded)
	for _, want := range []string{"已发送", "原 thread", "U_PENG"} {
		if !strings.Contains(body, want) {
			t.Fatalf("blocks = %s, missing %q", body, want)
		}
	}
	for _, unwanted := range []string{"Triage suggestion", "post_thread_reply", "Persona"} {
		if strings.Contains(body, unwanted) {
			t.Fatalf("blocks = %s, unexpectedly contains %q", body, unwanted)
		}
	}
}

func TestPendingActionDismissedPostThreadReplyShowsSilencedState(t *testing.T) {
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeThreadReply,
		Params: map[string]any{
			"title":   "Review triage reply",
			"message": "这条不该发。",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:     record.ID,
		Status: "dismissed",
		UserID: "U_PENG",
	})
	if !response.OK || !response.ReplaceOriginal {
		t.Fatalf("response = %#v, want replacement", response)
	}
	encoded, _ := json.Marshal(response.Blocks)
	body := string(encoded)
	for _, want := range []string{"已拒绝", "保持静默", "U_PENG"} {
		if !strings.Contains(body, want) {
			t.Fatalf("blocks = %s, missing %q", body, want)
		}
	}
	for _, unwanted := range []string{"Triage suggestion", "post_thread_reply", "Persona"} {
		if strings.Contains(body, unwanted) {
			t.Fatalf("blocks = %s, unexpectedly contains %q", body, unwanted)
		}
	}
}

func TestPostThreadReplyApprovalRecordsQualitySample(t *testing.T) {
	service := NewService(Config{Persistence: appconfig.PersistenceConfig{Provider: "memory"}})
	record, err := service.triage.InsertPendingAction(context.Background(), SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeThreadReply,
		Params: map[string]any{
			"source":            "slack-triage-visible-reply-approval",
			"triageRunId":       int64(99),
			"jobId":             "job_visible_reply",
			"cardId":            "pending_action:42",
			"proposedReplyText": "这条回复缺少来源，不应该发。",
			"message":           "这条回复缺少来源，不应该发。",
			"approvalDecision":  "pending",
		},
		Status: PendingActionStatusPending,
	})
	if err != nil {
		t.Fatalf("InsertPendingAction: %v", err)
	}

	response := service.HandlePendingActionInteraction(context.Background(), SlackPendingActionInteraction{
		ID:           record.ID,
		Status:       "dismissed",
		UserID:       "U_PENG",
		RejectReason: slackVisibleReplyRejectReasonNoCitation,
	})
	if !response.OK {
		t.Fatalf("response = %#v, want ok", response)
	}
	actions, err := service.triage.ListPendingActions(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListPendingActions: %v", err)
	}
	if len(actions) != 1 {
		t.Fatalf("pending actions = %#v, want one", actions)
	}
	sample, ok := actions[0].Params["replyQualitySample"].(map[string]any)
	if !ok {
		t.Fatalf("replyQualitySample = %#v, want object", actions[0].Params["replyQualitySample"])
	}
	if stringFromAny(sample["approvalDecision"]) != "rejected" || stringFromAny(sample["rejectReason"]) != slackVisibleReplyRejectReasonNoCitation || stringFromAny(sample["decisionUserId"]) != "U_PENG" {
		t.Fatalf("replyQualitySample = %#v", sample)
	}

	report, err := service.TriageAudit(context.Background(), 6*time.Hour, 10)
	if err != nil {
		t.Fatalf("TriageAudit: %v", err)
	}
	if report.ReplyQualitySamples.Total != 1 || report.ReplyQualitySamples.Rejected != 1 || len(report.ReplyQualitySamples.Samples) != 1 {
		t.Fatalf("replyQualitySamples = %#v", report.ReplyQualitySamples)
	}
	got := report.ReplyQualitySamples.Samples[0]
	if got.RejectReason != slackVisibleReplyRejectReasonNoCitation || got.ApprovalDecision != "rejected" || got.TriageRunID != 99 || got.AnchorConfidenceSource != "source_derived:slack_thread" || len(got.EvidenceAnchors) != 1 {
		t.Fatalf("sample = %#v", got)
	}
}

func TestSlackVisibleReplyQualitySamplesIncludeBlockedGateRuns(t *testing.T) {
	now := time.Now().UTC()
	report := buildSlackTriageAuditReport([]SlackTriageContext{{
		ID:        123,
		Timestamp: now.Format(time.RFC3339Nano),
		Status:    "ok",
		Channels:  []string{"C123"},
		Summary:   "visible reply suppressed by Slack-visible quality gate",
		ToolCalls: []SlackTriageToolCall{{
			Tool:    "slack_api",
			Action:  "persona_reply_quality_gate_silent",
			Success: true,
			Result:  "internal_control_plane_leak",
		}},
	}}, 6*time.Hour)
	if report.ReplyQualitySamples.Total != 1 || report.ReplyQualitySamples.Blocked != 1 {
		t.Fatalf("replyQualitySamples = %#v", report.ReplyQualitySamples)
	}
	sample := report.ReplyQualitySamples.Samples[0]
	if sample.ApprovalDecision != "blocked" || sample.BlockReason != "internal_control_plane_leak" || sample.TriageRunID != 123 {
		t.Fatalf("sample = %#v", sample)
	}
}

func TestVisibleReplyQualityGateDropsInternalMetaReplies(t *testing.T) {
	actions := requireSlackTriageVisibleReplyApproval([]SlackTriageDecisionAction{{
		Type:      slackActionTypeThreadReply,
		Title:     "Review triage reply",
		Message:   "根据 persona 分析，persona 已判定 Oneesama 不应在此线程插话，我无可见输出。",
		ChannelID: "C123",
		ThreadTS:  "123.456",
	}})
	if len(actions) != 0 {
		t.Fatalf("actions = %#v, want internal meta reply dropped", actions)
	}
	if got := slackVisibleReplyQualityBlockReason("The persona already classified this thread as no visible output."); got != "internal_control_plane_leak" {
		t.Fatalf("block reason = %q, want internal_control_plane_leak", got)
	}
}

func TestVisibleReplyAllowListBlocksNoAnchorPoliteReplies(t *testing.T) {
	t.Parallel()

	action := SlackTriageDecisionAction{
		Type:      slackActionTypeThreadReply,
		Title:     "Review reply",
		Message:   "我看了一下，这里应该可以继续按原计划推进。",
		ChannelID: "C123",
		ThreadTS:  "123.456",
	}
	verdict := slackVisibleReplyAllowListVerdictForAction(action)
	if verdict.Allowed || verdict.Reason != slackVisibleReplyAllowReasonMissingEvidenceAnchor {
		t.Fatalf("verdict = %#v, want missing evidence anchor", verdict)
	}
	if actions := requireSlackTriageVisibleReplyApproval([]SlackTriageDecisionAction{action}); len(actions) != 0 {
		t.Fatalf("actions = %#v, want polite no-anchor reply blocked", actions)
	}
}

func TestVisibleReplyAllowListAllowsFetchedLinkAnchor(t *testing.T) {
	t.Parallel()

	action := SlackTriageDecisionAction{
		Type:      slackActionTypeThreadReply,
		Title:     "Review reply",
		Message:   "这篇文章的核心是 agent 编辑工具的取舍，作者明确比较了 EDIT 路径。",
		ChannelID: "C123",
		ThreadTS:  "123.456",
		EvidenceAnchors: []SlackVisibleEvidenceAnchor{{
			Kind:      slackVisibleEvidenceKindFetchedLink,
			SourceRef: "https://antirez.com/news/166",
			Quote:     "Alternatives for the EDIT tool of LLM agents",
		}},
	}

	actions := requireSlackTriageVisibleReplyApproval([]SlackTriageDecisionAction{action})
	if len(actions) != 1 || !actions[0].RequiresConfirmation || len(actions[0].EvidenceAnchors) != 1 {
		t.Fatalf("actions = %#v, want allowed reply with evidence anchor and approval", actions)
	}
	if actions[0].EvidenceAnchors[0].ConfidenceSource != "source_derived:fetched_link" {
		t.Fatalf("anchor = %#v", actions[0].EvidenceAnchors[0])
	}
}

func TestSlackVisibleReplyQualitySamplePreservesEvidenceAnchors(t *testing.T) {
	t.Parallel()

	action := SlackPendingAction{
		ChannelID:  "C123",
		ThreadTS:   "177.000",
		ActionType: slackActionTypeThreadReply,
		Params: map[string]any{
			"proposedReplyText": "这条回复引用了链接内容。",
			"approvalDecision":  "pending",
			"evidenceAnchors": []any{map[string]any{
				"kind":       "fetched_link",
				"source_ref": "https://example.com/article",
				"quote":      "Article source quote",
				"confidence": 0.2,
			}},
		},
		Status: PendingActionStatusPending,
	}

	sample := slackVisibleReplyQualitySampleFromAction(action)
	if sample == nil || len(sample.EvidenceAnchors) != 1 {
		t.Fatalf("sample = %#v, want one evidence anchor", sample)
	}
	anchor := sample.EvidenceAnchors[0]
	if anchor.Kind != slackVisibleEvidenceKindFetchedLink || anchor.Confidence != 0.86 || anchor.ConfidenceSource != "source_derived:fetched_link" {
		t.Fatalf("anchor = %#v, want normalized source-derived fetched-link anchor", anchor)
	}
	if sample.AnchorConfidenceSource != "source_derived:fetched_link" {
		t.Fatalf("AnchorConfidenceSource = %q", sample.AnchorConfidenceSource)
	}
}

func TestPostThreadReplyApprovalCardOnlyShowsApproveReject(t *testing.T) {
	blocks := buildSlackTriageActionBlocks(SlackTriageDecisionAction{
		Type:       slackActionTypeThreadReply,
		Title:      "Review triage reply",
		Message:    "approval gate live smoke reply",
		Confidence: 0.98,
		ChannelID:  "C123",
		ThreadTS:   "123.456",
	}, SlackPendingAction{
		ID:         42,
		ChannelID:  "C123",
		ThreadTS:   "123.456",
		ActionType: slackActionTypeThreadReply,
	})
	encoded, _ := json.Marshal(blocks)
	body := string(encoded)
	for _, want := range []string{"待确认回复", "approval gate live smoke reply", "通过并发送", "不通过", "mab_pending_action_confirm", "mab_pending_action_dismiss"} {
		if !strings.Contains(body, want) {
			t.Fatalf("blocks = %s, missing %q", body, want)
		}
	}
	for _, unwanted := range []string{"mab_pending_action_snooze", "mab_pending_action_open_thread", "mab_pending_action_assign", "Snooze", "Open thread", "Assign", "Quality gate", "Confidence", "Reason:"} {
		if strings.Contains(body, unwanted) {
			t.Fatalf("blocks = %s, unexpectedly contains %q", body, unwanted)
		}
	}
}
