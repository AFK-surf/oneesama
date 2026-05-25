package meetingagent

import (
	"context"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

func (s *Service) deliverWorkerReportRealtime(ctx context.Context, report WorkerReport) (meetrunner.WorkerResultDelivery, *WorkerReport) {
	if workerReportIsNoAction(report) {
		updated, err := s.markWorkerDelivered(ctx, report.ID, true, DeliveryMeta{Channel: "realtime_noop_suppressed"})
		if err != nil {
			return meetrunner.WorkerResultDelivery{OK: false, Error: err.Error()}, nil
		}
		return meetrunner.WorkerResultDelivery{OK: true, Channel: "realtime_noop_suppressed"}, &updated
	}
	session, err := s.resolveJoinSession(ctx, "")
	if err != nil || session == nil {
		return meetrunner.WorkerResultDelivery{OK: false, Error: "no_active_join"}, nil
	}
	if channel := workerReportRealtimeSuppressChannel(report, session.ID); channel != "" {
		updated, err := s.markWorkerDelivered(ctx, report.ID, true, DeliveryMeta{Channel: channel})
		if err != nil {
			return meetrunner.WorkerResultDelivery{OK: false, Error: err.Error()}, nil
		}
		return meetrunner.WorkerResultDelivery{OK: true, Channel: channel}, &updated
	}
	delivery, err := s.meetRunner.InjectWorkerResult(ctx, meetrunner.WorkerResultInput{
		SessionID: session.ID,
		Job:       report,
	})
	if err != nil {
		return meetrunner.WorkerResultDelivery{OK: false, Error: err.Error()}, nil
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
	if sessionID != "" && targetSessionID != "" && targetSessionID != sessionID {
		return "realtime_session_mismatch_suppressed"
	}
	return ""
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
