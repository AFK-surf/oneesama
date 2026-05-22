package slackagent

import (
	"strings"
	"time"
)

const (
	slackVisibleReplyRejectReasonSpeculative      = "speculative"
	slackVisibleReplyRejectReasonNoCitation       = "no_citation"
	slackVisibleReplyRejectReasonRestatingThread  = "restating_thread"
	slackVisibleReplyRejectReasonWrongAudience    = "wrong_audience"
	slackVisibleReplyRejectReasonInternalTermLeak = "internal_term_leak"
	slackVisibleReplyRejectReasonOther            = "other"
)

func normalizeSlackVisibleReplyRejectReason(reason string) string {
	switch strings.TrimSpace(reason) {
	case slackVisibleReplyRejectReasonSpeculative,
		slackVisibleReplyRejectReasonNoCitation,
		slackVisibleReplyRejectReasonRestatingThread,
		slackVisibleReplyRejectReasonWrongAudience,
		slackVisibleReplyRejectReasonInternalTermLeak,
		slackVisibleReplyRejectReasonOther:
		return strings.TrimSpace(reason)
	case "manual_reject", "manual-reject", "rejected":
		return slackVisibleReplyRejectReasonOther
	default:
		if strings.TrimSpace(reason) == "" {
			return ""
		}
		return slackVisibleReplyRejectReasonOther
	}
}

func recordSlackVisibleReplyQualitySampleParams(action *SlackPendingAction) {
	if action == nil || action.ActionType != slackActionTypeThreadReply {
		return
	}
	if action.Params == nil {
		action.Params = make(map[string]any)
	}
	sample := slackVisibleReplyQualitySampleFromAction(*action)
	if sample == nil {
		return
	}
	action.Params["replyQualitySample"] = *sample
}

func slackVisibleReplyQualitySampleFromAction(action SlackPendingAction) *SlackVisibleReplyQualitySample {
	if action.ActionType != slackActionTypeThreadReply {
		return nil
	}
	message := strings.TrimSpace(firstNonEmpty(
		stringFromAny(action.Params["proposedReplyText"]),
		stringFromAny(action.Params["message"]),
	))
	if message == "" {
		return nil
	}
	decision := strings.TrimSpace(stringFromAny(action.Params["approvalDecision"]))
	if decision == "" {
		decision = slackTriagePendingApprovalDecision(action.Status)
	}
	decision = firstNonEmpty(decision, "pending")
	rejectReason := ""
	if decision == "rejected" || strings.TrimSpace(action.Status) == "dismissed" {
		rejectReason = normalizeSlackVisibleReplyRejectReason(stringFromAny(action.Params["rejectReason"]))
		if rejectReason == "" {
			rejectReason = slackVisibleReplyRejectReasonOther
		}
	}
	return &SlackVisibleReplyQualitySample{
		PendingActionID:        action.ID,
		CardID:                 strings.TrimSpace(stringFromAny(action.Params["cardId"])),
		TriageRunID:            int64FromAny(action.Params["triageRunId"]),
		JobID:                  strings.TrimSpace(stringFromAny(action.Params["jobId"])),
		ChannelID:              strings.TrimSpace(action.ChannelID),
		ThreadTS:               strings.TrimSpace(action.ThreadTS),
		CardTS:                 strings.TrimSpace(action.CardTS),
		ProposedMessage:        truncateSlackContextText(message, 800),
		ApprovalDecision:       decision,
		RejectReason:           rejectReason,
		FinalOutcome:           firstNonEmpty(strings.TrimSpace(stringFromAny(action.Params["finalOutcome"])), strings.TrimSpace(action.Result)),
		DecisionUserID:         strings.TrimSpace(action.ConfirmedBy),
		Source:                 firstNonEmpty(strings.TrimSpace(stringFromAny(action.Params["source"])), "pending_action"),
		AnchorConfidenceSource: firstNonEmpty(strings.TrimSpace(stringFromAny(action.Params["anchorConfidenceSource"])), "not_collected_phase0"),
		CreatedAt:              strings.TrimSpace(action.CreatedAt),
		UpdatedAt:              strings.TrimSpace(action.UpdatedAt),
	}
}

