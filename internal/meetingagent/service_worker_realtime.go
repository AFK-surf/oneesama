package meetingagent

import (
	"context"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

func (s *Service) deliverWorkerReportRealtime(ctx context.Context, report WorkerReport) (meetrunner.WorkerResultDelivery, *WorkerReport) {
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
