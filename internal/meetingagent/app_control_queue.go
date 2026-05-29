package meetingagent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

const (
	appControlStatusQueued  = "queued"
	appControlStatusRunning = "running"
)

type appControlJob struct {
	ID          string
	Provider    string
	SessionID   string
	Instruction string
	Status      string
	Error       string
	Blocker     string
	Request     AppControlRequest
	Backend     AppControlBackend
	ScreenShare map[string]any
	Result      map[string]any
	CreatedAt   time.Time
	StartedAt   time.Time
	FinishedAt  time.Time
}

type appControlQueuedJob struct {
	ID string
}

func (s *Service) startAppControlQueue() {
	s.GoBackground(func(ctx context.Context) {
		for {
			select {
			case <-ctx.Done():
				return
			case queued := <-s.appControlQueue:
				s.runQueuedAppControlJob(ctx, queued.ID)
			}
		}
	})
}

func (s *Service) enqueueAppControlJob(req AppControlRequest, screenShare map[string]any, backend AppControlBackend) (map[string]any, error) {
	if s == nil {
		return nil, fmt.Errorf("service_unavailable")
	}
	if backend == nil {
		backend = s.appControlBackendForRequest(req)
	}
	if err := requireAppControlBackend(backend); err != nil {
		return nil, err
	}
	id := fmt.Sprintf("app_control_%d", atomic.AddUint64(&s.appControlJobSeq, 1))
	now := time.Now().UTC()
	job := appControlJob{
		ID:          id,
		Provider:    backend.Name(),
		SessionID:   req.SessionID,
		Instruction: req.Instruction,
		Status:      appControlStatusQueued,
		Request:     req,
		Backend:     backend,
		ScreenShare: screenShare,
		CreatedAt:   now,
	}
	s.appControlJobsMu.Lock()
	s.appControlJobs[id] = job
	s.appControlJobsMu.Unlock()

	select {
	case s.appControlQueue <- appControlQueuedJob{ID: id}:
		s.logger.Info(
			"realtime app-control job queued",
			"job_id", id,
			"provider", job.Provider,
			"session_id", req.SessionID,
			"operations", len(req.Operations),
		)
		return appControlJobMap(job), nil
	default:
		job.Status = appControlStatusFailed
		job.Error = "app_control_queue_full"
		job.Blocker = "app_control_queue_full"
		job.FinishedAt = time.Now().UTC()
		s.appControlJobsMu.Lock()
		s.appControlJobs[id] = job
		s.appControlJobsMu.Unlock()
		return appControlJobMap(job), fmt.Errorf("app_control_queue_full")
	}
}

func (s *Service) appControlJobStatus(id string) (map[string]any, bool) {
	s.appControlJobsMu.Lock()
	defer s.appControlJobsMu.Unlock()
	job, ok := s.appControlJobs[strings.TrimSpace(id)]
	if !ok {
		return nil, false
	}
	return appControlJobMap(job), true
}

func (s *Service) runQueuedAppControlJob(ctx context.Context, id string) {
	job, ok := s.markAppControlJobRunning(id)
	if !ok {
		return
	}
	backend := job.Backend
	if backend == nil {
		backend = s.appControlBackendForRequest(job.Request)
		if err := requireAppControlBackend(backend); err != nil {
			job.Status = appControlStatusFailed
			job.Error = err.Error()
			job.Blocker = err.Error()
			job.FinishedAt = time.Now().UTC()
			s.storeAppControlJob(job)
			s.reportQueuedAppControlJob(ctx, job)
			return
		}
		job.Backend = backend
		job.Provider = backend.Name()
	}
	start := time.Now()
	result, err := backend.ControlSharedApp(ctx, job.Request)
	elapsed := time.Since(start)
	if err != nil {
		job.Status = appControlStatusFailed
		job.Error = err.Error()
		job.Blocker = err.Error()
		job.FinishedAt = time.Now().UTC()
		s.storeAppControlJob(job)
		s.logger.Warn(
			"realtime app-control queued job failed",
			"job_id", id,
			"provider", job.Provider,
			"session_id", job.SessionID,
			"duration", elapsed.String(),
			"error", err.Error(),
		)
		s.reportQueuedAppControlJob(ctx, job)
		return
	}
	resultMap := appControlResultMap(result, job.ScreenShare)
	status := strings.TrimSpace(stringFromAny(resultMap["status"]))
	if status == "" {
		status = appControlStatusCompleted
	}
	job.Status = status
	job.Error = strings.TrimSpace(stringFromAny(resultMap["error"]))
	job.Blocker = strings.TrimSpace(stringFromAny(resultMap["blocker"]))
	job.Result = resultMap
	job.FinishedAt = time.Now().UTC()
	s.storeAppControlJob(job)
	s.logger.Info(
		"realtime app-control queued job finished",
		"job_id", id,
		"provider", job.Provider,
		"session_id", job.SessionID,
		"status", job.Status,
		"duration", elapsed.String(),
		"error", job.Error,
		"blocker", job.Blocker,
	)
	s.reportQueuedAppControlJob(ctx, job)
}

