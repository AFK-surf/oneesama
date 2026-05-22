package slackagent

import (
	"context"
	"fmt"
	"strings"
)

func slackLearningSignalFromVisibleReplySample(sample SlackVisibleReplyQualitySample) SlackLearningSignal {
	verdict := firstNonEmpty(strings.TrimSpace(sample.ApprovalDecision), "pending")
	reason := firstNonEmpty(strings.TrimSpace(sample.RejectReason), strings.TrimSpace(sample.BlockReason), strings.TrimSpace(sample.FinalOutcome), "visible_reply_review")
	proposedAction := "memory_candidate"
	target := ""
	if verdict == "rejected" || verdict == "blocked" {
		proposedAction = "gate_fixture"
		target = "visible_reply_gate"
	}
	refs := []string{}
	if sample.PendingActionID != 0 {
		refs = append(refs, fmt.Sprintf("pending_action:%d", sample.PendingActionID))
	}
	if sample.TriageRunID != 0 {
		refs = append(refs, fmt.Sprintf("triage_run:%d", sample.TriageRunID))
	}
	if sample.ChannelID != "" || sample.ThreadTS != "" {
		refs = append(refs, "slack:"+strings.TrimSpace(sample.ChannelID)+"/"+strings.TrimSpace(sample.ThreadTS))
	}
	if sample.CardID != "" {
		refs = append(refs, sample.CardID)
	}
	return SlackLearningSignal{
		Source:         slackLearningSourceApprovalCard,
		Surface:        "slack",
		Verdict:        verdict,
		Refs:           refs,
		ReasonCode:     reason,
		ProposedAction: proposedAction,
		Target:         target,
		Subject:        "visible_reply_quality",
		SourceType:     firstNonEmpty(strings.TrimSpace(sample.Source), slackLearningSourceApprovalCard),
		Content:        sample.ProposedMessage,
		Timestamp:      firstNonEmpty(strings.TrimSpace(sample.UpdatedAt), strings.TrimSpace(sample.CreatedAt)),
		Metadata: map[string]any{
			"job_id":                   sample.JobID,
			"decision_user_id":         sample.DecisionUserID,
			"anchor_confidence_source": sample.AnchorConfidenceSource,
		},
	}
}

func slackLearningSignalFromVisibleReplyCanaryCase(candidate SlackVisibleReplyAllowListCanaryCase) SlackLearningSignal {
	verdict := "pass"
	if !candidate.Passed {
		verdict = "fail"
	}
	reason := firstNonEmpty(candidate.ActualReason, candidate.ExpectedReason, "canary")
	return SlackLearningSignal{
		Source:         slackLearningSourceAllowCanary,
		Surface:        "slack",
		Verdict:        verdict,
		Refs:           []string{"visible_reply_allow_list_canary:" + candidate.Name},
		ReasonCode:     reason,
		ProposedAction: "gate_fixture",
		Target:         "visible_reply_gate",
		Subject:        "visible_reply_allow_list",
		SourceType:     slackLearningSourceAllowCanary,
		Content:        candidate.Name,
		Metadata: map[string]any{
			"expected_allow": candidate.ExpectedAllow,
			"actual_allow":   candidate.ActualAllow,
		},
	}
}

func SlackLearningSignalFromIncident(surface string, reasonCode string, refs []string, summary string) SlackLearningSignal {
	return SlackLearningSignal{
		Source:         slackLearningSourceIncident,
		Surface:        strings.TrimSpace(surface),
		Verdict:        "quality_regression",
		Refs:           refs,
		ReasonCode:     strings.TrimSpace(reasonCode),
		ProposedAction: "memory_candidate",
		Subject:        "production_incident",
		SourceType:     slackLearningSourceIncident,
		Content:        strings.TrimSpace(summary),
	}
}