func slackVisibleReplyQualityBlockedSampleFromRun(run SlackTriageContext, call SlackTriageToolCall) SlackVisibleReplyQualitySample {
	return SlackVisibleReplyQualitySample{
		TriageRunID:            run.ID,
		ChannelID:              firstString(run.Channels),
		ProposedMessage:        truncateSlackContextText(firstNonEmpty(run.Summary, call.Brief), 800),
		ApprovalDecision:       "blocked",
		FinalOutcome:           "blocked",
		Source:                 "persona_reply_quality_gate",
		BlockReason:            strings.TrimSpace(call.Result),
		AnchorConfidenceSource: "not_collected_phase0",
		CreatedAt:              strings.TrimSpace(run.Timestamp),
		UpdatedAt:              strings.TrimSpace(run.Timestamp),
	}
}

func buildSlackVisibleReplyQualitySampleSummary(actions []SlackPendingAction, runs []SlackTriageContext, window time.Duration, limit int) SlackVisibleReplyQualitySampleSummary {
	now := timeNow().UTC()
	cutoff := now.Add(-window)
	if window <= 0 {
		cutoff = time.Time{}
	}
	samples := make([]SlackVisibleReplyQualitySample, 0)
	for _, action := range actions {
		sample := slackVisibleReplyQualitySampleFromAction(action)
		if sample == nil {
			continue
		}
		if !slackVisibleReplyQualitySampleInWindow(*sample, cutoff, now) {
			continue
		}
		samples = append(samples, *sample)
	}
	for _, run := range runs {
		if !slackTriageRunInWindow(run, cutoff, now) {
			continue
		}
		for _, call := range run.ToolCalls {
			if strings.TrimSpace(call.Action) != "persona_reply_quality_gate_silent" {
				continue
			}
			samples = append(samples, slackVisibleReplyQualityBlockedSampleFromRun(run, call))
		}
	}
	return summarizeSlackVisibleReplyQualitySamples(samples, limit)
}

func summarizeSlackVisibleReplyQualitySamples(samples []SlackVisibleReplyQualitySample, limit int) SlackVisibleReplyQualitySampleSummary {
	out := SlackVisibleReplyQualitySampleSummary{Total: len(samples)}
	for _, sample := range samples {
		switch strings.TrimSpace(sample.ApprovalDecision) {
		case "approved":
			out.Confirmed++
		case "rejected":
			out.Rejected++
		case "blocked":
			out.Blocked++
		default:
			out.Pending++
		}
	}
	if limit > 0 && len(samples) > limit {
		samples = samples[:limit]
	}
	out.Samples = samples
	return out
}

func slackVisibleReplyQualitySampleInWindow(sample SlackVisibleReplyQualitySample, cutoff time.Time, now time.Time) bool {
	if cutoff.IsZero() {
		return true
	}
	timestamp := parseTriageTimestamp(firstNonEmpty(sample.UpdatedAt, sample.CreatedAt))
	if timestamp.IsZero() {
		return false
	}
	timestamp = timestamp.UTC()
	return !timestamp.Before(cutoff.UTC()) && !timestamp.After(now.UTC())
}

func slackTriageRunInWindow(run SlackTriageContext, cutoff time.Time, now time.Time) bool {
	if cutoff.IsZero() {
		return true
	}
	timestamp := parseTriageTimestamp(run.Timestamp)
	if timestamp.IsZero() {
		return false
	}
	timestamp = timestamp.UTC()
	return !timestamp.Before(cutoff.UTC()) && !timestamp.After(now.UTC())
}

func firstString(items []string) string {
	for _, item := range items {
		if strings.TrimSpace(item) != "" {
			return strings.TrimSpace(item)
		}
	}
	return ""
}