func (s *Service) markAppControlJobRunning(id string) (appControlJob, bool) {
	s.appControlJobsMu.Lock()
	defer s.appControlJobsMu.Unlock()
	job, ok := s.appControlJobs[id]
	if !ok {
		return appControlJob{}, false
	}
	job.Status = appControlStatusRunning
	job.StartedAt = time.Now().UTC()
	s.appControlJobs[id] = job
	return job, true
}

func (s *Service) storeAppControlJob(job appControlJob) {
	s.appControlJobsMu.Lock()
	defer s.appControlJobsMu.Unlock()
	s.appControlJobs[job.ID] = job
}

func appControlJobMap(job appControlJob) map[string]any {
	out := map[string]any{
		"ok":             true,
		"job_id":         job.ID,
		"provider":       job.Provider,
		"status":         job.Status,
		"session_id":     job.SessionID,
		"screenShare":    job.ScreenShare,
		"created_at":     formatAppControlJobTime(job.CreatedAt),
		"started_at":     formatAppControlJobTime(job.StartedAt),
		"finished_at":    formatAppControlJobTime(job.FinishedAt),
		"operations":     len(job.Request.Operations),
		"answer_hint_zh": "我已经把 app 控制任务排队执行；不用等这个工具调用卡住语音。",
	}
	if strings.TrimSpace(job.Error) != "" {
		out["ok"] = false
		out["error"] = strings.TrimSpace(job.Error)
	}
	if strings.TrimSpace(job.Blocker) != "" {
		out["blocker"] = strings.TrimSpace(job.Blocker)
	}
	if strings.TrimSpace(job.Instruction) != "" {
		out["instruction"] = strings.TrimSpace(job.Instruction)
	}
	if job.Result != nil {
		out["result"] = job.Result
	}
	return out
}

func formatAppControlJobTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.Format(time.RFC3339Nano)
}

func (s *Service) reportQueuedAppControlJob(ctx context.Context, job appControlJob) {
	status := queuedAppControlWorkerStatus(job)
	if status == "" {
		return
	}
	report, err := s.createWorkerReport(ctx, WorkerReportInput{
		ID:       job.ID,
		Status:   status,
		Provider: job.Provider,
		Mode:     "app_control",
		Task:     firstNonEmpty(job.Instruction, "app-control job completed"),
		Context: map[string]any{
			"session_kind":       "meeting_app_control",
			"meeting_session_id": job.SessionID,
			"source":             "meeting-realtime-shared-app-control",
			"app_control_job_id": job.ID,
		},
		Result: queuedAppControlWorkerResult(job),
		Error:  firstNonEmpty(job.Error, job.Blocker),
	})
	if err != nil {
		s.logger.Warn("app-control worker report create failed", "job_id", job.ID, "error", err)
		return
	}
	s.logger.Info(
		"realtime app-control worker event queued",
		"job_id", job.ID,
		"report_id", report.ID,
		"status", report.Status,
		"session_id", job.SessionID,
	)
}

func queuedAppControlWorkerStatus(job appControlJob) string {
	switch strings.TrimSpace(job.Status) {
	case appControlStatusCompleted:
		return appControlStatusCompleted
	case appControlStatusFailed:
		return appControlStatusFailed
	case appControlStatusQueued, appControlStatusRunning, "":
		return ""
	default:
		if strings.TrimSpace(job.Error) != "" || strings.TrimSpace(job.Blocker) != "" {
			return appControlStatusFailed
		}
		return appControlStatusCompleted
	}
}

func queuedAppControlWorkerResult(job appControlJob) string {
	if job.Result != nil {
		if summary := strings.TrimSpace(stringFromAny(job.Result["summary"])); summary != "" {
			return summary
		}
		if raw, err := json.Marshal(job.Result); err == nil {
			return string(raw)
		}
	}
	if text := strings.TrimSpace(firstNonEmpty(job.Error, job.Blocker)); text != "" {
		return text
	}
	return "App-control job completed."
}
