package meetingagent

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/persistence"
)

const workerReportsCollection = "worker_reports"

func (s *Service) ReportFinishedWorkerJob(ctx context.Context, job agentrunner.Job) *WorkerReport {
	if !isTerminalWorkerStatus(string(job.Status)) {
		return nil
	}
	report, err := s.createWorkerReport(ctx, WorkerReportInput{
		ID: job.ID, Status: string(job.Status), Provider: job.Provider, Mode: job.Mode,
		Task: job.Task, Context: job.Context, AllowCodeChanges: job.AllowCodeChanges,
		Result: job.Result, Error: job.Error,
	})
	if err != nil {
		s.logger.Warn("worker report create failed", "job_id", job.ID, "error", err)
		return nil
	}
	return &report
}

func (s *Service) createWorkerReport(ctx context.Context, input WorkerReportInput) (WorkerReport, error) {
	store, err := s.workerReportStore()
	if err != nil {
		return WorkerReport{}, err
	}
	id := firstNonEmpty(input.ID, input.JobID)
	if id == "" {
		id = newSessionID()
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	previous, found, err := store.Get(ctx, id)
	if err != nil {
		return WorkerReport{}, fmt.Errorf("load worker report %s: %w", id, err)
	}
	result := workerResultString(input.Result)
	errText := strings.TrimSpace(input.Error)
	envelope := normalizedWorkerReportEnvelope(input, id, result, errText)
	result = envelope.Result
	errText = envelope.Error
	report := WorkerReport{
		ID: id, Status: firstNonEmpty(input.Status, "queued"), Provider: input.Provider,
		Mode: input.Mode, Task: input.Task, Context: cloneWorkerContext(input.Context),
		AllowCodeChanges: input.AllowCodeChanges, Result: result,
		Error: errText, ResultEnvelope: &envelope, CreatedAt: now, UpdatedAt: now,
	}
	if found {
		report.CreatedAt = firstNonEmpty(previous.CreatedAt, now)
		report.DeliveredToRealtime = previous.DeliveredToRealtime
		report.DeliveredToSlack = previous.DeliveredToSlack
		report.RealtimeDelivery = previous.RealtimeDelivery
		report.SlackDelivery = previous.SlackDelivery
	}
	if err := store.Set(ctx, id, report); err != nil {
		return WorkerReport{}, fmt.Errorf("save worker report %s: %w", id, err)
	}
	return report, nil
}

func normalizedWorkerReportEnvelope(input WorkerReportInput, id string, result string, errText string) agentrunner.WorkerResultEnvelope {
	if input.ResultEnvelope != nil {
		return agentrunner.NormalizeWorkerResultEnvelope(*input.ResultEnvelope, agentrunner.WorkerResultEnvelopeOptions{Source: "meetingagent"})
	}
	if input.ResultEnvelopeSnake != nil {
		return agentrunner.NormalizeWorkerResultEnvelope(*input.ResultEnvelopeSnake, agentrunner.WorkerResultEnvelopeOptions{Source: "meetingagent"})
	}
	return agentrunner.BuildWorkerResultEnvelope(agentrunner.Job{
		ID:               id,
		Provider:         input.Provider,
		Status:           agentrunner.JobStatus(firstNonEmpty(input.Status, "queued")),
		Mode:             input.Mode,
		Task:             input.Task,
		Context:          input.Context,
		AllowCodeChanges: input.AllowCodeChanges,
		Result:           result,
		Error:            errText,
	}, agentrunner.WorkerResultEnvelopeOptions{Source: "meetingagent"})
}

func (s *Service) getWorkerReport(ctx context.Context, id string) (WorkerReport, bool, error) {
	store, err := s.workerReportStore()
	if err != nil {
		return WorkerReport{}, false, err
	}
	return store.Get(ctx, id)
}

func (s *Service) listWorkerReports(ctx context.Context) ([]WorkerReport, error) {
	store, err := s.workerReportStore()
	if err != nil {
		return nil, err
	}
	reports, err := store.List(ctx)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(reports, func(i int, j int) bool {
		if reports[i].CreatedAt == reports[j].CreatedAt {
			return reports[i].ID < reports[j].ID
		}
		return reports[i].CreatedAt < reports[j].CreatedAt
	})
	return reports, nil
}

func (s *Service) pollReadyWorkerReports(ctx context.Context, realtime bool, request WorkerPollRequest) ([]WorkerReport, error) {
	reports, err := s.listWorkerReports(ctx)
	if err != nil {
		return nil, err
	}
	limit := request.Limit
	if limit <= 0 {
		if realtime {
			limit = 1
		} else {
			limit = 10
		}
	}
	minTime := time.Time{}
	minCreatedAt := firstNonEmpty(request.MinCreatedAt, request.MinCreatedAtSnake)
	if minCreatedAt != "" {
		minTime, _ = time.Parse(time.RFC3339Nano, minCreatedAt)
	}
	sessionID := firstNonEmpty(request.SessionID, request.SessionIDSnake)
	ready := make([]WorkerReport, 0, limit)
	for _, report := range reports {
		if len(ready) >= limit || !isTerminalWorkerStatus(report.Status) {
			continue
		}
		if realtime && report.DeliveredToRealtime || !realtime && report.DeliveredToSlack {
			continue
		}
		if !minTime.IsZero() && workerReportTime(report).Before(minTime) {
			continue
		}
		if realtime && workerReportIsNoAction(report) {
			if workerPollMarkDelivered(request) {
				_, _ = s.markWorkerDelivered(ctx, report.ID, true, DeliveryMeta{Channel: "realtime_noop_suppressed"})
			}
			continue
		}
		if realtime {
			if channel := workerReportRealtimeSuppressChannel(report, sessionID); channel != "" {
				if workerPollMarkDelivered(request) {
					_, _ = s.markWorkerDelivered(ctx, report.ID, true, DeliveryMeta{Channel: channel})
				}
				continue
			}
		}
		ready = append(ready, report)
	}
	if workerPollMarkDelivered(request) {
		for index := range ready {
			patch := DeliveryMeta{DeliveredAt: time.Now().UTC().Format(time.RFC3339Nano)}
			updated, err := s.markWorkerDelivered(ctx, ready[index].ID, realtime, patch)
			if err == nil {
				ready[index] = updated
			}
		}
	}
	return ready, nil
}

func workerPollMarkDelivered(request WorkerPollRequest) bool {
	if request.MarkDelivered != nil {
		return *request.MarkDelivered
	}
	if request.MarkDeliveredSnake != nil {
		return *request.MarkDeliveredSnake
	}
	return true
}

func (s *Service) markWorkerDelivered(ctx context.Context, id string, realtime bool, delivery DeliveryMeta) (WorkerReport, error) {
	store, err := s.workerReportStore()
	if err != nil {
		return WorkerReport{}, err
	}
	report, found, err := store.Get(ctx, id)
	if err != nil {
		return WorkerReport{}, err
	}
	if !found {
		return WorkerReport{}, fmt.Errorf("worker report %s not found", id)
	}
	report.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if delivery.DeliveredAt == "" {
		delivery.DeliveredAt = report.UpdatedAt
	}
	if realtime {
		report.DeliveredToRealtime = true
		report.RealtimeDelivery = &delivery
	} else {
		report.DeliveredToSlack = true
		report.SlackDelivery = &delivery
	}
	return report, store.Set(ctx, id, report)
}

func (s *Service) workerReportStore() (*persistence.TypedCollection[WorkerReport], error) {
	s.workerMu.Lock()
	defer s.workerMu.Unlock()
	if s.workerStore != nil {
		return s.workerStore, nil
	}
	store, err := persistence.OpenTyped[WorkerReport](persistence.Options{
		Provider:   persistence.NormalizeProvider(s.persistence.Provider),
		Collection: workerReportsCollection,
		DataDir:    s.persistence.DataDir,
		SQLitePath: s.persistence.SQLitePath,
	})
	if err != nil {
		return nil, fmt.Errorf("open worker report store: %w", err)
	}
	s.workerStore = store
	return store, nil
}

func workerResultString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case nil:
		return ""
	default:
		raw, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprint(typed)
		}
		return string(raw)
	}
}

func isTerminalWorkerStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "completed", "failed", "timeout":
		return true
	default:
		return false
	}
}

func workerReportTime(report WorkerReport) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, firstNonEmpty(report.CreatedAt, report.UpdatedAt))
	return parsed
}

func cloneWorkerContext(source map[string]any) map[string]any {
	if len(source) == 0 {
		return nil
	}
	clone := make(map[string]any, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}