func SlackLearningSignalFromBenchmark(caseID string, verdict string, reasonCode string, refs []string, summary string) SlackLearningSignal {
	return SlackLearningSignal{
		Source:         slackLearningSourceBenchmark,
		Surface:        "slack",
		Verdict:        strings.TrimSpace(verdict),
		Refs:           append([]string{"benchmark_case:" + strings.TrimSpace(caseID)}, refs...),
		ReasonCode:     strings.TrimSpace(reasonCode),
		ProposedAction: "benchmark_case",
		Target:         "benchmark_case",
		Subject:        strings.TrimSpace(caseID),
		SourceType:     slackLearningSourceBenchmark,
		Content:        strings.TrimSpace(summary),
	}
}

func slackLearningSignalFromReactionBackedHumanConclusion(conclusion SlackReactionBackedHumanConclusion) SlackLearningSignal {
	refs := []string{}
	if conclusion.ChannelID != "" || conclusion.ThreadTS != "" {
		refs = append(refs, "slack:"+strings.TrimSpace(conclusion.ChannelID)+"/"+strings.TrimSpace(conclusion.ThreadTS))
	}
	if conclusion.ChannelID != "" || conclusion.MessageTS != "" {
		refs = append(refs, "slack_message:"+strings.TrimSpace(conclusion.ChannelID)+"/"+strings.TrimSpace(conclusion.MessageTS))
	}
	return SlackLearningSignal{
		Source:         slackLearningSourceReactionBackedConclusion,
		Surface:        "slack",
		Verdict:        "confirm",
		Refs:           refs,
		ReasonCode:     "positive_reaction_on_human_thread_reply",
		ProposedAction: "memory_candidate",
		Target:         "persona_triage_quality",
		Subject:        "reaction_backed_human_conclusion",
		SourceType:     slackLearningSourceReactionBackedConclusion,
		Content:        conclusion.Summary,
		Metadata: map[string]any{
			"emoji":         conclusion.Emoji,
			"reactor_user":  conclusion.UserID,
			"message_user":  conclusion.ItemUserID,
			"thread_ts":     conclusion.ThreadTS,
			"message_ts":    conclusion.MessageTS,
			"source_signal": "reaction_added",
		},
	}
}

func (s *Service) RecordLearningSignal(ctx context.Context, signal SlackLearningSignal) {
	s.recordLearningSignal(ctx, signal)
}

func (s *Service) RecordVisibleReplyAllowListCanaryLearningSignals(ctx context.Context, summary SlackVisibleReplyAllowListCanarySummary) {
	for _, candidate := range summary.Cases {
		if candidate.Passed {
			continue
		}
		s.recordLearningSignal(ctx, slackLearningSignalFromVisibleReplyCanaryCase(candidate))
	}
}

func (s *Service) RecordIncidentLearningSignal(ctx context.Context, surface string, reasonCode string, refs []string, summary string) {
	s.recordLearningSignal(ctx, SlackLearningSignalFromIncident(surface, reasonCode, refs, summary))
}

func (s *Service) RecordBenchmarkLearningSignal(ctx context.Context, caseID string, verdict string, reasonCode string, refs []string, summary string) {
	s.recordLearningSignal(ctx, SlackLearningSignalFromBenchmark(caseID, verdict, reasonCode, refs, summary))
}

func (s *Service) recordLearningSignal(ctx context.Context, signal SlackLearningSignal) {
	if s == nil || s.learning == nil {
		return
	}
	if _, err := s.learning.Insert(ctx, signal); err != nil {
		s.logger.Warn("slack learning signal record failed", "source", signal.Source, "reason_code", signal.ReasonCode, "error", err)
	}
}

func (s *Service) recordLearningSignalFromPendingAction(ctx context.Context, action SlackPendingAction) {
	sample := slackVisibleReplyQualitySampleFromAction(action)
	if sample == nil {
		return
	}
	s.recordLearningSignal(ctx, slackLearningSignalFromVisibleReplySample(*sample))
}
