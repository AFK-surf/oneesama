package meetingagent

import (
	"context"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

func (s *Service) DialogProviders() map[string]any {
	return map[string]any{
		"ok": true,
		"stt": map[string]any{
			"provider": s.dialog.STTProvider,
			"note":     "event provider is the default seam; browser/native STT providers can dispatch meeting-avatar-local-utterance.",
		},
		"tts": map[string]any{
			"provider": normalizeTTSProvider(s.dialog.TTSProvider),
			"route":    "/tts/synthesize",
		},
		"agentRunner": s.agentRunnerName(),
	}
}

func (s *Service) RunDialogTurn(ctx context.Context, input DialogTurnRequest) map[string]any {
	utterance := strings.TrimSpace(firstNonEmpty(input.Utterance, input.Text))
	if utterance == "" {
		return map[string]any{"ok": false, "error": "utterance_required"}
	}
	if s.runner == nil {
		return map[string]any{
			"ok":           false,
			"provider":     s.agentRunnerName(),
			"status":       "failed",
			"responseText": "",
			"job":          nil,
			"report":       nil,
			"error":        runnerErrorText(s.runnerErr),
		}
	}

	job, err := s.runner.StartTask(ctx, agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             utterance,
		Context:          dialogTurnContext(input),
		Mode:             firstNonEmpty(input.Mode, "dialog"),
		AllowCodeChanges: input.AllowCodeChanges,
	}, agentrunner.SessionKindMeetingCopilot))
	if err != nil {
		return map[string]any{"ok": false, "provider": s.agentRunnerName(), "status": "failed", "responseText": "", "job": nil, "report": nil, "error": err.Error()}
	}

	completed := s.waitForRunnerJob(ctx, job.ID, dialogTurnTimeout(input.TimeoutMs))
	var report *WorkerReport
	if completed != nil && isTerminalWorkerStatus(string(completed.Status)) {
		report = s.ReportFinishedWorkerJob(context.WithoutCancel(ctx), *completed)
	}
	return map[string]any{
		"ok":           completed != nil,
		"provider":     firstNonEmpty(dialogJobProvider(completed), job.Provider, s.agentRunnerName()),
		"status":       dialogJobStatus(completed),
		"responseText": dialogJobResult(completed),
		"job":          firstNonNilJob(completed, job),
		"report":       report,
	}
}

func (s *Service) waitForRunnerJob(ctx context.Context, jobID string, timeout time.Duration) *agentrunner.Job {
	deadline := time.Now().Add(timeout)
	var last *agentrunner.Job
	for time.Now().Before(deadline) {
		job, found, err := s.runner.GetJob(ctx, jobID)
		if err == nil && found {
			last = &job
			if isTerminalWorkerStatus(string(job.Status)) {
				return &job
			}
		}
		select {
		case <-ctx.Done():
			return last
		case <-time.After(150 * time.Millisecond):
		}
	}
	if last != nil {
		timeoutJob := *last
		timeoutJob.Status = agentrunner.StatusTimeout
		timeoutJob.Error = "dialog turn timed out waiting for provider result"
		return &timeoutJob
	}
	return nil
}

func dialogTurnContext(input DialogTurnRequest) map[string]any {
	context := cloneMap(input.Context)
	if context == nil {
		context = map[string]any{}
	}
	context["sessionId"] = input.SessionID
	context["source"] = "meeting-local-dialog"
	return context
}

func dialogTurnTimeout(timeoutMs int) time.Duration {
	if timeoutMs <= 0 {
		timeoutMs = 30000
	}
	return time.Duration(timeoutMs) * time.Millisecond
}

func (s *Service) agentRunnerName() string {
	if s.runner != nil {
		return s.runner.Provider()
	}
	return s.runnerErrText()
}

func (s *Service) runnerErrText() string {
	return runnerErrorText(s.runnerErr)
}

func dialogJobProvider(job *agentrunner.Job) string {
	if job == nil {
		return ""
	}
	return job.Provider
}

func dialogJobStatus(job *agentrunner.Job) string {
	if job == nil {
		return "timeout"
	}
	return string(job.Status)
}

func dialogJobResult(job *agentrunner.Job) string {
	if job == nil {
		return ""
	}
	return job.Result
}

func firstNonNilJob(job *agentrunner.Job, fallback agentrunner.Job) any {
	if job != nil {
		return *job
	}
	return fallback
}
