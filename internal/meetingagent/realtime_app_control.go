package meetingagent

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

const defaultRealtimeAppControlTimeout = 90 * time.Second

type RealtimeSharedAppControlRequest struct {
	SessionID        string         `json:"session_id,omitempty"`
	Instruction      string         `json:"instruction,omitempty"`
	ApplicationName  string         `json:"applicationName,omitempty"`
	BundleIdentifier string         `json:"bundleIdentifier,omitempty"`
	WindowTitle      string         `json:"windowTitle,omitempty"`
	ProcessID        int            `json:"processId,omitempty"`
	TimeoutMs        int            `json:"timeoutMs,omitempty"`
	Context          map[string]any `json:"context,omitempty"`
}

type realtimeAppControlWorkerPayload struct {
	OK         *bool    `json:"ok"`
	Summary    string   `json:"summary,omitempty"`
	Actions    []string `json:"actions,omitempty"`
	Confidence float64  `json:"confidence,omitempty"`
	Blocker    string   `json:"blocker,omitempty"`
}

func (s *Service) ControlRealtimeSharedApp(ctx context.Context, input RealtimeSharedAppControlRequest) map[string]any {
	instruction := strings.TrimSpace(input.Instruction)
	if instruction == "" {
		return map[string]any{
			"ok":    false,
			"error": "instruction_required",
		}
	}
	if s.runner == nil {
		return map[string]any{
			"ok":       false,
			"error":    "agent_runner_unavailable",
			"provider": s.agentRunnerName(),
			"detail":   runnerErrorText(s.runnerErr),
		}
	}
	sessionID, err := s.resolveScreenShareSessionID(ctx, input.SessionID)
	if err != nil {
		return map[string]any{
			"ok":    false,
			"error": err.Error(),
		}
	}
	status := s.realtimeAppControlStatus(ctx, sessionID)
	startInput := agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             buildRealtimeAppControlTask(input, status),
		Context:          realtimeAppControlContext(input, sessionID, status),
		Mode:             "analysis",
		AllowCodeChanges: false,
		Sandbox:          "danger-full-access",
	}, agentrunner.SessionKindMeetingAppControl)
	job, err := s.runner.StartTask(ctx, startInput)
	if err != nil {
		return map[string]any{
			"ok":       false,
			"error":    err.Error(),
			"provider": s.agentRunnerName(),
			"status":   "failed",
		}
	}
	completed := s.waitForRunnerJob(ctx, job.ID, realtimeAppControlTimeout(input.TimeoutMs))
	var report *WorkerReport
	if completed != nil && isTerminalWorkerStatus(string(completed.Status)) {
		report = s.ReportFinishedWorkerJob(context.WithoutCancel(ctx), *completed)
	}
	responseText := dialogJobResult(completed)
	workerPayload, hasWorkerPayload := parseRealtimeAppControlWorkerPayload(responseText)
	ok := completed != nil && completed.Status == agentrunner.StatusCompleted
	if hasWorkerPayload && workerPayload.OK != nil && !*workerPayload.OK {
		ok = false
	}
	result := map[string]any{
		"ok":           ok,
		"provider":     firstNonEmpty(dialogJobProvider(completed), job.Provider, s.agentRunnerName()),
		"status":       dialogJobStatus(completed),
		"responseText": responseText,
		"job":          firstNonNilJob(completed, job),
		"report":       report,
		"screenShare":  status,
	}
	if hasWorkerPayload {
		result["workerResult"] = workerPayload
		if !ok {
			result["error"] = "app_control_blocked"
			result["blocker"] = strings.TrimSpace(firstNonEmpty(workerPayload.Blocker, workerPayload.Summary))
		}
	}
	return result
}

func buildRealtimeAppControlTask(input RealtimeSharedAppControlRequest, status map[string]any) string {
	payload, _ := json.MarshalIndent(map[string]any{
		"instruction":        strings.TrimSpace(input.Instruction),
		"applicationName":    strings.TrimSpace(input.ApplicationName),
		"bundleIdentifier":   strings.TrimSpace(input.BundleIdentifier),
		"windowTitle":        strings.TrimSpace(input.WindowTitle),
		"processId":          input.ProcessID,
		"currentShareStatus": status,
	}, "", "  ")
	return strings.Join([]string{
		"Operate the currently shared macOS app/window for the live meeting.",
		"Use the high-level Computer Use capability exposed by the runtime (Codex or KWWK). Do not implement low-level CGEvent, AppleScript, shell, or repository-code UI automation.",
		"Keep the operation bounded to the target app/window. If you cannot access the app or the requested action is unsafe/destructive, return a blocker instead of improvising.",
		`Return exactly one JSON object: {"ok":true,"summary":"what changed or what blocker you hit","actions":["short action list"],"confidence":0.0,"blocker":""}.`,
		"Request:\n" + string(payload),
	}, "\n\n")
}

func realtimeAppControlContext(input RealtimeSharedAppControlRequest, sessionID string, status map[string]any) map[string]any {
	context := cloneMap(input.Context)
	if context == nil {
		context = map[string]any{}
	}
	context["source"] = "meeting-realtime-shared-app-control"
	context["meeting_session_id"] = strings.TrimSpace(sessionID)
	context["application_name"] = strings.TrimSpace(input.ApplicationName)
	context["bundle_identifier"] = strings.TrimSpace(input.BundleIdentifier)
	context["window_title"] = strings.TrimSpace(input.WindowTitle)
	context["process_id"] = input.ProcessID
	context["screen_share_status"] = status
	context["output_contract"] = map[string]any{
		"format": "json_object_only",
		"fields": []string{"ok", "summary", "actions", "confidence", "blocker"},
	}
	return context
}

func (s *Service) realtimeAppControlStatus(ctx context.Context, sessionID string) map[string]any {
	status := map[string]any{
		"session_id": strings.TrimSpace(sessionID),
	}
	if s.meetRunner == nil {
		status["ok"] = false
		status["error"] = "meet_runner_unavailable"
		return status
	}
	runtime, err := s.meetRunner.StatusSession(ctx, meetrunner.StatusSessionInput{SessionID: sessionID})
	if err != nil {
		status["ok"] = false
		status["error"] = err.Error()
		return status
	}
	status["ok"] = runtime.OK
	status["active"] = runtime.Active
	status["session"] = runtime.Session
	return status
}

func realtimeAppControlTimeout(timeoutMs int) time.Duration {
	if timeoutMs <= 0 {
		return defaultRealtimeAppControlTimeout
	}
	return time.Duration(timeoutMs) * time.Millisecond
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
