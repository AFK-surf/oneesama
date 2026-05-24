package meetingagent

import (
	"context"
	"strings"

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
