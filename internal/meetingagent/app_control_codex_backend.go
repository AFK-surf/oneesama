package meetingagent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

type CodexAppControlBackend struct {
	service *Service
}

func NewCodexAppControlBackend(service *Service) *CodexAppControlBackend {
	return &CodexAppControlBackend{service: service}
}

func (b *CodexAppControlBackend) Name() string {
	if b == nil || b.service == nil {
		return "codex"
	}
	return firstNonEmpty(b.service.agentRunnerName(), "codex")
}

func (b *CodexAppControlBackend) ControlSharedApp(ctx context.Context, req AppControlRequest) (AppControlResult, error) {
	if b == nil || b.service == nil || b.service.runner == nil {
		provider := "codex"
		var detail string
		if b != nil && b.service != nil {
			provider = b.service.agentRunnerName()
			detail = runnerErrorText(b.service.runnerErr)
		}
		return AppControlResult{
			OK:       false,
			Provider: provider,
			Status:   appControlStatusFailed,
			Error:    firstNonEmpty(detail, "agent_runner_unavailable"),
			Blocker:  "agent_runner_unavailable",
		}, nil
	}
	input := realtimeRequestFromAppControl(req)
	startInput := agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             buildRealtimeAppControlTask(input, req.Target.ScreenShare),
		Context:          realtimeAppControlContext(input, req.SessionID, req.Target.ScreenShare),
		Mode:             "analysis",
		AllowCodeChanges: false,
		Sandbox:          "danger-full-access",
	}, agentrunner.SessionKindMeetingAppControl)
	job, err := b.service.runner.StartTask(ctx, startInput)
	if err != nil {
		return AppControlResult{
			OK:       false,
			Provider: b.service.agentRunnerName(),
			Status:   appControlStatusFailed,
			Error:    err.Error(),
		}, nil
	}
	completed := b.service.waitForRunnerJob(ctx, job.ID, req.Timeout)
	var report *WorkerReport
	if completed != nil && isTerminalWorkerStatus(string(completed.Status)) {
		report = b.service.ReportFinishedWorkerJob(context.WithoutCancel(ctx), *completed)
	}
	responseText := dialogJobResult(completed)
	workerPayload, hasWorkerPayload := parseRealtimeAppControlWorkerPayload(responseText)
	ok := completed != nil && completed.Status == agentrunner.StatusCompleted
	if hasWorkerPayload && workerPayload.OK != nil && !*workerPayload.OK {
		ok = false
	}
	result := AppControlResult{
		OK:           ok,
		Provider:     firstNonEmpty(dialogJobProvider(completed), job.Provider, b.service.agentRunnerName()),
		Status:       dialogJobStatus(completed),
		ResponseText: responseText,
		Job:          firstNonNilJob(completed, job),
		Report:       report,
	}
	if hasWorkerPayload {
		result.Raw = workerPayload
		result.Summary = strings.TrimSpace(workerPayload.Summary)
		result.Actions = append([]string(nil), workerPayload.Actions...)
		result.Confidence = workerPayload.Confidence
		if !ok {
			result.Error = "app_control_blocked"
			result.Blocker = strings.TrimSpace(firstNonEmpty(workerPayload.Blocker, workerPayload.Summary))
		}
	}
	return result, nil
}

func realtimeRequestFromAppControl(req AppControlRequest) RealtimeSharedAppControlRequest {
	return RealtimeSharedAppControlRequest{
		SessionID:        req.SessionID,
		Instruction:      req.Instruction,
		Standalone:       req.Context["standalone_app_control"] == true,
		ApplicationName:  req.Target.ApplicationName,
		BundleIdentifier: req.Target.BundleIdentifier,
		WindowTitle:      req.Target.WindowTitle,
		WindowID:         req.Target.WindowID,
		ProcessID:        req.Target.ProcessID,
		TimeoutMs:        int(req.Timeout.Milliseconds()),
		Context:          cloneMap(req.Context),
	}
}

type realtimeAppControlWorkerPayload struct {
	OK         *bool    `json:"ok"`
	Summary    string   `json:"summary,omitempty"`
	Actions    []string `json:"actions,omitempty"`
	Confidence float64  `json:"confidence,omitempty"`
	Blocker    string   `json:"blocker,omitempty"`
}

func parseRealtimeAppControlWorkerPayload(raw string) (realtimeAppControlWorkerPayload, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return realtimeAppControlWorkerPayload{}, false
	}
	for _, candidate := range demoCodexJSONCandidates(trimmed) {
		var payload realtimeAppControlWorkerPayload
		if err := json.Unmarshal([]byte(candidate), &payload); err == nil {
			return payload, payload.OK != nil || strings.TrimSpace(payload.Summary) != "" || strings.TrimSpace(payload.Blocker) != ""
		}
	}
	return realtimeAppControlWorkerPayload{}, false
}
