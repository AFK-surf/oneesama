package meetingagent

import (
	"context"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

func (s *Service) deliverWorkerReportRealtime(ctx context.Context, report WorkerReport) (meetrunner.WorkerResultDelivery, *WorkerReport) {
	if workerReportIsNoAction(report) {
		updated, err := s.markWorkerRealtimeSuppressed(ctx, report.ID, DeliveryMeta{Channel: "realtime_noop_suppressed", Reason: "no_action_result"})
		if err != nil {
			return meetrunner.WorkerResultDelivery{OK: false, Error: err.Error()}, nil
		}
		return meetrunner.WorkerResultDelivery{OK: false, Channel: "realtime_noop_suppressed", Suppressed: true, Reason: "no_action_result"}, &updated
	}
	session, err := s.resolveJoinSession(ctx, "")
	if err != nil || session == nil {
		return meetrunner.WorkerResultDelivery{OK: false, Error: "no_active_join"}, nil
	}
	if channel := workerReportRealtimeSuppressChannel(report, session.ID); channel != "" {
		reason := workerReportRealtimeSuppressReason(channel)
		updated, err := s.markWorkerRealtimeSuppressed(ctx, report.ID, DeliveryMeta{Channel: channel, Reason: reason})
		if err != nil {
			return meetrunner.WorkerResultDelivery{OK: false, Error: err.Error()}, nil
		}
		return meetrunner.WorkerResultDelivery{OK: false, Channel: channel, Suppressed: true, Reason: reason}, &updated
	}
	delivery, err := s.meetRunner.InjectWorkerResult(ctx, meetrunner.WorkerResultInput{
		SessionID: session.ID,
		Job:       report,
	})
	if err != nil {
		return meetrunner.WorkerResultDelivery{OK: false, Error: err.Error()}, nil
	}
	if workerResultDeliverySuppressed(delivery) {
		reason := workerResultDeliverySuppressionReason(delivery)
		updated, err := s.markWorkerRealtimeSuppressed(ctx, report.ID, DeliveryMeta{Channel: delivery.Channel, Reason: reason})
		if err != nil {
			s.logger.Warn("worker realtime suppression marker failed", "job_id", report.ID, "error", err)
			return delivery, nil
		}
		delivery.OK = false
		delivery.Suppressed = true
		delivery.Reason = reason
		return delivery, &updated
	}
	if !delivery.OK {
		return delivery, nil
	}
	updated, err := s.markWorkerDelivered(ctx, report.ID, true, DeliveryMeta{Channel: delivery.Channel})
	if err != nil {
		s.logger.Warn("worker realtime delivery marker failed", "job_id", report.ID, "error", err)
		return delivery, nil
	}
	return delivery, &updated
}

func workerReportIsNoAction(report WorkerReport) bool {
	if !strings.EqualFold(strings.TrimSpace(report.Status), "completed") {
		return false
	}
	result := strings.ToLower(strings.TrimSpace(report.Result))
	if result == "" {
		return true
	}
	noActionPhrases := []string{
		"no action needed",
		"no action.",
		"no action",
		"nothing to do",
		"无需",
		"不需要执行",
		"没有需要执行",
		"无需助手介入",
	}
	for _, phrase := range noActionPhrases {
		if strings.Contains(result, phrase) {
			return true
		}
	}
	if report.ResultEnvelope != nil {
		summary := strings.ToLower(strings.TrimSpace(firstNonEmpty(report.ResultEnvelope.Summary, report.ResultEnvelope.Result)))
		for _, phrase := range noActionPhrases {
			if strings.Contains(summary, phrase) {
				return true
			}
		}
	}
	return false
}

func workerReportRealtimeSuppressChannel(report WorkerReport, sessionID string) string {
	if !workerReportIsRealtimeMeetingScoped(report) {
		return "realtime_non_meeting_suppressed"
	}
	targetSessionID := workerReportMeetingSessionID(report)
	if sessionID != "" && targetSessionID == "" {
		return "realtime_session_missing_suppressed"
	}
	if sessionID != "" && targetSessionID != "" && targetSessionID != sessionID {
		return "realtime_session_mismatch_suppressed"
	}
	return ""
}

func workerReportRealtimeSuppressReason(channel string) string {
	switch channel {
	case "realtime_session_missing_suppressed":
		return "worker_result_session_missing"
	case "realtime_session_mismatch_suppressed":
		return "worker_result_session_mismatch"
	case "realtime_noop_suppressed":
		return "no_action_result"
	case "":
		return "worker_result_suppressed"
	default:
		return channel
	}
}

func workerResultDeliverySuppressed(delivery meetrunner.WorkerResultDelivery) bool {
	if delivery.Suppressed {
		return true
	}
	nested, ok := delivery.Delivery.(map[string]any)
	if !ok {
		return false
	}
	suppressed, _ := nested["suppressed"].(bool)
	return suppressed
}

func workerResultDeliverySuppressionReason(delivery meetrunner.WorkerResultDelivery) string {
	if delivery.Reason != "" {
		return delivery.Reason
	}
	nested, ok := delivery.Delivery.(map[string]any)
	if ok {
		if reason := strings.TrimSpace(stringFromAny(nested["reason"])); reason != "" {
			return reason
		}
	}
	return workerReportRealtimeSuppressReason(delivery.Channel)
}

func workerReportIsRealtimeMeetingScoped(report WorkerReport) bool {
	context := report.Context
	rawKind := firstNonEmpty(
		stringFromAny(context["session_kind"]),
		stringFromAny(context["sessionKind"]),
	)
	if rawKind != "" {
		switch agentrunner.NormalizeSessionKind(rawKind) {
		case agentrunner.SessionKindMeetingCopilot,
			agentrunner.SessionKindMeetingCalib,
			agentrunner.SessionKindMeetingSummary,
			agentrunner.SessionKindDemoSurface,
			agentrunner.SessionKindDemoExecution,
			agentrunner.SessionKindMeetingAppControl:
			return true
		case agentrunner.SessionKindSecretaryLookup,
			agentrunner.SessionKindTriage,
			agentrunner.SessionKindSlack,
			agentrunner.SessionKindCompact:
			return false
		}
	}
	source := strings.ToLower(strings.TrimSpace(stringFromAny(context["source"])))
	if source == "" {
		return false
	}
	if strings.Contains(source, "persona_delegate") || strings.Contains(source, "triage") || strings.Contains(source, "secretary") {
		return false
	}
	return strings.HasPrefix(source, "meeting-") || strings.HasPrefix(source, "meeting_")
}

func workerReportMeetingSessionID(report WorkerReport) string {
	context := report.Context
	return firstNonEmpty(
		stringFromAny(context["meeting_session_id"]),
		stringFromAny(context["meetingSessionId"]),
		stringFromAny(context["meetingSessionID"]),
		stringFromAny(context["session_id"]),
		stringFromAny(context["sessionId"]),
	)
}
